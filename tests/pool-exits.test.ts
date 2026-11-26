/**
 * Pool exits (#152): no pool may have only exits too high to swim over. A stroke lifts a swimmer's feet about 0.69 m
 * over the liquid's top (0.84 m in space's low gravity); the level validator rejects a level with a water, slime or
 * coolant pool that has no ledge within that reach (with room to stand) on either side. The full check (1000 seeds per
 * theme) is scripts/pool-exits.ts. A swimmer in a pool whose liquid has sunk out of a stroke's reach (a carved,
 * drained basin) still gets out: a stroke, then a kick off the basin's wall (#100).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, exampleSouls, initPhysics, Match, themedRuleset, validateRuleset, type Ruleset } from "../src/sim";
import { CELL, Liquid, Mat } from "../src/sim/grid";
import { poolExitProblems, poolExits, strokeReach } from "../src/sim/level-validate";
import { generateLevel } from "../src/sim/levelgen";
import { ALL_THEMES, type Theme } from "../src/sim/themes";

beforeAll(async () => {
  await initPhysics();
});

const H = (t: Theme) => CLASSIC.arena.themes[t].hazards;
const POOL_THEMES = ALL_THEMES.filter((t) => H(t).pools[1] > 0 && H(t).water + H(t).slime + H(t).coolant > 0);
const only = (t: Theme): Ruleset => validateRuleset({ arena: { enabledThemes: [t] }, round: { maxRounds: 1, winsToTake: 1 } });

describe("pool exits (#152)", () => {
  test("the pool themes of the rotation are all checked", () => {
    for (const t of ["beach", "forest", "cave", "space"] as const) expect(POOL_THEMES).toContain(t);
  });

  test("a stroke reaches about 0.69 m over the liquid's top, 0.84 m in space", () => {
    expect(strokeReach(themedRuleset(CLASSIC, "beach"), Liquid.Water)).toBeCloseTo(0.69, 2);
    expect(strokeReach(themedRuleset(CLASSIC, "cave"), Liquid.Slime)).toBeCloseTo(0.69, 2);
    expect(strokeReach(themedRuleset(CLASSIC, "space"), Liquid.Coolant)).toBeCloseTo(0.84, 2);
  });

  for (const theme of POOL_THEMES) {
    test(`${theme}: every pool of 100 generated levels has an exit a swimmer can reach`, () => {
      const rs = only(theme);
      const themed = themedRuleset(rs, theme);
      let pools = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const lv = generateLevel(seed, undefined, rs);
        for (const e of poolExits(lv, themed)) {
          pools++;
          expect({ seed, pool: e.x0, ok: e.ok[0] || e.ok[1] }).toEqual({ seed, pool: e.x0, ok: true });
        }
      }
      expect(pools).toBeGreaterThan(100);
    });
  }

  test("the validator rejects a pool walled in on both sides past a stroke's reach, not one with a way out", () => {
    const rs = only("beach");
    const themed = themedRuleset(rs, "beach");
    const fresh = () => {
      for (let seed = 1; ; seed++) {
        const lv = generateLevel(seed, undefined, rs);
        if (lv.pools?.length) return lv;
      }
    };
    // raise the ledge beside the pool's first pool by `cells` on the chosen sides
    const raise = (cells: number, sides: ("L" | "R")[]) => {
      const lv = fresh();
      const g = lv.grid, p = lv.pools![0]!;
      const top = g.cy(p.y - 0.01);
      for (const s of sides) for (let k = 1; k <= cells; k++) g.set(s === "L" ? g.cx(p.x0) - 1 : g.cx(p.x1 - 0.01) + 1, top + k, Mat.Rock, 0);
      return poolExitProblems(lv, themed);
    };
    expect(raise(0, [])).toEqual([]);
    expect(raise(1, ["L", "R"])).toEqual([]); // 0.5 m: within a stroke
    expect(raise(2, ["L"])).toEqual([]); // 1 m on one side: the other is the way out
    const walled = raise(2, ["L", "R"]);
    expect(walled.length).toBe(1);
    expect(walled[0]).toContain("no exit a swimmer can reach");
  });

  for (const theme of ["beach", "forest", "cave", "space"] as const) {
    test(`${theme}: a fighter in a pool sunk to one cell deep (its rims 1 m and more over the liquid) climbs out`, () => {
      let tried = 0;
      for (let seed = 1; tried < 3 && seed < 40; seed++) {
        const m = new Match(seed, { souls: exampleSouls(), ruleset: only(theme) });
        m.prepareRound();
        const sim = m.fight!.sim;
        const g = sim.grid;
        const pool = sim.level.pools?.find((p) => p.depth >= 3);
        if (!pool) continue;
        tried++;
        // the liquid sinks: only its bottom row is left
        const rim = g.cy(pool.y - 0.01) + 1;
        for (let cx = g.cx(pool.x0); cx <= g.cx(pool.x1 - 0.01); cx++) for (let cy = rim - pool.depth + 1; cy < rim; cy++) g.liq[g.idx(cx, cy)] = Liquid.None;
        const f = sim.fighters[0]!;
        f.entity.body.setTranslation({ x: (pool.x0 + pool.x1) / 2, y: pool.y - pool.depth * CELL + 0.9 }, true);
        let out = false;
        for (let t = 0; t < 900 && !m.step() && f.alive; t++) {
          const p = f.entity.body.translation();
          if (f.grounded && !(p.x > pool.x0 - 0.3 && p.x < pool.x1 + 0.3 && p.y < pool.y + 2.2)) {
            out = true;
            break;
          }
        }
        expect({ seed, out: out || !f.alive }).toEqual({ seed, out: true });
      }
      expect(tried).toBe(3);
    }, 60_000);
  }
});
