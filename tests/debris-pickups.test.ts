/**
 * Debris on the way to a pickup (#163): the nav graph is built from the grid only, so crates, props and broken-off
 * chunks are not in it. A bare-handed house bot going for the one bat with a stack of three crates in the way punches
 * through what it cannot hop over, and takes a pickup that lies under a prop from the floor beside it (not from on top,
 * where the body can't reach down). Hand-built scenes on generated levels; no real time, no network.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, initPhysics, NO_INPUT, resolveRuleset, Sim, type Input } from "../src/sim";
import { Controller } from "../src/sim/controller";
import { generateLevel } from "../src/sim/levelgen";
import { NavGraph } from "../src/sim/nav";
import { addProp } from "../src/sim/sim-objects";

beforeAll(async () => {
  await initPhysics();
});

const F = CLASSIC.combat.fighter;
/** no zone pressure, no drops, no pickups lying about */
const QUIET = resolveRuleset({ pickups: { supply: { firstTick: 36_000 }, armory: { nearSpawn: 0, middle: 0, high: 0, spread: { skyDrops: 0 } } } });

/**
 * Level `seed` without its props: seat 0 (house controller, item stance) on the longest dry surface, 1 m from its left
 * end; a stack of three crates 4 m along, the bat 7 m along; the other seats parked on other surfaces. Ticks until it
 * holds the bat (or `ticks` pass).
 */
function crateWall(seed: number, ticks: number) {
  const lv = generateLevel(seed, undefined, QUIET);
  lv.props = [];
  const nav = NavGraph.fromGrid(lv.grid, 2, QUIET);
  const s = nav.surfaces.filter((q) => !q.liquid && !q.oneWay && q.x1 - q.x0 >= 12).sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))[0]!;
  const others = nav.surfaces.filter((q) => q.id !== s.id && !q.liquid && q.x1 - q.x0 >= 2).slice(0, 3);
  const sim = new Sim(1, lv, undefined, QUIET);
  sim.zoneEnabled = false;
  for (const it of sim.items()) sim.entityStore.remove(it);
  const spots: [number, number][] = [[s.x0 + 1, s.y], ...others.map((q) => [(q.x0 + q.x1) / 2, q.y] as [number, number])];
  sim.fighters.forEach((f, i) => {
    f.entity.body.setTranslation({ x: spots[i]![0], y: spots[i]![1] + F.halfHeight + F.radius + 0.02 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  });
  const inputs: Input[] = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
  for (const k of [0, 1, 2]) addProp(sim, "crate", s.x0 + 5, s.y + k * 0.8 + 0.01);
  sim.spawnItem("bat", s.x0 + 8, s.y + 0.3);
  for (let i = 0; i < 40; i++) sim.step(inputs); // settle
  const me = sim.fighters[0]!;
  const c = new Controller(0, 0);
  c.peers = [c];
  c.setStrategy({ target: "nearest", stance: "item", weapons: ["bat"], line: "" }, sim);
  let punched = 0;
  while (sim.tick < ticks && !me.pickups.includes("bat")) {
    inputs[0] = c.think(sim);
    if (inputs[0].fire) punched++;
    sim.step(inputs);
  }
  return { got: me.pickups.includes("bat"), tick: sim.tick, punched };
}

describe("debris on the way to a pickup (#163)", () => {
  test("a crate stack in the way: punched through, the bat taken (before #163 seeds 7 and 10 never got it in 25 s)", () => {
    // seed 10: the stack falls across the way under a low roof; it punches through, then takes the bat from beside the
    // crate lying on it. Seed 7: it punches, gives the bat up a while, and gets it on the next try
    const ten = crateWall(10, 1500), seven = crateWall(7, 1500);
    expect(ten.got).toBe(true);
    expect(ten.punched).toBeGreaterThan(0);
    expect(ten.tick).toBeLessThan(400);
    expect(seven.got).toBe(true);
    expect(seven.tick).toBeLessThan(1200);
  }, 30_000);

  test("seeds 1-6 and 12: the bat is taken within 5 s (seed 2 took 7.8 s before #163)", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 12]) {
      const r = crateWall(seed, 1500);
      expect(r.got).toBe(true);
      expect(r.tick).toBeLessThan(300);
    }
  }, 30_000);
});
