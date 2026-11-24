/**
 * Pool edges (#135, after #88): a bot afloat plans from the pool it swims in and swims for the way out that leads to its goal.
 * Before, it kept flying the link that dropped it in (holding over the landing until the link timed out), then the
 * air's landing rule steered it back to the rim it came from, where the plan dropped it in again: a pacing loop at the
 * rim. Arena-style rounds (house bots, souls rotated, one round) on the rounds that looped before, under the stuck
 * detector: no stuck episode in a pool or at its rim.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { exampleSouls, initPhysics, Match, validateRuleset } from "../src/sim";
import { StuckDetector } from "../src/stats/stuck";

beforeAll(async () => {
  await initPhysics();
});

function poolEpisodes(theme: string, seed: number) {
  const base = validateRuleset({ arena: { enabledThemes: [theme] } });
  const souls = exampleSouls();
  const m = new Match(seed, { souls: [0, 1, 2, 3].map((i) => souls[(i + seed) % 4]!), ruleset: { ...base, round: { ...base.round, maxRounds: 1, winsToTake: 1 } } });
  m.prepareRound();
  const det = new StuckDetector(m.fight!);
  m.onEvent = (e) => det.event(e);
  while (!m.step()) det.tick();
  det.finish();
  const pools = m.fight!.sim.level.pools ?? [];
  // over a pool or within 1.5 m of its side, from under its floor to 2.5 m over its top (in it, afloat, at the rim)
  return det.episodes.filter((e) => pools.some((p) => {
    const dx = e.x < p.x0 ? p.x0 - e.x : e.x > p.x1 ? e.x - p.x1 : 0;
    return dx <= 1.5 && e.y > p.y - 3 && e.y < p.y + 2.5;
  })).map((e) => ({ theme, seed, fighter: e.fighter, seconds: (e.end - e.start) / 60 }));
}

describe("pool edges (#135)", () => {
  // the longest pool-edge loops of 300 rounds per map before the fix (up to 9 s pacing at a creek in the forest)
  const looped: [string, number][] = [["cave", 121], ["forest", 124], ["space", 267], ["forest", 78], ["beach", 106], ["beach", 94]];
  for (const [theme, seed] of looped) {
    test(`${theme} seed ${seed}: no bot stuck in a pool or at its rim`, () => {
      expect(poolEpisodes(theme, seed)).toEqual([]);
    }, 60_000);
  }
});
