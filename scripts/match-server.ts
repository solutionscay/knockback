/**
 * The match server (#20, #25, #27): remote agents play Knockback over HTTP; the viewer
 * watches live. API: src/server/match-server.ts (GET /api lists it).
 *
 *   bun run match-server                              # localhost:5176: the lobby waits for agents (no match until one joins)
 *   bun run match-server --host 0.0.0.0               # also on the LAN
 *   bun run match-server --seats remote,remote,remote,house --seed 42 --deadline 20 --fill-after 60
 *   bun run match-server --seats remote,claude,house,house   # local providers allowed from the CLI
 *   bun run match-server --seats remote,remote,remote,remote   # also open one match at startup (it expires if nobody joins)
 *   bun run match-server --host 0.0.0.0 --open        # trusted LAN: no seat token checks (?seat=N instead)
 *   bun run match-server --db records/match-server.db # storage (the default); --db :memory: keeps nothing
 *   bun run match-server --trust-proxy                # behind a reverse proxy (Caddy): client address from X-Forwarded-For,
 *                                                     # only when the request comes from --trusted-proxies (default: loopback and private addresses)
 *
 * Pace (#22): matches run at broadcast speed (the server waits until each round
 * has played out for viewers before asking for the next one); --fast keeps the
 * instant mode (tests, scripted demos). Agents that drop or miss a deadline
 * hand their fighter to the house bot until they come back.
 *
 * Check-ins (#9, on by default; --checkins off or KB_CHECKINS=false): every
 * agent (and local AI seat) gets a status every 10 s of fight and may change
 * its plan (GET /turn status "checkin", POST /checkin; MCP: wait_for_turn +
 * submit_checkin). At broadcast pace the check-in comes when viewers reach
 * that moment; it waits for the answer, and the change applies at the tick
 * viewers have reached when it arrives (+ a lead), so a slow answer applies
 * late. --checkin-cap (s, default 60) only stops hung calls; --checkin-every,
 * --checkin-max as in ai-match.
 *
 * Lobby (#22): agents wait in a queue (MCP join_lobby at /mcp, or HTTP POST /api/queue). The
 * matchmaker opens a match when 4 agents wait, or when one has waited --lobby-fill seconds (default
 * 60; --min-agents, default 1) with built-in AI seats from --ai-roster (default claude,codex,grok;
 * "house" allowed) in the empty places. Nothing runs while nobody waits: no loop, no automatic
 * match. Guardrails: --max-concurrent matchmaker matches (default 1), --ai-daily-cap built-in AI
 * seats per UTC day (default 30; then house bots) and --ai-per-address (default 9, charged to the
 * oldest agent's address), every provider call logged to the server log
 * and <out>/ai-usage.jsonl. --mcp-deadline seconds per turn (default 75), --public-url for links
 * and GET /api/join. --no-mcp turns MCP off (the HTTP queue stays).
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
 * Site (#22): http://<host>:5176/lobby (live fight, up next, queue, results, JOIN), /watch/:id,
 * /replay/:id, /agent/:name, /replays. Watch: http://<host>:5176/?live (the newest match). Records land in
 * records/ and replay with ?record=/records/<file>.json.
 */
import { checkinFlags } from "../src/ai/checkin";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { registerStubs } from "../src/ai/providers";
import { MAX_BODY } from "../src/server/limits";
import { MatchServer } from "../src/server/match-server";
import { Matchmaker } from "../src/server/matchmaker";
import { McpGateway } from "../src/server/mcp";
import { inCidrs, parseCidrs } from "../src/server/net";
import { SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";
import index from "../index.html";
import site from "../src/site/index.html";
import { SITE_PATHS } from "../src/site/route";
import { logLanUrls, serveRecord } from "./viewer-server";

import { parseFlags } from "./flags";

const flags = parseFlags(process.argv.slice(2));
// environment: KB_FILL_AFTER -> --fill-after, PORT -> --port, HOST -> --host (command-line flags win)
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined || v === "") continue;
  const name = k === "PORT" || k === "HOST" ? k.toLowerCase() : k.startsWith("KB_") && k !== "KB_VERSION" ? k.slice(3).toLowerCase().replace(/_/g, "-") : null;
  if (name && flags[name] === undefined) flags[name] = v;
}
const trustProxy = flags["trust-proxy"] === "true";
const trustedProxies = parseCidrs(flags["trusted-proxies"] ?? "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7");
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
  pace: flags.fast === "true" ? "fast" : "broadcast",
  // mid-round check-ins are on by default here (--checkins off / KB_CHECKINS=false turns them off)
  checkins: checkinFlags(flags, true),
  log: (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`),
});

if (flags["lobby-seats"]) console.log("--lobby-seats is gone (#22): the matchmaker seats queued agents and fills with --ai-roster");
const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const publicUrl = flags["public-url"]?.replace(/\/$/, "");
const lobby = await new Matchmaker(api, {
  fillAfterMs: secs(flags["lobby-fill"], 60_000),
  minAgents: Number(flags["min-agents"] ?? 1),
  roster: list(flags["ai-roster"], "claude,codex,grok"),
  deadlineMs: secs(flags["mcp-deadline"], 75_000),
  maxConcurrent: Number(flags["max-concurrent"] ?? 1),
  aiSeatsPerDay: Number(flags["ai-daily-cap"] ?? 30),
  aiSeatsPerAddress: Number(flags["ai-per-address"] ?? 9),
  ...(publicUrl ? { publicUrl } : {}),
}).init();
const mcp = flags["no-mcp"] === "true" ? null : new McpGateway(api, { lobby, ...(publicUrl ? { publicUrl } : {}) });

/**
 * The client's address for rate limits: behind a proxy, the last X-Forwarded-For
 * hop (the one the proxy added), but only when the request really comes from a
 * trusted proxy address; anyone else's X-Forwarded-For is ignored.
 */
function clientIp(req: Request, direct: string | undefined): string {
  if (trustProxy && direct && inCidrs(direct, trustedProxies)) {
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
  // the viewer at /, the site pages (#22: lobby, watch, replay, agent, replays) at their paths
  routes: { "/": index, ...Object.fromEntries(SITE_PATHS.map((p) => [p, site])) },
  async fetch(req, srv) {
    const ip = clientIp(req, srv.requestIP(req)?.address);
    if (mcp && new URL(req.url).pathname === "/mcp") return mcp.handle(req, ip);
    const res = await api.handle(req, ip);
    if (res) return res;
    return (await serveRecord(new URL(req.url).pathname, outDir)) ?? new Response("Not found", { status: 404 });
  },
});

console.log(`Knockback match server: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}/api  (site: /lobby, viewer: /?live)${flags.open === "true" ? "  OPEN MODE: no seat token checks" : ""}`);
logLanUrls(hostname, server.port, "/lobby");
console.log(`pace: ${flags.fast === "true" ? "fast (instant rounds)" : "broadcast (rounds wait for viewers; --fast for instant)"}${api.opts.checkins ? "; mid-round check-ins on" : ""}`);
if (mcp) console.log(`MCP: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}/mcp`);
console.log(`lobby: waits for agents; AI seats (${lobby.roster.join(", ")}) after ${lobby.fillAfterMs / 1000} s; ${lobby.deadlineMs / 1000} s turns; at most ${lobby.maxConcurrent} match(es) at once, ${lobby.aiSeatsPerDay} AI seats a day (${lobby.summary().ai.seatsToday} used today)`);
console.log(`storage: ${dbPath}`);
const resumed = await api.resume();
for (const id of resumed.running) console.log(`resumed match: ${id}`);
for (const id of resumed.open) console.log(`open match (restored): ${id}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    console.log(`${sig}: closing the database`);
    void store.close().finally(() => process.exit(0));
  });
// no automatic match (#22): only when --seats asks for one (it expires if nobody joins before the fill timer)
if (flags.seats && flags["no-match"] !== "true" && !resumed.open.length && !resumed.running.length) {
  const m = await api.createMatch({
    seats: flags.seats.split(",").map((s) => s.trim().toLowerCase()),
    ...(flags.seed ? { seed: Number(flags.seed) } : {}),
  });
  console.log(`open match: ${m.id}  (join: POST /api/matches/${m.id}/join)`);
}
