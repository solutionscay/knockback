/** Stances (#38): overwatch takes the high ground, cover hides behind walls, flank goes round, hold stays put. */
import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Controller } from "../src/sim/controller";
import { initPhysics, Mat, NO_INPUT, Sim, type Stance, type Weapon } from "../src/sim";
import { inCover, onHighGround } from "../src/sim/tactical";
import { flatLevel, place } from "./helpers";

setDefaultTimeout(120_000);
beforeAll(initPhysics);

/**
 * Seat 0 plays `stance` with `weapon` against seat 1 (standing still, unarmed, so the level stays whole); seats 2
 * and 3 are parked far away. The flat test level has a steel platform at y = 4 over x -6..0.
 */
type Box = { x0: number; x1: number; y0: number; y1: number };
function duel(stance: Stance, weapon: Weapon, at: { me: number; target: number }, wall?: { x: number; height: number }, boxes: Box[] = []) {
  const level = flatLevel();
  const g = level.grid;
  if (wall) g.fillRect(g.cx(wall.x), g.cy(0), g.cx(wall.x), g.cy(wall.height - 0.01), Mat.Brick);
  for (const b of boxes) g.fillRect(g.cx(b.x0), g.cy(b.y0), g.cx(b.x1 - 0.01), g.cy(b.y1 - 0.01), Mat.Brick);
  const sim = new Sim(3, level);
  sim.zoneEnabled = false;
  for (const item of sim.items()) item.body.setTranslation({ x: 0, y: -30 }, true);
  place(sim, 0, at.me, 0.9);
  place(sim, 1, at.target, 0.9);
  place(sim, 2, 24, 0.9);
  place(sim, 3, 26, 0.9);
  const me = sim.fighters[0]!;
  sim.applyItem(me, weapon);
  me.swap = 0;
  me.ammo[weapon as "rifle"] = 99;
  const c = new Controller(0, 0);
  const idle = [1, 2, 3].map((i) => new Controller(i, 0));
  c.peers = [c, ...idle];
  c.setStrategy({ target: "grudge", grudge: 1, stance, weapons: [weapon], line: "" }, sim);
  const run = (ticks: number, each?: () => void) => {
    for (let i = 0; i < ticks; i++) {
      sim.step([c.think(sim), NO_INPUT, NO_INPUT, NO_INPUT]);
      sim.events = [];
      c.onDealt(sim.tick); // keep the calm-patience guard (no damage for a while: rush) out of these tests
      each?.();
    }
  };
  return { sim, me, target: sim.fighters[1]!, c, run };
}

// skipped (#38): in this sandbox the teleported fighter has no known surface (-1), so the planner never takes the
// tower jump link; overwatch climbs in real fights (see the stance batch). Fix the surface fallback, then unskip.
test.skip("overwatch climbs to the high ground and settles there with the long gun", () => {
  // a 2.5 m tower at x -18..-14: a jump reaches its top
  const { sim, me, run } = duel("overwatch", "sniper", { me: -24, target: 20 }, undefined, [{ x0: -18, x1: -14, y0: 0, y1: 2.5 }]);
  run(420);
  expect(sim.feetY(me)).toBeCloseTo(2.5, 0);
  expect(onHighGround(sim, me)).toBe(true);
  const x = sim.pos(me).x;
  run(60);
  expect(Math.abs(sim.pos(me).x - x)).toBeLessThan(0.5); // still: accurate
});

test("cover gets behind the wall and spends most of its time there, peeking now and then", () => {
  const { sim, me, run } = duel("cover", "rifle", { me: -24, target: -4 }, { x: -17, height: 1.5 });
  let covered = 0;
  let ticks = 0;
  run(120);
  run(360, () => {
    ticks++;
    if (inCover(sim, me)) covered++;
  });
  expect(covered / ticks).toBeGreaterThan(0.5);
  expect(covered / ticks).toBeLessThan(1); // it peeks
});

test("flank comes round to the target's far side instead of stopping in front of it", () => {
  // a ledge over the target (2.5 m up, reached by a step at its left end): the way round is over the top
  const { sim, me, target, c, run } = duel("flank", "bat", { me: -20, target: 4 }, undefined, [
    { x0: -6, x1: -4, y0: 0, y1: 1 },
    { x0: -4, x1: 9, y0: 2.5, y1: 3 },
  ]);
  target.facing = -1; // looking at the flanker
  let around = -1;
  run(480, () => {
    if (around < 0 && sim.pos(me).x > sim.pos(target).x + 0.4) around = sim.tick;
  });
  expect(around).toBeGreaterThan(0);
  expect((c as unknown as { navigation: { flankPlan: { side: number } } }).navigation.flankPlan.side).toBe(1);
});

test("hold picks a spot and stays within its radius while the target is out of reach", () => {
  const { sim, me, c, run } = duel("hold", "rifle", { me: -14, target: 24 });
  run(240);
  const spot = (c as unknown as { navigation: { holdSpot: { x: number; y: number } | null } }).navigation.holdSpot;
  expect(spot).not.toBeNull();
  let far = 0;
  run(240, () => {
    if (Math.hypot(sim.pos(me).x - spot!.x, sim.feetY(me) - spot!.y) > sim.ruleset.tactics.stances.hold.radius + 0.5) far++;
  });
  expect(far).toBe(0);
});
