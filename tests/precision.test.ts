/** Precision weapons, the accuracy model and the tactical map (#38). */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { CLASSIC, initPhysics, Mat, NO_INPUT, resolveRuleset, Sim, type Input, type Rule, type SimEvent, type Weapon } from "../src/sim";
import { spreadFor } from "../src/sim/sim-precision";
import { coverSpots, gridClear, hasLongGun, inCover, inOpen, onHighGround } from "../src/sim/tactical";
import { damageTerrainCell } from "../src/sim/sim-terrain";
import { Controller } from "../src/sim/controller";
import { flatLevel, idle, place, stepN } from "./helpers";

setDefaultTimeout(120_000);
beforeAll(initPhysics);

const W = CLASSIC.weapons.table;
const shoot = (weapon: Weapon, x = 1, y = 0, move = 0): Input[] => [{ ...NO_INPUT, weapon, fire: true, aimX: x, aimY: y, move }, NO_INPUT, NO_INPUT, NO_INPUT];

/** Flat level, optionally a brick wall at x (bottom at 0, `height` m tall); seats 2 and 3 parked far right. */
function range(wall?: { x: number; height: number }, seed = 2) {
  const level = flatLevel();
  const g = level.grid;
  if (wall) g.fillRect(g.cx(wall.x), g.cy(0), g.cx(wall.x), g.cy(wall.height - 0.01), Mat.Brick);
  const sim = new Sim(seed, level);
  sim.zoneEnabled = false;
  for (const item of sim.items()) item.body.setTranslation({ x: 0, y: -30 }, true);
  place(sim, 2, 22, 0.9);
  place(sim, 3, 25, 0.9);
  return sim;
}

function arm(sim: Sim, id: number, w: Weapon) {
  const f = sim.fighters[id]!;
  sim.applyItem(f, w);
  f.swap = 0;
  return f;
}

describe("precision weapons", () => {
  test("the rifle is hitscan: one round, one hit, ammo counts down, the next waits for the cooldown", () => {
    const sim = range();
    const me = place(sim, 0, -20, 0.9);
    const target = place(sim, 1, -6, 0.9);
    arm(sim, 0, "rifle");
    const ev = stepN(sim, 2, shoot("rifle"));
    const shots = ev.filter((e) => e.type === "shot");
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ weapon: "rifle", hit: "fighter", target: 1 });
    expect(target.hp).toBeCloseTo(100 - W.rifle.damage, 5);
    expect(me.ammo.rifle).toBe(W.rifle.ammo - 1);
    expect(me.cooldown.rifle).toBeGreaterThan(W.rifle.cooldown - 3);
  });

  test("the sniper aims for aimTicks with the laser on; letting go cancels; a full aim fires one big round", () => {
    const sim = range();
    const me = place(sim, 0, -20, 0.9);
    const target = place(sim, 1, 15, 0.9);
    arm(sim, 0, "sniper");
    const short = stepN(sim, W.sniper.aimTicks - 1, shoot("sniper"));
    expect(short.filter((e) => e.type === "scope")).toHaveLength(1);
    expect(short.some((e) => e.type === "shot")).toBe(false);
    expect(me.scope).toBe(W.sniper.aimTicks - 1);
    stepN(sim, 1); // let go
    expect(me.scope).toBe(0);
    expect(me.ammo.sniper).toBe(W.sniper.ammo);
    const full = stepN(sim, W.sniper.aimTicks, shoot("sniper"));
    const shot = full.find((e) => e.type === "shot");
    expect(shot).toMatchObject({ weapon: "sniper", hit: "fighter", target: 1 });
    expect(target.hp).toBeCloseTo(100 - W.sniper.damage, 5);
    expect(me.ammo.sniper).toBe(W.sniper.ammo - 1);
  });

  test("a crossbow bolt pins a fighter with a wall behind it, and shoves one in the open", () => {
    const sim = range({ x: -8, height: 2 });
    place(sim, 0, -20, 0.9);
    const pinned = place(sim, 1, -9, 0.9);
    arm(sim, 0, "crossbow");
    const ev = stepN(sim, 2, shoot("crossbow"));
    expect(ev.find((e) => e.type === "pin")).toMatchObject({ fighter: 1, by: 0 });
    expect(pinned.pinned).toBeGreaterThan(W.crossbow.pinTicks - 3);
    const x = sim.pos(pinned).x;
    stepN(sim, 20);
    expect(Math.abs(sim.pos(pinned).x - x)).toBeLessThan(0.05);

    const open = range();
    place(open, 0, -20, 0.9);
    const shoved = place(open, 1, -9, 0.9);
    arm(open, 0, "crossbow");
    const ev2 = stepN(open, 2, shoot("crossbow"));
    expect(ev2.some((e) => e.type === "pin")).toBe(false);
    expect(shoved.pinned).toBe(0);
    expect(open.vel(shoved).x).toBeGreaterThan(2);
  });
});

describe("accuracy model", () => {
  test("still is accurate; walking, jumping and the jetpack spread the shot; cover tightens it", () => {
    const acc = CLASSIC.weapons.accuracy;
    const sim = range();
    const me = place(sim, 0, -20, 0.9);
    place(sim, 1, 5, 0.9);
    stepN(sim, 10);
    expect(me.grounded).toBe(true);
    expect(spreadFor(sim, me, "sniper")).toBeCloseTo(acc.sniper.still, 9);
    me.entity.body.setLinvel({ x: CLASSIC.combat.fighter.walkSpeed, y: 0 }, true);
    expect(spreadFor(sim, me, "sniper")).toBeCloseTo(acc.sniper.still + acc.sniper.move, 6);
    me.grounded = false;
    expect(spreadFor(sim, me, "rifle")).toBeCloseTo(acc.rifle.still + acc.rifle.air, 9);
    me.jetting = true;
    expect(spreadFor(sim, me, "crossbow")).toBeCloseTo(acc.crossbow.still + acc.crossbow.jet, 9);

    const walled = range({ x: -18.5, height: 2 });
    const hid = place(walled, 0, -19.6, 0.9);
    place(walled, 1, 5, 0.9);
    stepN(walled, 10);
    expect(inCover(walled, hid)).toBe(true);
    expect(spreadFor(walled, hid, "rifle")).toBeCloseTo(acc.rifle.still * acc.coverMul, 9);
  });

  test("spread is seeded: the same shots land in the same places, and moving shots scatter wider", () => {
    const endpoints = (move: number) => {
      const sim = range(undefined, 9);
      place(sim, 0, -24, 0.9);
      place(sim, 1, 30, -30); // out of the way: rounds fly the full range
      arm(sim, 0, "rifle");
      sim.fighters[0]!.ammo.rifle = 99;
      const ys: number[] = [];
      for (let i = 0; i < 12; i++) {
        const ev = stepN(sim, W.rifle.cooldown + 1, shoot("rifle", 1, 0, move));
        for (const e of ev) if (e.type === "shot") ys.push(e.y1 - e.y0);
        place(sim, 0, -24, 0.9);
      }
      return ys;
    };
    const still = endpoints(0);
    expect(endpoints(0)).toEqual(still);
    const moving = endpoints(1);
    const spread = (ys: number[]) => Math.max(...ys) - Math.min(...ys);
    expect(still.length).toBeGreaterThan(8);
    expect(spread(moving)).toBeGreaterThan(spread(still) * 2);
  });
});

describe("tactical map", () => {
  test("cover spots sit beside walls, the platform is high ground, and grid sightlines stop at walls", () => {
    const sim = range({ x: -10, height: 1.5 });
    const spots = sim.tactical.cover.filter((c) => Math.abs(c.x + 9.75) < 2);
    expect(spots.length).toBeGreaterThan(0);
    for (const c of spots) expect(c.side).toBe(c.x < -10 ? 1 : -1);
    expect(sim.tactical.high.some((h) => h.y === 4 && h.x > -6 && h.x < 0)).toBe(true);
    expect(gridClear(sim.grid, -20, 1, -5, 1)).toBe(false);
    expect(gridClear(sim.grid, -20, 2, -5, 2)).toBe(true);
  });

  test("the map follows broken terrain: blast the wall and its cover spots are gone", () => {
    const sim = range({ x: -10, height: 1.5 });
    expect(sim.tactical.cover.some((c) => Math.abs(c.x + 9.75) < 2)).toBe(true);
    // break the wall cell by cell (no crater: a crater's sides would be new walls)
    const g = sim.grid;
    for (let cy = g.cy(0); cy <= g.cy(1.49); cy++) damageTerrainCell(sim, g.cx(-10), cy, g.matAt(g.cx(-10), cy), 9999);
    stepN(sim, 25);
    expect(sim.tactical.cover.some((c) => Math.abs(c.x + 9.75) < 2)).toBe(false);
  });

  test("crates make cover spots too, and a spot taken by a prop is not offered", () => {
    const sim = new Sim(2, flatLevel([{ kind: "steel", x: -12, y: 0 }]));
    stepN(sim, 30);
    const spots = coverSpots(sim).filter((c) => Math.abs(c.x + 12) < 2);
    expect(spots.length).toBe(2);
    expect(spots.map((c) => c.side).sort()).toEqual([-1, 1]);
  });

  test("in cover, in the open, long guns and high ground read the live fight", () => {
    const sim = range({ x: -18.5, height: 2 });
    const hid = place(sim, 0, -19.6, 0.9);
    const shooter = place(sim, 1, 5, 0.9);
    stepN(sim, 10);
    expect(inCover(sim, hid)).toBe(true);
    expect(inOpen(sim, shooter, hid)).toBe(false);
    expect(inCover(sim, shooter)).toBe(false);
    expect(inOpen(sim, hid, shooter)).toBe(false); // the wall blocks both ways
    expect(hasLongGun(sim, shooter)).toBe(false);
    arm(sim, 1, "sniper");
    expect(hasLongGun(sim, shooter)).toBe(true);
    place(sim, 1, -3, 4.9);
    stepN(sim, 10);
    expect(onHighGround(sim, shooter)).toBe(true);
    expect(onHighGround(sim, hid)).toBe(false);
  });
});

describe("plan rules on cover and long guns", () => {
  /** Seat 0 hides behind a 2 m wall from seat 1 (its target); the rules are evaluated on the still scene. */
  function scene(rules: Rule[], wall = true) {
    const sim = range(wall ? { x: -18.5, height: 2 } : undefined);
    place(sim, 0, -19.6, 0.9);
    place(sim, 1, 5, 0.9);
    stepN(sim, 10);
    const c = new Controller(0, 0);
    c.peers = [c, new Controller(1, 0), new Controller(2, 0), new Controller(3, 0)];
    c.setStrategy({ target: "grudge", grudge: 1, stance: "distance", weapons: ["rifle"], line: "", rules }, sim);
    c.targetId = 1;
    const fired = () => {
      sim.events = [];
      c.rules.dirty = true;
      c.rules.evaluate(sim, c, sim.fighters[0]!);
      return sim.events.filter((e): e is Extract<SimEvent, { type: "rule" }> => e.type === "rule" && e.on);
    };
    return { sim, c, fired };
  }

  test("in_cover fires behind the wall; has_long_gun fires once the enemy holds a sniper", () => {
    const { sim, fired } = scene([
      { when: "has_long_gun", who: "enemy", do: "stance", stance: "cover", label: "duck the long gun" },
      { when: "in_cover", do: "retaliate", retaliate: "ignore", label: "stay put" },
    ]);
    expect(fired().map((e) => e.rule)).toEqual([1]);
    arm(sim, 1, "sniper");
    sim.tick += CLASSIC.tactics.ruleEval.minOffTicks;
    expect(fired()).toMatchObject([{ rule: 0, subject: 1 }]);
  });

  test("in_open sees a target with a clear line, not one behind a wall", () => {
    const rule: Rule[] = [{ when: "in_open", who: "target", do: "use", doItem: "rifle", label: "take the shot" }];
    expect(scene(rule, false).fired()).toMatchObject([{ rule: 0, subject: 1 }]);
    expect(scene(rule, true).fired()).toEqual([]);
  });
});

describe("ruleset", () => {
  test("every precision and stance number is a ruleset field, and the long-gun list is validated", () => {
    expect(CLASSIC.weapons.table.sniper.aimTicks).toBeGreaterThan(0);
    expect(CLASSIC.weapons.accuracy.rifle.move).toBeGreaterThan(CLASSIC.weapons.accuracy.rifle.still);
    expect(CLASSIC.tactics.stances.longGuns).toEqual(["railgun", "rifle", "sniper", "crossbow"]);
    expect(resolveRuleset({ tactics: { stances: { longGuns: ["sniper"] } } }).tactics.stances.longGuns).toEqual(["sniper"]);
    expect(() => resolveRuleset({ tactics: { stances: { longGuns: ["laser"] } } })).toThrow(/tactics.stances.longGuns/);
    expect(() => resolveRuleset({ weapons: { accuracy: { coverMul: 2 } } })).toThrow(/coverMul/);
    expect(() => resolveRuleset({ tactics: { stances: { cover: { peekFor: 300 } } } })).toThrow(/peekFor/);
  });

  test("a ruleset without the long guns plays without them", () => {
    const rs = resolveRuleset({ weapons: { enabled: ["rocket", "shotgun", "bat"] } });
    const sim = new Sim(4, undefined, undefined, rs);
    expect(sim.items().some((e) => e.itemType === "sniper" || e.itemType === "rifle" || e.itemType === "crossbow")).toBe(false);
    stepN(sim, 5, idle());
  });
});
