/**
 * Run a best-of-3 match with AI fighters and stream it to the viewer live.
 *
 *   bun run ai-match                       # http://localhost:5175/?live
 *   bun run ai-match --host 0.0.0.0        # also on the LAN (prints the URL)
 *   bun run ai-match --lineup claude,codex,grok,claude   (fighter order: Brick, Pike, Squeaks, Goldie)
 *   bun run ai-match --lineup pike=house --souls ./souls --seed 42 --deadline 20
 *   bun run ai-match --headless            # no server: just play and print the log
 *
 * Before each round all four fighters are asked in parallel; the engine plays
 * the round headless at once (it is deterministic), and the decisions are
 * streamed to every connected viewer, which plays the same rounds in real
 * time. The record (seed + all decisions) is saved to records/ and replays
 * exactly in the viewer with ?record=/records/<file>.json.
 *
 * Providers: claude, codex, grok, house (built-in bot); stub/slow/junk/broken for testing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { decideRound, DEFAULT_DEADLINE_MS, loadSouls, parseLineup, seatsFor } from "../src/ai/decide";
import { registerStubs } from "../src/ai/providers";
import { CHARACTERS } from "../src/sim/characters";
import { initPhysics, Match } from "../src/sim";
import index from "../index.html";

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
const lineup = parseLineup(flags.lineup);
const souls = loadSouls(resolve(flags.souls ?? "souls"));
const seats = seatsFor(lineup, souls);
const seed = flags.seed ? Number(flags.seed) >>> 0 : (Math.random() * 1e9) >>> 0;
const deadline = flags.deadline ? Number(flags.deadline) * 1000 : DEFAULT_DEADLINE_MS;
const outDir = resolve(flags.out ?? "records");
const headless = flags.headless === "true";
const hostname = flags.host ?? "localhost";
const port = Number(flags.port ?? 5175);
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------ live stream (SSE)
const history: string[] = [];
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
function broadcast(msg: unknown) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  history.push(line);
  for (const c of clients) {
    try {
      c.enqueue(enc.encode(line));
    } catch {
      clients.delete(c);
    }
  }
}

if (!headless) {
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    development: true,
    routes: { "/": index },
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/live") {
        let ctl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctl = c;
            for (const h of history) c.enqueue(enc.encode(h)); // late joiners catch up
            clients.add(c);
          },
          cancel() {
            clients.delete(ctl);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      if (url.pathname.startsWith("/records/")) {
        const f = Bun.file(join(outDir, url.pathname.slice("/records/".length).replace(/[^\w.-]/g, "")));
        return new Response(f, { headers: { "content-type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`AI match viewer: http://localhost:${server.port}/?live`);
  if (hostname === "0.0.0.0" || hostname === "::")
    for (const list of Object.values(networkInterfaces())) for (const ni of list ?? []) if (ni.family === "IPv4" && !ni.internal) console.log(`  LAN: http://${ni.address}:${server.port}/?live`);
  const wait = Number(flags.wait ?? 0);
  if (wait > 0) {
    console.log(`waiting ${wait} s for a viewer to connect...`);
    await Bun.sleep(wait * 1000);
  }
}

// ------------------------------------------------------------ the match
await initPhysics();
const names = CHARACTERS.map((c) => c.name);
const labels = seats.map((s) => s.provider?.label ?? "house");
console.log(`\nKNOCKBACK AI MATCH  seed ${seed}  deadline ${deadline / 1000} s`);
names.forEach((n, i) => console.log(`  ${n.padEnd(8)} ${labels[i]}`));
const t0 = performance.now();
const match = new Match(seed);
broadcast({ type: "match", seed, labels, names, theme: match.level.theme });
console.log(`  level: ${match.level.theme}, ${match.level.width} m, ${match.level.platforms} platforms\n`);
const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};
const promptLog: { round: number; prompts: string[]; raw: (string | null)[] }[] = [];
const stratText = (s: { stance: string; loadout: string[]; target: string; grudge?: number; retaliate?: string }) =>
  `${s.stance} ${s.loadout.join("+")} -> ${s.target === "grudge" && s.grudge !== undefined ? names[s.grudge] : s.target}, retaliate ${s.retaliate ?? "turn"}`;

while (!match.over) {
  const round = match.round + 1;
  const askStart = performance.now();
  const ask = await decideRound(match, seats, deadline);
  const askMs = Math.round(performance.now() - askStart);
  promptLog.push({ round, prompts: ask.prompts, raw: ask.raw });
  broadcast({ type: "decisions", round, decisions: ask.decisions, meta: ask.meta });
  say(`ROUND ${round} plans (${(askMs / 1000).toFixed(1)} s to decide)`);
  ask.decisions.forEach((d, i) => {
    const m = ask.meta[i]!;
    const tag = m.outcome === "ok" ? `${m.provider} ${(m.ms / 1000).toFixed(1)} s` : `${m.provider} ${(m.ms / 1000).toFixed(1)} s ${m.outcome.toUpperCase()}${m.detail ? ` (${m.detail})` : ""}`;
    say(`  ${names[i]!.padEnd(8)} [${tag}] "${d.line}"`);
    say(`  ${" ".repeat(8)}  plan: ${stratText(d.strategy)}`);
  });
  match.prepareRound(ask.decisions, ask.meta);
  while (!match.step()) {
    /* the engine plays the round */
  }
  const f = match.finishRound();
  say(`  -> ${names[f.winner]} wins round ${round} after ${f.seconds.toFixed(0)} s (wins ${match.wins.join("-")})`);
  for (const k of f.stats.kos) say(`     ${names[k.victim]} ${k.cause === "ringout" ? "rung out" : "knocked out"}${k.by >= 0 && k.by !== k.victim ? ` by ${names[k.by]}` : ""} (${k.weapon})`);
  f.stats.summary.forEach((s, i) => say(`     ${names[i]}: ${s}`));
  const reflexes = match.fight!.controllers.flatMap((c, i) => c.reflexLog.map((r) => `${names[i]} turned on ${names[r.attacker]} (${r.mode}) at ${(r.tick / 60).toFixed(0)} s`));
  if (reflexes.length) say(`     reflexes: ${reflexes.join("; ")}`);
  say("");
}
const totalMs = performance.now() - t0;
say(`MATCH: ${names[match.winner]} wins ${match.wins.join("-")} (${match.decidedBy()}), ${match.round} rounds, ${(totalMs / 1000).toFixed(1)} s total`);

// response times + fallbacks
say(`\nResponse times and fallbacks:`);
names.forEach((n, i) => {
  const ms = match.record.rounds.map((r) => r.meta?.[i]).filter((m) => m && m.outcome !== "house");
  const okMs = ms.filter((m) => m!.outcome === "ok").map((m) => m!.ms);
  const fb = ms.filter((m) => m!.outcome.startsWith("fallback"));
  const avg = okMs.length ? okMs.reduce((a, b) => a + b, 0) / okMs.length : 0;
  say(
    `  ${n.padEnd(8)} ${labels[i]!.padEnd(18)} ${okMs.map((x) => (x / 1000).toFixed(1) + " s").join(", ") || "-"}${okMs.length ? `  (avg ${(avg / 1000).toFixed(1)} s)` : ""}  fallbacks: ${fb.length}${fb.length ? " " + fb.map((m) => `${m!.outcome}${m!.detail ? ` [${m!.detail}]` : ""}`).join("; ") : ""}`,
  );
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const file = `ai-${seed}-${stamp}.json`;
writeFileSync(join(outDir, file), JSON.stringify({ ...match.record, labels, lineup, totalMs: Math.round(totalMs) }, null, 2));
writeFileSync(join(outDir, file.replace(/\.json$/, ".log.txt")), log.join("\n") + "\n");
writeFileSync(join(outDir, file.replace(/\.json$/, ".prompts.json")), JSON.stringify(promptLog, null, 2));
broadcast({ type: "done", record: `/records/${file}` });
say(`\nrecord: ${join(outDir, file)}  (replay: ${headless ? "bun run dev, then " : ""}?record=/records/${file})`);
if (headless) process.exit(0);
console.log("viewer still serving; Ctrl+C to stop");
