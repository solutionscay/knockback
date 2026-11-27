/**
 * Bare-handed fighters go for a weapon (#109): no standing about with fists while the fight goes on elsewhere. The
 * demo round (LAN round 2056) and Arena-style rounds under the idle tracker (src/stats/idle-bare.ts).
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "bun:test";
import { exampleSouls, initPhysics, Match, type MatchRecord } from "../src/sim";
import { CLASSIC } from "../src/sim/ruleset";
import { IdleBareTracker } from "../src/stats/idle-bare";

beforeAll(async () => {
  await initPhysics();
});

function play(m: Match) {
  m.prepareRound();
  const t = new IdleBareTracker(m.fight!);
  m.onEvent = (e) => t.event(e);
  let alive = 0;
  while (!m.step()) {
    t.tick();
    const sim = m.fight!.sim;
    if (sim.alive().length >= 2) alive += sim.alive().length;
  }
  t.finish();
  return { spells: t.spells, alive, sim: m.fight!.sim };
}

describe("bare-handed and standing still (#109)", () => {
  test("LAN round 2056: Vexly, cut off from every weapon on a ledge, gets one and never stands about", () => {
    // on main 6980876, house bot Vexly (seat 2) stood bare-handed at a pit's lip for 6.5 s, 8.3 s and 4.9 s: every
    // weapon and rival was across the pit, and the cap on loose weapons (counting the ones the others reach) held the
    // supply back. The same plans now: a weapon on its side, no idle spell for it. (#159 to #163: with the act order of
    // #159 the bat on its side lay past a crate stack under a hanging chunk, debris the nav graph does not see, and two
    // spells came back, 5.4 s and 2.1 s. #163 punches through such debris and takes covered pickups from beside them; the
    // round now plays differently from 29 s on, and the debris scene is tested on its own in debris-pickups.test.ts)
    const rec = JSON.parse(readFileSync(new URL("./fixtures/lan-round-2056.json", import.meta.url), "utf8")) as MatchRecord;
    const { spells } = play(new Match(rec.seed, { recorded: rec }));
    expect(spells.filter((s) => s.fighter === 2)).toEqual([]);
  }, 30_000);

  test("over 12 rounds: under 4% of alive time bare-handed and still, no spell over 12 s", () => {
    // the longest left (seed 10, about 11 s): boxed in by a steel block and a gas can under a low shelf; the nav graph
    // does not see props, so no drop comes for it
    let alive = 0, idle = 0, longest = 0;
    const souls = exampleSouls();
    for (let seed = 1; seed <= 12; seed++) {
      const m = new Match(seed, { souls: [0, 1, 2, 3].map((i) => souls[(i + seed) % 4]!), ruleset: { ...CLASSIC, round: { ...CLASSIC.round, maxRounds: 1, winsToTake: 1 } } });
      const r = play(m);
      alive += r.alive;
      for (const s of r.spells) {
        idle += s.end - s.start;
        longest = Math.max(longest, s.end - s.start);
      }
    }
    expect(idle / alive).toBeLessThan(0.04);
    expect(longest).toBeLessThanOrEqual(12 * 60);
  }, 60_000);
});
