import { beforeAll, expect, test } from "bun:test";
import { CLASSIC, Controller, initPhysics, Mat, NO_INPUT, resolveRuleset, Sim, type Ruleset, type Weapon } from "../src/sim";
import { inWeaponBand } from "../src/sim/controller-weapons";
import { flatLevel, idle } from "./helpers";

beforeAll(initPhysics);

function setup(weapons: [Weapon, Weapon], distance: number, opts: { wall?: Mat; wallDistance?: number; ruleset?: Ruleset; duel?: boolean } = {}) {
  const level = flatLevel();
  const grid = level.grid;
  // Keep the shot corridor open above waist-height test walls.
  for (let cx = grid.cx(-6); cx < grid.cx(0); cx++) grid.set(cx, grid.cy(4) - 1, Mat.Empty);
  const wallX = -18 + (opts.wallDistance ?? 2);
  if (opts.wall !== undefined) for (let y = grid.cy(0); y < grid.cy(2); y++) grid.set(grid.cx(wallX), y, opts.wall);
  const sim = new Sim(5, level, undefined, opts.ruleset);
  sim.zoneEnabled = false;
  for (const e of sim.items()) e.body.setTranslation({ x: 0, y: -35 }, true);
  const x = [-18, -18 + distance, 17, 22];
  for (const [i, f] of sim.fighters.entries()) {
    f.entity.body.setTranslation({ x: x[i]!, y: 0.9 }, true);
    f.entity.body.setLinvel({ x: 0, y: 0 }, true);
  }
  for (let tick = 0; tick < 12; tick++) sim.step(idle());
  const me = sim.fighters[0]!;
  me.weapons = [...weapons];
  me.slot = 0;
  me.ammo = { hammer: 1, mine: 1, railgun: 1 };
  me.fuel = 60;
  for (const w of Object.keys(me.cooldown) as Weapon[]) me.cooldown[w] = 0;
  if (opts.duel) for (const f of sim.fighters.slice(2)) sim.damageFighter(f, 10_000, -1, 0, 0, "test", 0, 0);
  const controller = new Controller(0, 0);
  controller.setStrategy({ target: "grudge", grudge: 1, stance: "distance", weapons, line: "" }, sim);
  return { sim, me, controller, wallX };
}

test("bat preference and slot order cannot displace a ranged weapon beyond melee reach", () => {
  for (const order of [["bat", "shotgun"], ["shotgun", "bat"]] as [Weapon, Weapon][]) {
    for (const meters of [3, 6.7, 8, 10, 15]) {
      const { controller, sim } = setup(order, meters);
      const input = controller.think(sim);
      expect(input.weapon).toBe("shotgun");
      expect(input.fire).toBe(order[0] === "shotgun" && meters <= 6.9);
    }
  }
});

test("hold the longest usable reach outside range, and consider cooldowns within range", () => {
  for (const ranged of ["shotgun", "railgun", "rocket", "grenade", "mine", "flamethrower", "grapple"] as const) {
    for (const melee of ["bat", "hammer", "fist"] as const) {
      const { sim, me, controller } = setup([melee, ranged], 19);
      me.cooldown[ranged] = 100;
      expect(controller.think(sim).weapon).toBe(ranged);
    }
  }
  const empty = setup(["bat", "mine"], 15);
  empty.me.ammo.mine = 0;
  expect(empty.controller.think(empty.sim).weapon).toBe("bat");
  const alternate = setup(["shotgun", "rocket"], 6);
  alternate.me.cooldown.shotgun = 100;
  expect(alternate.controller.think(alternate.sim).weapon).toBe("rocket");
  const far = setup(["grenade", "shotgun"], 18);
  expect(far.controller.think(far.sim).weapon).toBe("grenade");
});

test("shotgun and rocket breach by wall distance and preserve a carried railgun shot", () => {
  for (const [weapon, material, wallDistance] of [["shotgun", Mat.Brick, 1.5], ["rocket", Mat.Dirt, 4]] as const) {
    const { sim, me, controller, wallX } = setup([weapon, "railgun"], 9, { wall: material, wallDistance });
    const cell = sim.grid.idx(sim.grid.cx(wallX), sim.grid.cy(1));
    const hp = sim.grid.hp[cell]!;
    let fired = false;
    for (let i = 0; i < 30; i++) {
      const input = controller.think(sim);
      sim.step([{ ...input, move: 0, jump: false }, NO_INPUT, NO_INPUT, NO_INPUT]);
      fired ||= sim.events.some(e => e.type === "fire" && e.weapon === weapon);
      if (sim.grid.hp[cell]! < hp) break;
    }
    expect(fired).toBe(true);
    expect(sim.grid.hp[cell]!).toBeLessThan(hp);
    expect(me.ammo.railgun).toBe(1);
  }
});

test("bedrock blocks a direct shot, and grenades can lob over it", () => {
  const blocked = setup(["shotgun", "bat"], 9, { wall: Mat.Bedrock, duel: true });
  expect(blocked.controller.think(blocked.sim)).toMatchObject({ weapon: "shotgun", fire: false });
  expect(blocked.controller.goal).not.toBeNull();
  const grenade = setup(["grenade", "bat"], 9, { wall: Mat.Bedrock });
  const input = grenade.controller.think(grenade.sim);
  expect(input).toMatchObject({ weapon: "grenade", fire: true });
  expect(input.aimY).toBeGreaterThan(0.5);
});

test("a grenade lobs to the fighter when a nearby destructible is inside the blast safety band", () => {
  const { sim, controller } = setup(["grenade", "bat"], 9, { wall: Mat.Dirt, wallDistance: 2 });
  const input = controller.think(sim);
  expect(input).toMatchObject({ weapon: "grenade", fire: true });
  expect(input.aimY).toBeGreaterThan(0.5);
});

test("duel and breach use the same reach policy, and stand-off ignores slot order", () => {
  const duel = setup(["flamethrower", "shotgun"], 8, { duel: true, wall: Mat.Dirt });
  expect(duel.controller.think(duel.sim).weapon).toBe("shotgun");
  const goals = ([["bat", "shotgun"], ["shotgun", "bat"]] as [Weapon, Weapon][])
    .map(weapons => {
      const { sim, controller } = setup(weapons, 8);
      controller.think(sim);
      return controller.goal!.x - sim.pos(sim.fighters[1]!).x;
    });
  expect(goals[0]).toBe(goals[1]!);
  expect(Math.abs(goals[0]!)).toBeLessThanOrEqual(CLASSIC.tactics.weapons.reach.shotgun.max);
});

test("a ruleset can change reach within physical limits", () => {
  const custom = resolveRuleset({ tactics: { weapons: { reach: { shotgun: { max: 5 } } } } });
  const { sim, controller } = setup(["shotgun", "bat"], 6, { ruleset: custom });
  expect(inWeaponBand("shotgun", 6, CLASSIC)).toBe(true);
  expect(controller.think(sim)).toMatchObject({ weapon: "shotgun", fire: false });
  for (const reach of [{ min: 7, max: 6 }, { max: 8 }]) {
    expect(() => resolveRuleset({ tactics: { weapons: { reach: { shotgun: reach } } } })).toThrow(/tactics.weapons.reach.shotgun/);
  }
});
