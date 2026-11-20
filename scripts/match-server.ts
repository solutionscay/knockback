/**
 * The match server (#20): remote agents play Knockback over HTTP; the viewer
 * watches live. API: src/server/match-server.ts (GET /api lists it).
 *
 *   bun run match-server                              # localhost:5176, one open match (4 remote seats)
 *   bun run match-server --host 0.0.0.0               # also on the LAN
 *   bun run match-server --seats remote,remote,remote,house --seed 42 --deadline 20 --fill-after 60
 *   bun run match-server --seats remote,claude,house,house   # local providers allowed from the CLI
 *   bun run match-server --no-match                   # matches only via POST /api/matches
 *
 * Watch: http://<host>:5176/?live (the newest match). Records land in
 * records/ and replay with ?record=/records/<file>.json.
 */
import { resolve } from "node:path";
import { registerStubs } from "../src/ai/providers";
import { MAX_BODY } from "../src/server/limits";
import { MatchServer } from "../src/server/match-server";
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
registerStubs();
await initPhysics();
const outDir = resolve(flags.out ?? "records");
const hostname = flags.host ?? "localhost";
const port = Number(flags.port ?? 5176);
const secs = (s: string | undefined, dflt: number) => (s !== undefined ? Math.round(Number(s) * 1000) : dflt);

const api = new MatchServer({
  outDir,
  defaultDeadlineMs: secs(flags.deadline, 20_000),
  defaultFillAfterMs: secs(flags["fill-after"], 60_000),
  log: (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`),
});

const server = Bun.serve({
  hostname,
  port,
  idleTimeout: 0, // long polls and the live stream stay open
  maxRequestBodySize: MAX_BODY * 4,
  development: flags.dev === "true",
  routes: { "/": index },
  async fetch(req, srv) {
    const res = await api.handle(req, srv.requestIP(req)?.address ?? "unknown");
    if (res) return res;
    return serveRecord(new URL(req.url).pathname, outDir) ?? new Response("Not found", { status: 404 });
  },
});

console.log(`Knockback match server: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}/api  (watch: /?live)`);
logLanUrls(hostname, server.port, "/?live");
if (flags["no-match"] !== "true") {
  const m = api.createMatch({
    seats: (flags.seats ?? "remote,remote,remote,remote").split(",").map((s) => s.trim().toLowerCase()),
    ...(flags.seed ? { seed: Number(flags.seed) } : {}),
  });
  console.log(`open match: ${m.id}  (join: POST /api/matches/${m.id}/join)`);
}
