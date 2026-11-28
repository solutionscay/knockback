/**
 * Measure stalled pursuit with a terrain obstruction.
 * bun scripts/wall-batch.ts [matches=200] [firstSeed=1] [minSeconds=1]
 * The observer samples every tenth tick without changing match inputs.
 */
import { nearestRank } from "../src/stats/quantiles";
import { sum } from "./batch-stats";
import { initPhysics, Match, TICK_RATE } from "../src/sim";

const [count, first, minimum] = process.argv.slice(2).map(Number);
const matches = count ?? 200;
const firstSeed = first ?? 1;
const minSeconds = minimum ?? 1;
if (!Number.isInteger(matches) || matches < 1 || !Number.isInteger(firstSeed) || !(minSeconds > 0)) {
  throw new Error("usage: bun scripts/wall-batch.ts [matches=200] [firstSeed=1] [minSeconds=1]");
}
const sample = 10;
const progress = 0.75;
const summaries: number[] = [];
const stretches: { seed: number; round: number; fighter: number; at: number; seconds: number }[] = [];
const matchWins = [0, 0, 0, 0];
const roundWins = [0, 0, 0, 0];
const rounds: { seed: number; round: number; ticks: number; winner: number; reason: string; hash: string; checkpoints: string[]; stuck: number[] }[] = [];
await initPhysics();

for (let seed = firstSeed; seed < firstSeed + matches; seed++) {
  const m = new Match(seed);
  while (!m.over) {
    m.prepareRound();
    const { sim, controllers } = m.fight!;
    const watches: ({ target: number; best: number; since: number } | null)[] = [null, null, null, null];
    const stuck = [0, 0, 0, 0];
    const end = (seat: number, tick: number) => {
      const watch = watches[seat];
      if (!watch) return;
      const seconds = (tick - watch.since) / TICK_RATE;
      if (seconds >= minSeconds) {
        stuck[seat]! += seconds;
        stretches.push({ seed, round: m.round, fighter: seat, at: watch.since / TICK_RATE, seconds });
      }
      watches[seat] = null;
    };
    for (;;) {
      const done = m.step();
      if (done) break;
      if (sim.tick % sample) continue;
      for (const f of sim.fighters) {
        const target = sim.fighters[controllers[f.id]!.targetId];
        if (!f.alive || !target?.alive) {
          end(f.id, sim.tick);
          continue;
        }
        const p = sim.pos(f);
        const t = sim.pos(target);
        const dx = t.x - p.x;
        const dy = t.y - p.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const hit = distance > 0 ? sim.raycast(p.x, p.y, dx / distance, dy / distance, distance, f.entity.collider) : null;
        const blocked = hit && (hit.terrain || hit.entity?.kind === "chunk" || hit.entity?.kind === "block");
        if (!blocked) {
          end(f.id, sim.tick);
          continue;
        }
        const watch = watches[f.id];
        if (!watch || watch.target !== target.id || distance <= watch.best - progress) {
          end(f.id, sim.tick);
          watches[f.id] = { target: target.id, best: distance, since: sim.tick };
        }
      }
    }
    for (const f of sim.fighters) end(f.id, sim.tick);
    const facts = m.finishRound();
    const { fight } = m.record.rounds.at(-1)!;
    roundWins[facts.winner]!++;
    rounds.push({ seed, round: facts.round, ticks: fight.ticks, winner: facts.winner, reason: facts.reason, hash: fight.finalHash, checkpoints: fight.checkpoints, stuck });
    summaries.push(...stuck);
  }
  matchWins[m.winner]!++;
}

function stats(values: number[]) {
  return {
    mean: sum(values) / Math.max(1, values.length),
    p95: nearestRank(values, 0.95),
    max: values.reduce((a, b) => Math.max(a, b), 0),
  };
}

console.log(JSON.stringify({
  matches, firstSeed, minSeconds,
  summary: {
    stuckSecondsPerFighterRound: stats(summaries),
    stuckSecondsPerStretch: stats(stretches.map((s) => s.seconds)),
    stretchesOverFiveSeconds: stretches.filter((s) => s.seconds > 5).length,
    roundSeconds: stats(rounds.map((r) => r.ticks / TICK_RATE)),
    timeouts: rounds.filter((r) => r.reason === "time-out").length,
    matchWins, roundWins,
  },
  rounds, stretches,
}, null, 2));
