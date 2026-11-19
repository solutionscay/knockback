/**
 * Knockback simulation core. Pure TypeScript + Rapier (deterministic build).
 * No rendering, no wall clock, no Math.random: same seed + same inputs =
 * same state, in Bun and in the browser.
 *
 * Trig functions are avoided on purpose (only + - * / sqrt, which IEEE 754
 * defines exactly), so the JS side does not drift between JS engines.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import {
  BARREL,
  BLOCK,
  CRATE,
  DT,
  FIGHTER,
  G,
  GRAVITY,
  ITEM,
  PLANK,
  WEAPONS,
  ZONE_HALF_WIDTHS,
  ZONE_SHRINK_TICKS,
  groups,
  zoneDps,
} from "./constants";
import { ARENA, type MapDef } from "./map";
import { NavGraph } from "./nav";
import { Rng } from "./rng";

export type R = typeof RAPIER;
export type Weapon = "rocket" | "shotgun" | "grenade";
export type Stance = "rush" | "distance" | "cover" | "item";
export type Personality = "aggressive" | "sniper" | "coward" | "opportunist";
export type EntityKind = "fighter" | "block" | "crate" | "barrel" | "plank" | "item" | "grenade";
export type ItemType = "health" | "grenade";
export type ExplosionKind = "rocket" | "barrel" | "grenade";

export interface Order {
  /** Fighter id to attack. */
  target: number;
  weapon: Weapon;
  stance: Stance;
}

export interface Input {
  move: number; // -1..1
  jump: boolean;
  aimX: number;
  aimY: number;
  fire: Weapon | null;
}

export const NO_INPUT: Input = { move: 0, jump: false, aimX: 1, aimY: 0, fire: null };

export interface Entity {
  id: number;
  kind: EntityKind;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  hw: number; // half width
  hh: number; // half height
  hp: number;
  maxHp: number;
  dead: boolean;
  fighter?: Fighter;
  // barrel
  fuse?: number;
  chainDepth?: number;
  chainFrom?: ExplosionKind | "shotgun" | null;
  triggeredBy?: number;
  // item
  itemType?: ItemType;
  // grenade
  owner?: number;
  ticksLeft?: number;
}

export interface Fighter {
  id: number;
  name: string;
  color: number;
  personality: Personality;
  entity: Entity;
  hp: number;
  alive: boolean;
  koTick: number;
  koCause: "ringout" | "hp" | "zone" | null;
  koBy: number;
  facing: 1 | -1;
  aimX: number;
  aimY: number;
  cooldown: Record<Weapon, number>;
  grenades: number;
  stun: number;
  jumpCd: number;
  grounded: boolean;
  surface: number; // last known nav surface
  lastHitBy: number;
  lastHitTick: number;
  kbTick: number;
  inZoneDamage: boolean;
  // stats
  damageDealt: number;
  damageTaken: number;
  kos: number;
  removed: boolean;
}

export interface Rocket {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

export type SimEvent =
  | { type: "fire"; tick: number; fighter: number; weapon: Weapon; x: number; y: number; dx: number; dy: number }
  | { type: "pellet"; tick: number; fighter: number; x0: number; y0: number; x1: number; y1: number; hit: boolean }
  | {
      type: "explosion";
      tick: number;
      kind: ExplosionKind;
      x: number;
      y: number;
      radius: number;
      owner: number;
      depth: number;
      chainFrom: ExplosionKind | "shotgun" | null;
    }
  | { type: "hit"; tick: number; target: number; source: number; damage: number; kb: number; x: number; y: number; cause: string }
  | { type: "ko"; tick: number; fighter: number; cause: "ringout" | "hp" | "zone"; by: number; x: number; y: number }
  | { type: "break"; tick: number; entity: number; kind: EntityKind; x: number; y: number; hw: number; hh: number }
  | { type: "pickup"; tick: number; fighter: number; item: ItemType; x: number; y: number }
  | { type: "impact"; tick: number; fighter: number; damage: number; x: number; y: number }
  | { type: "jump"; tick: number; fighter: number }
  | { type: "land"; tick: number; fighter: number; speed: number }
  | { type: "itemSpawn"; tick: number; entity: number; item: ItemType; x: number; y: number };

export const FIGHTER_DEFS: { name: string; color: number; personality: Personality }[] = [
  { name: "Red", color: 0xff4f4f, personality: "aggressive" },
  { name: "Blue", color: 0x47a3ff, personality: "sniper" },
  { name: "Green", color: 0x4fdc6a, personality: "coward" },
  { name: "Gold", color: 0xffc733, personality: "opportunist" },
];

let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const ALL = 0xffff;
const SHOT_FILTER = groups(ALL, G.TERRAIN | G.FIGHTER | G.PROP);

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Sim {
  readonly map: MapDef;
  readonly nav: NavGraph;
  readonly rng: Rng;
  readonly world: RAPIER.World;
  readonly terrainBody: RAPIER.RigidBody;
  tick = 0;
  round = 0;
  fighters: Fighter[] = [];
  entities = new Map<number, Entity>();
  private byCollider = new Map<number, Entity>();
  rockets: Rocket[] = [];
  planks: Entity[] = [];
  events: SimEvent[] = [];
  private nextId = 1;
  zone = { center: 0, half: ZONE_HALF_WIDTHS[0]!, fromHalf: ZONE_HALF_WIDTHS[0]!, toHalf: ZONE_HALF_WIDTHS[0]!, shrinkStart: 0 };
  stats = { blocksDestroyed: 0, cratesDestroyed: 0, barrelsExploded: 0, chainBarrels: 0, barrelToBarrel: 0, explosions: 0 };

  constructor(seed: number, map: MapDef = ARENA) {
    this.map = map;
    this.rng = new Rng(seed);
    this.nav = new NavGraph(map);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY });
    this.world.timestep = DT;
    this.terrainBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const r of map.terrain) {
      const cd = RAPIER.ColliderDesc.cuboid((r.x1 - r.x0) / 2, (r.top - r.bottom) / 2)
        .setTranslation((r.x0 + r.x1) / 2, (r.top + r.bottom) / 2)
        .setFriction(0.9)
        .setCollisionGroups(groups(G.TERRAIN, ALL));
      this.world.createCollider(cd, this.terrainBody);
    }
    for (const p of map.props) {
      if (p.kind === "block") this.addBox("block", p.x, p.y + BLOCK.size / 2, BLOCK.size / 2, BLOCK.size / 2, BLOCK.density, BLOCK.hp);
      else if (p.kind === "crate") this.addBox("crate", p.x, p.y + CRATE.size / 2, CRATE.size / 2, CRATE.size / 2, CRATE.density, CRATE.hp);
      else this.addBox("barrel", p.x, p.y + 0.5, 0.34, 0.5, 0.9, BARREL.hp);
    }
    if (map.bridge) this.buildBridge(map.bridge);
    this.zone.center = Math.round(this.rng.range(-7, 7) * 4) / 4;

    // Seat order is shuffled by seed so personalities do not own a spawn.
    const spawns = this.rng.shuffle(map.spawns.slice());
    FIGHTER_DEFS.forEach((def, i) => this.addFighter(i, def, spawns[i]!.x));
  }

  // ---------------------------------------------------------------- building

  private register(e: Entity) {
    this.entities.set(e.id, e);
    this.byCollider.set(e.collider.handle, e);
  }

  private addBox(kind: EntityKind, x: number, y: number, hw: number, hh: number, density: number, hp: number): Entity {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setLinearDamping(0.05).setAngularDamping(0.3),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hw, hh)
        .setDensity(density)
        .setFriction(0.8)
        .setRestitution(0.05)
        .setCollisionGroups(groups(G.PROP, G.TERRAIN | G.FIGHTER | G.PROP | G.ITEM | G.GRENADE)),
      body,
    );
    const e: Entity = { id: this.nextId++, kind, body, collider, hw, hh, hp, maxHp: hp, dead: false };
    this.register(e);
    return e;
  }

  private buildBridge(br: NonNullable<MapDef["bridge"]>) {
    const w = (br.x1 - br.x0) / br.planks;
    const y = br.y - PLANK.h / 2;
    let prev: Entity | null = null;
    for (let i = 0; i < br.planks; i++) {
      const x = br.x0 + w * (i + 0.5);
      const p = this.addBox("plank", x, y, w / 2 - 0.01, PLANK.h / 2, 2.0, PLANK.hp);
      p.body.setAngularDamping(2);
      this.planks.push(p);
      if (!prev) {
        this.world.createImpulseJoint(RAPIER.JointData.revolute({ x: br.x0, y }, { x: -w / 2, y: 0 }), this.terrainBody, p.body, true);
      } else {
        this.world.createImpulseJoint(RAPIER.JointData.revolute({ x: w / 2, y: 0 }, { x: -w / 2, y: 0 }), prev.body, p.body, true);
      }
      prev = p;
    }
    if (prev) this.world.createImpulseJoint(RAPIER.JointData.revolute({ x: br.x1, y }, { x: w / 2, y: 0 }), this.terrainBody, prev.body, true);
  }

  private addFighter(id: number, def: (typeof FIGHTER_DEFS)[number], x: number) {
    const s = this.nav.surfaceAt(x, 50)!;
    const y = s.y + FIGHTER.halfHeight + FIGHTER.radius + 0.05;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).lockRotations().setCcdEnabled(true).setLinearDamping(0.1),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(FIGHTER.halfHeight, FIGHTER.radius)
        .setDensity(2.2)
        .setFriction(0)
        .setRestitution(0)
        .setCollisionGroups(groups(G.FIGHTER, G.TERRAIN | G.FIGHTER | G.PROP | G.GRENADE)),
      body,
    );
    const e: Entity = {
      id: this.nextId++,
      kind: "fighter",
      body,
      collider,
      hw: FIGHTER.radius,
      hh: FIGHTER.halfHeight + FIGHTER.radius,
      hp: FIGHTER.maxHp,
      maxHp: FIGHTER.maxHp,
      dead: false,
    };
    const f: Fighter = {
      id,
      name: def.name,
      color: def.color,
      personality: def.personality,
      entity: e,
      hp: FIGHTER.maxHp,
      alive: true,
      koTick: -1,
      koCause: null,
      koBy: -1,
      facing: x < 0 ? 1 : -1,
      aimX: x < 0 ? 1 : -1,
      aimY: 0,
      cooldown: { rocket: 0, shotgun: 0, grenade: 0 },
      grenades: 0,
      stun: 0,
      jumpCd: 0,
      grounded: false,
      surface: s.id,
      lastHitBy: -1,
      lastHitTick: -9999,
      kbTick: -1,
      inZoneDamage: false,
      damageDealt: 0,
      damageTaken: 0,
      kos: 0,
      removed: false,
    };
    e.fighter = f;
    this.fighters.push(f);
    this.register(e);
  }

  spawnItem(type: ItemType, x: number, y: number, vx = 0, vy = 0): Entity {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setLinvel(vx, vy).setAngularDamping(1),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(ITEM.size / 2, ITEM.size / 2)
        .setDensity(0.5)
        .setFriction(0.9)
        .setCollisionGroups(groups(G.ITEM, G.TERRAIN | G.PROP)),
      body,
    );
    const e: Entity = { id: this.nextId++, kind: "item", body, collider, hw: ITEM.size / 2, hh: ITEM.size / 2, hp: 1, maxHp: 1, dead: false, itemType: type };
    this.register(e);
    this.events.push({ type: "itemSpawn", tick: this.tick, entity: e.id, item: type, x, y });
    return e;
  }

  // ----------------------------------------------------------------- queries

  alive(): Fighter[] {
    return this.fighters.filter((f) => f.alive);
  }

  pos(f: Fighter): { x: number; y: number } {
    const t = f.entity.body.translation();
    return { x: t.x, y: t.y };
  }

  vel(f: Fighter): { x: number; y: number } {
    const v = f.entity.body.linvel();
    return { x: v.x, y: v.y };
  }

  feetY(f: Fighter): number {
    return f.entity.body.translation().y - FIGHTER.halfHeight - FIGHTER.radius;
  }

  bridgeIntact(): boolean {
    return this.planks.length > 0 && this.planks.every((p) => !p.dead);
  }

  entityOf(c: RAPIER.Collider): Entity | undefined {
    return this.byCollider.get(c.handle);
  }

  /** First collider hit by a ray (terrain, fighters, props). */
  raycast(x: number, y: number, dx: number, dy: number, maxDist: number, exclude?: RAPIER.Collider) {
    const ray = new RAPIER.Ray({ x, y }, { x: dx, y: dy });
    const hit = this.world.castRay(ray, maxDist, true, undefined, SHOT_FILTER, exclude);
    if (!hit) return null;
    return { dist: hit.timeOfImpact, entity: this.byCollider.get(hit.collider.handle) ?? null, collider: hit.collider };
  }

  kbMult(hp: number): number {
    return 1 + (clamp(FIGHTER.maxHp - hp, 0, FIGHTER.maxHp) / 100) * FIGHTER.kbGrowth;
  }

  // ------------------------------------------------------------------ rounds

  /** Called by the match at the start of each round (1-based). */
  beginRound(round: number) {
    this.round = round;
    const z = this.zone;
    z.fromHalf = z.half;
    z.toHalf = ZONE_HALF_WIDTHS[Math.min(round - 1, ZONE_HALF_WIDTHS.length - 1)]!;
    z.shrinkStart = this.tick;
    if (round === 3 || round === 5) {
      // supply drop inside the zone
      const lo = Math.max(this.map.minX + 3, z.center - z.toHalf + 1);
      const hi = Math.min(this.map.maxX - 3, z.center + z.toHalf - 1);
      let x = this.rng.range(lo, hi);
      if (x > -3.6 && x < 3.6 && !this.bridgeIntact()) x = 0; // lands on the center platform
      this.spawnItem(this.rng.chance(0.5) ? "health" : "grenade", x, 14);
    }
  }

  // -------------------------------------------------------------------- step

  step(inputs: readonly Input[]) {
    const tick = this.tick;
    // zone animation
    const z = this.zone;
    const k = clamp((tick - z.shrinkStart) / ZONE_SHRINK_TICKS, 0, 1);
    z.half = z.fromHalf + (z.toHalf - z.fromHalf) * k;

    for (const f of this.fighters) {
      if (!f.alive) continue;
      this.applyInput(f, inputs[f.id] ?? NO_INPUT);
    }
    this.updateRockets();
    this.updateFuses();

    // velocity before the physics step, for impact damage
    const pre: { x: number; y: number }[] = this.fighters.map((f) => (f.removed ? { x: 0, y: 0 } : this.vel(f)));
    this.world.step();

    for (const f of this.fighters) {
      if (f.removed) continue;
      const p = this.pos(f);
      if (!f.alive) {
        if (p.y < FIGHTER.ringOutY - 6 || tick - f.koTick > 150) this.removeFighterBody(f);
        continue;
      }
      const v = this.vel(f);
      const wasGrounded = f.grounded;
      f.grounded = this.checkGrounded(f);
      if (f.grounded) {
        const s = this.nav.surfaceAt(p.x, this.feetY(f));
        if (s) f.surface = s.id;
        if (!wasGrounded && pre[f.id]!.y < -4) this.events.push({ type: "land", tick, fighter: f.id, speed: -pre[f.id]!.y });
      }
      // impact damage: velocity change beyond what gravity explains
      const ex = pre[f.id]!.x;
      const ey = pre[f.id]!.y - GRAVITY * DT;
      const dvx = v.x - ex;
      const dvy = v.y - ey;
      const dv = Math.sqrt(dvx * dvx + dvy * dvy);
      if (dv > FIGHTER.impactThreshold) {
        const dmg = (dv - FIGHTER.impactThreshold) * FIGHTER.impactDamagePerMs;
        const src = tick - f.lastHitTick < 120 ? f.lastHitBy : -1;
        this.events.push({ type: "impact", tick, fighter: f.id, damage: dmg, x: p.x, y: p.y });
        this.damageFighter(f, dmg, src, 0, 0, "impact", p.x, p.y);
        if (!f.alive) continue;
      }
      // ring-out
      if (p.y < FIGHTER.ringOutY || p.x < -FIGHTER.ringOutX || p.x > FIGHTER.ringOutX) {
        this.knockOut(f, "ringout", p.x, p.y);
        continue;
      }
      // zone
      f.inZoneDamage = p.x < z.center - z.half || p.x > z.center + z.half;
      if (f.inZoneDamage) {
        const dps = zoneDps(this.round);
        f.hp -= dps * DT;
        f.damageTaken += dps * DT;
        if (f.hp <= 0) {
          f.hp = 0;
          this.knockOut(f, "zone", p.x, p.y);
          continue;
        }
      }
      this.checkPickups(f, p.x, p.y);
    }
    // world-out cleanup for props
    for (const e of this.entities.values()) {
      if (e.dead || e.kind === "fighter") continue;
      const t = e.body.translation();
      if (t.y < -25 || t.x < -60 || t.x > 60) this.removeEntity(e);
    }
    this.tick++;
  }

  private checkGrounded(f: Fighter): boolean {
    const p = f.entity.body.translation();
    const reach = FIGHTER.halfHeight + FIGHTER.radius + 0.12;
    for (const ox of [-0.28, 0, 0.28]) {
      const ray = new RAPIER.Ray({ x: p.x + ox, y: p.y }, { x: 0, y: -1 });
      const hit = this.world.castRay(ray, reach, true, undefined, groups(ALL, G.TERRAIN | G.PROP | G.FIGHTER), f.entity.collider);
      if (hit) return true;
    }
    return false;
  }

  private applyInput(f: Fighter, inp: Input) {
    const body = f.entity.body;
    const v = body.linvel();
    let vx = v.x;
    let vy = v.y;
    if (f.jumpCd > 0) f.jumpCd--;
    for (const w of ["rocket", "shotgun", "grenade"] as const) if (f.cooldown[w] > 0) f.cooldown[w]--;
    if (f.stun > 0) {
      f.stun--;
      if (f.grounded) vx *= 0.9;
      body.setLinvel({ x: vx, y: vy }, true);
      return;
    }
    const target = clamp(inp.move, -1, 1) * FIGHTER.walkSpeed;
    const accel = (f.grounded ? FIGHTER.groundAccel : FIGHTER.airAccel) * DT;
    vx += clamp(target - vx, -accel, accel);
    if (inp.jump && f.grounded && f.jumpCd === 0) {
      vy = FIGHTER.jumpSpeed;
      f.jumpCd = 14;
      f.grounded = false;
      this.events.push({ type: "jump", tick: this.tick, fighter: f.id });
    }
    body.setLinvel({ x: vx, y: vy }, true);

    // aim (normalize; no trig)
    const al = Math.sqrt(inp.aimX * inp.aimX + inp.aimY * inp.aimY);
    if (al > 1e-6) {
      f.aimX = inp.aimX / al;
      f.aimY = inp.aimY / al;
    }
    if (f.aimX > 0.05) f.facing = 1;
    else if (f.aimX < -0.05) f.facing = -1;

    if (inp.fire) this.fire(f, inp.fire);
  }

  // ----------------------------------------------------------------- weapons

  private fire(f: Fighter, weapon: Weapon) {
    if (weapon === "grenade" && f.grenades <= 0) weapon = "rocket";
    if (f.cooldown[weapon] > 0) return;
    const p = this.pos(f);
    const ox = p.x;
    const oy = p.y + 0.25;
    const dx = f.aimX;
    const dy = f.aimY;
    this.events.push({ type: "fire", tick: this.tick, fighter: f.id, weapon, x: ox, y: oy, dx, dy });
    if (weapon === "rocket") {
      f.cooldown.rocket = WEAPONS.rocket.cooldown;
      const muzzle = 0.95;
      const block = this.raycast(ox, oy, dx, dy, muzzle, f.entity.collider);
      if (block) {
        this.explode(ox + dx * block.dist, oy + dy * block.dist, WEAPONS.rocket, "rocket", f.id, 0, null);
        return;
      }
      const s = WEAPONS.rocket.speed;
      this.rockets.push({ id: this.nextId++, owner: f.id, x: ox + dx * muzzle, y: oy + dy * muzzle, vx: dx * s, vy: dy * s, age: 0 });
    } else if (weapon === "shotgun") {
      f.cooldown.shotgun = WEAPONS.shotgun.cooldown;
      this.fireShotgun(f, ox, oy, dx, dy);
    } else {
      f.cooldown.grenade = WEAPONS.grenade.cooldown;
      f.grenades--;
      const v = this.vel(f);
      const gx = ox + dx * 0.8;
      const gy = oy + dy * 0.8 + 0.2;
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(gx, gy)
          .setLinvel(dx * WEAPONS.grenade.speed + v.x * 0.3, dy * WEAPONS.grenade.speed + v.y * 0.3)
          .setCcdEnabled(true)
          .setAngularDamping(0.5),
      );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.ball(0.22)
          .setDensity(3)
          .setRestitution(0.45)
          .setFriction(0.6)
          .setCollisionGroups(groups(G.GRENADE, G.TERRAIN | G.FIGHTER | G.PROP)),
        body,
      );
      const e: Entity = {
        id: this.nextId++,
        kind: "grenade",
        body,
        collider,
        hw: 0.22,
        hh: 0.22,
        hp: 1,
        maxHp: 1,
        dead: false,
        owner: f.id,
        ticksLeft: WEAPONS.grenade.fuse,
      };
      this.register(e);
    }
  }

  private fireShotgun(f: Fighter, ox: number, oy: number, dx: number, dy: number) {
    const W = WEAPONS.shotgun;
    const px = -dy;
    const py = dx;
    for (let i = 0; i < W.pellets; i++) {
      const spread = ((i / (W.pellets - 1)) * 2 - 1) * 0.16 + this.rng.gauss() * 0.03;
      let rx = dx + px * spread;
      let ry = dy + py * spread;
      const l = Math.sqrt(rx * rx + ry * ry);
      rx /= l;
      ry /= l;
      const hit = this.raycast(ox, oy, rx, ry, W.range, f.entity.collider);
      const dist = hit ? hit.dist : W.range;
      this.events.push({ type: "pellet", tick: this.tick, fighter: f.id, x0: ox, y0: oy, x1: ox + rx * dist, y1: oy + ry * dist, hit: !!hit });
      if (!hit || !hit.entity) continue;
      const e = hit.entity;
      const fall = 1 - 0.45 * (dist / W.range);
      const hx = ox + rx * dist;
      const hy = oy + ry * dist;
      if (e.kind === "fighter" && e.fighter) {
        const t = e.fighter;
        if (!t.alive) continue;
        const dmg = W.pelletDamage * fall;
        // knockback applied after damage so it uses the new hp
        const kbBase = W.pelletKnock * fall;
        this.damageFighter(t, dmg, f.id, rx * kbBase, ry * kbBase + 0.35 * kbBase, "shotgun", hx, hy);
      } else {
        this.damageProp(e, W.pelletBlockDamage * fall, f.id, 0, "shotgun");
        if (!e.dead) e.body.applyImpulseAtPoint({ x: rx * W.pelletImpulse, y: ry * W.pelletImpulse }, { x: hx, y: hy }, true);
      }
    }
  }

  private updateRockets() {
    const W = WEAPONS.rocket;
    const keep: Rocket[] = [];
    for (const r of this.rockets) {
      r.age++;
      r.vy -= W.gravity * DT;
      const sx = r.vx * DT;
      const sy = r.vy * DT;
      const len = Math.sqrt(sx * sx + sy * sy);
      const owner = this.fighters[r.owner]!;
      const exclude = r.age < 30 && !owner.removed ? owner.entity.collider : undefined;
      const hit = this.raycast(r.x, r.y, sx / len, sy / len, len, exclude);
      if (hit) {
        this.explode(r.x + (sx / len) * hit.dist, r.y + (sy / len) * hit.dist, W, "rocket", r.owner, 0, null);
        continue;
      }
      r.x += sx;
      r.y += sy;
      if (r.age > W.maxLife) {
        this.explode(r.x, r.y, W, "rocket", r.owner, 0, null);
        continue;
      }
      if (r.y < -20 || r.x < -60 || r.x > 60) continue;
      keep.push(r);
    }
    this.rockets = keep;
  }

  private updateFuses() {
    for (const e of [...this.entities.values()]) {
      if (e.dead) continue;
      if (e.kind === "grenade") {
        e.ticksLeft!--;
        if (e.ticksLeft! <= 0) {
          const t = e.body.translation();
          this.removeEntity(e);
          this.explode(t.x, t.y, WEAPONS.grenade, "grenade", e.owner!, 0, null);
        }
      } else if (e.kind === "barrel" && e.fuse !== undefined) {
        e.fuse--;
        if (e.fuse <= 0) {
          const t = e.body.translation();
          this.removeEntity(e);
          this.stats.barrelsExploded++;
          if (e.chainFrom === "rocket" || e.chainFrom === "barrel" || e.chainFrom === "grenade") this.stats.chainBarrels++;
          if (e.chainFrom === "barrel") this.stats.barrelToBarrel++;
          this.explode(t.x, t.y, BARREL, "barrel", e.triggeredBy ?? -1, e.chainDepth ?? 0, e.chainFrom ?? null);
        }
      }
    }
  }

  explode(
    x: number,
    y: number,
    spec: { radius: number; damage: number; knockback: number; blockDamage: number },
    kind: ExplosionKind,
    owner: number,
    depth: number,
    chainFrom: ExplosionKind | "shotgun" | null,
  ) {
    this.stats.explosions++;
    this.events.push({ type: "explosion", tick: this.tick, kind, x, y, radius: spec.radius, owner, depth, chainFrom });
    const found: Entity[] = [];
    const seen = new Set<number>();
    this.world.intersectionsWithShape({ x, y }, 0, new RAPIER.Ball(spec.radius), (c) => {
      const e = this.byCollider.get(c.handle);
      if (e && !e.dead && !seen.has(e.id)) {
        seen.add(e.id);
        found.push(e);
      }
      return true;
    });
    for (const e of found) {
      if (e.dead) continue;
      const t = e.body.translation();
      const dx = t.x - x;
      const dy = t.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const edge = Math.max(0, d - Math.min(e.hw, e.hh));
      const f = clamp(1 - edge / spec.radius, 0, 1);
      if (f <= 0) continue;
      let nx = d > 0.01 ? dx / d : 0;
      let ny = d > 0.01 ? dy / d : 1;
      if (e.kind === "fighter" && e.fighter) {
        const fi = e.fighter;
        if (!fi.alive) continue;
        // lift: knockback always has an upward part, so fighters fly
        ny += 0.55;
        const l = Math.sqrt(nx * nx + ny * ny);
        nx /= l;
        ny /= l;
        const dmg = spec.damage * (0.35 + 0.65 * f);
        const kb = spec.knockback * (0.45 + 0.55 * f);
        this.damageFighter(fi, dmg, owner, nx * kb, ny * kb, kind, t.x, t.y);
      } else if (e.kind === "block" || e.kind === "crate" || e.kind === "plank" || e.kind === "barrel") {
        // blocks only break near the center; further out they get shoved, so cover collapses
        this.damageProp(e, spec.blockDamage * f * f, owner, depth, kind);
        if (!e.dead) {
          const m = e.body.mass();
          const imp = spec.knockback * f * m * 0.55;
          e.body.applyImpulse({ x: nx * imp, y: (ny + 0.3) * imp }, true);
          e.body.applyTorqueImpulse((nx >= 0 ? -1 : 1) * imp * 0.08, true);
        }
      } else {
        const m = e.body.mass();
        const imp = spec.knockback * f * m * 0.7;
        e.body.applyImpulse({ x: nx * imp, y: (ny + 0.4) * imp }, true);
      }
    }
  }

  private damageProp(e: Entity, dmg: number, owner: number, depth: number, cause: ExplosionKind | "shotgun") {
    if (e.dead || dmg <= 0) return;
    e.hp -= dmg;
    if (e.hp > 0) return;
    if (e.kind === "barrel") {
      if (e.fuse === undefined) {
        e.fuse = this.rng.int(BARREL.fuseMin, BARREL.fuseMax);
        e.chainDepth = cause === "shotgun" ? 0 : depth + 1;
        e.chainFrom = cause;
        e.triggeredBy = owner;
      }
      return;
    }
    const t = e.body.translation();
    this.events.push({ type: "break", tick: this.tick, entity: e.id, kind: e.kind, x: t.x, y: t.y, hw: e.hw, hh: e.hh });
    if (e.kind === "block") this.stats.blocksDestroyed++;
    if (e.kind === "crate") {
      this.stats.cratesDestroyed++;
      if (this.rng.chance(CRATE.dropChance)) {
        const type: ItemType = this.rng.chance(0.55) ? "health" : "grenade";
        this.removeEntity(e);
        this.spawnItem(type, t.x, t.y + 0.2, 0, 3);
        return;
      }
    }
    this.removeEntity(e);
  }

  damageFighter(f: Fighter, dmg: number, source: number, kbx: number, kby: number, cause: string, hx: number, hy: number) {
    if (!f.alive) return;
    f.hp -= dmg;
    f.damageTaken += dmg;
    if (source >= 0 && source !== f.id) {
      this.fighters[source]!.damageDealt += dmg;
      f.lastHitBy = source;
      f.lastHitTick = this.tick;
    }
    let kb = 0;
    if (kbx !== 0 || kby !== 0) {
      const m = this.kbMult(Math.max(0, f.hp));
      const body = f.entity.body;
      const v = body.linvel();
      // several hits in one tick (shotgun pellets, blast + barrel) add up
      const stack = f.kbTick === this.tick;
      const nvx = (stack ? v.x : v.x * 0.3) + kbx * m;
      const nvy = (stack ? v.y : Math.max(v.y * 0.3, 0)) + kby * m;
      f.kbTick = this.tick;
      body.setLinvel({ x: nvx, y: nvy }, true);
      kb = Math.sqrt(kbx * kbx + kby * kby) * m;
      f.stun = Math.max(f.stun, Math.round(clamp(kb * 1.7, 6, 55)));
      f.grounded = false;
    }
    if (cause !== "impact") this.events.push({ type: "hit", tick: this.tick, target: f.id, source, damage: dmg, kb, x: hx, y: hy, cause });
    if (f.hp <= 0) {
      f.hp = 0;
      const p = this.pos(f);
      this.knockOut(f, "hp", p.x, p.y);
    }
  }

  private knockOut(f: Fighter, cause: "ringout" | "hp" | "zone", x: number, y: number) {
    if (!f.alive) return;
    f.alive = false;
    f.koTick = this.tick;
    f.koCause = cause;
    const by = this.tick - f.lastHitTick < 300 ? f.lastHitBy : -1;
    f.koBy = by;
    if (by >= 0 && by !== f.id) this.fighters[by]!.kos++;
    this.events.push({ type: "ko", tick: this.tick, fighter: f.id, cause, by, x, y });
    // the body becomes a ragdoll that only touches terrain
    f.entity.collider.setCollisionGroups(groups(G.PROP, G.TERRAIN));
    f.entity.body.lockRotations(false, true);
    f.entity.body.setAngvel(f.facing * -6, true);
    if (cause === "ringout") this.removeFighterBody(f);
  }

  private removeFighterBody(f: Fighter) {
    if (f.removed) return;
    f.removed = true;
    this.removeEntity(f.entity);
  }

  private removeEntity(e: Entity) {
    if (e.dead) return;
    e.dead = true;
    this.byCollider.delete(e.collider.handle);
    this.entities.delete(e.id);
    this.world.removeRigidBody(e.body);
  }

  private checkPickups(f: Fighter, x: number, y: number) {
    for (const e of this.entities.values()) {
      if (e.kind !== "item" || e.dead) continue;
      const t = e.body.translation();
      const dx = t.x - x;
      const dy = t.y - y;
      if (dx * dx + dy * dy > ITEM.pickupRange * ITEM.pickupRange) continue;
      if (e.itemType === "health") f.hp = Math.min(FIGHTER.maxHp, f.hp + ITEM.healAmount);
      else f.grenades += 2;
      this.events.push({ type: "pickup", tick: this.tick, fighter: f.id, item: e.itemType!, x: t.x, y: t.y });
      this.removeEntity(e);
      return;
    }
  }

  items(): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) if (e.kind === "item" && !e.dead) out.push(e);
    return out;
  }

  // -------------------------------------------------------------------- hash

  /** FNV-1a over the Rapier snapshot plus all game state. */
  hash(): string {
    let h = 0x811c9dc5;
    const mix = (b: number) => {
      h ^= b & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    };
    const snap = this.world.takeSnapshot();
    for (let i = 0; i < snap.length; i++) mix(snap[i]!);
    const buf = new DataView(new ArrayBuffer(8));
    const num = (n: number) => {
      buf.setFloat64(0, n);
      for (let i = 0; i < 8; i++) mix(buf.getUint8(i));
    };
    num(this.tick);
    for (const f of this.fighters) {
      num(f.hp);
      num(f.alive ? 1 : 0);
      num(f.stun);
      num(f.grenades);
      num(f.cooldown.rocket + f.cooldown.shotgun * 1000 + f.cooldown.grenade * 1e6);
      num(f.aimX);
      num(f.aimY);
    }
    for (const r of this.rockets) {
      num(r.x);
      num(r.y);
      num(r.vx);
      num(r.vy);
    }
    for (const e of this.entities.values()) {
      num(e.id);
      num(e.hp);
      num(e.fuse ?? -1);
    }
    for (const s of this.rng.state()) num(s);
    return h.toString(16).padStart(8, "0");
  }
}
