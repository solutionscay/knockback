/**
 * The match server (#20, #25, #27, #64): the always-on Arena. Remote agents play Knockback over MCP or HTTP; the
 * viewer watches live. API: src/server/match-server.ts (GET /api lists it).
 *
 *   bun run match-server                              # localhost:5176: the Arena runs at once, house bots in every seat
 *   bun run match-server --host 0.0.0.0               # also on the LAN
 *   bun run match-server --deadline 75                # seconds an agent has for its turn (default 75)
 *   bun run match-server --db records/match-server.db # storage (the default); --db :memory: keeps nothing
 *   bun run match-server --trust-proxy                # behind a reverse proxy (Caddy): client address from X-Forwarded-For,
 *                                                     # only when the request comes from --trusted-proxies (default: loopback and private addresses)
 *
 * The Arena (#64): one fight with 4 seats, rounds back to back (each round a one-round match). House bots hold the
 * seats no agent holds, so something is always on. An agent joins (MCP join_lobby at /mcp, or HTTP POST /api/queue)
 * and claims a house bot's seat from the next round, or waits in the queue. It keeps its seat while it answers; 2
 * missed rounds in a row, or leaving, give the seat back to a house bot. With 4 agents seated and more waiting, the
 * one that placed last goes to the back of the queue. The server makes no model call. --public-url for links and
 * GET /api/join; --no-mcp turns MCP off (HTTP stays).
 *
 * Pace (#22): rounds run at broadcast speed, whether or not anyone watches (the win screen plays between rounds);
 * --fast runs them instantly (tests, scripted demos, scripts/remote-agent.ts against a local server).
 *
 * Check-ins (#9, on by default; --checkins off or KB_CHECKINS=false): every agent gets a status every 10 s of fight
 * and may change its plan (GET /api/arena/turn status "checkin", POST /api/arena/checkin; MCP: wait_for_turn +
 * submit_checkin). At broadcast pace the check-in comes when viewers reach that moment; it waits for the answer,
 * and the change applies at the tick viewers have reached when it arrives (+ a lead), so a slow answer applies late.
 * --checkin-cap (s, default 60) only stops hung calls; --checkin-every, --checkin-max as in ai-match.
 *
 * Drain (#167, before a deploy): SIGUSR2 lets the round on now end and holds the next round (at most --drain-max s,
 * default 600; SIGHUP ends it). GET /api/health shows `arena.idle`; `bun run arena wait-idle` waits for it.
 *
 * Every flag can also come from the environment as KB_<FLAG> (KB_DEADLINE=75, KB_FAST=true, ...), plus PORT and
 * HOST; command-line flags win. KB_VERSION is shown by GET /api/health. SIGTERM/SIGINT close the database cleanly (a
 * SIGKILL is safe too: SQLite WAL, and the round in progress resumes).
 *
 * State lives in a SQLite file (--db, default <out>/match-server.db). After a restart the Arena round in progress
 * resumes where it was (its stored decisions replay deterministically) and agents join again.
 *
 * Site (#22, #106): http://<host>:5176/lobby (the Arena live), /watch/:id (one round live), /replays, /replay/:id,
 * /leaderboard, /agent/:name, /connect (an owner key and the MCP config). Watch: http://<host>:5176/?live. Records land in records/
 * and replay with ?record=/records/<file>.json.
 */
import { checkinFlags } from "../src/ai/checkin";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { MAX_BODY } from "../src/server/limits";
import { MatchServer } from "../src/server/match-server";
import { McpGateway } from "../src/server/mcp";
import { inCidrs, parseCidrs } from "../src/server/net";
import { SchemaError, SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";
import index from "../index.html";
import site from "../src/site/index.html";
import { REDIRECTS, SITE_PATHS } from "../src/site/route";
import { logLanUrls, serveRecord } from "./viewer-server";

import { parseFlags } from "./flags";

const flags = parseFlags(process.argv.slice(2));
// environment: KB_DEADLINE -> --deadline, PORT -> --port, HOST -> --host (command-line flags win)
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined || v === "") continue;
  const name = k === "PORT" || k === "HOST" ? k.toLowerCase() : k.startsWith("KB_") && k !== "KB_VERSION" ? k.slice(3).toLowerCase().replace(/_/g, "-") : null;
  if (name && flags[name] === undefined) flags[name] = v;
}
const trustProxy = flags["trust-proxy"] === "true";
const trustedProxies = parseCidrs(flags["trusted-proxies"] ?? "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7");
await initPhysics();
const outDir = resolve(flags.out ?? "records");
const hostname = flags.host ?? "localhost";
const port = Number(flags.port ?? 5176);
mkdirSync(outDir, { recursive: true });
const dbPath = flags.db ?? join(outDir, "match-server.db");
let store: SqliteStore;
try {
  store = new SqliteStore(dbPath);
} catch (e) {
  // an old or unknown schema is refused (pre-alpha: no upgrade code); the message says how to reset
  if (!(e instanceof SchemaError)) throw e;
  console.error(e.message);
  process.exit(1);
}
const secs = (s: string | undefined, dflt: number) => (s !== undefined ? Math.round(Number(s) * 1000) : dflt);

const publicUrl = flags["public-url"]?.replace(/\/$/, "");
const api = new MatchServer({
  outDir,
  store,
  version: process.env.KB_VERSION ?? "dev",
  pace: flags.fast === "true" ? "fast" : "broadcast",
  // mid-round check-ins are on by default here (--checkins off / KB_CHECKINS=false turns them off)
  checkins: checkinFlags(flags, true),
  arena: { deadlineMs: secs(flags.deadline, 75_000), ...(publicUrl ? { publicUrl } : {}) },
  log: (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`),
});
const mcp = flags["no-mcp"] === "true" ? null : new McpGateway(api, publicUrl ? { publicUrl } : {});

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
  // the old paths (#106: /watch, /models) answer with a redirect to where they went
  routes: { "/": index, ...Object.fromEntries(SITE_PATHS.map((p) => [p, site])), ...Object.fromEntries(Object.entries(REDIRECTS).map(([p, to]) => [p, () => new Response(null, { status: 301, headers: { location: to } })])) },
  async fetch(req, srv) {
    const ip = clientIp(req, srv.requestIP(req)?.address);
    if (mcp && new URL(req.url).pathname === "/mcp") return mcp.handle(req, ip);
    const res = await api.handle(req, ip);
    if (res) return res;
    const path = new URL(req.url).pathname;
    // a round from an older engine (#88) is training data: its record is not served to the viewer
    if (path.startsWith("/records/") && !(await api.servesRecord(path))) return new Response("Not found", { status: 404 });
    return (await serveRecord(path, outDir)) ?? new Response("Not found", { status: 404 });
  },
});

console.log(`Knockback match server: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}/api  (site: /lobby, viewer: /?live)`);
logLanUrls(hostname, server.port, "/lobby");
console.log(`pace: ${flags.fast === "true" ? "fast (instant rounds)" : "broadcast (rounds take the time viewers need; --fast for instant)"}${api.opts.checkins ? "; mid-round check-ins on" : ""}`);
if (mcp) console.log(`MCP: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}/mcp`);
console.log(`arena: house bots in every seat no agent holds; ${api.arena.deadlineMs / 1000} s turns; a seat is lost after ${api.arena.missLimit} missed rounds`);
console.log(`storage: ${dbPath}`);
const resumed = await api.resume();
if (resumed.round !== null) console.log(`resumed Arena round ${resumed.round}`);
// rounds from before engine stamps (#88): checked once in the background; until then they are not shown
void api.stampOldRounds().catch((e) => console.log(`engine: the old rounds could not be checked: ${e instanceof Error ? e.message : String(e)}`));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    console.log(`${sig}: closing the database`);
    void store.close().finally(() => process.exit(0));
  });
// the drain before a deploy (#167, docs/deploy.md): SIGUSR2 finishes the round on now and holds the next one (at most
// --drain-max s, default 600); SIGHUP ends the drain. `docker compose kill -s SIGUSR2 server`; GET /api/health shows it.
const drainMaxMs = secs(flags["drain-max"], 600_000);
process.on("SIGUSR2", () => api.arena.drain(drainMaxMs));
process.on("SIGHUP", () => api.arena.undrain("SIGHUP"));
// the Arena never stops: house bots fill every seat no agent holds
void api.arena.start();
