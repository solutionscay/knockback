/**
 * The cave (#125): gravel over a rock frame, a low rock ceiling (rock under bedrock) with stalactites, slime pools, rock,
 * timber and ice jump-through ledges, in the default rotation. A fighter dropped in slime swims out in a few seconds;
 * drops fall from under the ceiling; a stalactite cut from the ceiling falls. Generated levels and house controllers.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, exampleSouls, initPhysics, Match, validateRuleset, type Ruleset, type SimEvent } from "../src/sim";
import { F_ONEWAY, Liquid, Mat } from "../src/sim/grid";
import { generateLevel, themeFor } from "../src/sim/levelgen";
import { NavGraph } from "../src/sim/nav";
import { footing } from "../src/sim/sim-liquid";
import { supplyDrop } from "../src/sim/sim-items";

beforeAll(async () => {
  await initPhysics();
});

const CAVE: Ruleset = validateRuleset({ arena: { enabledThemes: ["cave"] }, round: { maxRounds: 1, winsToTake: 1 } });
const ROOF = CLASSIC.arena.themes.cave.stage.ceiling;

describe("cave (#125)", () => {
  test("it is in the default rotation", () => {
    const seeds = Array.from({ length: 60 }, (_, s) => s).filter((s) => themeFor(s) === "cave");
    expect(seeds.length).toBeGreaterThan(5);
    expect(generateLevel(seeds[0]!).theme).toBe("cave");
  });

  test("levels: a ceiling over every column (rock under bedrock), stalactites, slime pools, platforms under the ceiling, nothing stands on it", () => {
    let pools = 0, oneWay = 0, ice = 0, stalactites = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const lv = generateLevel(seed, undefined, CAVE);
      const g = lv.grid;
      expect(lv.theme).toBe("cave");
      const roof = g.cy(ROOF);
      for (let cx = 0; cx < g.cols; cx++) {
        // solid from the ceiling's underside (never under ROOF) to the grid's top; bedrock at the top, rock under it
        let cy = roof;
        while (cy < g.rows && !g.solid(cx, cy)) cy++;
        expect(cy).toBeLessThanOrEqual(roof + 2);
        expect(g.mat[g.idx(cx, cy)]).toBe(Mat.Rock);
        for (let k = cy; k < g.rows; k++) expect(g.solid(cx, k)).toBe(true);
        expect(g.mat[g.idx(cx, g.rows - 1)]).toBe(Mat.Bedrock);
        // a stalactite tip: a lone rock cell under the ceiling, empty on both sides and under it
        for (let k = roof - 1; k > roof - 8; k--) {
          if (g.mat[g.idx(cx, k)] === Mat.Rock && !g.solid(cx, k - 1) && !g.solid(cx - 1, k) && !g.solid(cx + 1, k)) {
            stalactites++;
            // clear under it by 4.5 m: a fighter's jump never meets it
            for (let d = 1; d <= 9; d++) expect(g.solid(cx, k - d)).toBe(false);
          }
        }
      }
      for (const p of lv.pools ?? []) expect(p.liquid).toBe(Liquid.Slime);
      pools += lv.pools?.length ?? 0;
      for (let i = 0; i < g.mat.length; i++) {
        if (g.flags[i]! & F_ONEWAY && g.mat[i]) oneWay++;
        if (g.mat[i] === Mat.Ice) ice++;
      }
      const nav = NavGraph.fromGrid(g, 2, CAVE);
      // nothing to stand on at or over the ceiling, and every platform 4 m under it
      for (const s of nav.surfaces) expect(s.y).toBeLessThanOrEqual(ROOF - 4);
      for (const sp of lv.spawns) expect(nav.surfaceAt(sp.x, sp.y + 0.05, 0)!.liquid).toBe(Liquid.None);
    }
    expect(pools).toBeGreaterThanOrEqual(12);
    expect(oneWay).toBeGreaterThan(80);
    expect(ice).toBeGreaterThan(0);
    expect(stalactites).toBeGreaterThanOrEqual(40);
  });

  test("the other themes have no ceiling and draw no slime (their keys are 0); the ceiling's keys are validated", () => {
    for (const t of ["warehouse", "rooftop", "junkyard", "construction", "beach", "testbed"] as const) {
      expect(CLASSIC.arena.themes[t].stage.ceiling).toBe(0);
      expect(CLASSIC.arena.themes[t].hazards.slime).toBe(0);
    }
    expect(() => validateRuleset({ arena: { themes: { cave: { stage: { ceiling: 5 } } } } })).toThrow("ceiling");
    expect(() => validateRuleset({ arena: { themes: { cave: { stage: { stalactites: [8, 5] } } } } })).toThrow("minimum");
  });

  test("slime: thicker than water (slower), a fighter floats in it and swims out within 4 s (every fighter, seeds 1-12)", () => {
    let tried = 0, slowest = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const who of [0, 1, 2, 3]) {
        const m = new Match(seed, { souls: exampleSouls(), ruleset: CAVE });
        m.prepareRound();
        const sim = m.fight!.sim;
        const pool = sim.level.pools?.[0];
        if (!pool) continue;
        tried++;
        const f = sim.fighters[who]!;
        f.entity.body.setTranslation({ x: (pool.x0 + pool.x1) / 2, y: pool.y - 0.4 }, true);
        // in the slime: slower than in water
        const slow = footing(sim, f).speed === CAVE.liquids.slime.speedMul && CAVE.liquids.slime.speedMul < CAVE.liquids.water.speedMul;
        let out = -1;
        for (let t = 0; t < 300 && !m.step() && f.alive; t++) {
          // out: standing on dry ground at the rim's height or above
          const p = f.entity.body.translation();
          if (f.grounded && sim.feetY(f) >= pool.y - 0.05 && !sim.grid.liquidAt(p.x, sim.feetY(f) + 0.1) && !sim.grid.liquidAt(p.x, p.y)) { out = t; break; }
        }
        expect({ seed, who, slow, out: out >= 0 || !f.alive }).toEqual({ seed, who, slow: true, out: true });
        slowest = Math.max(slowest, out);
      }
    }
    expect(tried).toBeGreaterThanOrEqual(30);
    expect(slowest).toBeLessThan(240);
  });

  test("a cave match is deterministic, nobody dies in slime, and a swimmer splashes once per 45 ticks at most", () => {
    const play = () => {
      const m = new Match(5, { souls: exampleSouls(), ruleset: CAVE });
      m.prepareRound();
      const causes: string[] = [];
      const last = [-1e9, -1e9, -1e9, -1e9];
      m.onEvent = (e: SimEvent) => {
        if (e.type === "ko") causes.push(e.weapon);
        if (e.type === "splash") {
          expect(e.tick - last[e.fighter]!).toBeGreaterThanOrEqual(45);
          last[e.fighter] = e.tick;
        }
      };
      const pool = m.fight!.sim.level.pools![0]!;
      m.fight!.sim.fighters[0]!.entity.body.setTranslation({ x: (pool.x0 + pool.x1) / 2, y: pool.y - 0.4 }, true);
      for (let t = 0; t < 2400 && !m.step(); t++);
      return { hash: m.fight!.sim.hash(), causes };
    };
    const a = play();
    expect(play().hash).toBe(a.hash);
    expect(a.causes).not.toContain("slime");
  });

  test("supply drops fall from under the ceiling, clear of the rock (pickups, weapons, barrels and TNT)", () => {
    for (const seed of [1, 2, 3]) {
      const m = new Match(seed, { souls: exampleSouls(), ruleset: CAVE });
      m.prepareRound();
      const sim = m.fight!.sim;
      const before = new Set(sim.entities.keys());
      for (let n = 0; n < 8; n++) supplyDrop(sim, n);
      let fresh = 0;
      for (const [id, e] of sim.entities) {
        if (before.has(id)) continue;
        fresh++;
        const t = e.body.translation();
        expect(t.y + e.hh).toBeLessThan(ROOF);
        for (const [dx, dy] of [[-e.hw, -e.hh], [e.hw, -e.hh], [-e.hw, e.hh], [e.hw, e.hh], [0, 0]] as const) expect(sim.grid.solidAt(t.x + dx * 0.9, t.y + dy * 0.9)).toBe(false);
      }
      expect(fresh).toBeGreaterThan(8);
    }
  });

  test("a stalactite cut from the ceiling falls (a loose piece)", () => {
    const m = new Match(4, { souls: exampleSouls(), ruleset: CAVE });
    m.prepareRound();
    const sim = m.fight!.sim;
    const g = sim.grid;
    const roof = g.cy(ROOF);
    // the first stalactite tip, then the 3-wide row above its 1-wide part
    let tip: [number, number] | null = null;
    for (let cx = 1; cx < g.cols - 1 && !tip; cx++) for (let k = roof - 1; k > roof - 8 && !tip; k--) if (g.mat[g.idx(cx, k)] === Mat.Rock && !g.solid(cx, k - 1) && !g.solid(cx - 1, k) && !g.solid(cx + 1, k)) tip = [cx, k];
    expect(tip).not.toBeNull();
    const [cx, k] = tip!;
    let r = k;
    while (!g.solid(cx - 1, r) && !g.solid(cx + 1, r)) r++;
    const pieces = () => [...sim.entities.values()].filter((e) => e.cells?.length).length;
    const had = pieces();
    for (let x = cx - 1; x <= cx + 1; x++) sim.terrain.removeCell(x, r);
    for (let t = 0; t < 30 && !m.step(); t++);
    expect(g.solid(cx, k)).toBe(false);
    expect(pieces()).toBeGreaterThan(had);
  });
});
