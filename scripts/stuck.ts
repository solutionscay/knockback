/**
 * Stuck and aimless counts (#88), with the detector in src/stats/stuck.ts.
 *
 *   bun scripts/stuck.ts sims [count=100] [first=1] --out runs.json     Arena-style rounds: house bots in every seat,
 *                                                                        the souls rotated, one round per match
 *   bun scripts/stuck.ts records <file|dir>... --out runs.json          replay match records on the current sim (rounds
 *                                                                        that no longer reach their recorded hash are
 *                                                                        counted apart and left out)
 *   bun scripts/stuck.ts records <file|dir>... --replay-plans --out ...  the same, but play every round's recorded plans
 *                                                                        on the current sim even where the hash moved
 *   bun scripts/stuck.ts report runs.json [after.json] [--md]          rates by plan, build, map, weapon and seat kind
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exampleSouls, initPhysics, Match, type MatchRecord } from "../src/sim";
import { CLASSIC, type Ruleset } from "../src/sim/ruleset";
import { StuckDetector, type StuckEpisode } from "../src/stats/stuck";

export interface FighterRound {
  src: string;
  seed: number;
  round: number;
  fighter: number;
  seat: string;
  plan: string;
  retaliate: string;
  build: string;
  theme: string;
  aliveTicks: number;
  stareTicks: number;
  exposure: Record<string, number>;
  episodes: StuckEpisode[];
}
interface RunFile {
  kind: "sims" | "records";
  rounds: number;
  diverged: number;
  skipped: number;
  fighters: FighterRound[];
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Play the prepared round of `m` with a detector on it; push its fighter rows. */
function watchRound(m: Match, src: string, seats: string[], out: FighterRound[]) {
  const fight = m.fight!;
  const det = new StuckDetector(fight, seats);
  const prev = m.onEvent;
  m.onEvent = (e) => {
    det.event(e);
    prev?.(e);
  };
  while (!m.step()) det.tick();
  det.finish();
  m.onEvent = prev;
  for (let i = 0; i < 4; i++) {
    const s = fight.controllers[i]!.strategy;
    const b = s.build;
    out.push({
      src,
      seed: m.seed,
      round: m.round,
      fighter: i,
      seat: seats[i]!,
      plan: s.stance,
      retaliate: s.retaliate ?? "turn",
      build: b ? `${b.health},${b.weight},${b.power}` : "0,0,0",
      theme: fight.sim.level.theme,
      aliveTicks: det.aliveTicks[i]!,
      stareTicks: det.stareTicks[i]!,
      exposure: det.exposure[i]!,
      episodes: det.episodes.filter((e) => e.fighter === i),
    });
  }
}

function arenaRuleset(): Ruleset {
  return { ...CLASSIC, round: { ...CLASSIC.round, maxRounds: 1, winsToTake: 1 } };
}

function runSims(count: number, first: number): RunFile {
  const souls = exampleSouls();
  const fighters: FighterRound[] = [];
  let rounds = 0;
  for (let k = 0; k < count; k++) {
    const seed = first + k;
    const order = [0, 1, 2, 3].map((i) => (i + seed) % 4);
    const m = new Match(seed, { souls: order.map((i) => souls[i]!), ruleset: arenaRuleset() });
    while (!m.over) {
      m.prepareRound();
      watchRound(m, `sim:${seed}`, ["house", "house", "house", "house"], fighters);
      m.finishRound();
      rounds++;
    }
  }
  return { kind: "sims", rounds, diverged: 0, skipped: 0, fighters };
}

function recordFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) out.push(...recordFiles(readdirSync(p).map((f) => join(p, f))));
    else if (/\.json$/.test(p) && !/\.(prompts|checkins)\.json$/.test(p)) out.push(p);
  }
  return out.sort();
}

/** `replayPlans`: play every round's recorded plans on the current sim even where it no longer reaches the recorded hash
 * (the same seeds and plans, a changed controller: the after half of a before/after over recorded rounds). */
function runRecords(paths: string[], replayPlans = false): RunFile {
  const fighters: FighterRound[] = [];
  let rounds = 0, diverged = 0, skipped = 0;
  for (const file of recordFiles(paths)) {
    let rec: MatchRecord;
    try {
      rec = JSON.parse(readFileSync(file, "utf8")) as MatchRecord;
      if (!rec.rounds?.length) throw new Error("no rounds");
    } catch {
      skipped++;
      continue;
    }
    let m: Match;
    try {
      m = new Match(rec.seed, { recorded: rec });
    } catch {
      skipped++;
      continue;
    }
    const rows: FighterRound[] = [];
    try {
      while (!m.over && m.round < rec.rounds.length) {
        const meta = rec.rounds[m.round]?.meta ?? [];
        const seats = [0, 1, 2, 3].map((i) => (meta[i]?.outcome === "ok" && meta[i]?.provider !== "house" ? "agent" : "house"));
        m.prepareRound();
        const before = rows.length;
        watchRound(m, file, seats, rows);
        const want = rec.rounds[m.round - 1]?.fight.finalHash;
        m.finishRound();
        if (want && want !== m.fight!.record.finalHash && !replayPlans) {
          rows.length = before;
          diverged++;
          break; // later rounds carry this one's morale: they no longer match either
        }
        rounds++;
      }
    } catch {
      skipped++;
      continue;
    }
    fighters.push(...rows);
  }
  return { kind: "records", rounds, diverged, skipped, fighters };
}

// ---------------------------------------------------------------------------------------------------- report

type Agg = { fr: number; ticks: number; eps: number; hop: number; pace: number; stuckTicks: number; frWith: number; unreach: number };
const agg = (): Agg => ({ fr: 0, ticks: 0, eps: 0, hop: 0, pace: 0, stuckTicks: 0, frWith: 0, unreach: 0 });

function addEpisodes(a: Agg, eps: StuckEpisode[]) {
  for (const e of eps) {
    a.eps++;
    a[e.kind]++;
    a.stuckTicks += e.end - e.start;
    if (!e.reachable) a.unreach++;
  }
}

/** By a fighter-round field: exposure = the fighter-round's alive time. */
function byRound(rows: FighterRound[], key: (r: FighterRound) => string) {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    const a = m.get(key(r)) ?? agg();
    m.set(key(r), a);
    a.fr++;
    a.ticks += r.aliveTicks;
    if (r.episodes.length) a.frWith++;
    addEpisodes(a, r.episodes);
  }
  return m;
}

/** By a per-tick field (held weapon, stance played): exposure = alive ticks with it; episodes by their start. */
function byTick(rows: FighterRound[], prefix: string, field: (e: StuckEpisode) => string) {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.exposure)) {
      if (!k.startsWith(prefix)) continue;
      const a = m.get(k.slice(prefix.length)) ?? agg();
      m.set(k.slice(prefix.length), a);
      a.ticks += v;
    }
    for (const e of r.episodes) {
      const a = m.get(field(e)) ?? agg();
      m.set(field(e), a);
      addEpisodes(a, [e]);
    }
  }
  return m;
}

const perMin = (a: Agg) => (a.ticks ? (a.eps / (a.ticks / 3600)) : 0);
const share = (a: Agg) => (a.ticks ? (100 * a.stuckTicks) / a.ticks : 0);

function table(title: string, before: Map<string, Agg>, after: Map<string, Agg> | null, withFr: boolean): string[] {
  const keys = [...new Set([...before.keys(), ...(after?.keys() ?? [])])].sort((x, y) => (before.get(y)?.ticks ?? 0) - (before.get(x)?.ticks ?? 0));
  const head = after
    ? `| ${title} | alive min | episodes/min before | after | stuck time before | after | hop/pace before | after |`
    : `| ${title} | alive min | episodes | episodes/min | stuck time | hop / pace | target unreachable |${withFr ? " fighter-rounds with one |" : ""}`;
  const sep = head.replace(/[^|]+/g, "---");
  const lines = [head, sep];
  for (const k of keys) {
    const b = before.get(k) ?? agg();
    if (b.ticks < 3600 * 2 && !after) continue; // under 2 alive minutes: noise
    if (after) {
      const a = after.get(k) ?? agg();
      lines.push(`| ${k} | ${(b.ticks / 3600).toFixed(0)} | ${perMin(b).toFixed(3)} | ${perMin(a).toFixed(3)} | ${share(b).toFixed(2)}% | ${share(a).toFixed(2)}% | ${b.hop}/${b.pace} | ${a.hop}/${a.pace} |`);
    } else {
      lines.push(`| ${k} | ${(b.ticks / 3600).toFixed(0)} | ${b.eps} | ${perMin(b).toFixed(3)} | ${share(b).toFixed(2)}% | ${b.hop} / ${b.pace} | ${b.eps ? ((100 * b.unreach) / b.eps).toFixed(0) : 0}% |${withFr ? ` ${b.fr ? ((100 * b.frWith) / b.fr).toFixed(1) : 0}% |` : ""}`);
    }
  }
  return lines;
}

function report(files: string[]) {
  const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as RunFile);
  const [b, a] = runs;
  const out: string[] = [];
  for (const [i, r] of runs.entries()) {
    const alive = r.fighters.reduce((s, f) => s + f.aliveTicks, 0), stare = r.fighters.reduce((s, f) => s + (f.stareTicks ?? 0), 0);
    let route = 0, noRoute = 0;
    for (const f of r.fighters) for (const [k, v] of Object.entries(f.exposure)) if (k.startsWith("stare:route")) route += v; else if (k.startsWith("stare:noroute")) noRoute += v;
    out.push(`${files[i]}: ${r.kind}, ${r.rounds} rounds counted, ${r.diverged} diverged, ${r.skipped} skipped, ${r.fighters.length} fighter-rounds; staring (#69) ${((100 * stare) / alive).toFixed(2)}% of alive time (with a route to the target ${((100 * route) / alive).toFixed(2)}%, with none ${((100 * noRoute) / alive).toFixed(2)}%)`);
  }
  const views: [string, (rows: FighterRound[]) => Map<string, Agg>, boolean][] = [
    ["all", (rows) => byRound(rows, () => "all"), true],
    ["seat kind", (rows) => byRound(rows, (r) => r.seat), true],
    ["plan stance", (rows) => byRound(rows, (r) => r.plan), true],
    ["stance played", (rows) => byTick(rows, "s:", (e) => e.stance), false],
    ["retaliate", (rows) => byRound(rows, (r) => r.retaliate), true],
    ["build (h,w,p)", (rows) => byRound(rows, (r) => r.build), true],
    ["map", (rows) => byRound(rows, (r) => r.theme), true],
    ["held weapon", (rows) => byTick(rows, "w:", (e) => e.weapon), false],
  ];
  for (const [title, view, fr] of views) {
    out.push("", ...table(title, view(b!.fighters), a ? view(a.fighters) : null, fr));
  }
  if (!a) {
    const eps = b!.fighters.flatMap((r) => r.episodes.map((e) => ({ ...e, src: r.src, round: r.round })));
    eps.sort((x, y) => y.end - y.start - (x.end - x.start));
    out.push("", "longest episodes:", ...eps.slice(0, 15).map((e) => `  ${e.src} r${e.round} f${e.fighter} ${e.kind} ${((e.end - e.start) / 60).toFixed(1)}s from ${(e.start / 60).toFixed(1)}s at (${e.x}, ${e.y}) jumps ${e.jumps} path ${e.path} fires ${e.fires} ${e.stance}/${e.plan} ${e.weapon} target ${e.target} reach ${e.reachable} cost ${e.routeCost} grounded ${e.grounded}`));
  }
  console.log(out.join("\n"));
}

const mode = process.argv[2];
if (mode === "report") report(process.argv.slice(3).filter((a) => !a.startsWith("--")));
else {
  await initPhysics();
  const outFile = arg("--out") ?? "stuck-runs.json";
  const pos = process.argv.slice(3).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--out");
  const t0 = performance.now();
  const run = mode === "sims" ? runSims(Number(pos[0] ?? 100), Number(pos[1] ?? 1)) : mode === "records" ? runRecords(pos, process.argv.includes("--replay-plans")) : null;
  if (!run) throw new Error("usage: bun scripts/stuck.ts sims|records|report ...");
  writeFileSync(outFile, JSON.stringify(run));
  console.error(`${run.rounds} rounds, ${run.diverged} diverged, ${run.skipped} skipped, ${((performance.now() - t0) / 1000).toFixed(0)} s -> ${outFile}`);
}
