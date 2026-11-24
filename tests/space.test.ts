/**
 * Space (#127): an asteroid station. Regolith (ice chunks in it) over a rock frame, steel, hull-panel and ice
 * jump-through ledges, coolant pools, low gravity scoped to the theme, in the default rotation. A fighter dropped in
 * coolant swims out in a few seconds. Generated levels and house controllers; no network.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, exampleSouls, initPhysics, Match, themedRuleset, validateRuleset, type Ruleset, type SimEvent } from "../src/sim";
import { F_ONEWAY, Liquid, Mat } from "../src/sim/grid";
import { generateLevel, themeFor } from "../src/sim/levelgen";
import { NavGraph } from "../src/sim/nav";
import { footing } from "../src/sim/sim-liquid";

beforeAll(async () => {
  await initPhysics();
});

const SPACE: Ruleset = validateRuleset({ arena: { enabledThemes: ["space"] }, round: { maxRounds: 1, winsToTake: 1 } });
const LOW = CLASSIC.arena.themes.space.physics.gravity;

describe("space (#127)", () => {
  test("it is in the default rotation", () => {
    const seeds = Array.from({ length: 120 }, (_, s) => s).filter((s) => themeFor(s) === "space");
    expect(seeds.length).toBeGreaterThan(5);
    expect(generateLevel(seeds[0]!).theme).toBe("space");
  });

  test("low gravity on the space map only: its rounds play it, every other theme plays the ruleset as it is", () => {
    expect(LOW).toBeLessThan(1);
    expect(themedRuleset(CLASSIC, "space").combat.gravity).toBeCloseTo(CLASSIC.combat.gravity * LOW, 6);
    for (const t of ["warehouse", "rooftop", "junkyard", "construction", "beach"] as const) {
      expect(CLASSIC.arena.themes[t].physics.gravity).toBe(1);
      expect(themedRuleset(CLASSIC, t)).toBe(CLASSIC);
      expect(CLASSIC.arena.themes[t].hazards.coolant).toBe(0);
    }
    const m = new Match(9, { souls: exampleSouls(), ruleset: SPACE });
    m.prepareRound();
    expect(m.fight!.sim.ruleset.combat.gravity).toBeCloseTo(CLASSIC.combat.gravity * LOW, 6);
  });

  test("levels: regolith over the rock frame, ice in it, coolant pools, steel and ice jump-through ledges", () => {
    let pools = 0, oneWay = 0, ice = 0, steel = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const lv = generateLevel(seed, undefined, SPACE);
      const g = lv.grid;
      expect(lv.theme).toBe("space");
      for (const p of lv.pools ?? []) expect(p.liquid).toBe(Liquid.Coolant);
      pools += lv.pools?.length ?? 0;
      for (let i = 0; i < g.mat.length; i++) {
        if (g.flags[i]! & F_ONEWAY && g.mat[i]) oneWay++;
        if (g.mat[i] === Mat.Ice) ice++;
        if (g.mat[i] === Mat.Steel) steel++;
      }
      const nav = NavGraph.fromGrid(g, 2, themedRuleset(SPACE, "space"));
      for (const sp of lv.spawns) expect(nav.surfaceAt(sp.x, sp.y + 0.05, 0)!.liquid).toBe(Liquid.None);
    }
    expect(pools).toBeGreaterThanOrEqual(12);
    expect(oneWay).toBeGreaterThan(100);
    expect(ice).toBeGreaterThan(100);
    expect(steel).toBeGreaterThan(100);
  });

  test("a standing jump goes higher and stays up longer than on a normal map", () => {
    const jump = (th: string) => {
      const R = validateRuleset({ arena: { enabledThemes: [th] }, round: { maxRounds: 1, winsToTake: 1 } });
      const m = new Match(3, { souls: exampleSouls(), ruleset: R });
      m.prepareRound();
      const sim = m.fight!.sim;
      const ctrls = (m.fight as unknown as { controllers: { think: (s: unknown) => Record<string, unknown> }[] }).controllers;
      for (const c of ctrls) {
        const think = c.think.bind(c);
        c.think = (s: unknown) => {
          const i = think(s);
          for (const k of Object.keys(i)) i[k] = typeof i[k] === "number" ? 0 : false;
          i.jump = (s as { tick: number }).tick === 90 && c === ctrls[0];
          return i;
        };
      }
      const f = sim.fighters[0]!;
      let y0 = 0, peak = -1e9, up = -1, land = -1;
      for (let t = 0; t < 400 && !m.step(); t++) {
        if (sim.tick === 89) y0 = sim.feetY(f);
        if (sim.tick > 90 && up < 0 && !f.grounded) up = sim.tick;
        if (up > 0) {
          peak = Math.max(peak, sim.feetY(f));
          if (f.grounded && land < 0 && sim.tick > up + 3) land = sim.tick;
        }
      }
      return { rise: peak - y0, air: land - up };
    };
    const normal = jump("warehouse"), low = jump("space");
    expect(low.rise / normal.rise).toBeGreaterThan(1.1);
    expect(low.air).toBeGreaterThan(normal.air);
  });

  test("coolant: slower than water, a fighter floats in it and swims out within 4 s (every fighter, seeds 1-12)", () => {
    let tried = 0, slowest = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const who of [0, 1, 2, 3]) {
        const m = new Match(seed, { souls: exampleSouls(), ruleset: SPACE });
        m.prepareRound();
        const sim = m.fight!.sim;
        const pool = sim.level.pools?.[0];
        if (!pool) continue;
        tried++;
        const f = sim.fighters[who]!;
        f.entity.body.setTranslation({ x: (pool.x0 + pool.x1) / 2, y: pool.y - 0.4 }, true);
        const slow = footing(sim, f).speed === SPACE.liquids.coolant.speedMul && SPACE.liquids.coolant.speedMul < SPACE.liquids.water.speedMul;
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

  test("a space match is deterministic, nobody dies in coolant, and a swimmer splashes once per 45 ticks at most", () => {
    const play = () => {
      const m = new Match(5, { souls: exampleSouls(), ruleset: SPACE });
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
    expect(a.causes).not.toContain("coolant");
  });
});
