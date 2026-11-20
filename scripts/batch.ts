/**
 * Run N best-of-3 bot matches headless and print stats.
 *   bun scripts/batch.ts [count=200] [startSeed=1] [--json out.json] [--no-morale-effect]
 * Also runs the same seeds with morale's behavior nudges switched off, to show
 * how much morale moves win rates.
 */
import { exampleSouls, initPhysics, Match, MORALE_STATES, TICK_RATE, VoiceSession, type MoraleState } from "../src/sim";
import { Tally } from "../src/flow/score";

await initPhysics();
const SOULS = exampleSouls();
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const pos = args.filter((a, i) => !a.startsWith("--") && (jsonIdx < 0 || i !== jsonIdx + 1));
const N = Number(pos[0] ?? 200);
const start = Number(pos[1] ?? 1);

interface Row {
  seed: number;
  theme: string;
  rounds: number;
  fightSeconds: number;
  roundSeconds: number[];
  roundWinners: number[];
  winner: number;
  wins: number[];
  decidedBy: string;
  kos: number[];
  ringouts: number;
  /** morale state at the start of each round, per fighter */
  moraleStart: MoraleState[][];
  /** morale state after the match, per fighter */
  moraleEnd: MoraleState[];
  humiliations: string[];
  lines: number;
  repeatedLines: number;
}

function run(noMoraleEffect: boolean): { rows: Row[]; ms: number; tally: Tally } {
  const rows: Row[] = [];
  const tally = new Tally();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const seed = start + i;
    const session = new VoiceSession();
    const m = new Match(seed, { noMoraleEffect, session });
    let ringouts = 0;
    const humiliations: string[] = [];
    const seen = new Set<string>();
    let lines = 0;
    let repeated = 0;
    m.onEvent = (e) => {
      if (e.type === "ko" && e.cause === "ringout") ringouts++;
    };
    while (!m.over) {
      const d = m.prepareRound();
      for (const x of d) {
        lines++;
        if (seen.has(x.line)) repeated++;
        seen.add(x.line);
      }
      while (!m.step()) {
        /* step */
      }
      const f = m.finishRound();
      tally.add(m.results[m.results.length - 1]!);
      for (const fi of f.fighters) for (const h of fi.humiliations) humiliations.push(h.kind);
    }
    rows.push({
      seed,
      theme: m.level.theme,
      rounds: m.round,
      fightSeconds: m.results.reduce((a, r) => a + r.ticks / TICK_RATE, 0),
      roundSeconds: m.results.map((r) => r.ticks / TICK_RATE),
      roundWinners: m.results.map((r) => r.winner),
      winner: m.winner,
      wins: m.wins.slice(),
      decidedBy: m.decidedBy(),
      kos: m.kos.slice(),
      ringouts,
      moraleStart: m.moraleAtStart.map((ms) => ms.map((x) => x.state)),
      moraleEnd: m.morale.map((x) => x.state),
      humiliations,
      lines,
      repeatedLines: repeated,
    });
  }
  return { rows, ms: performance.now() - t0, tally };
}

const on = run(false);
const off = args.includes("--no-ab") ? on : run(true);
const rows = on.rows;
const avg = (f: (r: Row) => number, rs = rows) => rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length);
const pct = (v: number) => `${v.toFixed(0)}%`;
const count = (xs: (string | number)[]) => {
  const h = new Map<string | number, number>();
  for (const x of xs) h.set(x, (h.get(x) ?? 0) + 1);
  return [...h.entries()].sort((a, b) => b[1] - a[1]);
};
const out: string[] = [];
out.push(`matches: ${N} best-of-3 (seeds ${start}..${start + N - 1}), ${(on.ms / 1000).toFixed(1)} s wall, ${(on.ms / N).toFixed(0)} ms/match`);
out.push(`rounds per match: ${avg((r) => r.rounds).toFixed(2)} avg; ${count(rows.map((r) => r.rounds)).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k} rounds ${v} (${pct((100 * v) / N)})`).join(", ")}`);
out.push(`decided by: ${count(rows.map((r) => r.decidedBy)).map(([k, v]) => `${k} ${v} (${pct((100 * v) / N)})`).join(", ")}  (decider = nobody on 2 wins, round 3 winner takes it)`);
const roundsAll = rows.flatMap((r) => r.roundSeconds);
out.push(`match length: ${avg((r) => r.fightSeconds).toFixed(0)} s of fighting avg (rounds ${(roundsAll.reduce((a, b) => a + b, 0) / roundsAll.length).toFixed(1)} s avg each); viewer adds ~${(2.4 + 4 * 3 + 3 + 4).toFixed(0)} s for the opening and ~15 s per break`);
const roundWins = rows.flatMap((r) => r.roundWinners);
out.push(`round wins: ${SOULS.map((c, i) => `${c.name} ${pct((100 * roundWins.filter((w) => w === i).length) / roundWins.length)}`).join(", ")}`);
out.push(`match wins: ${SOULS.map((c, i) => `${c.name} ${pct((100 * rows.filter((r) => r.winner === i).length) / N)}`).join(", ")}`);
out.push(`tally over all matches (round win 3, knockout 1): ${SOULS.map((c, i) => `${c.name} ${on.tally.points[i]}`).join(", ")}`);
out.push(`ring-outs per match: ${avg((r) => r.ringouts).toFixed(2)}; humiliations per match: ${avg((r) => r.humiliations.length).toFixed(2)} (${count(rows.flatMap((r) => r.humiliations)).map(([k, v]) => `${k} ${v}`).join(", ")})`);
// morale
const starts = rows.flatMap((r) => r.moraleStart.flatMap((ms, ri) => ms.map((s, fi) => ({ s, fi, ri, won: r.roundWinners[ri] === fi }))));
const later = starts.filter((x) => x.ri > 0);
out.push(`morale states at the start of rounds 2-3 (${later.length} fighter-rounds): ${MORALE_STATES.map((s) => `${s} ${pct((100 * later.filter((x) => x.s === s).length) / later.length)}`).join(", ")}`);
out.push(`  by character: ${SOULS.map((c, i) => `${c.name} [${MORALE_STATES.map((s) => `${s[0]}${s[1]}${pct((100 * later.filter((x) => x.fi === i && x.s === s).length) / Math.max(1, later.filter((x) => x.fi === i).length))}`).join(" ")}]`).join("  ")}`);
out.push(`round win rate by morale state at round start (rounds 2-3; 25% = even): ${MORALE_STATES.map((s) => {
  const g = later.filter((x) => x.s === s);
  return `${s} ${pct((100 * g.filter((x) => x.won).length) / Math.max(1, g.length))} (n=${g.length})`;
}).join(", ")}`);
// A/B
const offWins = off.rows.flatMap((r) => r.roundWinners);
out.push(`morale behavior nudges A/B (same seeds, nudges off vs on):`);
out.push(`  round wins OFF: ${SOULS.map((c, i) => `${c.name} ${pct((100 * offWins.filter((w) => w === i).length) / offWins.length)}`).join(", ")}`);
out.push(`  round wins ON:  ${SOULS.map((c, i) => `${c.name} ${pct((100 * roundWins.filter((w) => w === i).length) / roundWins.length)}`).join(", ")}`);
out.push(`  match wins OFF: ${SOULS.map((c, i) => `${c.name} ${pct((100 * off.rows.filter((r) => r.winner === i).length) / N)}`).join(", ")}`);
const offStarts = off.rows.flatMap((r) => r.moraleStart.flatMap((ms, ri) => ms.map((st, fi) => ({ s: st, fi, ri, won: r.roundWinners[ri] === fi })))).filter((x) => x.ri > 0);
out.push(`  round win rate by state, nudges OFF: ${MORALE_STATES.map((st) => {
  const g = offStarts.filter((x) => x.s === st);
  return `${st} ${pct((100 * g.filter((x) => x.won).length) / Math.max(1, g.length))} (n=${g.length})`;
}).join(", ")}`);
out.push(`  (the difference between ON and OFF per state is what the nudge itself does; the OFF numbers show the state's natural correlation with winning)`);
out.push(`dialogue: ${avg((r) => r.lines).toFixed(1)} lines per match, repeated lines within a match: ${rows.reduce((a, r) => a + r.repeatedLines, 0)}`);
console.log(out.join("\n"));
if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ summary: out, rows, rowsNoMoraleEffect: off.rows }, null, 2));
