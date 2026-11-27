/**
 * The zone stops on ground a fighter can hold (#156): not at a pit's lip, not over a pit.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { exampleSouls, initPhysics, Match } from "../src/sim";
import { validateRuleset } from "../src/sim/ruleset";
import { holdableEdge, holdableEdges } from "../src/sim/sim-zone";
import { suddenDeathSpot } from "../src/sim/weapon-spots";

beforeAll(async () => {
  await initPhysics();
});

/** The arena round of scripts/stuck.ts sims (souls rotated, one round) on one map. */
function arenaRound(theme: string, seed: number) {
  const base = validateRuleset({ arena: { enabledThemes: [theme] } });
  const souls = exampleSouls();
  const m = new Match(seed, { souls: [0, 1, 2, 3].map((i) => souls[(i + seed) % 4]!), ruleset: { ...base, round: { ...base.round, maxRounds: 1, winsToTake: 1 } } });
  m.prepareRound();
  return m;
}

describe("zone edges", () => {
  test("junkyard seed 169: sudden death stops past the lip at x = 3.5, not on it", () => {
    // before #156 the zone closed to -1.5..3.5 with its right edge on the lip of the ground (x 3.5..18): fighter 0 stood
    // on the lip, stepped out, was pushed back, and paced there for 54 s
    const m = arenaRound("junkyard", 169);
    const sim = m.fight!.sim;
    while (!m.step() && sim.tick < 2400) {}
    expect(sim.suddenDeath).toBeGreaterThan(0);
    expect(sim.zone.hi).toBeGreaterThanOrEqual(3.5 + 1.5);
    expect(holdableEdge(sim, sim.zone.hi, 1)).toBe(true);
    expect(holdableEdge(sim, 3.5, 1)).toBe(false);
  });

  test("every map: each stopping edge is holdable (or, with no holdable ground in reach, the plain one), at most 2 m in", () => {
    for (const theme of ["warehouse", "rooftop", "junkyard", "construction", "beach", "forest", "cave", "space"]) {
      for (const seed of [1, 2]) {
        const sim = arenaRound(theme, seed).fight!.sim;
        const c = sim.level.zoneCenter, h = sim.ruleset.zone.boundary.endHalf;
        const [lo, hi] = holdableEdges(sim, c - h, c + h, [c - sim.zone.startHalf, c + sim.zone.startHalf]);
        const ok = (x: number, plain: number, out: -1 | 1) => x === plain || holdableEdge(sim, x, out);
        expect({ theme, seed, lo: ok(lo, c - h, -1), hi: ok(hi, c + h, 1) }).toEqual({ theme, seed, lo: true, hi: true });
        expect(lo).toBeLessThanOrEqual(c - h + 2);
        expect(hi).toBeGreaterThanOrEqual(c + h - 2);
      }
    }
  });

  test("sudden-death drops land on ground the survivors reach, not in the pit between them (#159)", () => {
    // junkyard seed 169: the survivors' midpoint is over the pit; each side gets its turn
    const m = arenaRound("junkyard", 169);
    const sim = m.fight!.sim;
    while (!m.step() && sim.suddenDeath < 0) {}
    for (const side of [-1, 1] as const) {
      const alive = sim.alive();
      const mid = alive.reduce((a, f) => a + sim.pos(f).x, 0) / alive.length;
      const spot = suddenDeathSpot(sim, mid, side)!;
      expect(spot).not.toBeNull();
      const s = sim.nav.surfaces[spot.surface]!;
      expect(s.fragile).toBe(false);
      expect(spot.x).toBeGreaterThanOrEqual(sim.zone.lo - 1);
      expect(spot.x).toBeLessThanOrEqual(sim.zone.hi + 1);
      const reached = alive.filter((f) => f.surface >= 0 && sim.nav.fighterPlan(sim.grid, f.surface, sim.pos(f).x).cost[spot.surface] !== Infinity);
      expect(reached.length).toBeGreaterThan(0);
    }
  });
});
