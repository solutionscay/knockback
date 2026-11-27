/**
 * Bare-handed fighters go for a weapon (#109): no standing about with fists while the fight goes on elsewhere. The
 * demo round (LAN round 2056) and Arena-style rounds under the idle tracker (src/stats/idle-bare.ts).
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "bun:test";
import { exampleSouls, initPhysics, Match, type MatchRecord, type SimEvent } from "../src/sim";
import { isPickupWeapon } from "../src/sim/sim-types";
import { CLASSIC } from "../src/sim/ruleset";
import { IdleBareTracker } from "../src/stats/idle-bare";

beforeAll(async () => {
  await initPhysics();
});

function play(m: Match, watch?: (e: SimEvent) => void) {
  m.prepareRound();
  const t = new IdleBareTracker(m.fight!);
  m.onEvent = (e) => {
    t.event(e);
    watch?.(e);
  };
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
    // supply back. The same plans now: a weapon on its side, and it gets one. With the act order of #159 the round
    // plays differently: the bat on its side lies under a debris chunk, and a crate stack with a chunk on top blocks the
    // way (debris the nav graph does not see, like seed 10 below), so two short spells remain (5.4 s and 2.1 s) while
    // the pickup's give-up timer skips the bat; it gets the bat at 56 s
    const rec = JSON.parse(readFileSync(new URL("./fixtures/lan-round-2056.json", import.meta.url), "utf8")) as MatchRecord;
    const picked: number[] = [];
    const m = new Match(rec.seed, { recorded: rec });
    const { spells } = play(m, (e) => {
      if (e.type === "pickup" && e.fighter === 2 && isPickupWeapon(e.item)) picked.push(e.tick);
    });
    const vexly = spells.filter((s) => s.fighter === 2);
    expect(picked.length).toBeGreaterThan(0);
    expect(Math.max(0, ...vexly.map((s) => s.end - s.start))).toBeLessThanOrEqual(6 * 60);
    expect(vexly.reduce((t, s) => t + s.end - s.start, 0)).toBeLessThanOrEqual(10 * 60);
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
