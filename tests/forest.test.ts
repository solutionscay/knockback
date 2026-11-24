/**
 * The forest (#114): soil over a rock frame, muddy creeks (water pools with mud walls and banks), tree-trunk walls,
 * branch and canopy jump-through platforms, in the default rotation; a fighter dropped in a creek swims out in a few
 * seconds and splashes at most once per 45 ticks. Generated levels and house controllers; no network.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, exampleSouls, initPhysics, Match, validateRuleset, type Ruleset, type SimEvent } from "../src/sim";
import { F_ONEWAY, Liquid, Mat } from "../src/sim/grid";
import { generateLevel, themeFor } from "../src/sim/levelgen";
import { NavGraph } from "../src/sim/nav";

beforeAll(async () => {
  await initPhysics();
});

const FOREST: Ruleset = validateRuleset({ arena: { enabledThemes: ["forest"] }, round: { maxRounds: 1, winsToTake: 1 } });

describe("forest (#114)", () => {
  test("it is in the default rotation", () => {
    const seeds = Array.from({ length: 60 }, (_, s) => s).filter((s) => themeFor(s) === "forest");
    expect(seeds.length).toBeGreaterThan(5);
    expect(generateLevel(seeds[0]!).theme).toBe("forest");
  });

  test("levels: soil over the rock frame, water creeks lined with mud (walls and two cells of bank), trunks, jump-through branches", () => {
    let pools = 0, oneWay = 0, trunks = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const lv = generateLevel(seed, undefined, FOREST);
      const g = lv.grid;
      expect(lv.theme).toBe("forest");
      for (const p of lv.pools ?? []) {
        expect(p.liquid).toBe(Liquid.Water);
        pools++;
        const c0 = g.cx(p.x0), c1 = g.cx(p.x1) - 1, ty = g.cy(p.y);
        // the walls are mud from the floor up, the banks' top two cells each side are mud, the floor is not
        for (let cy = ty - p.depth; cy < ty; cy++) {
          expect(g.mat[g.idx(c0 - 1, cy)]).toBe(Mat.Mud);
          expect(g.mat[g.idx(c1 + 1, cy)]).toBe(Mat.Mud);
        }
        for (const cx of [c0 - 2, c1 + 2]) expect(g.mat[g.idx(cx, ty - 1)]).toBe(Mat.Mud);
        for (let cx = c0; cx <= c1; cx++) expect(g.mat[g.idx(cx, ty - p.depth - 1)]).not.toBe(Mat.Mud);
      }
      // the ground: soil on top, rock (the frame) somewhere under it in every untouched column
      for (let cx = 4; cx < g.cols - 4; cx += 9) {
        let top = g.rows - 1;
        while (top > 0 && !g.solid(cx, top)) top--;
        if (top < 8 || g.mat[g.idx(cx, top)] !== Mat.Dirt || g.flags[g.idx(cx, top)]! & F_ONEWAY) continue;
        const col = Array.from({ length: 8 }, (_, d) => g.mat[g.idx(cx, top - d)]);
        if (col.some((m) => m === 0)) continue;
        expect(col).toContain(Mat.Rock);
      }
      for (let i = 0; i < g.mat.length; i++) if (g.flags[i]! & F_ONEWAY && g.mat[i]) oneWay++;
      for (let i = 0; i < g.mat.length; i++) if (g.mat[i] === Mat.Wood && !(g.flags[i]! & F_ONEWAY)) trunks++;
      const nav = NavGraph.fromGrid(g, 2, FOREST);
      for (const sp of lv.spawns) expect(nav.surfaceAt(sp.x, sp.y + 0.05, 0)!.liquid).toBe(Liquid.None);
    }
    expect(pools).toBeGreaterThanOrEqual(12);
    expect(oneWay).toBeGreaterThan(100);
    expect(trunks).toBeGreaterThan(0);
  });

  test("the other themes draw no mud banks (bankCells 0)", () => {
    for (const t of ["warehouse", "rooftop", "junkyard", "construction", "beach", "testbed"] as const) expect(CLASSIC.arena.themes[t].hazards.bankCells).toBe(0);
    expect(CLASSIC.arena.themes.forest.hazards.bankCells).toBe(2);
    expect(() => validateRuleset({ arena: { themes: { forest: { hazards: { bankCells: 5 } } } } })).toThrow("bankCells");
  });

  test("a forest match is deterministic and nobody drowns", () => {
    const play = () => {
      const m = new Match(5, { souls: exampleSouls(), ruleset: FOREST });
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

  test("a fighter dropped into a creek gets out within 5 s (#114: a stale landing no longer holds a swimmer over one spot)", () => {
    let tried = 0, slowest = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const who of [0, 1, 2, 3]) {
        const m = new Match(seed, { souls: exampleSouls(), ruleset: FOREST });
        m.prepareRound();
        const sim = m.fight!.sim;
        const pool = sim.level.pools?.[0];
        if (!pool) continue;
        tried++;
        const f = sim.fighters[who]!;
        f.entity.body.setTranslation({ x: (pool.x0 + pool.x1) / 2, y: pool.y - 0.4 }, true);
        let out = -1;
        for (let t = 0; t < 300 && !m.step() && f.alive; t++) {
          const p = f.entity.body.translation();
          if (f.grounded && !(p.x > pool.x0 - 0.3 && p.x < pool.x1 + 0.3 && p.y < pool.y + 2.2)) { out = t; break; }
        }
        expect({ seed, who, out: out >= 0 || !f.alive }).toEqual({ seed, who, out: true });
        slowest = Math.max(slowest, out);
      }
    }
    expect(tried).toBeGreaterThanOrEqual(30);
    expect(slowest).toBeLessThan(300);
  });

  test("a swimmer splashes once per 45 ticks at most (#114: every stroke re-entered the water)", () => {
    const m = new Match(3, { souls: exampleSouls(), ruleset: FOREST });
    m.prepareRound();
    const sim = m.fight!.sim;
    const pool = sim.level.pools![0]!;
    const last = [-1e9, -1e9, -1e9, -1e9];
    let splashes = 0;
    m.onEvent = (e: SimEvent) => {
      if (e.type !== "splash") return;
      expect(e.tick - last[e.fighter]!).toBeGreaterThanOrEqual(45);
      last[e.fighter] = e.tick;
      splashes++;
    };
    const f = sim.fighters[0]!;
    f.entity.body.setTranslation({ x: (pool.x0 + pool.x1) / 2, y: pool.y - 0.4 }, true);
    for (let t = 0; t < 600 && !m.step(); t++);
    expect(splashes).toBeGreaterThan(0);
  });
});
