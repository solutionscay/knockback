/**
 * AI match evaluation harness (#2): run N AI matches with no viewer and get
 * one report (report.json + report.md) with variety, plan change, rules,
 * follows-the-stats, fact checks, reliability and results.
 *
 *   bun run ai-eval --matches 3 --lineup stub,stub,house,house
 *   bun run ai-eval --seeds 100-105 --lineup claude,codex,grok,claude --yes
 *   bun run ai-eval --matches 3 --compare evals/baseline/report.json
 *
 * Flags: --matches N, --seeds a-b (or a,b,c), --lineup, --souls, --deadline s,
 * --checkins on (mid-round check-ins, #9; --checkin-deadline/-every/-max),
 * --concurrency 1..4, --out <dir>, --tag <name>, --compare <report.json>, --yes.
 * --rescore <run dir>: recompute the report from a run's saved records (exact replay, no AI calls).
 * Souls rotate across seats every match (match k: seat i plays soul (i+k) % 4),
 * so every provider plays every soul and seat.
 */
import { CHECKIN, checkinFlags } from "../src/ai/checkin";
import { formatSeconds } from "../src/format";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_DEADLINE_MS, loadSouls, parseLineup, seatsFor } from "../src/ai/decide";
import { compareReports, computeReport, reportMarkdown, type EvalReport } from "../src/ai/eval";
import { buildPrompt } from "../src/ai/prompt";
import { PROVIDERS, registerStubs } from "../src/ai/providers";
import { playAiMatch, type PlayedMatch } from "../src/ai/run";
import { initPhysics, Match } from "../src/sim";

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
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

/** Above this many AI calls a run needs --yes. */
export const CONFIRM_CALLS = 40;

registerStubs(20);
const loaded = (() => {
  try {
    return loadSouls(flags.souls ? (flags.souls.includes(",") ? flags.souls : resolve(flags.souls)) : resolve("souls"));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();
const souls = loaded.map((l) => l.soul);
let lineup: string[] = [];
try {
  lineup = parseLineup(flags.lineup, souls.map((s) => s.id));
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
const parseSeeds = (s: string): number[] => {
  const range = /^(\d+)-(\d+)$/.exec(s);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    if (b < a || b - a > 999) fail(`bad --seeds range ${s}`);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  const list = s.split(",").map((x) => Number(x.trim()));
  if (list.some((x) => !Number.isInteger(x) || x < 0)) fail(`bad --seeds ${s}`);
  return list;
};
const seeds = flags.seeds ? parseSeeds(flags.seeds) : Array.from({ length: Number(flags.matches ?? 3) }, (_, i) => 1001 + i);
if (flags.matches && flags.seeds && Number(flags.matches) !== seeds.length) fail(`--matches ${flags.matches} and --seeds ${flags.seeds} disagree`);
if (!seeds.length) fail("no matches to run");
// --deadline overrides every provider; without it each provider uses its own (src/ai/providers.ts)
const deadline = flags.deadline ? Number(flags.deadline) * 1000 : undefined;
const deadlineText = deadline !== undefined ? `${deadline / 1000} s` : `per provider (${[...new Set(lineup.filter((p) => p !== "house"))].map((p) => `${p} ${(PROVIDERS[p]?.deadlineMs ?? DEFAULT_DEADLINE_MS) / 1000} s${PROVIDERS[p]?.hedgeAfterMs ? `, hedged at ${PROVIDERS[p]!.hedgeAfterMs! / 1000} s` : ""}`).join("; ")})`;
const concurrency = Math.max(1, Math.min(4, Number(flags.concurrency ?? 1)));
// mid-round check-ins (#9): --checkins on, plus --checkin-deadline/--checkin-every/--checkin-max
const checkins = (() => {
  try {
    return checkinFlags(flags);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();
const tag = (flags.tag ?? "").replace(/[^\w.-]/g, "");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(flags.out ?? join("evals", `${stamp}${tag ? `-${tag}` : ""}`));
const oldReport: EvalReport | null = flags.compare ? (existsSync(flags.compare) ? JSON.parse(readFileSync(flags.compare, "utf8")) : fail(`no report at ${flags.compare}`)) : null;

// ------------------------------------------------------------ rescore (no AI calls)
if (flags.rescore) {
  const { readdirSync } = await import("node:fs");
  const { rescoreRecord } = await import("../src/ai/run");
  await initPhysics();
  const dir = resolve(flags.rescore);
  const files = readdirSync(dir).filter((f) => /^match-\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (!files.length) fail(`no match-*.json records in ${dir}`);
  const evals = files.map((f) => {
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return rescoreRecord(rec, rec.lineup);
  });
  const report = computeReport(evals);
  const compare = oldReport ? compareReports(oldReport, report) : undefined;
  const out = resolve(flags.out ?? dir);
  mkdirSync(out, { recursive: true });
  const prev = existsSync(join(dir, "report.json")) ? JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).run : undefined;
  writeFileSync(join(out, "report.json"), JSON.stringify({ ...report, run: { ...prev, rescored: true } }, null, 2));
  writeFileSync(join(out, "report.md"), reportMarkdown(report, { title: `AI eval${tag || prev?.tag ? `: ${tag || prev.tag}` : ""} (rescored)`, compare, meta: [`Rescored from ${files.length} saved records (exact replay, no AI calls).`] }));
  console.log(`rescored ${files.length} records: ${join(out, "report.md")}`);
  process.exit(0);
}

// ------------------------------------------------------------ cost estimate
await initPhysics();
const aiSeats = lineup.filter((p) => p !== "house").length;
const realSeats = lineup.filter((p) => p !== "house" && !["stub", "slow", "junk", "broken"].includes(p)).length;
const maxCalls = seeds.length * 3 * aiSeats;
const sample = new Match(seeds[0]!, { souls });
const firstChars = Math.round(souls.reduce((a, s, i) => a + buildPrompt(s, sample.contextFor(i), { level: sample.level, lastLines: null, lastHealth: null }).length, 0) / 4);
// later rounds carry the last round's stats and lines: about 1.45x the first prompt (measured on real matches)
const estChars = seeds.length * aiSeats * (firstChars + 1.45 * firstChars * 1.8);
console.log(`KNOCKBACK AI EVAL  ${seeds.length} matches (seeds ${seeds[0]}${seeds.length > 1 ? `..${seeds[seeds.length - 1]}` : ""}), lineup ${lineup.join(",")}, deadline ${deadlineText}, concurrency ${concurrency}${checkins ? ", check-ins on" : ""}`);
if (checkins) console.log(`check-ins: up to ${checkins.maxPerRound ?? CHECKIN.maxPerRound} per AI seat per round -> up to ${seeds.length * 3 * aiSeats * (checkins.maxPerRound ?? CHECKIN.maxPerRound)} more calls (short prompts, ~1,100 characters each; most rounds end before the last check-in)`);
console.log(`cost estimate: ${aiSeats} AI seats -> up to ${maxCalls} calls (2 or 3 rounds a match, about ${Math.round(seeds.length * 2.6 * aiSeats)} expected), ~${Math.round(estChars / 1000)}k prompt characters (~${Math.round(estChars / 4000)}k tokens)${realSeats ? ` to real providers (${realSeats} seats)` : " (stub/house only: free)"}`);
if (realSeats && maxCalls > CONFIRM_CALLS && flags.yes !== "true") fail(`that is more than ${CONFIRM_CALLS} AI calls: add --yes to run it`);
console.log(`output: ${outDir}\n`);
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------ run
const t0 = performance.now();
const results: (PlayedMatch | null)[] = new Array(seeds.length).fill(null);
let next = 0;
const worker = async () => {
  while (next < seeds.length) {
    const k = next++;
    const seed = seeds[k]!;
    const rotated = [0, 1, 2, 3].map((i) => souls[(i + k) % 4]!);
    const played = await playAiMatch(seed, seatsFor(lineup, rotated), rotated, deadline, checkins);
    results[k] = played;
    const base = join(outDir, `match-${seed}`);
    writeFileSync(`${base}.json`, JSON.stringify({ ...played.match.record, labels: lineup, lineup, totalMs: Math.round(played.ms) }, null, 2));
    writeFileSync(`${base}.prompts.json`, JSON.stringify(played.prompts, null, 2));
    writeFileSync(`${base}.log.txt`, played.log.join("\n") + "\n");
    if (played.checkinPrompts?.length) writeFileSync(`${base}.checkins.json`, JSON.stringify(played.checkinPrompts, null, 2));
    console.log(played.log.join("\n"));
    console.log(`  (${formatSeconds(played.ms)})\n`);
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));
const totalS = (performance.now() - t0) / 1000;

// ------------------------------------------------------------ report
const played = results.filter((r): r is PlayedMatch => !!r);
const report = computeReport(played.map((p) => p.eval));
const compare = oldReport ? compareReports(oldReport, report) : undefined;
writeFileSync(join(outDir, "report.json"), JSON.stringify({ ...report, run: { tag, lineup, deadline: deadlineText, concurrency, seconds: Math.round(totalS) } }, null, 2));
writeFileSync(
  join(outDir, "report.md"),
  reportMarkdown(report, { title: `AI eval${tag ? `: ${tag}` : ""}`, compare, meta: [`Lineup flag: ${lineup.join(",")}; deadline ${deadlineText}${checkins ? "; check-ins on" : ""}; ran in ${totalS.toFixed(0)} s.`] }),
);
writeFileSync(join(outDir, "log.txt"), played.map((p) => p.log.join("\n")).join("\n\n") + "\n");
console.log(`done in ${totalS.toFixed(1)} s: ${join(outDir, "report.md")}`);
if (compare) {
  console.log(`\nchange per metric (old -> new):`);
  for (const d of compare) console.log(`  ${d.metric.padEnd(52)} ${String(d.old).padStart(9)} -> ${String(d.new).padStart(9)}  ${d.delta === "n/a" ? "n/a" : d.delta === 0 ? "=" : d.delta > 0 ? `+${d.delta}` : d.delta}`);
}
