import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT, G, groups, SPEED_ACCEL_MUL } from "./constants";
import type { Sim } from "./sim";
import { ALL_WEAPONS, type Entity, type Fighter, type Input } from "./sim-types";
import type { Ruleset } from "./ruleset";
import { type Look } from "./identity";
import { clamp, length2D } from "./dmath";
import { fire } from "./sim-weapons";
import { dropCarried } from "./sim-items";
import { fighterStats, type Build } from "./build";
import { footing, setSlick } from "./sim-liquid";
import { FIGHTER_FILTER } from "./sim-oneway";

export function addFighter(sim: Sim, id: number, def: Look, x: number, y: number, build: Build) {
  const stats = fighterStats(sim.ruleset, build);
  const body = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y + sim.ruleset.combat.fighter.halfHeight + sim.ruleset.combat.fighter.radius + 0.05)
      .lockRotations()
      .setCcdEnabled(true)
      .setLinearDamping(0.1),
  );
  const collider = sim.world.createCollider(
    RAPIER.ColliderDesc.capsule(sim.ruleset.combat.fighter.halfHeight, sim.ruleset.combat.fighter.radius)
      .setDensity(stats.density)
      .setFriction(0)
      .setRestitution(0)
      .setCollisionGroups(groups(G.FIGHTER, FIGHTER_FILTER)),
    body,
  );
  const e: Entity = {
    id: sim.entityStore.allocateId(),
    kind: "fighter",
    body,
    collider,
    hw: sim.ruleset.combat.fighter.radius,
    hh: sim.ruleset.combat.fighter.halfHeight + sim.ruleset.combat.fighter.radius,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    dead: false,
    born: 0,
  };
  const s = sim.nav.surfaceAt(x, y + 0.05);
  const f: Fighter = {
    id,
    name: def.name,
    color: def.color,
    look: { ...def },
    prefs: sim.ruleset.weapons.enabled.slice(),
    entity: e,
    build: { ...build },
    stats,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    alive: true,
    koTick: -1,
    koCause: null,
    koBy: -1,
    facing: x < sim.zone.center ? 1 : -1,
    aimX: x < sim.zone.center ? 1 : -1,
    aimY: 0,
    weapons: ["fist", "fist"],
    slot: 0,
    swap: 0,
    // nobody fires on the first frame
    cooldown: { rocket: 45 + id * 7, shotgun: 30, bat: 20, grenade: 60, grapple: 40, flamethrower: 20, fist: 20, mine: 0, railgun: 0, hammer: 0, rifle: 0, sniper: 0, crossbow: 0, lightning: 0 },
    ammo: { rocket: 0, shotgun: 0, bat: 0, grenade: 0, grapple: 0, flamethrower: 0, mine: 0, railgun: 0, hammer: 0, rifle: 0, sniper: 0, crossbow: 0, lightning: 0 },
    railCharge: 0,
    scope: 0,
    pinned: 0,
    stun: 0,
    jumpCd: 0,
    airJumped: false,
    dropTicks: 0,
    wallSide: 0,
    grounded: false,
    surface: s ? s.id : -1,
    lastHitBy: -1,
    lastHitTick: -9999,
    lastHitCause: "",
    kbTick: -1,
    kbStack: 0,
    shieldTick: -1,
    padCd: 0,
    crushCd: 0,
    burning: 0,
    burnBy: -1,
    burnCause: "",
    shockCd: 0,
    outsideZone: false,
    outsideTicks: 0,
    power: { shield: 0, shieldHits: 0, speed: 0, heavy: 0, damage: 0, jump: 0, jetpack: 0 },
    jetting: false,
    damageDealt: 0,
    damageTaken: 0,
    kos: 0,
    pickups: [],
    removed: false,
  };
  e.fighter = f;
  sim.fighters.push(f);
  sim.entityStore.register(e);
}
/** A fighter's top walk speed now: the base walk speed with the Speed and Heavy power-ups and the jetpack. */
export function walkSpeedNow(ruleset: Ruleset, f: Fighter, thrust = false): number {
  const P = ruleset.pickups.power;
  let speed = ruleset.combat.fighter.walkSpeed;
  if (f.power.speed > 0) speed *= P.speed.mul;
  if (f.power.heavy > 0) speed *= P.heavy.speedMul;
  if (thrust) speed *= P.jetpack.speedMul;
  return speed;
}

export function checkGrounded(sim: Sim, f: Fighter): boolean {
  const p = f.entity.body.translation();
  const reach = sim.ruleset.combat.fighter.halfHeight + sim.ruleset.combat.fighter.radius + 0.12;
  for (const ox of [-0.28, 0, 0.28]) {
    const ray = new RAPIER.Ray({ x: p.x + ox, y: p.y }, { x: 0, y: -1 });
    // #100: jump-through platforms count as ground only while they hold the fighter
    const hit = sim.world.castRay(ray, reach, true, undefined, groups(0xffff, G.TERRAIN | G.PROP | G.FIGHTER | (sim.oneWayLand[f.id] ? G.ONEWAY : 0)), f.entity.collider);
    if (hit) return true;
  }
  return false;
}
export function applyInput(sim: Sim, f: Fighter, inp: Input) {
  const body = f.entity.body;
  const v = body.linvel();
  let vx = v.x;
  let vy = v.y;
  if (f.jumpCd > 0) f.jumpCd--;
  for (const w of ALL_WEAPONS) if (f.cooldown[w] > 0) f.cooldown[w]--;
  if (f.swap > 0) f.swap--;
  const wasJetting = f.jetting;
  f.jetting = false;
  if (f.pinned > 0) {
    // pinned to a wall by a crossbow bolt (#38): held in place, no aiming, no firing
    f.railCharge = 0;
    f.scope = 0;
    f.pinned--;
    body.setLinvel({ x: 0, y: 0 }, true);
    return;
  }
  if (f.stun > 0) {
    f.railCharge = 0;
    f.scope = 0;
    f.stun--;
    if (f.grounded) vx *= 0.9;
    body.setLinvel({ x: vx, y: vy }, true);
    return;
  }
  const thrust = !!inp.thrust && f.power.jetpack > 0;
  // #94: mud, ice, water and oil under and around the fighter
  const foot = footing(sim, f);
  if (sim.liquids.on) setSlick(sim, f, foot.accel < 0.5);
  const speed = walkSpeedNow(sim.ruleset, f, thrust) * foot.speed;
  const target = clamp(inp.move, -1, 1) * speed;
  const F = sim.ruleset.combat.fighter;
  const accel = (f.grounded ? F.groundAccel : F.airAccel) * DT * (f.power.speed > 0 ? SPEED_ACCEL_MUL : 1) * foot.accel;
  vx += clamp(target - vx, -accel, accel);
  // #100: down (or down + jump) on a jump-through platform drops through it
  const dropping = !!inp.down && f.grounded && onOneWay(sim, f);
  if (dropping) {
    if (f.dropTicks === 0) sim.stats.platformDrops++;
    f.dropTicks = 14;
    f.grounded = false;
  }
  if (inp.jump && f.jumpCd === 0 && !dropping) {
    const wall = f.grounded || foot.swim ? 0 : wallToKick(sim, f, inp.move);
    if (foot.swim) {
      // a swim stroke (#94): up, on its own pace
      vy = Math.max(vy, sim.ruleset.liquids.water.strokeSpeed);
      f.jumpCd = sim.ruleset.liquids.water.strokeTicks;
    } else if (f.grounded) {
      vy = F.jumpSpeed * foot.jump;
      f.jumpCd = 14;
      f.grounded = false;
      sim.events.push({ type: "jump", tick: sim.tick, fighter: f.id, air: false });
    } else if (wall) {
      // a wall jump (#100): up, and away from the wall
      const W = sim.ruleset.combat.wallJump;
      vy = Math.max(vy, W.speed);
      vx = -wall * W.push;
      f.wallSide = wall;
      f.jumpCd = 14;
      sim.stats.wallJumps++;
      sim.events.push({ type: "jump", tick: sim.tick, fighter: f.id, air: true, wall: true });
    } else if (f.power.jump > 0 && !f.airJumped) {
      // the Jump power-up's air jump: a little under a ground jump
      vy = F.jumpSpeed * 0.95;
      f.airJumped = true;
      f.jumpCd = 10;
      sim.events.push({ type: "jump", tick: sim.tick, fighter: f.id, air: true });
    }
  }
  if (thrust) {
    // Thrust adds acceleration below the flight cap, preserving faster knockback.
    // #41: near the jetpack ceiling (above the highest platform) the flight cap fades to zero.
    const jp = sim.ruleset.pickups.power.jetpack;
    const room = sim.topY + jp.ceiling - sim.feetY(f);
    const rise = room >= jp.fade ? jp.riseSpeed : room <= 0 ? 0 : jp.riseSpeed * (room / jp.fade);
    vy += clamp(rise - vy, 0, jp.thrust * DT);
    f.jetting = true;
    if (!wasJetting) sim.events.push({ type: "jetpack", tick: sim.tick, fighter: f.id });
    if (--f.power.jetpack === 0) sim.events.push({ type: "power", tick: sim.tick, fighter: f.id, power: "jetpack", on: false });
  }
  body.setLinvel({ x: vx, y: vy }, true);

  const al = length2D(inp.aimX, inp.aimY);
  if (al > 1e-6) {
    f.aimX = inp.aimX / al;
    f.aimY = inp.aimY / al;
  }
  if (f.aimX > 0.05) f.facing = 1;
  else if (f.aimX < -0.05) f.facing = -1;

  // drop the carried weapon (#95): it lands in front, with its ammo; fists in hand
  if (inp.drop && f.weapons[1] !== "fist") {
    const p = body.translation();
    dropCarried(sim, f, p.x + f.facing * 0.5, p.y + 0.3, f.facing * 2, 3, "drop");
  }
  // fists are always there: a jab needs no swap, and the carried weapon stays in hand
  const jab = inp.weapon === "fist";
  if (inp.weapon && !jab && inp.weapon !== sim.weapon(f)) {
    const slot = f.weapons.indexOf(inp.weapon);
    if (slot >= 0) {
      f.slot = slot as 0 | 1;
      f.swap = sim.ruleset.combat.swapTicks;
      sim.events.push({ type: "swap", tick: sim.tick, fighter: f.id, weapon: inp.weapon });
    }
  }
  const weapon = jab ? "fist" : sim.weapon(f);
  const firing = inp.fire && f.swap === 0;
  if (weapon === "railgun" && firing && f.cooldown.railgun === 0 && f.ammo.railgun > 0) {
    if (f.railCharge === 0) sim.events.push({ type: "railCharge", tick: sim.tick, fighter: f.id });
    if (++f.railCharge < sim.ruleset.weapons.table.railgun.chargeTicks) return;
  }
  f.railCharge = 0;
  // sniper (#38): hold the trigger aimTicks to aim (the laser sight is on), then it fires; letting go cancels
  if (weapon === "sniper" && firing && f.cooldown.sniper === 0 && f.ammo.sniper > 0) {
    if (f.scope === 0) sim.events.push({ type: "scope", tick: sim.tick, fighter: f.id });
    if (++f.scope < sim.ruleset.weapons.table.sniper.aimTicks) return;
  }
  f.scope = 0;
  if (firing) fire(sim, f, weapon, !!inp.dig);
}

/** #100: is the fighter standing on a jump-through cell (the cell under the middle of its feet)? */
export function onOneWay(sim: Sim, f: Fighter): boolean {
  const g = sim.grid;
  const p = f.entity.body.translation();
  const cy = g.cy(sim.feetY(f) - 0.1);
  return g.oneway(g.cx(p.x), cy) || (!g.blocks(g.cx(p.x), cy) && (g.oneway(g.cx(p.x - 0.3), cy) || g.oneway(g.cx(p.x + 0.3), cy)));
}

/**
 * #100: the wall a fighter in the air can kick off (-1 left, 1 right, 0 none): a wall (not a jump-through cell)
 * within combat.wallJump.reach of the body's side over most of its height, preferring the side it presses toward. Not
 * off the side it last kicked off before it stood again, not in stun or soon after a knock, not over the void.
 */
export function wallToKick(sim: Sim, f: Fighter, move: number): number {
  const W = sim.ruleset.combat.wallJump;
  if (f.stun > 0 || sim.tick - f.kbTick < W.knockTicks || f.pinned > 0) return 0;
  const g = sim.grid;
  const p = f.entity.body.translation();
  const feet = sim.feetY(f);
  if (sim.nav.fallBelow(g, p.x, feet) === Infinity) return 0;
  const R = sim.ruleset.combat.fighter.radius + W.reach;
  const touching = (side: number) => {
    let n = 0;
    for (const y of [feet + 0.35, p.y, feet + 1.35]) if (g.blocksAt(p.x + side * R, y)) n++;
    return n >= 2;
  };
  const order = move < -0.1 ? [-1, 1] : [1, -1];
  for (const side of order) if (side !== f.wallSide && touching(side)) return side;
  return 0;
}
