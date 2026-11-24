/**
 * Contract: liquids and the #94 materials. Water floats a fighter (a slow sink, swim strokes) and puts fire out; oil
 * is lit by a blast and burns away; lava hurts, sets alight, melts the terrain beside it, melts ice into water and cools
 * to rock where it meets water; liquids and sand settle into carved terrain. Mud slows, ice slides. All deterministic,
 * and a level with none of it plays exactly as before (the golden hashes in sim.test.ts and levelgen.test.ts).
 *
 * The scene is built by hand (no level generator), so it moves only when liquids or materials change.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CELL, CLASSIC, Grid, initPhysics, Mat, Match, NO_INPUT, Sim, exampleSouls, generateLevel, type Input, type LevelDef, type SimEvent } from "../src/sim";
import { Liquid } from "../src/sim/grid";
import { NavGraph } from "../src/sim/nav";
import { validateRuleset, type Ruleset } from "../src/sim/ruleset";
import { igniteFighter } from "../src/sim/sim-ignite";
import { ALL_THEMES, themesJson } from "../src/sim/themes";

beforeAll(async () => {
  await initPhysics();
});

const TESTBED: Ruleset = validateRuleset({ arena: { enabledThemes: ["testbed"] }, round: { maxRounds: 1, winsToTake: 1 } });

/**
 * Dirt ground, top at y = 0 (cy 8), over bedrock. A water basin (cx 10-15, 4 cells deep), an oil basin (cx 24-27),
 * a lava basin (cx 40-43) with an ice cell on its right rim, a mud strip (cx 28-37) and an ice strip (cx 46-58) on top,
 * and a sand column (cx 61, cy 8-10).
 */
function scene() {
  const g = new Grid(80, 40, -20, -4);
  for (let cx = 0; cx < g.cols; cx++) for (let cy = 0; cy < 8; cy++) g.set(cx, cy, cy < 2 ? Mat.Bedrock : Mat.Dirt);
  const basin = (c0: number, c1: number, cy0: number, l: Liquid) => {
    for (let cx = c0; cx <= c1; cx++) for (let cy = cy0; cy < 8; cy++) {
      g.clear(cx, cy);
      g.liq[g.idx(cx, cy)] = l;
    }
  };
  basin(10, 15, 4, Liquid.Water);
  basin(24, 27, 6, Liquid.Oil);
  basin(40, 43, 6, Liquid.Lava);
  g.set(44, 7, Mat.Ice);
  for (let cx = 28; cx <= 37; cx++) g.set(cx, 7, Mat.Mud);
  for (let cx = 46; cx <= 58; cx++) g.set(cx, 7, Mat.Ice);
  for (let cy = 8; cy <= 10; cy++) g.set(61, cy, Mat.Sand);
  const level: LevelDef = {
    seed: 1, attempt: 0, theme: "warehouse", name: "LIQUIDS", width: 40, minX: -20, maxX: 20, grid: g,
    props: [], spawns: [{ x: 15, y: 0 }, { x: 16, y: 0 }, { x: 17, y: 0 }, { x: 18, y: 0 }],
    pits: [], zoneCenter: 0, platforms: 0, towers: 0, walls: [], bridges: 0,
  };
  const sim = new Sim(1, level, undefined, CLASSIC);
  sim.zoneEnabled = false;
  const events: SimEvent[] = [];
  const inputs: Input[] = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
  const run = (ticks: number, each?: () => void) => {
    for (let t = 0; t < ticks; t++) {
      sim.step(inputs);
      events.push(...sim.events);
      sim.events = [];
      each?.();
    }
  };
  const put = (id: number, x: number, y: number) => {
    const f = sim.fighters[id]!;
    f.entity.body.setTranslation({ x, y }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
    return f;
  };
  return { sim, g: sim.grid, events, inputs, run, put, count: (l: Liquid) => [...sim.grid.liq].filter((v) => v === l).length };
}

describe("liquids", () => {
  test("water: a fighter in it sinks slowly, swims up with jump, and stops burning", () => {
    const { sim, run, put, inputs, events } = scene();
    const f = put(0, -14.5 + 0.25, 1.5);
    igniteFighter(sim, f, -1, "test");
    let fastest = 0;
    run(90, () => (fastest = Math.min(fastest, sim.vel(f).y)));
    expect(sim.liquids.on).toBe(true);
    expect(f.burning).toBe(0);
    expect(events.some((e) => e.type === "douse" && e.fighter === 0)).toBe(true);
    expect(events.some((e) => e.type === "splash" && e.fighter === 0 && e.liquid === Liquid.Water)).toBe(true);
    // the fall is caught: it sinks no faster than sinkSpeed once in
    expect(sim.vel(f).y).toBeGreaterThanOrEqual(-sim.ruleset.liquids.water.sinkSpeed - 0.5);
    expect(f.alive).toBe(true);
    const low = sim.feetY(f);
    inputs[0] = { ...NO_INPUT, jump: true };
    let high = low;
    run(60, () => (high = Math.max(high, sim.feetY(f))));
    inputs[0] = NO_INPUT;
    expect(high).toBeGreaterThan(low + 0.6);
  });

  test("oil: a blast lights it, it burns fighters over it, then it is used up", () => {
    const { sim, run, events, count } = scene();
    expect(count(Liquid.Oil)).toBe(8);
    sim.explode(-7.5, 0.5, { radius: 1.2, damage: 0, knockback: 0, blockDamage: 0, terrainDamage: 0 }, "barrel", 2, 0, null);
    events.push(...sim.events);
    sim.events = [];
    expect(events.some((e) => e.type === "ignite" && e.what === "oil" && e.by === 2)).toBe(true);
    run(60);
    expect(sim.liquids.oilFires.size).toBe(8); // it spread through the pool
    run(sim.ruleset.liquids.oil.burnTicks + 30);
    expect(sim.liquids.oilFires.size).toBe(0);
    expect(count(Liquid.Oil)).toBe(0);
  });

  test("lava: hurts and sets alight, melts its rim, melts ice into water and cools to rock against it", () => {
    const { sim, g, run, put } = scene();
    const f = put(1, -0.25 + 0.5, 0.3);
    const hp = f.hp;
    run(40);
    expect(f.hp).toBeLessThan(hp);
    expect(f.burning).toBeGreaterThan(0);
    expect(f.lastHitCause).toBe("lava");
    put(1, 18, 0.5);
    run(30);
    // the ice cell on the rim became water, and the lava beside it rock
    expect(g.matAt(44, 7)).not.toBe(Mat.Ice);
    // (an island of rock in the lava: it comes loose as a piece, or stays)
    expect(g.liqAt(43, 7)).not.toBe(Liquid.Lava);
    expect(g.matAt(43, 7) === Mat.Rock || [...sim.entities.values()].some((e) => e.kind === "chunk" && e.cells!.some((c) => c.mat === Mat.Rock))).toBe(true);
    // the rim on the left is melting (hit points down), bedrock never
    const rim = g.hp[g.idx(39, 7)]!;
    expect(rim).toBeLessThan(CLASSIC.arena.terrain.hitPoints[Mat.Dirt]!);
    run(1200);
    expect(g.matAt(39, 7)).toBe(Mat.Empty);
    expect(g.matAt(41, 1)).toBe(Mat.Bedrock);
  });

  test("a carved wall lets a pool drain into the hole; sand falls into a hole under it; then it all rests", () => {
    const { sim, g, run, count } = scene();
    run(12); // the lava melts the ice on its rim into water first
    const water = count(Liquid.Water);
    for (let cx = 16; cx <= 18; cx++) for (let cy = 3; cy <= 7; cy++) sim.terrain.removeCell(cx, cy);
    for (let cy = 5; cy <= 7; cy++) sim.terrain.removeCell(61, cy);
    run(300);
    expect(count(Liquid.Water)).toBe(water);
    for (let cx = 16; cx <= 18; cx++) expect(g.liqAt(cx, 3)).toBe(Liquid.Water);
    expect(g.liqAt(10, 7)).toBe(Liquid.None); // the pool's top row went down into the hole
    // and it levelled: the surface is flat to within a cell
    const tops = [10, 12, 14, 16, 18].map((cx) => { let cy = 3; while (g.liqAt(cx, cy + 1) === Liquid.Water) cy++; return cy; });
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
    expect([5, 6, 7].map((cy) => g.matAt(61, cy))).toEqual([Mat.Sand, Mat.Sand, Mat.Sand]);
    expect(g.matAt(61, 8)).toBe(Mat.Empty);
    expect(sim.liquids.active).toBe(false);
  });

  test("mud slows a walk; ice keeps a fighter sliding", () => {
    const { sim, run, put, inputs } = scene();
    for (const id of [0, 1, 3]) put(id, -19 + id * 0.6, 0.9);
    const walk = (x: number) => {
      const f = put(2, x, 0.9);
      inputs[2] = { ...NO_INPUT, move: 1 };
      run(50);
      const v = sim.vel(f).x;
      inputs[2] = { ...NO_INPUT, move: 0 };
      const x0 = sim.pos(f).x;
      run(30);
      return { v, slide: sim.pos(f).x - x0 };
    };
    const mud = walk(-5.8);
    const plain = walk(11.8);
    const ice = walk(3.2);
    expect(mud.v).toBeLessThan(plain.v * 0.6);
    expect(ice.slide).toBeGreaterThan(plain.slide * 2);
  });
});

describe("themes as data", () => {
  test("tools/art/themes.json is the themes' looks (bun scripts/themes-json.ts)", () => {
    expect(readFileSync(join(import.meta.dir, "..", "tools", "art", "themes.json"), "utf8")).toBe(themesJson());
  });

  test("every theme is a valid ruleset theme, and the default rotation is the four plus the beach (#111), the forest (#114), the cave (#125) and space (#127)", () => {
    expect(validateRuleset({ arena: { enabledThemes: ALL_THEMES } }).arena.enabledThemes).toEqual(ALL_THEMES);
    expect(CLASSIC.arena.enabledThemes).toEqual(["warehouse", "rooftop", "junkyard", "construction", "beach", "forest", "cave", "space"]);
  });

  test("a ruleset saved before the #94 materials (8 hit points) still loads", () => {
    const hp = CLASSIC.arena.terrain.hitPoints.slice(0, 9);
    const r = validateRuleset({ arena: { terrain: { hitPoints: hp, density: CLASSIC.arena.terrain.density.slice(0, 9) } } });
    expect(r.arena.terrain.hitPoints).toEqual(CLASSIC.arena.terrain.hitPoints);
  });

  test("testbed levels: pools on flat ground, their floors tagged and fragile, nobody spawns in one", () => {
    let pools = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const lv = generateLevel(seed, undefined, TESTBED);
      expect(lv.theme).toBe("testbed");
      pools += lv.pools?.length ?? 0;
      const nav = NavGraph.fromGrid(lv.grid, 2, TESTBED);
      for (const p of lv.pools ?? []) {
        const floor = nav.surfaces.find((s) => s.liquid === p.liquid && s.x0 <= p.x0 + CELL && s.x1 >= p.x1 - CELL);
        expect(floor?.fragile).toBe(true);
      }
      for (const sp of lv.spawns) expect(nav.surfaceAt(sp.x, sp.y + 0.05, 0)!.liquid).toBe(Liquid.None);
    }
    expect(pools).toBeGreaterThanOrEqual(20);
  });

  test("a testbed match is deterministic", () => {
    const play = () => {
      const m = new Match(3, { souls: exampleSouls(), ruleset: TESTBED });
      m.prepareRound();
      for (let t = 0; t < 1500 && !m.step(); t++);
      return m.fight!.sim.hash();
    };
    expect(play()).toBe(play());
  });
});
