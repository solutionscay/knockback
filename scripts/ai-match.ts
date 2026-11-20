/**
 * Run a best-of-3 match with AI fighters and stream it to the viewer live.
 *
 *   bun run ai-match                       # http://localhost:5175/?live
 *   bun run ai-match --host 0.0.0.0        # also on the LAN (prints the URL)
 *   bun run ai-match --lineup claude,codex,grok,claude   (by seat; souls: brawler, sniper, rat, vulture)
 *   bun run ai-match --lineup sniper=house --souls ./souls --seed 42 --deadline 20
 *   bun run ai-match --headless            # no server: just play and print the log
 *   bun run ai-match --checkins on         # mid-round check-ins (#9): each AI may change its plan every ~10 s of fight
 *        --checkin-deadline 8 --checkin-every 10 --checkin-max 6   (seconds; max = check-ins per round)
 *
 * Before each round all four fighters are asked in parallel; the engine plays
 * the round headless at once (it is deterministic), and the decisions are
 * streamed to every connected viewer, which plays the same rounds in real
 * time. The record (seed + all decisions) is saved to records/ and replays
 * exactly in the viewer with ?record=/records/<file>.json.
 *
 * Check-ins run in fast mode here: the sim waits at each check-in tick for
 * the answers (up to the deadline) and an answer applies at the check-in
 * tick plus its measured latency in fight time, saved in the record as a
 * plan update; the replay needs no AI.
 *
 * Providers: claude, codex, grok, house (built-in bot); stub/slow/junk/broken for testing.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_DEADLINE_MS, loadSouls, parseLineup, seatsFor } from "../src/ai/decide";
import { MatchRunner } from "../src/ai/runner";
import { selectRuleset, type MatchRuleset } from "../src/server/match-rulesets";
import { SqliteStore } from "../src/server/store";
import { LiveStream } from "../src/server/live";
import { PROVIDERS, registerStubs } from "../src/ai/providers";
import { initPhysics, resolveRuleset } from "../src/sim";
import { checkinFlags } from "../src/ai/checkin";
import index from "../index.html";
import { logLanUrls, serveRecord } from "./viewer-server";

import { parseFlags } from "./flags";

const flags = parseFlags(process.argv.slice(2));
registerStubs();
const loaded = (() => {
  try {
    return loadSouls(flags.souls ? (flags.souls.includes(",") ? flags.souls : resolve(flags.souls)) : resolve("souls"));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();
for (const l of loaded) for (const w of l.warnings) console.warn(`soul ${l.file}: ${w}`);
const souls = loaded.map((l) => l.soul);
const lineup = parseLineup(flags.lineup, souls.map((s) => s.id));
const seats = seatsFor(lineup, souls);
const seed = flags.seed ? Number(flags.seed) >>> 0 : (Math.random() * 1e9) >>> 0;
// --deadline overrides every provider; without it each provider uses its own (src/ai/providers.ts)
const deadline = flags.deadline ? Number(flags.deadline) * 1000 : undefined;
const deadlineText = deadline !== undefined ? `${deadline / 1000} s` : `per provider (${[...new Set(lineup.filter((p) => p !== "house"))].map((p) => `${p} ${(PROVIDERS[p]?.deadlineMs ?? DEFAULT_DEADLINE_MS) / 1000} s${PROVIDERS[p]?.hedgeAfterMs ? `, hedged at ${PROVIDERS[p]!.hedgeAfterMs! / 1000} s` : ""}`).join("; ")})`;
const outDir = resolve(flags.out ?? "records");
const selection: MatchRuleset | undefined = await (async () => {
  if (!flags.ruleset) return undefined;
  try {
    const file = Bun.file(resolve(flags.ruleset));
    if (await file.exists()) return { ruleset: resolveRuleset(await file.json()) };
    const db = resolve(flags["ruleset-db"] ?? "records/match-server.db");
    if (flags["ruleset-db"] && !await Bun.file(db).exists()) throw new Error(`ruleset database does not exist: ${db}`);
    const store = new SqliteStore(await Bun.file(db).exists() ? db : ":memory:");
    try { return await selectRuleset(store, flags.ruleset); }
    finally { await store.close(); }
  } catch (e) {
    console.error(`--ruleset: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();
const checkins = checkinFlags(flags);
const headless = flags.headless === "true";
const hostname = flags.host ?? "localhost";
const port = Number(flags.port ?? 5175);
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------ live stream (SSE)
const live = new LiveStream();

if (!headless) {
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    development: true,
    routes: { "/": index },
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/live") return live.response();
      return (await serveRecord(url.pathname, outDir)) ?? new Response("Not found", { status: 404 });
    },
  });
  console.log(`AI match viewer: http://localhost:${server.port}/?live`);
  logLanUrls(hostname, server.port, "/?live");
  const wait = Number(flags.wait ?? 0);
  if (wait > 0) {
    console.log(`waiting ${wait} s for a viewer to connect...`);
    await Bun.sleep(wait * 1000);
  }
}

// ------------------------------------------------------------ the match
await initPhysics();
const runner = new MatchRunner({ seed, seats, ...selection, deadlineMs: deadline, lineup, checkins, onEvent: (e) => live.broadcast(e), onLog: (s) => console.log(s) });
const { labels, match } = runner;
console.log(`\nKNOCKBACK AI MATCH  seed ${seed}  deadline ${deadlineText}${runner.checkin ? `  check-ins every ${runner.checkin.everyS} s (each waits for its answer; hung calls stop at ${runner.checkin.capMs / 1000} s)` : ""}`);
match.identities.forEach((id, i) => console.log(`  ${id.name.padEnd(12)} ${labels[i]!.padEnd(18)} soul ${loaded[i]!.file}  (${id.shape} head, ${id.eyes} eyes, ${id.mark}, #${id.color.toString(16).padStart(6, "0")})`));
runner.start();
console.log(`  level: ${match.level.theme}, ${match.level.width} m, ${match.level.platforms} platforms\n`);
await runner.run();
const file = runner.save(outDir);
runner.say(`\nrecord: ${join(outDir, file)}  (replay: ${headless ? "bun run dev, then " : ""}?record=/records/${file})`);
if (headless) process.exit(0);
console.log("viewer still serving; Ctrl+C to stop");
