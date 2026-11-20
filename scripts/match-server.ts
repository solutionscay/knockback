/**
 * The match server (#20, #25, #27): remote agents play Knockback over HTTP; the viewer
 * watches live. API: src/server/match-server.ts (GET /api lists it).
 *
 *   bun run match-server                              # localhost:5176, one open match (4 remote seats)
 *   bun run match-server --host 0.0.0.0               # also on the LAN
 *   bun run match-server --seats remote,remote,remote,house --seed 42 --deadline 20 --fill-after 60
 *   bun run match-server --seats remote,claude,house,house   # local providers allowed from the CLI
 *   bun run match-server --no-match                   # matches only via POST /api/matches
 *   bun run match-server --host 0.0.0.0 --open        # trusted LAN: no seat token checks (?seat=N instead)
 *   bun run match-server --db records/match-server.db # storage (the default); --db :memory: keeps nothing
 *   bun run match-server --trust-proxy                # behind a reverse proxy (Caddy): client address from X-Forwarded-For
 *
 * Every flag can also come from the environment as KB_<FLAG> (KB_FILL_AFTER=60,
 * KB_OPEN=true, KB_NO_MATCH=true, ...), plus PORT and HOST; command-line flags
 * win. KB_VERSION is shown by GET /api/health. SIGTERM/SIGINT close the
 * database cleanly (a SIGKILL is safe too: SQLite WAL, and matches resume).
 *
 * State lives in a SQLite file (--db, default <out>/match-server.db). After a
 * restart, open matches wait again and running ones resume where they were
 * (stored rounds replay deterministically); a new match is created only when
 * none was resumed.
 *
 * Watch: http://<host>:5176/?live (the newest match). Records land in
 * records/ and replay with ?record=/records/<file>.json.
 */
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { registerStubs } from "../src/ai/providers";
import { MAX_BODY } from "../src/server/limits";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";
import index from "../index.html";
import { logLanUrls, serveRecord } from "./viewer-server";

const flags: Record<string, string> = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    flags[k] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true");
  }
}
// environment: KB_FILL_AFTER -> --fill-after, PORT -> --port, HOST -> --host (command-line flags win)
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined || v === "") continue;
  const name = k === "PORT" || k === "HOST" ? k.toLowerCase() : k.startsWith("KB_") && k !== "KB_VERSION" ? k.slice(3).toLowerCase().replace(/_/g, "-") : null;
  if (name && flags[name] === undefined) flags[name] = v;
}
const trustProxy = flags["trust-proxy"] === "true";
registerStubs();
await initPhysics();
const outDir = resolve(flags.out ?? "records");
const hostname = flags.host ?? "localhost";
const port = Number(flags.port ?? 5176);
mkdirSync(outDir, { recursive: true });
const dbPath = flags.db ?? join(outDir, "match-server.db");
const store = new SqliteStore(dbPath);
const secs = (s: string | undefined, dflt: number) => (s !== undefined ? Math.round(Number(s) * 1000) : dflt);

const api = new MatchServer({
  outDir,
  open: flags.open === "true",
  store,
  defaultDeadlineMs: secs(flags.deadline, 20_000),
  defaultFillAfterMs: secs(flags["fill-after"], 60_000),
  version: process.env.KB_VERSION ?? "dev",
  log: (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`),
});

/** The client's address for rate limits: behind a proxy, the last X-Forwarded-For hop (the one the proxy added). */
function clientIp(req: Request, direct: string | undefined): string {
  if (trustProxy) {
    const hop = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
    if (hop) return hop;
  }
  return direct ?? "unknown";
}

const server = Bun.serve({
  hostname,
  port,
  idleTimeout: 0, // long polls and the live stream stay open
  maxRequestBodySize: MAX_BODY * 4,
  development: flags.dev === "true",
  routes: { "/": index },
  async fetch(req, srv) {
    const res = await api.handle(req, clientIp(req, srv.requestIP(req)?.address));
    if (res) return res;
    return (await serveRecord(new URL(req.url).pathname, outDir)) ?? new Response("Not found", { status: 404 });
  },
});

console.log(`Knockback match server: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}/api  (watch: /?live)${flags.open === "true" ? "  OPEN MODE: no seat token checks" : ""}`);
logLanUrls(hostname, server.port, "/?live");
console.log(`storage: ${dbPath}`);
const resumed = await api.resume();
for (const id of resumed.running) console.log(`resumed match: ${id}`);
for (const id of resumed.open) console.log(`open match (restored): ${id}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    console.log(`${sig}: closing the database`);
    void store.close().finally(() => process.exit(0));
  });
if (flags["no-match"] !== "true" && !resumed.open.length && !resumed.running.length) {
  const m = await api.createMatch({
    seats: (flags.seats ?? "remote,remote,remote,remote").split(",").map((s) => s.trim().toLowerCase()),
    ...(flags.seed ? { seed: Number(flags.seed) } : {}),
  });
  console.log(`open match: ${m.id}  (join: POST /api/matches/${m.id}/join)`);
}
