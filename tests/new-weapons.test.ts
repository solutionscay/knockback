import { beforeAll, expect, test } from "bun:test";
import { initPhysics, Mat, NO_INPUT, Sim, WEAPONS, type Weapon } from "../src/sim";
import { flatLevel, idle, place, sandbox, stepN } from "./helpers";

beforeAll(initPhysics);
const shoot = (weapon: Weapon, x = 1, y = 0) => [{ ...NO_INPUT, weapon, fire: true, aimX: x, aimY: y }];

test("a mine sticks to a fighter, follows its host, then arms and blasts on proximity", () => {
  const sim = sandbox();
  const me = sim.fighters[0]!;
  const target = sim.fighters[1]!;
  sim.applyItem(me, "mine");
  me.swap = 0;
  const events = stepN(sim, 18, shoot("mine"));
  expect(events.some(e => e.type === "mineStick")).toBe(true);
  expect(sim.mines[0]?.mount).toMatchObject({ kind: "entity", id: target.entity.id });
  expect(me.ammo.mine).toBe(WEAPONS.mine.ammo - 1);
  expect(target.hp).toBe(100);
  const oldX = sim.mines[0]!.x;
  place(sim, target.id, -15.4, 0.9);
  stepN(sim, 1);
  expect(sim.mines[0]!.x).toBeGreaterThan(oldX + 0.4);
  const blast = stepN(sim, WEAPONS.mine.armTicks);
  expect(blast.find(e => e.type === "explosion")).toMatchObject({ kind: "mine", owner: me.id });
  expect(target.hp).toBeLessThan(100);
});

test.each(["terrain", "prop"] as const)("a mine sticks to %s and has a timed fallback fuse", kind => {
  const sim = sandbox(kind === "prop" ? [{ kind: "steel", x: -17, y: 0 }] : []);
  place(sim, 1, 5, 0.9);
  const me = sim.fighters[0]!;
  sim.applyItem(me, "mine");
  me.swap = 0;
  const early = stepN(sim, 30, shoot("mine", 1, kind === "terrain" ? -0.8 : -0.08));
  expect(early.some(e => e.type === "mineStick")).toBe(true);
  expect(sim.mines[0]!.mount?.kind).toBe(kind === "terrain" ? "terrain" : "entity");
  const later = stepN(sim, WEAPONS.mine.fuse);
  expect(later.find(e => e.type === "explosion")).toMatchObject({ kind: "mine" });
});

test("rail charge cancels when released, then pierces one thin wall and two fighters", () => {
  const level = flatLevel();
  const g = level.grid;
  g.fillRect(g.cx(-18), g.cy(0), g.cx(-18), g.cy(2), Mat.Brick);
  const sim = new Sim(2, level);
  for (const item of sim.items()) item.body.setTranslation({ x: 0, y: -30 }, true);
  sim.zoneEnabled = false;
  const me = place(sim, 0, -21, 0.9);
  const a = place(sim, 1, -16, 0.9);
  const b = place(sim, 2, -14, 0.9);
  place(sim, 3, 22, 0.9);
  sim.applyItem(me, "railgun");
  me.swap = 0;
  const spec = WEAPONS.railgun;
  const held = shoot("railgun");
  const short = stepN(sim, spec.chargeTicks - 1, held);
  expect(short.some(e => e.type === "railCharge")).toBe(true);
  expect(short.some(e => e.type === "rail")).toBe(false);
  stepN(sim, 1);
  expect(me.railCharge).toBe(0);
  expect(me.ammo.railgun).toBe(spec.ammo);
  const shot = stepN(sim, spec.chargeTicks, held);
  expect(shot.filter(e => e.type === "hit" && e.cause === "railgun")).toHaveLength(2);
  expect(a.hp).toBeLessThan(100);
  expect(b.hp).toBeLessThan(100);
  expect(me.cooldown.railgun).toBe(spec.cooldown);
});

test("a rail shot spends its penetration budget inside a thick wall", () => {
  const level = flatLevel();
  const g = level.grid;
  g.fillRect(g.cx(-19), g.cy(0), g.cx(-17), g.cy(2), Mat.Brick);
  const sim = new Sim(2, level);
  for (const item of sim.items()) item.body.setTranslation({ x: 0, y: -30 }, true);
  const me = place(sim, 0, -21, 0.9);
  const target = place(sim, 1, -16, 0.9);
  sim.applyItem(me, "railgun");
  me.swap = 0;
  const ev = stepN(sim, WEAPONS.railgun.chargeTicks, shoot("railgun")).find(e => e.type === "rail");
  expect(ev?.x1).toBeLessThan(-18);
  expect(target.hp).toBe(100);
});

test("a hammer wave throws rivals outward, breaks a wall, and preserves its floor", () => {
  const level = flatLevel();
  const g = level.grid;
  g.fillRect(g.cx(-18.5), g.cy(0), g.cx(-18.5), g.cy(1), Mat.Brick);
  const sim = new Sim(4, level);
  for (const item of sim.items()) item.body.setTranslation({ x: 0, y: -30 }, true);
  const me = place(sim, 0, -19.7, 0.9);
  const left = place(sim, 1, -22, 0.9);
  const right = place(sim, 2, -17, 0.9);
  place(sim, 3, 22, 0.9);
  sim.applyItem(me, "hammer");
  me.swap = 0;
  const ev = stepN(sim, 1, shoot("hammer"));
  expect(ev.some(e => e.type === "shockwave")).toBe(true);
  expect(sim.vel(left).x).toBeLessThan(-3);
  expect(sim.vel(right).x).toBeGreaterThan(3);
  expect(sim.grid.solidAt(-18.4, 0.25)).toBe(false);
  expect(sim.grid.solidAt(-18.4, -0.25)).toBe(true);
});

test("a hammer wave does not bridge a break in the floor", () => {
  const sim = sandbox();
  const me = place(sim, 0, 9.3, 0.9);
  const other = place(sim, 1, 12, 0.9);
  sim.applyItem(me, "hammer");
  me.swap = 0;
  const ev = stepN(sim, 1, shoot("hammer")).find(e => e.type === "shockwave");
  expect(ev?.paths[1]?.at(-1)?.x).toBeLessThan(10.2);
  expect(other.hp).toBe(100);
});
