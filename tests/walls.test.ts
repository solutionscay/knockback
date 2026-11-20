import { beforeAll, expect, test } from "bun:test";
import { Controller, initPhysics, Mat, Sim, WEAPONS } from "../src/sim";
import { WALL_PURSUIT } from "../src/sim/controller-wall";
import { flatLevel, idle, place } from "./helpers";

beforeAll(initPhysics);

test("a blocked pursuit aims at the wall before switching to another living rival", () => {
  const level = flatLevel();
  const g = level.grid;
  g.fillRect(g.cx(-18), g.cy(0), g.cx(-18), g.cy(4.5), Mat.Brick);
  const sim = new Sim(1, level);
  sim.zoneEnabled = false;
  const me = place(sim, 0, -18.85, 0.9);
  place(sim, 1, -16, 0.9);
  place(sim, 2, -23, 0.9);
  place(sim, 3, -26, 0.9);
  me.cooldown.fist = 0;

  const controller = new Controller(0, 0);
  controller.setStrategy({ target: "grudge", grudge: 1, stance: "cover", weapons: [], line: "" }, sim);
  const start = sim.tick;
  controller.think(sim);
  expect(controller.targetId).toBe(1);
  // Keep the fighters in place to test recovery from a continuous obstruction.
  for (let elapsed = 1; elapsed < WALL_PURSUIT.attackTicks; elapsed++) {
    sim.tick = start + elapsed;
    controller.think(sim);
  }
  sim.tick = start + WALL_PURSUIT.attackTicks;
  const input = controller.think(sim);
  expect(input.weapon).toBe("fist");
  expect(input.fire).toBe(true);
  expect(input.aimX).toBeGreaterThan(0.8);

  for (let elapsed = WALL_PURSUIT.attackTicks + 1; elapsed <= WALL_PURSUIT.retargetTicks + 1; elapsed++) {
    sim.tick = start + elapsed;
    controller.think(sim);
  }
  expect(controller.targetId).toBe(2);
});

test("a rocket carves the far side of a thin brick wall", () => {
  const level = flatLevel();
  const g = level.grid;
  const from = g.cx(-20.5);
  const to = g.cx(-19.5);
  g.fillRect(from, g.cy(0), to, g.cy(2), Mat.Brick);
  const sim = new Sim(1, level);
  sim.step(idle());
  sim.explode(-21, 1.25, WEAPONS.rocket, "rocket", 0, 0, null);
  expect(sim.grid.solid(to, g.cy(1))).toBe(false);
});
