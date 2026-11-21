import { beforeAll, describe, expect, test } from "bun:test";
import { DT, initPhysics, NO_INPUT, Sim } from "../src/sim";
import { CLASSIC, CLOSE_QUARTERS, resolveRuleset } from "../src/sim/ruleset";
import { ALL_MAX_VIEW_HEIGHT, viewAllTarget } from "../src/viewer/scene-camera";
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

  test("Close Quarters has no launch cap, full stacking and no ceilings", () => {
    expect(CLOSE_QUARTERS.combat.launch).toEqual({ maxUpSpeed: 36_000, stackRetention: 1, ceilingAbove: 0, ceilingDrag: 0 });
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

describe("View all framing (#41)", () => {
  const W = 1280;
  const H = 720;
  test("a fighter far above does not zoom the frame out past the cap; the lowest fighters stay in view", () => {
    const t = viewAllTarget([{ x: -4, y: 0.9, frame: true }, { x: 4, y: 1, frame: true }, { x: 0, y: 60, frame: true }], W, H);
    const viewH = H / t.s;
    expect(viewH).toBeCloseTo(ALL_MAX_VIEW_HEIGHT, 6);
    expect(t.cy - viewH / 2).toBeLessThan(0.9 - 3); // ground fighters ~3 m above the bottom edge
    expect(t.cy + viewH / 2).toBeLessThan(60); // the high one is above the frame: an edge marker
  });

  test("fighters spread wide still all fit across", () => {
    const t = viewAllTarget([{ x: -30, y: 0, frame: true }, { x: 30, y: 0, frame: true }], W, H);
    expect(W / t.s).toBeGreaterThanOrEqual(60);
  });

  test("below the cap the framing is unchanged", () => {
    const pts = [{ x: -5, y: 0, frame: true }, { x: 5, y: 9, frame: true }];
    const t = viewAllTarget(pts, W, H);
    const s = Math.min(W / (10 + 7), H / (9 + 5 + 1.5));
    expect(t.s).toBeCloseTo(s, 9);
    expect(t.cy).toBeCloseTo(Math.max(0 - 3.2 + H / s / 2, 4.5 + 0.8), 9);
  });
});
