/**
 * The beach (#111): dry sand over wet sand over a rock frame, water pools only, boardwalk jump-through platforms, in the
 * default rotation; a fighter dropped in a tide pool swims out. Generated levels and house controllers; no network.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { exampleSouls, initPhysics, Match, validateRuleset, type Ruleset, type SimEvent } from "../src/sim";
import { F_ONEWAY, Liquid, Mat } from "../src/sim/grid";
import { generateLevel, themeFor } from "../src/sim/levelgen";
import { NavGraph } from "../src/sim/nav";

beforeAll(async () => {
  await initPhysics();
});

const BEACH: Ruleset = validateRuleset({ arena: { enabledThemes: ["beach"] }, round: { maxRounds: 1, winsToTake: 1 } });

describe("beach (#111)", () => {
  test("it is in the default rotation", () => {
    const seeds = Array.from({ length: 120 }, (_, s) => s).filter((s) => themeFor(s) === "beach");
    expect(seeds.length).toBeGreaterThan(5);
    expect(generateLevel(seeds[0]!).theme).toBe("beach");
  });

  test("levels: two rows of dry sand, wet sand under them, the rock frame, water pools only, jump-through boardwalk", () => {
    let pools = 0, oneWay = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const lv = generateLevel(seed, undefined, BEACH);
      const g = lv.grid;
      expect(lv.theme).toBe("beach");
      for (const p of lv.pools ?? []) expect(p.liquid).toBe(Liquid.Water);
      pools += lv.pools?.length ?? 0;
      // a column of untouched ground away from pools, pits and walls: from the top, sand, sand, wet sand (dirt), ... rock
      let checked = 0;
      for (let cx = 4; cx < g.cols - 4 && checked < 3; cx += 7) {
        let top = g.rows - 1;
        while (top > 0 && !g.solid(cx, top)) top--;
        if (top < 8 || g.mat[g.idx(cx, top)] !== Mat.Sand || g.flags[g.idx(cx, top)]! & F_ONEWAY) continue;
        const below = [1, 2, 3].map((d) => g.mat[g.idx(cx, top - d)]);
        if (below.some((m) => m === 0)) continue;
        expect(below[0]).toBe(Mat.Sand);
        expect([Mat.Dirt, Mat.Rock]).toContain(below[1]!);
        checked++;
      }
      for (let i = 0; i < g.mat.length; i++) if (g.flags[i]! & F_ONEWAY && g.mat[i]) oneWay++;
      const nav = NavGraph.fromGrid(g, 2, BEACH);
      for (const sp of lv.spawns) expect(nav.surfaceAt(sp.x, sp.y + 0.05, 0)!.liquid).toBe(Liquid.None);
    }
    expect(pools).toBeGreaterThanOrEqual(12);
    expect(oneWay).toBeGreaterThan(100);
  });

  test("a beach match is deterministic and nobody drowns", () => {
    const play = () => {
      const m = new Match(5, { souls: exampleSouls(), ruleset: BEACH });
      m.prepareRound();
      const causes: string[] = [];
      m.onEvent = (e: SimEvent) => { if (e.type === "ko") causes.push(e.weapon); };
      for (let t = 0; t < 2400 && !m.step(); t++);
      return { hash: m.fight!.sim.hash(), causes };
    };
    const a = play();
    expect(play().hash).toBe(a.hash);
    expect(a.causes).not.toContain("water");
  });

  test("a fighter dropped into a tide pool swims out (#111: afloat with no link, it swims for a rim)", () => {
    let tried = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const who of [0, 1, 2, 3]) {
        const m = new Match(seed, { souls: exampleSouls(), ruleset: BEACH });
        m.prepareRound();
        const sim = m.fight!.sim;
        const pool = sim.level.pools?.[0];
        if (!pool) continue;
        tried++;
        const f = sim.fighters[who]!;
        f.entity.body.setTranslation({ x: (pool.x0 + pool.x1) / 2, y: pool.y - 0.4 }, true);
        let out = -1;
        for (let t = 0; t < 900 && !m.step() && f.alive; t++) {
          const p = f.entity.body.translation();
          if (f.grounded && !(p.x > pool.x0 - 0.3 && p.x < pool.x1 + 0.3 && p.y < pool.y + 2.2)) { out = t; break; }
        }
        expect({ seed, who, out: out >= 0 || !f.alive }).toEqual({ seed, who, out: true });
      }
    }
    expect(tried).toBeGreaterThanOrEqual(30);
  });
});
