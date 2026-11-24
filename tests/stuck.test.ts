/**
 * Bots go somewhere (#88): no hopping or pacing on one spot while the fight goes on without them. Arena-style rounds
 * (house bots, the souls rotated, one round each) under the stuck detector (src/stats/stuck.ts).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { exampleSouls, initPhysics, Match } from "../src/sim";
import { CLASSIC } from "../src/sim/ruleset";
import { StuckDetector } from "../src/stats/stuck";

beforeAll(async () => {
  await initPhysics();
});

function arenaRound(seed: number) {
  const souls = exampleSouls();
  const m = new Match(seed, { souls: [0, 1, 2, 3].map((i) => souls[(i + seed) % 4]!), ruleset: { ...CLASSIC, round: { ...CLASSIC.round, maxRounds: 1, winsToTake: 1 } } });
  m.prepareRound();
  const det = new StuckDetector(m.fight!);
  m.onEvent = (e) => det.event(e);
  while (!m.step()) det.tick();
  det.finish();
  return { det, fight: m.fight! };
}

describe("stuck and aimless (#88)", () => {
  test("seed 14: the fighter that hopped in place under a low platform goes another way", () => {
    // before #88, fighter 2 of this round hopped 13 times in 10.5 s from 7.75 s in, under a low platform beside a crate
    // and a gas can, for the pickups up on the platform; now it gives that way up and goes somewhere else
    const { det } = arenaRound(14);
    expect(det.episodes.filter((e) => e.fighter === 2 && e.end - e.start > 3 * 60)).toEqual([]);
  });

  test("over 16 rounds: under 1.5% of alive time stuck, no episode over 10 s", () => {
    let alive = 0, stuck = 0, longest = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const { det } = arenaRound(seed);
      alive += det.aliveTicks.reduce((a, b) => a + b, 0);
      for (const e of det.episodes) {
        stuck += e.end - e.start;
        longest = Math.max(longest, e.end - e.start);
      }
    }
    expect(stuck / alive).toBeLessThan(0.015);
    expect(longest).toBeLessThanOrEqual(10 * 60);
    // 16 whole rounds of physics: bunfig's limit does not reach this test (it timed out at bun's 5 s default under load)
  }, 60_000);
});
