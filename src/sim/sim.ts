/**
 * Knockback simulation core. Pure TypeScript + Rapier (deterministic build).
 * No rendering, no wall clock, no Math.random: same seed + same inputs =
 * same state, in Bun and in the browser.
 *
 * The level is procedurally generated from the seed (levelgen.ts) and almost
 * all of it can be destroyed (terrain.ts). Trig is only done through the
 * polynomial dsin/dcos (dmath.ts), so the JS side does not drift between engines.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import {
  BARREL,
  BLOCK,
  CRUSH,
  CRATE,
  CRUMBLE_DPS,
  DEBRIS,
  DT,
  FIGHTER,
  G,
  GAS,
  GLASS,
  GRAVITY,
  ITEM,
  ARMORY,
  PAD,
  POWER,
  STEEL,
  SUPPLY,
  SWAP_TICKS,
  TNT,
  WEAPONS,
  WEIGHT,
  ZONE,
  groups,
  type Blast,
} from "./constants";
import { dcos, dsin } from "./dmath";
import { CELL, Mat, type Grid } from "./grid";
import { generateLevel, PROP_HALF, type LevelDef, type PropKind } from "./levelgen";
import { NavGraph } from "./nav";
import { Rng } from "./rng";
import { buildPieceColliders, components, pieceCellWorld, Terrain, type PieceCell } from "./terrain";

/** "fist" is what everyone starts with; the rest are picked up in the arena. */
export type Weapon = "rocket" | "shotgun" | "bat" | "grenade" | "grapple" | "fist";
/** Weapons that exist as pickups. */
export const WEAPON_LIST: readonly Weapon[] = ["rocket", "shotgun", "bat", "grenade", "grapple"];
export const ALL_WEAPONS: readonly Weapon[] = ["rocket", "shotgun", "bat", "grenade", "grapple", "fist"];
export type PowerUp = "health" | "shield" | "speed" | "heavy" | "damage" | "jump";
export const POWER_LIST: readonly PowerUp[] = ["health", "shield", "speed", "heavy", "damage", "jump"];
export type ItemType = PowerUp | Weapon;
export type Stance = "rush" | "distance" | "cover" | "item";
export type EntityKind = PropKind | "fighter" | "chunk" | "item" | "grenade";
export type ExplosionKind = "rocket" | "barrel" | "grenade" | "tnt" | "gas";

/** Who a fighter goes after. Resolved continuously during the fight. */
export type TargetPref = "nearest" | "weakest" | "strongest" | "rocket" | "shotgun" | "leader" | "grudge";

/**
 * What to do when someone keeps hitting you from behind (see the reflex in controller.ts):
 *   attacker  switch your target to them for a while
 *   turn      turn and fight back briefly, then resume (default)
 *   ignore    just glance back and keep going after your target
 */
export type Retaliate = "attacker" | "turn" | "ignore";

/**
 * A fighter's orders for one round, chosen before it (house bot or AI).
 * Nobody is handed weapons: `weapons` is which pickups to go for and use,
 * best first. `line` is what it says before the round.
 */
export interface Strategy {
  target: TargetPref;
  retaliate?: Retaliate;
  /** For target "grudge": the fighter to go after. */
  grudge?: number;
  stance: Stance;
  weapons: Weapon[];
  line: string;
}

export interface Input {
  move: number; // -1..1
  jump: boolean;
  aimX: number;
  aimY: number;
  /** Weapon the controller wants in hand (switches if carried). */
  weapon: Weapon | null;
  fire: boolean;
}

export const NO_INPUT: Input = { move: 0, jump: false, aimX: 1, aimY: 0, weapon: null, fire: false };

export interface Entity {
  id: number;
  kind: EntityKind;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  colliders?: RAPIER.Collider[];
  hw: number; // half width
  hh: number; // half height
  hp: number;
  maxHp: number;
  dead: boolean;
  born: number;
  fighter?: Fighter;
  // barrels, tnt: armed fuse
  fuse?: number;
  chainDepth?: number;
  chainFrom?: string | null;
  triggeredBy?: number;
  // gas canister
  thrust?: number;
  pvx?: number;
  pvy?: number;
  // hanging weight
  joint?: RAPIER.ImpulseJoint | null;
  anchorCx?: number;
  anchorCy?: number;
  ropeLen?: number;
  ax?: number;
  ay?: number;
  // terrain piece
  cells?: PieceCell[];
  // item
  itemType?: ItemType;
  // grenade
  owner?: number;
  ticksLeft?: number;
}

export interface Powers {
  shield: number;
  shieldHits: number;
  speed: number;
  heavy: number;
  damage: number;
  jump: number;
}

export interface Fighter {
  id: number;
  name: string;
  /** cosmetic, from the soul (the engine never reads these) */
  color: number;
  mark: string;
  /** weapon pickups this fighter wants, best first (from its strategy) */
  prefs: Weapon[];
  entity: Entity;
  hp: number;
  alive: boolean;
  koTick: number;
  koCause: "ringout" | "hp" | null;
  koBy: number;
  facing: 1 | -1;
  aimX: number;
  aimY: number;
  weapons: [Weapon, Weapon];
  slot: 0 | 1;
  swap: number;
  cooldown: Record<Weapon, number>;
  stun: number;
  jumpCd: number;
  airJumped: boolean;
  grounded: boolean;
  surface: number; // last known nav surface (-1 unknown)
  lastHitBy: number;
  lastHitTick: number;
  lastHitCause: string;
  kbTick: number;
  shieldTick: number;
  padCd: number;
  crushCd: number;
  outsideZone: boolean;
  outsideTicks: number;
  power: Powers;
  // stats
  damageDealt: number;
  damageTaken: number;
  kos: number;
  pickups: ItemType[];
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
  | { type: "swing"; tick: number; fighter: number; x: number; y: number; dx: number; dy: number; hit: boolean; weapon: "bat" | "fist" }
  | { type: "grapple"; tick: number; fighter: number; x0: number; y0: number; x1: number; y1: number; hit: "fighter" | "prop" | "terrain" | "none"; target: number }
  | { type: "swap"; tick: number; fighter: number; weapon: Weapon }
  | {
      type: "explosion";
      tick: number;
      kind: ExplosionKind;
      x: number;
      y: number;
      radius: number;
      owner: number;
      depth: number;
      chainFrom: string | null;
    }
  | { type: "carve"; tick: number; cells: { x: number; y: number; mat: number }[] }
  | { type: "detach"; tick: number; entity: number; cells: number; x: number; y: number }
  | { type: "hit"; tick: number; target: number; source: number; damage: number; kb: number; x: number; y: number; cause: string; shielded: boolean }
  | { type: "ko"; tick: number; fighter: number; cause: "ringout" | "hp"; by: number; weapon: string; x: number; y: number }
  | { type: "break"; tick: number; entity: number; kind: EntityKind; x: number; y: number; hw: number; hh: number }
  | { type: "pickup"; tick: number; fighter: number; item: ItemType; x: number; y: number }
  | { type: "power"; tick: number; fighter: number; power: PowerUp; on: boolean }
  | { type: "shieldPop"; tick: number; fighter: number; x: number; y: number }
  | { type: "impact"; tick: number; fighter: number; damage: number; x: number; y: number }
  | { type: "jump"; tick: number; fighter: number; air: boolean }
  | { type: "land"; tick: number; fighter: number; speed: number }
  | { type: "bounce"; tick: number; fighter: number; x: number; y: number }
  | { type: "shatter"; tick: number; entity: number; x: number; y: number }
  | { type: "lit"; tick: number; entity: number; kind: "tnt" | "gas" | "barrel" }
  | { type: "snap"; tick: number; entity: number }
  | { type: "zap"; tick: number; fighter: number; x: number; y: number; dir: number }
  | { type: "itemSpawn"; tick: number; entity: number; item: ItemType; x: number; y: number }
  | { type: "propDrop"; tick: number; entity: number; kind: EntityKind; x: number; y: number };

/**
 * How a seat looks: name, color and a cosmetic mark, from its soul. Purely
 * visual: all fighters have the same body, speed, health and fists.
 */
export interface Look {
  name: string;
  color: number;
  mark: string;
}
export const SEAT_LOOKS: Look[] = [
  { name: "Red", color: 0xff4f4f, mark: "none" },
  { name: "Blue", color: 0x47a3ff, mark: "none" },
  { name: "Green", color: 0x4fdc6a, mark: "none" },
  { name: "Gold", color: 0xffc733, mark: "none" },
];

let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const ALL = 0xffff;
const SHOT_FILTER = groups(ALL, G.TERRAIN | G.FIGHTER | G.PROP);
const PROP_FILTER = G.TERRAIN | G.FIGHTER | G.PROP | G.ITEM | G.GRENADE;
const FIGHTER_DENSITY = 2.2;
const POWER_WEIGHTS: [PowerUp, number][] = [
  ["health", 3],
  ["shield", 2.5],
  ["speed", 2],
  ["heavy", 1.5],
  ["damage", 2],
  ["jump", 2],
];

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function zoneHalfAt(tick: number, startHalf: number): number {
  const k = clamp((tick - ZONE.holdTicks) / (ZONE.shrinkEndTicks - ZONE.holdTicks), 0, 1);
  return startHalf + (ZONE.endHalf - startHalf) * k;
}

export class Sim {
  readonly level: LevelDef;
  readonly grid: Grid;
  nav: NavGraph;
  navVersion = 0;
  private lastNavTick = -999;
  readonly rng: Rng;
  readonly world: RAPIER.World;
  readonly terrain: Terrain;
  tick = 0;
  fighters: Fighter[] = [];
  entities = new Map<number, Entity>();
  private byCollider = new Map<number, Entity>();
  rockets: Rocket[] = [];
  events: SimEvent[] = [];
  private nextId = 1;
  zone: { center: number; half: number; startHalf: number };
  /** Sandbox switch (tests): when false the zone neither shrinks nor pushes. */
  zoneEnabled = true;
  private supplyCount = 0;
  readonly initialCells: number;
  stats = {
    blocksDestroyed: 0,
    cratesDestroyed: 0,
    barrelsExploded: 0,
    tntExploded: 0,
    gasLaunched: 0,
    glassShattered: 0,
    weightsDropped: 0,
    bounces: 0,
    chainBarrels: 0,
    barrelToBarrel: 0,
    explosions: 0,
    propsDropped: 0,
    cellsDestroyed: 0,
    cellsDetached: 0,
    piecesFallen: 0,
    platformsFallen: 0,
  };

  constructor(seed: number, level?: LevelDef, looks: Look[] = SEAT_LOOKS) {
    this.level = level ?? generateLevel(seed);
    this.grid = this.level.grid.clone();
    this.rng = new Rng(seed);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY });
    this.world.timestep = DT;
    this.terrain = new Terrain(this.world, this.grid);
    this.nav = NavGraph.fromGrid(this.grid);
    this.navVersion = this.terrain.version;
    this.initialCells = this.grid.countSolid() - this.grid.countMat(Mat.Bedrock);
    const startHalf = this.level.width / 2 - 1;
    this.zone = { center: this.level.zoneCenter, half: startHalf, startHalf };
    for (const p of this.level.props) this.addProp(p.kind, p.x, p.y, p);
    // two power-ups waiting up high: a reason to climb
    const high = this.nav.surfaces.filter((s) => s.y > 3.5 && s.x1 - s.x0 >= 2 && Math.abs((s.x0 + s.x1) / 2 - this.zone.center) < 18);
    for (let i = 0; i < 2 && high.length; i++) {
      const s = high.splice(this.rng.int(0, high.length - 1), 1)[0]!;
      this.spawnItem(this.randomPower(), (s.x0 + s.x1) / 2, s.y + 0.4);
    }
    // seat order is shuffled by seed so no seat owns a spawn
    const spawns = this.rng.shuffle(this.level.spawns.slice());
    for (let i = 0; i < 4; i++) this.addFighter(i, looks[i] ?? SEAT_LOOKS[i]!, spawns[i]!.x, spawns[i]!.y);
    this.stockArmory(spawns);
  }

  /** Weapons waiting at the start: near each spawn (toward the middle), in the middle, up high. */
  private stockArmory(spawns: { x: number; y: number }[]) {
    const nav = this.nav;
    const c = this.zone.center;
    const placed: { x: number; y: number }[] = [];
    // nearest free spot on a solid surface (weapons never stack: ARMORY.minGap apart)
    const near = (x: number, y: number, maxDy: number) => {
      let best: { x: number; y: number } | null = null;
      let bd = Infinity;
      for (const s of nav.surfaces) {
        if (s.x1 - s.x0 < 1 || s.fragile || Math.abs(s.y - y) > maxDy) continue;
        for (let k = 0; k <= 8; k++) {
          const px = clamp(x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.75, s.x0 + 0.4, s.x1 - 0.4);
          if (placed.some((p) => Math.abs(p.x - px) < ARMORY.minGap && Math.abs(p.y - s.y) < 1)) continue;
          const d = Math.abs(px - x) + Math.abs(s.y - y) * 1.5;
          if (d < bd) {
            bd = d;
            best = { x: px, y: s.y };
          }
          break;
        }
      }
      if (best) placed.push(best);
      return best;
    };
    const bag = this.rng.shuffle(WEAPON_LIST.slice());
    let k = 0;
    const next = () => bag[k++ % bag.length]!;
    for (const sp of spawns) {
      for (let n = 0; n < ARMORY.nearSpawn; n++) {
        const q = near(sp.x + (sp.x < c ? 1 : -1) * ARMORY.spawnOffset, sp.y, 2.5);
        if (q) this.spawnItem(next(), q.x, q.y + 0.4);
      }
    }
    for (let n = 0; n < ARMORY.middle; n++) {
      const q = near(c + (n % 2 ? 2.5 : -2.5) * (1 + (n >> 1)), 0, 30);
      if (q) this.spawnItem(next(), q.x, q.y + 0.4);
    }
    const high = nav.surfaces.filter((s) => s.y > 3.5 && s.x1 - s.x0 >= 2 && Math.abs((s.x0 + s.x1) / 2 - c) < 14);
    for (let n = 0; n < ARMORY.high && high.length; n++) {
      const s = high.splice(this.rng.int(0, high.length - 1), 1)[0]!;
      this.spawnItem(this.rng.pick(WEAPON_LIST), (s.x0 + s.x1) / 2 + 0.8, s.y + 0.4);
    }
  }

  // ---------------------------------------------------------------- building

  private register(e: Entity) {
    this.entities.set(e.id, e);
    for (const c of e.colliders ?? [e.collider]) this.byCollider.set(c.handle, e);
  }

  addProp(kind: PropKind, x: number, yBottom: number, spec?: { ax?: number; ay?: number; len?: number }): Entity {
    const [hw, hh] = PROP_HALF[kind];
    const density =
      kind === "steel" || kind === "weight" ? STEEL.density : kind === "pad" ? PAD.density : kind === "block" ? BLOCK.density : kind === "crate" ? CRATE.density : kind === "glass" ? 1.2 : 0.9;
    const hp =
      kind === "block"
        ? BLOCK.hp
        : kind === "crate"
          ? CRATE.hp
          : kind === "barrel"
            ? BARREL.hp
            : kind === "tnt"
              ? TNT.hp
              : kind === "gas"
                ? GAS.hp
                : kind === "glass"
                  ? GLASS.hp
                  : kind === "weight"
                    ? WEIGHT.ropeHp
                    : Infinity;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, yBottom + hh)
        .setLinearDamping(0.05)
        .setAngularDamping(kind === "pad" ? 4 : 0.3)
        .setCcdEnabled(kind === "steel" || kind === "weight"),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hw, hh)
        .setDensity(density)
        .setFriction(0.8)
        .setRestitution(0.05)
        .setCollisionGroups(groups(G.PROP, PROP_FILTER)),
      body,
    );
    const e: Entity = { id: this.nextId++, kind, body, collider, hw, hh, hp, maxHp: hp, dead: false, born: this.tick };
    if (kind === "weight" && spec?.ax !== undefined) {
      e.ax = spec.ax;
      e.ay = spec.ay!;
      e.ropeLen = spec.len!;
      e.anchorCx = this.grid.cx(spec.ax);
      e.anchorCy = this.grid.cy(spec.ay! + 0.01);
      e.joint = this.world.createImpulseJoint(
        RAPIER.JointData.rope(spec.len!, { x: spec.ax, y: spec.ay! }, { x: 0, y: hh }),
        this.terrain.body,
        body,
        true,
      );
    }
    this.register(e);
    return e;
  }

  private addFighter(id: number, def: Look, x: number, y: number) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y + FIGHTER.halfHeight + FIGHTER.radius + 0.05)
        .lockRotations()
        .setCcdEnabled(true)
        .setLinearDamping(0.1),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(FIGHTER.halfHeight, FIGHTER.radius)
        .setDensity(FIGHTER_DENSITY)
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
      born: 0,
    };
    const s = this.nav.surfaceAt(x, y + 0.05);
    const f: Fighter = {
      id,
      name: def.name,
      color: def.color,
      mark: def.mark,
      prefs: WEAPON_LIST.slice(),
      entity: e,
      hp: FIGHTER.maxHp,
      alive: true,
      koTick: -1,
      koCause: null,
      koBy: -1,
      facing: x < this.zone.center ? 1 : -1,
      aimX: x < this.zone.center ? 1 : -1,
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
    this.fighters.push(f);
    this.register(e);
  }

  /** Which weapon pickups a fighter wants, best first (from its strategy). */
  setPrefs(id: number, prefs: readonly Weapon[]) {
    const f = this.fighters[id]!;
    const ok = prefs.filter((w, i) => WEAPON_LIST.includes(w) && prefs.indexOf(w) === i);
    // anything not listed still beats fists, after the listed ones
    f.prefs = [...ok, ...WEAPON_LIST.filter((w) => !ok.includes(w))];
  }

  /** Is a weapon pickup worth taking for this fighter right now? */
  wantsWeapon(f: Fighter, w: Weapon): boolean {
    if (f.weapons.includes(w)) return false;
    if (f.weapons.includes("fist")) return true;
    const other = f.weapons[1 - f.slot]!;
    const rank = (x: Weapon) => {
      const i = f.prefs.indexOf(x);
      return i < 0 ? 99 : i;
    };
    return rank(w) < rank(other);
  }

  spawnItem(type: ItemType, x: number, y: number, vx = 0, vy = 0): Entity {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setLinvel(vx, vy).setAngularDamping(1));
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(ITEM.size / 2, ITEM.size / 2)
        .setDensity(0.5)
        .setFriction(0.9)
        .setCollisionGroups(groups(G.ITEM, G.TERRAIN | G.PROP)),
      body,
    );
    const e: Entity = { id: this.nextId++, kind: "item", body, collider, hw: ITEM.size / 2, hh: ITEM.size / 2, hp: 1, maxHp: 1, dead: false, born: this.tick, itemType: type };
    this.register(e);
    this.events.push({ type: "itemSpawn", tick: this.tick, entity: e.id, item: type, x, y });
    return e;
  }

  private randomPower(): PowerUp {
    const total = POWER_WEIGHTS.reduce((a, w) => a + w[1], 0);
    let r = this.rng.next() * total;
    for (const [p, w] of POWER_WEIGHTS) {
      r -= w;
      if (r < 0) return p;
    }
    return "health";
  }

  private randomDrop(weaponChance: number): ItemType {
    return this.rng.chance(weaponChance) ? this.rng.pick(WEAPON_LIST) : this.randomPower();
  }

  private looseWeapons(): number {
    let n = 0;
    for (const e of this.entities.values()) if (e.kind === "item" && !e.dead && WEAPON_LIST.includes(e.itemType as Weapon)) n++;
    return n;
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

  weapon(f: Fighter): Weapon {
    return f.weapons[f.slot];
  }

  entityOf(c: RAPIER.Collider): Entity | undefined {
    return this.byCollider.get(c.handle);
  }

  /** First thing hit by a ray. entity null + terrain true = static level cells. */
  raycast(x: number, y: number, dx: number, dy: number, maxDist: number, exclude?: RAPIER.Collider) {
    const ray = new RAPIER.Ray({ x, y }, { x: dx, y: dy });
    const hit = this.world.castRay(ray, maxDist, true, undefined, SHOT_FILTER, exclude);
    if (!hit) return null;
    const entity = this.byCollider.get(hit.collider.handle) ?? null;
    return { dist: hit.timeOfImpact, entity, terrain: !entity };
  }

  kbMult(hp: number): number {
    return 1 + (clamp(FIGHTER.maxHp - hp, 0, FIGHTER.maxHp) / 100) * FIGHTER.kbGrowth;
  }

  /** Share of the original destructible cells destroyed or knocked loose. */
  destroyedShare(): number {
    return (this.stats.cellsDestroyed + this.stats.cellsDetached) / Math.max(1, this.initialCells);
  }

  /** Lit TNT, armed barrels and flying gas canisters: things to run from. */
  dangers(): { x: number; y: number; r: number }[] {
    const out: { x: number; y: number; r: number }[] = [];
    for (const e of this.entities.values()) {
      if (e.dead) continue;
      if ((e.kind === "tnt" || e.kind === "barrel") && e.fuse !== undefined) {
        const t = e.body.translation();
        out.push({ x: t.x, y: t.y, r: e.kind === "tnt" ? TNT.radius + 0.8 : BARREL.radius });
      }
    }
    return out;
  }

  // -------------------------------------------------------------- supply drops

  private dropX(): number {
    const z = this.zone;
    const lo = Math.max(this.level.minX + 3, z.center - z.half + 1.5);
    const hi = Math.min(this.level.maxX - 3, z.center + z.half - 1.5);
    // land on something: pick among nav surfaces inside the zone
    const surf = this.nav.surfaces.filter((s) => s.x1 > lo + 0.5 && s.x0 < hi - 0.5 && s.x1 - s.x0 > 1.5);
    if (surf.length === 0) return this.rng.range(lo, hi);
    const s = this.rng.pick(surf);
    return this.rng.range(Math.max(lo, s.x0 + 0.5), Math.min(hi, s.x1 - 0.5));
  }

  private supplyDrop() {
    const n = this.supplyCount++;
    const wc = this.looseWeapons() >= SUPPLY.maxLooseWeapons ? 0 : SUPPLY.weaponChance;
    this.spawnItem(this.randomDrop(wc), this.dropX(), 16);
    if (n % 2 === 0) {
      const x = this.dropX();
      const tnt = this.rng.chance(0.3);
      const a = this.addProp(tnt ? "tnt" : "barrel", x, 15);
      this.events.push({ type: "propDrop", tick: this.tick, entity: a.id, kind: a.kind, x, y: 15 });
      if (!tnt) {
        const b = this.addProp("barrel", x + (this.rng.chance(0.5) ? 0.75 : -0.75), 16.4);
        this.events.push({ type: "propDrop", tick: this.tick, entity: b.id, kind: b.kind, x, y: 16.4 });
      }
      this.stats.propsDropped += tnt ? 1 : 2;
    }
  }

  // -------------------------------------------------------------------- step

  step(inputs: readonly Input[]) {
    const tick = this.tick;
    const z = this.zone;
    if (this.zoneEnabled) z.half = zoneHalfAt(tick, z.startHalf);
    if (tick >= SUPPLY.firstTick && (tick - SUPPLY.firstTick) % SUPPLY.interval === 0) this.supplyDrop();

    for (const f of this.fighters) {
      if (!f.alive) continue;
      this.tickPowers(f);
      this.applyInput(f, inputs[f.id] ?? NO_INPUT);
      this.zonePush(f);
    }
    this.updateRockets();
    this.updateObjects();
    this.flushTerrain();

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
        f.airJumped = false;
        const s = this.nav.surfaceAt(p.x, this.feetY(f));
        if (s) f.surface = s.id;
        if (!wasGrounded && pre[f.id]!.y < -4) this.events.push({ type: "land", tick, fighter: f.id, speed: -pre[f.id]!.y });
        this.crumbleUnder(f, p.x);
      }
      const ex = pre[f.id]!.x;
      const ey = pre[f.id]!.y - GRAVITY * DT;
      const dv = Math.sqrt((v.x - ex) * (v.x - ex) + (v.y - ey) * (v.y - ey));
      if (dv > FIGHTER.impactThreshold) {
        const dmg = (dv - FIGHTER.impactThreshold) * FIGHTER.impactDamagePerMs;
        const src = tick - f.lastHitTick < 120 ? f.lastHitBy : -1;
        this.events.push({ type: "impact", tick, fighter: f.id, damage: dmg, x: p.x, y: p.y });
        this.damageFighter(f, dmg, src, 0, 0, "impact", p.x, p.y);
        if (!f.alive) continue;
      }
      const ringX = this.level.width / 2 + 6;
      if (p.y < FIGHTER.ringOutY || p.x < -ringX || p.x > ringX) {
        this.knockOut(f, "ringout", p.x, p.y);
        continue;
      }
      this.checkPickups(f, p.x, p.y);
    }
    // world-out and debris cleanup
    for (const e of [...this.entities.values()]) {
      if (e.dead || e.kind === "fighter") continue;
      const t = e.body.translation();
      if (t.y < -25 || t.x < -70 || t.x > 70) {
        this.removeEntity(e);
        continue;
      }
      if (e.kind === "chunk" && e.cells!.length <= DEBRIS.smallCells && tick - e.born > DEBRIS.smallTicks) {
        this.events.push({ type: "break", tick, entity: e.id, kind: "chunk", x: t.x, y: t.y, hw: e.hw, hh: e.hh });
        this.removeEntity(e);
      }
    }
    if (this.terrain.version !== this.navVersion && tick - this.lastNavTick >= 20) this.rebuildNav();
    this.tick++;
  }

  private rebuildNav() {
    this.nav = NavGraph.fromGrid(this.grid);
    this.navVersion = this.terrain.version;
    this.lastNavTick = this.tick;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      const p = this.pos(f);
      const s = this.nav.surfaceAt(p.x, this.feetY(f), 1);
      f.surface = s ? s.id : -1;
    }
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

  private crumbleUnder(f: Fighter, x: number) {
    const g = this.grid;
    const cy = g.cy(this.feetY(f) - 0.1);
    for (const ox of [-0.3, 0, 0.3]) {
      const cx = g.cx(x + ox);
      if (g.matAt(cx, cy) !== Mat.Crumble) continue;
      const m = Mat.Crumble;
      if (this.terrain.damageCell(cx, cy, CRUMBLE_DPS * DT)) {
        this.stats.cellsDestroyed++;
        this.events.push({ type: "carve", tick: this.tick, cells: [{ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2, mat: m }] });
      }
    }
  }

  private tickPowers(f: Fighter) {
    const p = f.power;
    const end = (k: PowerUp) => this.events.push({ type: "power", tick: this.tick, fighter: f.id, power: k, on: false });
    if (p.shield > 0 && --p.shield === 0) end("shield");
    if (p.speed > 0 && --p.speed === 0) end("speed");
    if (p.damage > 0 && --p.damage === 0) end("damage");
    if (p.jump > 0 && --p.jump === 0) end("jump");
    if (p.heavy > 0 && --p.heavy === 0) {
      f.entity.collider.setDensity(FIGHTER_DENSITY);
      end("heavy");
    }
    if (f.padCd > 0) f.padCd--;
    if (f.crushCd > 0) f.crushCd--;
  }

  private zonePush(f: Fighter) {
    const z = this.zone;
    const p = f.entity.body.translation();
    const out = !this.zoneEnabled ? 0 : p.x < z.center - z.half ? z.center - z.half - p.x : p.x > z.center + z.half ? -(p.x - z.center - z.half) : 0;
    f.outsideZone = out !== 0;
    if (out === 0) {
      f.outsideTicks = 0;
      return;
    }
    const dir = out > 0 ? 1 : -1;
    const depth = Math.abs(out);
    // stuck outside (behind a wall, in a hole): the zone flings you back in, over obstacles
    if (++f.outsideTicks >= ZONE.shockAfter && (f.outsideTicks - ZONE.shockAfter) % ZONE.shockEvery === 0) {
      const p2 = this.pos(f);
      this.damageFighter(f, ZONE.shockDamage, -1, 0, 0, "zone", p2.x, p2.y);
      if (!f.alive) return;
      f.entity.body.setLinvel({ x: dir * ZONE.shockX, y: ZONE.shockY }, true);
      f.stun = Math.max(f.stun, 18);
      f.grounded = false;
      this.events.push({ type: "zap", tick: this.tick, fighter: f.id, x: p2.x, y: p2.y, dir });
      return;
    }
    const v = f.entity.body.linvel();
    let nvx: number;
    if (f.grounded && f.stun === 0) {
      const min = Math.min(14, ZONE.pushSpeed + ZONE.pushSpeedPerMeter * depth);
      nvx = dir > 0 ? Math.max(v.x, min) : Math.min(v.x, -min);
    } else {
      const a = ZONE.pushAccel + ZONE.pushPerMeter * depth;
      const w = v.x + dir * a * DT;
      nvx = dir > 0 ? Math.max(v.x, Math.min(w, 14)) : Math.min(v.x, Math.max(w, -14));
    }
    f.entity.body.setLinvel({ x: nvx, y: v.y }, true);
  }

  private applyInput(f: Fighter, inp: Input) {
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
        this.events.push({ type: "jump", tick: this.tick, fighter: f.id, air: false });
      } else if (f.power.jump > 0 && !f.airJumped) {
        vy = FIGHTER.jumpSpeed * 0.95;
        f.airJumped = true;
        f.jumpCd = 10;
        this.events.push({ type: "jump", tick: this.tick, fighter: f.id, air: true });
      }
    }
    body.setLinvel({ x: vx, y: vy }, true);

    const al = Math.sqrt(inp.aimX * inp.aimX + inp.aimY * inp.aimY);
    if (al > 1e-6) {
      f.aimX = inp.aimX / al;
      f.aimY = inp.aimY / al;
    }
    if (f.aimX > 0.05) f.facing = 1;
    else if (f.aimX < -0.05) f.facing = -1;

    if (inp.weapon && inp.weapon !== this.weapon(f)) {
      const slot = f.weapons.indexOf(inp.weapon);
      if (slot >= 0) {
        f.slot = slot as 0 | 1;
        f.swap = SWAP_TICKS;
        this.events.push({ type: "swap", tick: this.tick, fighter: f.id, weapon: inp.weapon });
      }
    }
    if (inp.fire && f.swap === 0) this.fire(f, this.weapon(f));
  }

  // ----------------------------------------------------------------- weapons

  private fire(f: Fighter, weapon: Weapon) {
    if (f.cooldown[weapon] > 0) return;
    const p = this.pos(f);
    const ox = p.x;
    const oy = p.y + 0.25;
    const dx = f.aimX;
    const dy = f.aimY;
    this.events.push({ type: "fire", tick: this.tick, fighter: f.id, weapon, x: ox, y: oy, dx, dy });
    switch (weapon) {
      case "rocket": {
        f.cooldown.rocket = WEAPONS.rocket.cooldown;
        const muzzle = 0.95;
        const block = this.raycast(ox, oy, dx, dy, muzzle, f.entity.collider);
        if (block) {
          this.explode(ox + dx * block.dist, oy + dy * block.dist, WEAPONS.rocket, "rocket", f.id, 0, null);
          return;
        }
        const s = WEAPONS.rocket.speed;
        this.rockets.push({ id: this.nextId++, owner: f.id, x: ox + dx * muzzle, y: oy + dy * muzzle, vx: dx * s, vy: dy * s, age: 0 });
        break;
      }
      case "shotgun":
        f.cooldown.shotgun = WEAPONS.shotgun.cooldown;
        this.fireShotgun(f, ox, oy, dx, dy);
        break;
      case "bat":
        f.cooldown.bat = WEAPONS.bat.cooldown;
        this.swingBat(f, ox, oy, dx, dy);
        break;
      case "fist":
        f.cooldown.fist = WEAPONS.fist.cooldown;
        this.punch(f, ox, oy, dx, dy);
        break;
      case "grenade":
        f.cooldown.grenade = WEAPONS.grenade.cooldown;
        this.throwGrenade(f, ox, oy, dx, dy);
        break;
      case "grapple":
        f.cooldown.grapple = WEAPONS.grapple.cooldown;
        this.fireGrapple(f, ox, oy, dx, dy);
        break;
    }
  }

  /** Damage the static cell just behind a hit point on terrain. */
  private chipTerrain(x: number, y: number, dx: number, dy: number, dmg: number) {
    const g = this.grid;
    const cx = g.cx(x + dx * 0.05);
    const cy = g.cy(y + dy * 0.05);
    const m = g.matAt(cx, cy);
    if (m !== Mat.Empty && this.terrain.damageCell(cx, cy, dmg)) {
      this.stats.cellsDestroyed++;
      this.events.push({ type: "carve", tick: this.tick, cells: [{ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL / 2, mat: m }] });
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
      const hx = ox + rx * dist;
      const hy = oy + ry * dist;
      this.events.push({ type: "pellet", tick: this.tick, fighter: f.id, x0: ox, y0: oy, x1: hx, y1: hy, hit: !!hit });
      if (!hit) continue;
      const fall = 1 - 0.45 * (dist / W.range);
      if (hit.terrain) {
        this.chipTerrain(hx, hy, rx, ry, W.pelletTerrainDamage * fall);
        continue;
      }
      const e = hit.entity!;
      if (e.kind === "fighter" && e.fighter) {
        if (!e.fighter.alive) continue;
        const kb = W.pelletKnock * fall;
        this.damageFighter(e.fighter, W.pelletDamage * fall, f.id, rx * kb, ry * kb + 0.35 * kb, "shotgun", hx, hy);
      } else {
        this.hitProp(e, W.pelletBlockDamage * fall, f.id, "shotgun", hx, hy);
        if (!e.dead) e.body.applyImpulseAtPoint({ x: rx * W.pelletImpulse, y: ry * W.pelletImpulse }, { x: hx, y: hy }, true);
      }
    }
  }

  private swingBat(f: Fighter, ox: number, oy: number, dx: number, dy: number) {
    const B = WEAPONS.bat;
    const cx = ox + dx * B.reach;
    const cy = oy + dy * B.reach + 0.1;
    const found: Entity[] = [];
    this.world.intersectionsWithShape({ x: cx, y: cy }, 0, new RAPIER.Ball(B.radius), (c) => {
      const e = this.byCollider.get(c.handle);
      if (e && !e.dead && e !== f.entity && !found.includes(e)) found.push(e);
      return true;
    });
    let lx = dx;
    let ly = dy + B.lift;
    const l = Math.sqrt(lx * lx + ly * ly);
    lx /= l;
    ly /= l;
    let hitAny = false;
    for (const e of found) {
      if (e.kind === "fighter" && e.fighter) {
        if (!e.fighter.alive) continue;
        const t = e.body.translation();
        this.damageFighter(e.fighter, B.damage, f.id, lx * B.knockback, ly * B.knockback, "bat", t.x, t.y);
        hitAny = true;
      } else if (e.kind !== "item") {
        this.hitProp(e, 15, f.id, "bat", cx, cy);
        if (!e.dead) {
          const m = e.body.mass();
          e.body.applyImpulse({ x: lx * B.propImpulse * Math.min(m, 4), y: ly * B.propImpulse * Math.min(m, 4) }, true);
        }
        hitAny = true;
      }
    }
    // the bat smashes through walls too
    const smashed = this.terrain.carve(cx + dx * 0.3, cy + dy * 0.3, B.terrainRadius, B.terrainDamage);
    if (smashed.length) {
      this.stats.cellsDestroyed += smashed.length;
      this.events.push({ type: "carve", tick: this.tick, cells: smashed });
      hitAny = true;
    }
    this.events.push({ type: "swing", tick: this.tick, fighter: f.id, x: cx, y: cy, dx, dy, hit: hitAny, weapon: "bat" });
  }

  /** Fists: a short jab, small shove, chips nothing. */
  private punch(f: Fighter, ox: number, oy: number, dx: number, dy: number) {
    const P = WEAPONS.fist;
    const cx = ox + dx * P.reach;
    const cy = oy + dy * P.reach;
    const found: Entity[] = [];
    this.world.intersectionsWithShape({ x: cx, y: cy }, 0, new RAPIER.Ball(P.radius), (c) => {
      const e = this.byCollider.get(c.handle);
      if (e && !e.dead && e !== f.entity && !found.includes(e)) found.push(e);
      return true;
    });
    let lx = dx;
    let ly = dy + P.lift;
    const l = Math.sqrt(lx * lx + ly * ly);
    lx /= l;
    ly /= l;
    let hitAny = false;
    for (const e of found) {
      if (e.kind === "fighter" && e.fighter) {
        if (!e.fighter.alive) continue;
        const t = e.body.translation();
        this.damageFighter(e.fighter, P.damage, f.id, lx * P.knockback, ly * P.knockback, "fist", t.x, t.y);
        hitAny = true;
      } else if (e.kind !== "item") {
        this.hitProp(e, 4, f.id, "fist", cx, cy);
        if (!e.dead) {
          const m = e.body.mass();
          e.body.applyImpulse({ x: lx * P.propImpulse * Math.min(m, 3), y: ly * P.propImpulse * Math.min(m, 3) }, true);
        }
        hitAny = true;
      }
    }
    this.events.push({ type: "swing", tick: this.tick, fighter: f.id, x: cx, y: cy, dx, dy, hit: hitAny, weapon: "fist" });
  }

  private throwGrenade(f: Fighter, ox: number, oy: number, dx: number, dy: number) {
    const v = this.vel(f);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(ox + dx * 0.8, oy + dy * 0.8 + 0.2)
        .setLinvel(dx * WEAPONS.grenade.speed + v.x * 0.3, dy * WEAPONS.grenade.speed + v.y * 0.3)
        .setCcdEnabled(true)
        .setAngularDamping(0.5),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(0.22).setDensity(3).setRestitution(0.45).setFriction(0.6).setCollisionGroups(groups(G.GRENADE, G.TERRAIN | G.FIGHTER | G.PROP)),
      body,
    );
    this.register({ id: this.nextId++, kind: "grenade", body, collider, hw: 0.22, hh: 0.22, hp: 1, maxHp: 1, dead: false, born: this.tick, owner: f.id, ticksLeft: WEAPONS.grenade.fuse });
  }

  private fireGrapple(f: Fighter, ox: number, oy: number, dx: number, dy: number) {
    const Gp = WEAPONS.grapple;
    const hit = this.raycast(ox, oy, dx, dy, Gp.range, f.entity.collider);
    const dist = hit ? hit.dist : Gp.range;
    const hx = ox + dx * dist;
    const hy = oy + dy * dist;
    let kind: "fighter" | "prop" | "terrain" | "none" = hit ? (hit.terrain ? "terrain" : "prop") : "none";
    let target = -1;
    if (hit?.entity) {
      const e = hit.entity;
      const t = e.body.translation();
      let px = ox - t.x;
      let py = oy - t.y;
      const l = Math.sqrt(px * px + py * py) || 1;
      px /= l;
      py /= l;
      if (e.kind === "fighter" && e.fighter) {
        kind = "fighter";
        target = e.fighter.id;
        const fi = e.fighter;
        if (fi.alive) {
          // yank toward the shooter: off ledges, into bat range
          this.damageFighter(fi, Gp.damage, f.id, 0, 0, "grapple", t.x, t.y);
          if (fi.alive) {
            const k = fi.power.heavy > 0 ? 0.5 : fi.power.shield > 0 ? 0.6 : 1;
            e.body.setLinvel({ x: px * Gp.pull * k, y: (py * Gp.pull + Gp.lift) * k }, true);
            fi.stun = Math.max(fi.stun, Gp.stun);
            fi.grounded = false;
          }
        }
      } else if (e.kind !== "item") {
        const m = Math.min(e.body.mass(), 12);
        e.body.applyImpulse({ x: px * Gp.pull * m * 0.8, y: (py * Gp.pull + Gp.lift) * m * 0.8 }, true);
        if (e.kind === "glass") this.hitProp(e, 5, f.id, "grapple", hx, hy);
      }
    }
    this.events.push({ type: "grapple", tick: this.tick, fighter: f.id, x0: ox, y0: oy, x1: hx, y1: hy, hit: kind, target });
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
      if (r.y < -20 || r.x < -70 || r.x > 70) continue;
      keep.push(r);
    }
    this.rockets = keep;
  }

  // ----------------------------------------------------------------- objects

  private updateObjects() {
    for (const e of [...this.entities.values()]) {
      if (e.dead) continue;
      switch (e.kind) {
        case "grenade":
          if (--e.ticksLeft! <= 0) {
            const t = e.body.translation();
            this.removeEntity(e);
            this.explode(t.x, t.y, WEAPONS.grenade, "grenade", e.owner!, 0, null);
          }
          break;
        case "barrel":
        case "tnt":
          if (e.fuse !== undefined && --e.fuse <= 0) {
            const t = e.body.translation();
            this.removeEntity(e);
            if (e.kind === "barrel") this.stats.barrelsExploded++;
            else this.stats.tntExploded++;
            if (e.chainFrom === "rocket" || e.chainFrom === "barrel" || e.chainFrom === "grenade" || e.chainFrom === "tnt" || e.chainFrom === "gas") this.stats.chainBarrels++;
            if (e.chainFrom === "barrel" || e.chainFrom === "tnt") this.stats.barrelToBarrel++;
            this.explode(t.x, t.y, e.kind === "tnt" ? TNT : BARREL, e.kind, e.triggeredBy ?? -1, e.chainDepth ?? 0, e.chainFrom ?? null);
          }
          break;
        case "gas":
          if (e.thrust !== undefined) this.updateGas(e);
          break;
        case "weight":
          if (e.joint && (!this.grid.solid(e.anchorCx!, e.anchorCy!) || e.hp <= 0)) {
            this.world.removeImpulseJoint(e.joint, true);
            e.joint = null;
            this.stats.weightsDropped++;
            this.events.push({ type: "snap", tick: this.tick, entity: e.id });
          }
          break;
        case "pad":
          this.updatePad(e);
          break;
        case "glass":
          this.checkGlass(e);
          break;
      }
      if ((e.kind === "steel" || e.kind === "weight" || e.kind === "chunk") && !e.dead) this.checkCrush(e);
    }
  }

  private updateGas(e: Entity) {
    const a = e.body.rotation();
    const ux = -dsin(a);
    const uy = dcos(a);
    const m = e.body.mass();
    e.body.applyImpulse({ x: ux * GAS.thrust * m * DT, y: uy * GAS.thrust * m * DT }, true);
    e.body.applyTorqueImpulse((this.rng.next() - 0.5) * 0.5 * m, true);
    const v = e.body.linvel();
    const dv = e.pvx === undefined ? 0 : Math.sqrt((v.x - e.pvx) * (v.x - e.pvx) + (v.y - e.pvy!) * (v.y - e.pvy!));
    e.pvx = v.x;
    e.pvy = v.y;
    e.thrust!--;
    if (e.thrust! <= 0 || (e.thrust! < GAS.thrustTicks - 15 && dv > 7)) {
      const t = e.body.translation();
      this.removeEntity(e);
      this.explode(t.x, t.y, GAS, "gas", e.triggeredBy ?? -1, e.chainDepth ?? 0, e.chainFrom ?? null);
    }
  }

  private updatePad(e: Entity) {
    const t = e.body.translation();
    const top = t.y + e.hh;
    for (const f of this.fighters) {
      if (!f.alive || f.padCd > 0) continue;
      const p = this.pos(f);
      const feet = this.feetY(f);
      if (Math.abs(p.x - t.x) < e.hw + 0.15 && feet > top - 0.15 && feet < top + 0.35 && f.entity.body.linvel().y <= 2) {
        f.entity.body.setLinvel({ x: f.entity.body.linvel().x, y: PAD.launch }, true);
        f.padCd = PAD.cooldown;
        f.grounded = false;
        this.stats.bounces++;
        this.events.push({ type: "bounce", tick: this.tick, fighter: f.id, x: t.x, y: top });
      }
    }
  }

  /** Heavy things falling on fighters hurt (a pinned fighter cannot show it as a velocity change). */
  private checkCrush(e: Entity) {
    const v = e.body.linvel();
    if (v.y > -CRUSH.minSpeed) return;
    const m = e.body.mass();
    if (m < CRUSH.minMass) return;
    const t = e.body.translation();
    this.world.intersectionsWithShape({ x: t.x, y: t.y - 0.15 }, e.body.rotation(), new RAPIER.Ball(Math.max(e.hw, e.hh) + 0.1), (c) => {
      const o = this.byCollider.get(c.handle);
      const f = o?.fighter;
      if (!f || !f.alive || f.crushCd > 0) return true;
      const p = this.pos(f);
      if (p.y > t.y) return true; // only from above
      const dmg = Math.min(CRUSH.max, (-v.y - CRUSH.minSpeed + 2) * Math.sqrt(m) * CRUSH.perUnit);
      f.crushCd = 30;
      this.damageFighter(f, dmg, e.triggeredBy ?? -1, 0, 0, "crush", p.x, p.y);
      return true;
    });
  }

  private checkGlass(e: Entity) {
    const t = e.body.translation();
    let smash = false;
    // look ahead: a fast body is caught before the contact stops it
    this.world.intersectionsWithShape({ x: t.x, y: t.y }, e.body.rotation(), new RAPIER.Cuboid(e.hw + 0.6, e.hh + 0.3), (c) => {
      const o = this.byCollider.get(c.handle);
      if (!o || o === e || o.kind === "item") return true;
      const v = o.body.linvel();
      if (v.x * v.x + v.y * v.y > GLASS.shatterSpeed * GLASS.shatterSpeed) smash = true;
      return !smash;
    });
    if (smash) this.shatter(e);
  }

  private shatter(e: Entity) {
    const t = e.body.translation();
    this.stats.glassShattered++;
    this.events.push({ type: "shatter", tick: this.tick, entity: e.id, x: t.x, y: t.y });
    this.removeEntity(e);
  }

  private light(e: Entity, owner: number, depth: number, cause: string) {
    if (e.dead) return;
    if (e.kind === "tnt") {
      const fuse = cause === "shotgun" || cause === "bat" || cause === "grapple" ? TNT.fuse : TNT.chainFuse;
      if (e.fuse === undefined) {
        e.fuse = fuse;
        e.chainDepth = depth + 1;
        e.chainFrom = cause;
        e.triggeredBy = owner;
        this.events.push({ type: "lit", tick: this.tick, entity: e.id, kind: "tnt" });
      } else e.fuse = Math.min(e.fuse, fuse);
    } else if (e.kind === "barrel" && e.fuse === undefined) {
      e.fuse = this.rng.int(BARREL.fuseMin, BARREL.fuseMax);
      e.chainDepth = cause === "shotgun" || cause === "bat" ? 0 : depth + 1;
      e.chainFrom = cause;
      e.triggeredBy = owner;
      this.events.push({ type: "lit", tick: this.tick, entity: e.id, kind: "barrel" });
    } else if (e.kind === "gas" && e.thrust === undefined) {
      e.thrust = GAS.thrustTicks;
      e.chainDepth = depth + 1;
      e.chainFrom = cause;
      e.triggeredBy = owner;
      e.body.setAngularDamping(0.2);
      this.stats.gasLaunched++;
      this.events.push({ type: "lit", tick: this.tick, entity: e.id, kind: "gas" });
    }
  }

  /** Damage any non-fighter thing; reacts by kind. */
  private hitProp(e: Entity, dmg: number, owner: number, cause: string, hx: number, hy: number, depth = 0) {
    if (e.dead || dmg <= 0) return;
    switch (e.kind) {
      case "glass":
        this.shatter(e);
        return;
      case "barrel":
      case "tnt":
      case "gas":
        e.hp -= dmg;
        if (e.hp <= 0) this.light(e, owner, depth, cause);
        return;
      case "weight":
        e.hp -= dmg;
        return;
      case "steel":
      case "pad":
      case "item":
      case "grenade":
      case "fighter":
        return;
      case "chunk":
        this.damagePiece(e, hx, hy, 0.7, dmg * 1.5);
        return;
      default: {
        e.hp -= dmg;
        if (e.hp > 0) return;
        const t = e.body.translation();
        this.events.push({ type: "break", tick: this.tick, entity: e.id, kind: e.kind, x: t.x, y: t.y, hw: e.hw, hh: e.hh });
        if (e.kind === "block") this.stats.blocksDestroyed++;
        this.removeEntity(e);
        if (e.kind === "crate") {
          this.stats.cratesDestroyed++;
          if (this.rng.chance(CRATE.dropChance)) this.spawnItem(this.randomDrop(ARMORY.crateWeaponChance), t.x, t.y + 0.2, 0, 3);
        }
      }
    }
  }

  explode(x: number, y: number, spec: Blast, kind: ExplosionKind, owner: number, depth: number, chainFrom: string | null) {
    this.stats.explosions++;
    this.events.push({ type: "explosion", tick: this.tick, kind, x, y, radius: spec.radius, owner, depth, chainFrom });
    const carved = this.terrain.carve(x, y, spec.radius * 0.85, spec.terrainDamage);
    if (carved.length) {
      this.stats.cellsDestroyed += carved.length;
      this.events.push({ type: "carve", tick: this.tick, cells: carved.slice(0, 60) });
    }
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
      if (f <= 0 && e.kind !== "chunk") continue;
      let nx = d > 0.01 ? dx / d : 0;
      let ny = d > 0.01 ? dy / d : 1;
      if (e.kind === "fighter" && e.fighter) {
        const fi = e.fighter;
        if (!fi.alive) continue;
        ny += 0.55;
        const l = Math.sqrt(nx * nx + ny * ny);
        nx /= l;
        ny /= l;
        const kb = spec.knockback * (0.45 + 0.55 * f);
        this.damageFighter(fi, spec.damage * (0.35 + 0.65 * f), owner, nx * kb, ny * kb, kind, t.x, t.y);
        continue;
      }
      if (e.kind === "chunk") {
        this.damagePiece(e, x, y, spec.radius * 0.85, spec.terrainDamage);
        if (e.dead) continue;
      } else if (e.kind !== "item" && e.kind !== "grenade") {
        // blocks only break near the center; further out they get shoved, so cover collapses
        this.hitProp(e, spec.blockDamage * f * f, owner, kind, t.x, t.y, depth);
        if (e.dead) continue;
      }
      const m = Math.min(e.body.mass(), 30);
      const imp = spec.knockback * f * m * (e.kind === "item" || e.kind === "grenade" ? 0.7 : 0.55);
      e.body.applyImpulse({ x: nx * imp, y: (ny + 0.3) * imp }, true);
      e.body.applyTorqueImpulse((nx >= 0 ? -1 : 1) * imp * 0.08, true);
    }
  }

  // ------------------------------------------------------------ terrain pieces

  /** Rebuild changed terrain colliders and drop whatever lost its support. */
  private flushTerrain() {
    const groupsLoose = this.terrain.detachUnsupported();
    this.terrain.flushColliders();
    for (const comp of groupsLoose) {
      let minCx = Infinity;
      let minCy = Infinity;
      for (const c of comp) {
        minCx = Math.min(minCx, c.cx);
        minCy = Math.min(minCy, c.cy);
      }
      const cells: PieceCell[] = comp.map((c) => ({ lx: c.cx - minCx, ly: c.cy - minCy, mat: c.mat, hp: c.hp }));
      const e = this.makePiece(cells, this.grid.wx(minCx), this.grid.wy(minCy), 0, { x: 0, y: 0 }, 0);
      this.stats.cellsDetached += cells.length;
      this.stats.piecesFallen++;
      if (cells.length >= 4) this.stats.platformsFallen++;
      const t = e.body.translation();
      this.events.push({ type: "detach", tick: this.tick, entity: e.id, cells: cells.length, x: t.x + e.hw, y: t.y + e.hh });
    }
  }

  private makePiece(cells: PieceCell[], x: number, y: number, angle: number, v: { x: number; y: number }, w: number): Entity {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setRotation(angle).setLinvel(v.x, v.y).setAngvel(w).setLinearDamping(0.05).setAngularDamping(0.4).setCcdEnabled(cells.length >= 6),
    );
    const colliders = buildPieceColliders(this.world, body, cells);
    let maxX = 0;
    let maxY = 0;
    for (const c of cells) {
      maxX = Math.max(maxX, c.lx + 1);
      maxY = Math.max(maxY, c.ly + 1);
    }
    const e: Entity = {
      id: this.nextId++,
      kind: "chunk",
      body,
      collider: colliders[0]!,
      colliders,
      hw: (maxX * CELL) / 2,
      hh: (maxY * CELL) / 2,
      hp: cells.length,
      maxHp: cells.length,
      dead: false,
      born: this.tick,
      cells,
    };
    this.register(e);
    return e;
  }

  /** Damage the cells of a loose piece within radius r of (x, y); splits it if needed. */
  private damagePiece(e: Entity, x: number, y: number, r: number, dmg: number) {
    const t = e.body.translation();
    const a = e.body.rotation();
    const cells = e.cells!;
    let changed = false;
    const broken: { x: number; y: number; mat: number }[] = [];
    for (const c of cells) {
      const w = pieceCellWorld(t, a, c);
      const d = Math.sqrt((w.x - x) * (w.x - x) + (w.y - y) * (w.y - y));
      if (d > r + CELL * 0.5) continue;
      c.hp -= dmg * clamp(1 - d / (r + CELL), 0.2, 1);
      if (c.hp <= 0) {
        changed = true;
        broken.push({ x: w.x, y: w.y, mat: c.mat });
      }
    }
    if (!changed) return;
    this.stats.cellsDestroyed += broken.length;
    this.events.push({ type: "carve", tick: this.tick, cells: broken });
    const left = cells.filter((c) => c.hp > 0);
    const v = e.body.linvel();
    const w = e.body.angvel();
    this.removeEntity(e);
    if (left.length === 0) return;
    for (const comp of components(left)) {
      this.makePiece(comp, t.x, t.y, a, v, w);
    }
  }

  // ----------------------------------------------------------------- damage

  damageFighter(f: Fighter, dmg: number, source: number, kbx: number, kby: number, cause: string, hx: number, hy: number) {
    if (!f.alive) return;
    const src = source >= 0 && source !== f.id ? this.fighters[source]! : null;
    if (src && src.power.damage > 0) {
      dmg *= POWER.damage.mul;
      kbx *= POWER.damage.kbMul;
      kby *= POWER.damage.kbMul;
    }
    let shielded = false;
    if (f.power.shield > 0 && cause !== "impact") {
      shielded = true;
      dmg *= POWER.shield.damageMul;
      kbx *= POWER.shield.kbMul;
      kby *= POWER.shield.kbMul;
      if (f.shieldTick !== this.tick) {
        f.shieldTick = this.tick;
        if (++f.power.shieldHits >= POWER.shield.hits) {
          f.power.shield = 0;
          const p = this.pos(f);
          this.events.push({ type: "shieldPop", tick: this.tick, fighter: f.id, x: p.x, y: p.y });
        }
      }
    }
    if (f.power.heavy > 0) {
      kbx *= POWER.heavy.kbMul;
      kby *= POWER.heavy.kbMul;
    }
    f.hp -= dmg;
    f.damageTaken += dmg;
    if (src) {
      src.damageDealt += dmg;
      f.lastHitBy = src.id;
      // slamming into a wall after a hit is credited to the weapon that launched you
      if (cause !== "impact") {
        f.lastHitTick = this.tick;
        f.lastHitCause = cause;
      }
    } else if (source < 0 && cause !== "impact") {
      f.lastHitCause = cause;
    }
    let kb = 0;
    if (kbx !== 0 || kby !== 0) {
      const m = this.kbMult(Math.max(0, f.hp));
      const body = f.entity.body;
      const v = body.linvel();
      const stack = f.kbTick === this.tick;
      const nvx = (stack ? v.x : v.x * 0.3) + kbx * m;
      const nvy = (stack ? v.y : Math.max(v.y * 0.3, 0)) + kby * m;
      f.kbTick = this.tick;
      body.setLinvel({ x: nvx, y: nvy }, true);
      kb = Math.sqrt(kbx * kbx + kby * kby) * m;
      f.stun = Math.max(f.stun, Math.round(clamp(kb * 1.7, 6, 55)));
      f.grounded = false;
    }
    if (cause !== "impact") this.events.push({ type: "hit", tick: this.tick, target: f.id, source, damage: dmg, kb, x: hx, y: hy, cause, shielded });
    if (f.hp <= 0) {
      f.hp = 0;
      const p = this.pos(f);
      this.knockOut(f, "hp", p.x, p.y);
    }
  }

  private knockOut(f: Fighter, cause: "ringout" | "hp", x: number, y: number) {
    if (!f.alive) return;
    f.alive = false;
    f.koTick = this.tick;
    f.koCause = cause;
    const by = this.tick - f.lastHitTick < 300 ? f.lastHitBy : -1;
    f.koBy = by;
    if (by >= 0 && by !== f.id) this.fighters[by]!.kos++;
    const weapon = by >= 0 ? f.lastHitCause || "unknown" : cause === "ringout" ? "fall" : f.lastHitCause || "crush";
    this.events.push({ type: "ko", tick: this.tick, fighter: f.id, cause, by, weapon, x, y });
    // a knocked-out fighter drops its weapons: up for grabs
    if (cause === "hp") this.dropWeapons(f, x, y);
    f.entity.collider.setCollisionGroups(groups(G.PROP, G.TERRAIN));
    f.entity.body.lockRotations(false, true);
    f.entity.body.setAngvel(f.facing * -6, true);
    if (cause === "ringout") this.removeFighterBody(f);
  }

  private dropWeapons(f: Fighter, x: number, y: number) {
    let side = -1;
    for (const w of f.weapons) {
      if (w === "fist") continue;
      const e = this.spawnItem(w, x + side * 0.3, y + 0.6, side * 2.2, 4);
      e.owner = f.id;
      side = -side;
    }
    f.weapons = ["fist", "fist"];
  }

  private removeFighterBody(f: Fighter) {
    if (f.removed) return;
    f.removed = true;
    this.removeEntity(f.entity);
  }

  private removeEntity(e: Entity) {
    if (e.dead) return;
    e.dead = true;
    for (const c of e.colliders ?? [e.collider]) this.byCollider.delete(c.handle);
    this.entities.delete(e.id);
    if (e.joint) {
      this.world.removeImpulseJoint(e.joint, false);
      e.joint = null;
    }
    this.world.removeRigidBody(e.body);
  }

  private checkPickups(f: Fighter, x: number, y: number) {
    for (const e of this.entities.values()) {
      if (e.kind !== "item" || e.dead) continue;
      const t = e.body.translation();
      // reach covers the whole body: from just below the feet to just above the head
      const dx = Math.abs(t.x - x);
      const dy = t.y - y;
      const half = FIGHTER.halfHeight + FIGHTER.radius;
      if (dx > ITEM.pickupRange * 0.85 || dy < -half - ITEM.reachBelow || dy > half + 0.3) continue;
      const it = e.itemType!;
      if (WEAPON_LIST.includes(it as Weapon)) {
        // the one who just dropped it can't grab it straight back
        if (e.owner === f.id && this.tick - e.born < ARMORY.pickupGraceTicks) continue;
        if (!this.wantsWeapon(f, it as Weapon)) continue;
      }
      this.applyItem(f, it);
      this.events.push({ type: "pickup", tick: this.tick, fighter: f.id, item: e.itemType!, x: t.x, y: t.y });
      this.removeEntity(e);
      return;
    }
  }

  applyItem(f: Fighter, it: ItemType) {
    f.pickups.push(it);
    const on = (p: PowerUp) => this.events.push({ type: "power", tick: this.tick, fighter: f.id, power: p, on: true });
    switch (it) {
      case "health":
        f.hp = Math.min(FIGHTER.maxHp, f.hp + ITEM.healAmount);
        return;
      case "shield":
        f.power.shield = POWER.shield.ticks;
        f.power.shieldHits = 0;
        return on("shield");
      case "speed":
        f.power.speed = POWER.speed.ticks;
        return on("speed");
      case "heavy":
        f.power.heavy = POWER.heavy.ticks;
        f.entity.collider.setDensity(FIGHTER_DENSITY * POWER.heavy.densityMul);
        return on("heavy");
      case "damage":
        f.power.damage = POWER.damage.ticks;
        return on("damage");
      case "jump":
        f.power.jump = POWER.jump.ticks;
        return on("jump");
      default: {
        // a weapon: fill an empty (fists) slot, else replace the one not in hand and drop it
        if (f.weapons.includes(it)) return;
        const free = f.weapons[1 - f.slot] === "fist" ? 1 - f.slot : f.weapons[f.slot] === "fist" ? f.slot : -1;
        const other = (free >= 0 ? free : 1 - f.slot) as 0 | 1;
        const old = f.weapons[other]!;
        if (old !== "fist") {
          const p = this.pos(f);
          const d = this.spawnItem(old, p.x - f.facing * 0.4, p.y + 0.4, -f.facing * 2.5, 3.5);
          d.owner = f.id;
        }
        f.weapons[other] = it;
        f.slot = other;
        f.swap = SWAP_TICKS;
        f.cooldown[it] = 0;
        this.events.push({ type: "swap", tick: this.tick, fighter: f.id, weapon: it });
      }
    }
  }

  items(): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) if (e.kind === "item" && !e.dead) out.push(e);
    return out;
  }

  // -------------------------------------------------------------------- hash

  /** FNV-1a over the Rapier snapshot, the grid, and all game state. */
  hash(): string {
    let h = 0x811c9dc5;
    const mix = (b: number) => {
      h ^= b & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    };
    const snap = this.world.takeSnapshot();
    for (let i = 0; i < snap.length; i++) mix(snap[i]!);
    const g = this.grid;
    for (let i = 0; i < g.mat.length; i++) mix(g.mat[i]!);
    const hb = new Uint8Array(g.hp.buffer);
    for (let i = 0; i < hb.length; i += 8) for (let k = 0; k < 8; k++) mix(hb[i + k]!);
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
      num(f.slot);
      num(ALL_WEAPONS.indexOf(f.weapons[0]) * 10 + ALL_WEAPONS.indexOf(f.weapons[1]));
      for (const w of ALL_WEAPONS) num(f.cooldown[w]);
      num(f.power.shield + f.power.speed * 1e3 + f.power.heavy * 1e6 + f.power.damage * 1e9 + f.power.jump * 1e12);
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
      num(e.thrust ?? -1);
      if (e.cells) for (const c of e.cells) num(c.hp);
    }
    for (const s of this.rng.state()) num(s);
    return h.toString(16).padStart(8, "0");
  }
}
