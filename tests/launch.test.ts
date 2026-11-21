import { beforeAll, describe, expect, test } from "bun:test";
import { DT, initPhysics, NO_INPUT, Sim } from "../src/sim";
import { CLASSIC, CLOSE_QUARTERS, resolveRuleset, UNCAPPED_LAUNCH } from "../src/sim/ruleset";
import { flatLevel, place, sandbox, stepN } from "./helpers";

beforeAll(initPhysics);

const launch = CLASSIC.combat.launch;
const kick = (sim: Sim, id: number, kbx: number, kby: number) => sim.damageFighter(sim.fighters[id]!, 0, -1, kbx, kby, "rocket", 0, 0);

describe("launch height (#41)", () => {
  test("a launch never rises faster than maxUpSpeed; sideways speed is kept", () => {
    const sim = sandbox();
    kick(sim, 0, 30, 40);
    expect(sim.vel(sim.fighters[0]!).y).toBe(launch.maxUpSpeed);
    expect(sim.vel(sim.fighters[0]!).x).toBeCloseTo(30, 6);
  });

  test("extra kicks in the same tick keep less of their upward push", () => {
    const sim = sandbox();
    for (let i = 0; i < 3; i++) kick(sim, 0, 1, 4);
    const r = launch.stackRetention;
    expect(sim.vel(sim.fighters[0]!).y).toBeCloseTo(4 + 4 * r + 4 * r * r, 6);
    // sideways pushes still add up in full
    expect(sim.vel(sim.fighters[0]!).x).toBeCloseTo(3, 6);
    // the next tick starts a new stack
    sim.step([NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT]);
    const before = sim.vel(sim.fighters[0]!).y;
    kick(sim, 0, 0, 4);
    expect(sim.vel(sim.fighters[0]!).y).toBeCloseTo(Math.max(before * 0.3, 0) + 4, 6);
  });

  test("the top platform sets the ceilings", () => {
    expect(sandbox().topY).toBe(4); // the flat level's floating platform
  });

  test("above the soft ceiling upward speed decays; below it, it does not", () => {
    const rise = (y: number) => {
      const sim = sandbox();
      const f = place(sim, 0, -20, y);
      f.entity.body.setLinvel({ x: 0, y: 12 }, true);
      sim.step([NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT]);
      return sim.vel(f).y;
    };
    const low = rise(4 + launch.ceilingAbove - 2);
    const high = rise(4 + launch.ceilingAbove + 2);
    expect(low).toBeGreaterThan((12 - 20 * DT) * 0.99); // gravity and the body's light damping only
    expect(high).toBeLessThan(low * (1 - launch.ceilingDrag * DT) + 1e-3);
    expect(high).toBeGreaterThan(0); // drag, not a wall
  });

  test("a jetpack stops climbing near its ceiling above the highest platform", () => {
    const sim = sandbox();
    const f = sim.fighters[0]!;
    sim.applyItem(f, "jetpack");
    f.power.jetpack = 600;
    let peak = -Infinity;
    for (let i = 0; i < 400; i++) {
      stepN(sim, 1, [{ ...NO_INPUT, thrust: true }]);
      peak = Math.max(peak, sim.feetY(f));
    }
    expect(peak).toBeGreaterThan(sim.topY + CLASSIC.pickups.power.jetpack.ceiling - CLASSIC.pickups.power.jetpack.fade);
    expect(peak).toBeLessThan(sim.topY + CLASSIC.pickups.power.jetpack.ceiling + 0.5);
  });

  test("Close Quarters keeps launches as they were", () => {
    expect(CLOSE_QUARTERS.combat.launch).toEqual(UNCAPPED_LAUNCH);
    const sim = new Sim(1, flatLevel(), undefined, CLOSE_QUARTERS);
    sim.zoneEnabled = false;
    stepN(sim, 30);
    for (let i = 0; i < 3; i++) kick(sim, 0, 0, 20);
    expect(sim.vel(sim.fighters[0]!).y).toBeCloseTo(60, 6);
  });

  test("the ruleset validates launch settings", () => {
    expect(() => resolveRuleset({ combat: { launch: { stackRetention: 1.5 } } })).toThrow("combat.launch.stackRetention: expected a value from 0 to 1");
    expect(() => resolveRuleset({ combat: { launch: { maxUpSpeed: -1 } } })).toThrow("combat.launch.maxUpSpeed");
    expect(resolveRuleset({ combat: { launch: { maxUpSpeed: 20 } } }).combat.launch).toEqual({ ...launch, maxUpSpeed: 20 });
  });
});
