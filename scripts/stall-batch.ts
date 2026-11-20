/**
 * Stalemate check: N headless house-bot matches (souls rotated across seats).
 * Per round: the longest stretch without fighter-on-fighter damage, round
 * length, time-outs, and how often sudden death kicked in.
 *   bun scripts/stall-batch.ts [N=200] [firstSeed=1]
 */
import { exampleSouls, FIGHT_TICKS, initPhysics, Match } from "../src/sim";

await initPhysics();
const N = Number(process.argv[2] ?? 200);
const first = Number(process.argv[3] ?? 1);
const souls = exampleSouls();
const gaps: number[] = [];
const lens: number[] = [];
const worst: { seed: number; round: number; gap: number; at: number }[] = [];
let timeouts = 0;
let sudden = 0;
let rounds = 0;
const t0 = performance.now();
for (let k = 0; k < N; k++) {
  const seed = first + k;
  const order = [0, 1, 2, 3].map((i) => (i + k) % 4);
  const m = new Match(seed, { souls: order.map((i) => souls[i]!) });
  while (!m.over) {
    m.prepareRound();
    let last = 0;
    let gap = 0;
    let gapAt = 0;
    let sd = false;
    m.onEvent = (e) => {
      if (e.type === "hit" && e.source >= 0 && e.source !== e.target) {
        if (e.tick - last > gap) {
          gap = e.tick - last;
          gapAt = last;
        }
        last = e.tick;
      }
      if ((e as { type: string }).type === "suddenDeath") sd = true;
    };
    while (!m.step()) {
      /* round */
    }
    const end = m.fight!.sim.tick;
    // the stretch after the last hit only counts while 2+ fighters were alive (not the finish pause)
    const lastKo = Math.max(0, ...m.fight!.sim.fighters.map((f) => f.koTick));
    const tail = (m.fight!.sim.alive().length > 1 ? end : lastKo) - last;
    if (tail > gap) {
      gap = tail;
      gapAt = last;
    }
    const f = m.finishRound();
    rounds++;
    gaps.push(gap / 60);
    lens.push(end / 60);
    if (end >= FIGHT_TICKS) timeouts++;
    if (sd) sudden++;
    worst.push({ seed, round: f.round, gap: gap / 60, at: gapAt / 60 });
  }
}
const q = (a: number[], p: number) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const hist = [20, 30, 45, 60, 75, 90].map((hi, i, arr) => {
  const lo = i ? arr[i - 1]! : 0;
  return `${lo}-${hi}s ${lens.filter((x) => x > lo && x <= hi + (hi === 90 ? 1 : 0)).length}`;
});
worst.sort((a, b) => b.gap - a.gap);
console.log(`${N} matches, ${rounds} rounds, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
console.log(`longest stretch without fighter-on-fighter damage per round: max ${q(gaps, 1).toFixed(1)} s, p95 ${q(gaps, 0.95).toFixed(1)} s, p50 ${q(gaps, 0.5).toFixed(1)} s; rounds with a stretch over 8 s: ${gaps.filter((g) => g > 8).length}`);
console.log(`round length: p50 ${q(lens, 0.5).toFixed(0)} s, p95 ${q(lens, 0.95).toFixed(0)} s, max ${q(lens, 1).toFixed(0)} s; distribution ${hist.join(", ")}`);
console.log(`time-outs: ${timeouts} (${((100 * timeouts) / rounds).toFixed(1)}%); rounds with sudden death: ${sudden} (${((100 * sudden) / rounds).toFixed(1)}%)`);
console.log(`worst stretches: ${worst
  .slice(0, 6)
  .map((w) => `seed ${w.seed} r${w.round} ${w.gap.toFixed(1)} s from ${w.at.toFixed(0)} s`)
  .join("; ")}`);
