/**
 * Contract: bots get out of bad terrain (#100). A house bot dropped into a pocket too deep to jump out of (3.5 m, walls
 * the nav graph cannot use) digs a ramp up its side with digging punches (Input.dig) and climbs out; with the escape switched off it
 * stays down there. Generated levels have few pits now: most have none.
 *
 * The scene is built by hand (no level generator), so it moves only when the escape, digging or movement change.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, Grid, initPhysics, Mat, NO_INPUT, resolveRuleset, Sim, generateLevel, type Input, type LevelDef } from "../src/sim";
import { Controller } from "../src/sim/controller";
import { ESCAPE } from "../src/sim/controller-escape";

beforeAll(async () => {
  await initPhysics();
});

/** no zone pressure, no drops, no pickups lying about */
const QUIET = resolveRuleset({ pickups: { supply: { firstTick: 36_000 }, armory: { nearSpawn: 0, middle: 0, high: 0, spread: { skyDrops: 0 } } } });
const F = CLASSIC.combat.fighter;

/** Dirt ground with its top at y = 0; a pocket 6 cells wide and 7 deep (x -1.5..1.5, floor at y -3.5). Seat 0 (a
 * house bot with fists) starts on its floor; the others stand still far to the right. */
function pocket(ticks: number) {
  const g = new Grid(100, 40, -25, -6);
  for (let cx = 0; cx < g.cols; cx++) for (let cy = 0; cy < 12; cy++) g.set(cx, cy, cy < 2 ? Mat.Bedrock : Mat.Dirt);
  for (let cx = 47; cx <= 52; cx++) for (let cy = 5; cy < 12; cy++) g.clear(cx, cy);
  const level: LevelDef = {
    seed: 1, attempt: 0, theme: "junkyard", name: "POCKET", width: 50, minX: -25, maxX: 25, grid: g,
    props: [], spawns: [{ x: 0, y: -3.5 }, { x: 15, y: 0 }, { x: 17, y: 0 }, { x: 19, y: 0 }],
    pits: [], zoneCenter: 0, platforms: 0, towers: 0, walls: [], bridges: 0,
  };
  const sim = new Sim(1, level, undefined, QUIET);
  sim.zoneEnabled = false;
  for (const it of sim.items()) sim.entityStore.remove(it);
  const spots: [number, number][] = [[0, -3.5], [15, 0], [17, 0], [19, 0]];
  sim.fighters.forEach((f, i) => {
    f.entity.body.setTranslation({ x: spots[i]![0], y: spots[i]![1] + F.halfHeight + F.radius + 0.02 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  });
  const inputs: Input[] = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
  for (let i = 0; i < 20; i++) sim.step(inputs);
  const me = sim.fighters[0]!;
  const c = new Controller(0, 0);
  c.peers = [c];
  c.setStrategy({ target: "nearest", stance: "rush", weapons: ["bat"], line: "" }, sim);
  let outAt = -1;
  while (sim.tick < ticks) {
    inputs[0] = c.think(sim);
    sim.step(inputs);
    if (outAt < 0 && sim.feetY(me) > -0.2 && Math.abs(sim.pos(me).x) > 1.6) outAt = sim.tick;
  }
  return { sim, me, c, outAt };
}

describe("getting out of bad terrain (#100)", () => {
  test("a bot in a pocket too deep to jump digs a ramp and climbs out", () => {
    // sheer 3.5 m walls on every side: the worst pocket; it is out in about 30 s (a blast crater has steps, and is quicker)
    const { outAt, c } = pocket(2400);
    expect(outAt).toBeGreaterThan(0);
    expect(c.escape.digs).toBeGreaterThan(0);
  });

  test("without the escape it stays down there (the old behaviour)", () => {
    const keep = ESCAPE.trappedFloor;
    ESCAPE.trappedFloor = 0;
    try {
      const { outAt, sim, me } = pocket(2400);
      expect(outAt).toBe(-1);
      expect(sim.feetY(me)).toBeLessThan(-2.5);
    } finally {
      ESCAPE.trappedFloor = keep;
    }
  });

  test("generated pits are rare: none in most levels, never more than one", () => {
    let pits = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const lv = generateLevel(seed, undefined, CLASSIC);
      expect(lv.pits.length).toBeLessThanOrEqual(1);
      pits += lv.pits.length;
    }
    expect(pits).toBeLessThanOrEqual(6);
  });
});
