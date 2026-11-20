import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT, FIGHTER, FIGHTER_DENSITY, G, POWER, SWAP_TICKS, groups } from "./constants";
import type { Sim } from "./sim";
import { ALL_WEAPONS, WEAPON_LIST, type Entity, type Fighter, type Input, type Look } from "./sim-types";
import { clamp, length2D } from "./dmath";
import { fire } from "./sim-weapons";

export function addFighter(sim: Sim, id: number, def: Look, x: number, y: number) {
  const body = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y + FIGHTER.halfHeight + FIGHTER.radius + 0.05)
      .lockRotations()
      .setCcdEnabled(true)
      .setLinearDamping(0.1),
  );
  const collider = sim.world.createCollider(
    RAPIER.ColliderDesc.capsule(FIGHTER.halfHeight, FIGHTER.radius)
      .setDensity(FIGHTER_DENSITY)
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
    hw: FIGHTER.radius,
    hh: FIGHTER.halfHeight + FIGHTER.radius,
    hp: FIGHTER.maxHp,
    maxHp: FIGHTER.maxHp,
    dead: false,
    born: 0,
  };
  const s = sim.nav.surfaceAt(x, y + 0.05);
  const f: Fighter = {
    id,
    name: def.name,
    color: def.color,
    look: { ...def },
    prefs: WEAPON_LIST.slice(),
    entity: e,
    hp: FIGHTER.maxHp,
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
    cooldown: { rocket: 45 + id * 7, shotgun: 30, bat: 20, grenade: 60, grapple: 40, fist: 20 },
    stun: 0,
    jumpCd: 0,
    airJumped: false,
    grounded: false,
    surface: s ? s.id : -1,
    lastHitBy: -1,
    lastHitTick: -9999,
    lastHitCause: "",
    kbTick: -1,
    shieldTick: -1,
    padCd: 0,
    crushCd: 0,
    outsideZone: false,
    outsideTicks: 0,
    power: { shield: 0, shieldHits: 0, speed: 0, heavy: 0, damage: 0, jump: 0 },
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
  const reach = FIGHTER.halfHeight + FIGHTER.radius + 0.12;
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
  if (f.stun > 0) {
    f.stun--;
    if (f.grounded) vx *= 0.9;
    body.setLinvel({ x: vx, y: vy }, true);
    return;
  }
  let speed = FIGHTER.walkSpeed;
  if (f.power.speed > 0) speed *= POWER.speed.mul;
  if (f.power.heavy > 0) speed *= POWER.heavy.speedMul;
  const target = clamp(inp.move, -1, 1) * speed;
  const accel = (f.grounded ? FIGHTER.groundAccel : FIGHTER.airAccel) * DT * (f.power.speed > 0 ? 1.3 : 1);
  vx += clamp(target - vx, -accel, accel);
  if (inp.jump && f.jumpCd === 0) {
    if (f.grounded) {
      vy = FIGHTER.jumpSpeed;
      f.jumpCd = 14;
      f.grounded = false;
      sim.events.push({ type: "jump", tick: sim.tick, fighter: f.id, air: false });
    } else if (f.power.jump > 0 && !f.airJumped) {
      vy = FIGHTER.jumpSpeed * 0.95;
      f.airJumped = true;
      f.jumpCd = 10;
      sim.events.push({ type: "jump", tick: sim.tick, fighter: f.id, air: true });
    }
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
      f.swap = SWAP_TICKS;
      sim.events.push({ type: "swap", tick: sim.tick, fighter: f.id, weapon: inp.weapon });
    }
  }
  if (inp.fire && f.swap === 0) fire(sim, f, jab ? "fist" : sim.weapon(f));
}
