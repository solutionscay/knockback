/**
 * A decided round is over for the arena too: once one fighter (or none) is left, the walls stop closing in and
 * pushing, and no more supply drops fall, through the finish and the celebrate screen (the viewer's afterglow).
 */
import { beforeAll, expect, test } from "bun:test";
import { Fight } from "../src/sim/fight";
import { initPhysics } from "../src/sim/sim";
import type { Strategy } from "../src/sim/sim-types";

beforeAll(async () => {
  await initPhysics();
});

const PLANS: Strategy[] = [
  { target: "weakest", stance: "rush", weapons: ["rocket", "bat"], retaliate: "attacker", line: "" },
  { target: "nearest", stance: "rush", weapons: ["shotgun"], line: "" },
  { target: "nearest", stance: "rush", weapons: ["grenade"], line: "" },
  { target: "leader", stance: "rush", weapons: ["bat"], line: "" },
];

test("after the round is decided, the walls stop and nothing more drops", () => {
  const f = new Fight(1001, PLANS);
  const sim = f.sim;
  while (!f.over && sim.alive().length > 1) f.step();
  expect(sim.alive().length).toBeLessThanOrEqual(1);
  f.playToEnd();
  const half = sim.zone.half;
  const drops = (sim as unknown as { supplyCount: number }).supplyCount;
  const interval = sim.ruleset.pickups.supply.interval;
  // the celebrate screen keeps the world moving: longer than one supply interval
  for (let i = 0; i < Math.max(30 * 60, interval * 2); i++) f.stepAfterglow();
  expect(sim.zone.half).toBe(half);
  expect((sim as unknown as { supplyCount: number }).supplyCount).toBe(drops);
  for (const fi of sim.fighters) if (fi.alive) expect(fi.outsideTicks ?? 0).toBe(0);
});
