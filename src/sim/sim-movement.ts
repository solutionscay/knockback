import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT, G, groups } from "./constants";
import type { Sim } from "./sim";
import { ALL_WEAPONS, type Entity, type Fighter, type Input } from "./sim-types";
import { type Look } from "./identity";
import { clamp, length2D } from "./dmath";
import { fire } from "./sim-weapons";
import { fighterStats, type Build } from "./build";

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
      .setCollisionGroups(groups(G.FIGHTER, G.TERRAIN | G.FIGHTER | G.PROP | G.GRENADE)),
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
    ammo: { mine: 0, railgun: 0, hammer: 0, rifle: 0, sniper: 0, crossbow: 0, lightning: 0 },
    railCharge: 0,
    scope: 0,
    pinned: 0,
    stun: 0,
    jumpCd: 0,
    airJumped: false,
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
    fuel: 0,
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
export function checkGrounded(sim: Sim, f: Fighter): boolean {
  const p = f.entity.body.translation();
  const reach = sim.ruleset.combat.fighter.halfHeight + sim.ruleset.combat.fighter.radius + 0.12;
  for (const ox of [-0.28, 0, 0.28]) {
    const ray = new RAPIER.Ray({ x: p.x + ox, y: p.y }, { x: 0, y: -1 });
    const hit = sim.world.castRay(ray, reach, true, undefined, groups(0xffff, G.TERRAIN | G.PROP | G.FIGHTER), f.entity.collider);
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
  let speed = sim.ruleset.combat.fighter.walkSpeed;
  if (f.power.speed > 0) speed *= sim.ruleset.pickups.power.speed.mul;
  if (f.power.heavy > 0) speed *= sim.ruleset.pickups.power.heavy.speedMul;
  const thrust = inp.thrust && f.power.jetpack > 0;
  if (thrust) speed *= sim.ruleset.pickups.power.jetpack.speedMul;
  const target = clamp(inp.move, -1, 1) * speed;
  const accel = (f.grounded ? sim.ruleset.combat.fighter.groundAccel : sim.ruleset.combat.fighter.airAccel) * DT * (f.power.speed > 0 ? 1.3 : 1);
  vx += clamp(target - vx, -accel, accel);
  if (inp.jump && f.jumpCd === 0) {
    if (f.grounded) {
      vy = sim.ruleset.combat.fighter.jumpSpeed;
      f.jumpCd = 14;
      f.grounded = false;
      sim.events.push({ type: "jump", tick: sim.tick, fighter: f.id, air: false });
    } else if (f.power.jump > 0 && !f.airJumped) {
      vy = sim.ruleset.combat.fighter.jumpSpeed * 0.95;
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

  // fists are always there: a jab needs no free slot and no weapon swap
  const jab = inp.weapon === "fist" && !f.weapons.includes("fist");
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
  if (firing) fire(sim, f, weapon);
}
