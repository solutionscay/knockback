import type RAPIER from "@dimforge/rapier2d-deterministic-compat";
import type { PropKind } from "./level-config";
import type { PieceCell } from "./terrain";
import type { Build, FighterStats } from "./build";
import { generateIdentities, type Look } from "./identity";

/** "fist" is what everyone starts with; the rest are picked up in the arena. */
const PICKUP_WEAPONS = ["rocket", "shotgun", "bat", "grenade", "grapple", "flamethrower", "mine", "railgun", "hammer", "rifle", "sniper", "crossbow", "lightning"] as const;
export type Weapon = (typeof PICKUP_WEAPONS)[number] | "fist";
export const WEAPON_LIST: readonly Weapon[] = PICKUP_WEAPONS;
/** Weapons whose ammo runs out: empty, they are thrown away. */
export const LIMITED_WEAPONS = ["mine", "railgun", "hammer", "rifle", "sniper", "crossbow"] as const;
/**
 * Weapons that carry a count from pickup to pickup (it goes with the item when dropped): the limited weapons, and
 * the lightning sword's bolts (#72), which run out while the sword stays.
 */
export const AMMO_WEAPONS = [...LIMITED_WEAPONS, "lightning"] as const;
export type AmmoWeapon = (typeof AMMO_WEAPONS)[number];
export function hasAmmo(weapon: Weapon): weapon is AmmoWeapon {
  return (AMMO_WEAPONS as readonly Weapon[]).includes(weapon);
}
/** Precision weapons (#38): hitscan, and their spread follows the accuracy model (still or in cover = accurate). */
export const PRECISION_WEAPONS = ["rifle", "sniper", "crossbow"] as const;
export type PrecisionWeapon = (typeof PRECISION_WEAPONS)[number];
export function isPrecision(weapon: unknown): weapon is PrecisionWeapon {
  return (PRECISION_WEAPONS as readonly unknown[]).includes(weapon);
}
export type LimitedWeapon = (typeof LIMITED_WEAPONS)[number];
/** Swung weapons: a ball in front of the fighter hits what it touches. */
export type MeleeWeapon = "bat" | "fist" | "lightning";
export function usesAmmo(weapon: Weapon): weapon is LimitedWeapon {
  return (LIMITED_WEAPONS as readonly Weapon[]).includes(weapon);
}
export const ALL_WEAPONS: readonly Weapon[] = [...WEAPON_LIST, "fist"];

export function isPickupWeapon(value: unknown): value is Exclude<Weapon, "fist"> {
  return WEAPON_LIST.includes(value as Weapon);
}

export const POWER_LIST = ["health", "shield", "speed", "heavy", "damage", "jump", "jetpack"] as const;
export type PowerUp = (typeof POWER_LIST)[number];
export type ItemType = PowerUp | Weapon;
/**
 * How a fighter positions itself. #38 adds overwatch (high ground, long gun, shoot whoever is in the open),
 * flank (route around the target) and hold (defend a spot); cover now moves between sim-computed cover spots.
 */
export type Stance = "rush" | "distance" | "cover" | "item" | "overwatch" | "flank" | "hold";
export type EntityKind = PropKind | "fighter" | "chunk" | "item" | "grenade";
export type ExplosionKind = "mine" | "rocket" | "barrel" | "grenade" | "tnt" | "gas";

/** Who a fighter goes after. Resolved continuously during the fight. */
export const TARGET_PREFERENCES = ["nearest", "weakest", "strongest", "leader", "rocket", "shotgun"] as const;
export type TargetPref = (typeof TARGET_PREFERENCES)[number] | "grudge";

/**
 * What to do when someone keeps hitting you from behind (see the reflex in controller.ts):
 *   attacker  switch your target to them for a while
 *   turn      turn and fight back briefly, then resume (default)
 *   ignore    just glance back and keep going after your target
 */
export type Retaliate = "attacker" | "turn" | "ignore";

/**
 * Conditional plan rules (#5): data, not code. "When <trigger> (about
 * <who>), do <action>" for as long as the trigger holds (with hysteresis).
 * See docs/rules.md. Validated in src/ai/parse.ts (AI answers) and
 * src/viewer/sanitize.ts (records, live stream); evaluated in controller.ts.
 */
export const RULE_WHEN = ["holds", "my_health_below", "health_below", "near_ledge", "near_barrel", "on_streak", "chasing_me", "hit_me", "item_near", "alone_with", "in_open", "has_long_gun", "in_cover"] as const;
export type RuleWhen = (typeof RULE_WHEN)[number];
export const RULE_DO = ["target", "avoid", "seek", "use", "stance", "retaliate"] as const;
export type RuleDo = (typeof RULE_DO)[number];
/** anyone | enemy (not me) | target (my current target) | a seat number */
export type RuleWho = "anyone" | "enemy" | "target" | number;
export const MAX_RULES = 4;

export interface Rule {
  when: RuleWhen;
  /** for triggers about a fighter */
  who?: RuleWho;
  /** for holds (a weapon or jetpack) and item_near (any pickup) */
  item?: ItemType;
  /** for my_health_below / health_below (10-90 %) and on_streak (1-3 knockouts) */
  value?: number;
  do: RuleDo;
  /** for seek (any pickup) and use (a weapon or jetpack) */
  doItem?: ItemType;
  /** for do: stance */
  stance?: Stance;
  /** for do: retaliate */
  retaliate?: Retaliate;
  /** short name (at most 40 characters) */
  label: string;
}

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
  /** conditional rules, highest priority first (at most MAX_RULES; optional) */
  rules?: Rule[];
  /** the fighter's body for the round (#79): fixed at the round start, so a mid-round plan update never changes it; none = neutral */
  build?: Build;
  line: string;
}

export interface Input {
  move: number; // -1..1
  jump: boolean;
  /**
   * Take-off speed for this jump, at most the fighter's own (#84): a short hop, so a stronger body can fly the arc of a
   * weaker one (NavGraph.flight). Unset: a full jump. Air jumps ignore it.
   */
  jumpSpeed?: number;
  /** Burn one tick of jetpack fuel while steering with move. */
  thrust?: boolean;
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
  ax?: number;
  ay?: number;
  // terrain piece
  cells?: PieceCell[];
  // fire (#33): fire-steps left burning (crates, barrels, TNT, gas), and who lit it
  burn?: number;
  burnBy?: number;
  // item
  itemType?: ItemType;
  ammo?: number;
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
  jetpack: number; // fuel ticks remaining
}

export interface Fighter {
  id: number;
  name: string;
  /** cosmetic, from the generated identity (the sim never reads these) */
  color: number;
  look: Look;
  /** weapon pickups this fighter wants, best first (from its strategy) */
  prefs: Weapon[];
  entity: Entity;
  /** this round's build (#79) and the body values it gives */
  build: Build;
  stats: FighterStats;
  hp: number;
  /** max HP from the build (#79) */
  maxHp: number;
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
  ammo: Record<AmmoWeapon, number>;
  railCharge: number;
  /** sniper (#38): ticks spent aiming down the scope (the laser sight shows while > 0) */
  scope: number;
  /** ticks pinned by a crossbow bolt (#38): no movement, no firing */
  pinned: number;
  stun: number;
  jumpCd: number;
  airJumped: boolean;
  grounded: boolean;
  surface: number; // last known nav surface (-1 unknown)
  lastHitBy: number;
  lastHitTick: number;
  lastHitCause: string;
  kbTick: number;
  /** extra kicks taken this tick (#41 stack retention) */
  kbStack: number;
  shieldTick: number;
  padCd: number;
  crushCd: number;
  /** on fire (#33): ticks left, who lit it, and what to credit ("flamethrower" or "fire") */
  burning: number;
  burnBy: number;
  burnCause: string;
  /** flamethrower fuel (#32): pulses left in the tank */
  fuel: number;
  /** live ground (#72): ticks before another shock can stun this fighter */
  shockCd: number;
  outsideZone: boolean;
  outsideTicks: number;
  power: Powers;
  jetting: boolean;
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

export interface Mine {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  armedAt: number;
  mount: { kind: "terrain"; cx: number; cy: number } | { kind: "entity"; id: number; x: number; y: number } | null;
}

/**
 * Live ground (#72): a strip of floor a lightning bolt electrified. points: the floor it covers, half a cell apart,
 * left to right (it follows steps like the hammer's wave). Anyone standing on it, the owner too, is shocked.
 */
export interface LiveGround {
  id: number;
  owner: number;
  born: number;
  /** ticks left */
  ticks: number;
  points: { x: number; y: number }[];
}

export type SimEvent =
  | { type: "fire"; tick: number; fighter: number; weapon: Weapon; x: number; y: number; dx: number; dy: number }
  | { type: "mineStick" | "mineArm"; tick: number; x: number; y: number; entity: number }
  | { type: "railCharge"; tick: number; fighter: number }
  | { type: "rail"; tick: number; fighter: number; x0: number; y0: number; x1: number; y1: number }
  /** a precision shot (#38): rifle round, sniper round or crossbow bolt; spread = the perpendicular offset the accuracy model gave it */
  | { type: "shot"; tick: number; fighter: number; weapon: "rifle" | "sniper" | "crossbow"; x0: number; y0: number; x1: number; y1: number; hit: "fighter" | "prop" | "terrain" | "none"; target: number; spread: number }
  /** a sniper started aiming (#38): the laser sight is on */
  | { type: "scope"; tick: number; fighter: number }
  /** a crossbow bolt pinned a fighter to a wall (#38) */
  | { type: "pin"; tick: number; fighter: number; by: number; x: number; y: number }
  | { type: "shockwave"; tick: number; fighter: number; x: number; y: number; paths: { x: number; y: number }[][] }
  | { type: "pellet"; tick: number; fighter: number; x0: number; y0: number; x1: number; y1: number; hit: boolean }
  | { type: "swing"; tick: number; fighter: number; x: number; y: number; dx: number; dy: number; hit: boolean; weapon: MeleeWeapon }
  /** a lightning bolt (#72): from the sword to the first fighter, prop or surface on its line; ground = the live strip's id, or -1 */
  | { type: "bolt"; tick: number; fighter: number; x0: number; y0: number; x1: number; y1: number; hit: "fighter" | "prop" | "terrain" | "none"; target: number; ground: number }
  /** live ground (#72) shocked a fighter: by = the bolt's owner; stun = it was stunned too */
  | { type: "shock"; tick: number; fighter: number; by: number; x: number; y: number; stun: boolean }
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
  | { type: "jetpack"; tick: number; fighter: number }
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
  | { type: "propDrop"; tick: number; entity: number; kind: EntityKind; x: number; y: number }
  | { type: "suddenDeath"; tick: number; quietTicks: number }
  /** something caught fire from a flame or a blast (#33; spreading fire is read from the state, not evented) */
  | { type: "ignite"; tick: number; what: "cell" | "prop" | "piece"; x: number; y: number; source: string; by: number }
  /** a fighter caught fire */
  | { type: "burn"; tick: number; fighter: number; by: number; cause: string }
  /** a flamethrower ran dry and was dropped (#32) */
  | { type: "fuelOut"; tick: number; fighter: number }
  /** a platform chain snapped (#34); by = who damaged it last, or -1 */
  | { type: "chainBreak"; tick: number; chain: number; x: number; y: number; cause: string; by: number }
  /** a platform lost a chain and now hangs from its last one */
  | { type: "platformSwing"; tick: number; entity: number; chain: number; x: number; y: number }
  /** a platform lost its last chain and falls */
  | { type: "platformFall"; tick: number; entity: number; x: number; y: number; by: number }
  /** a plan rule started or stopped (#6); subject = the fighter that made it true, or -1 */
  | { type: "rule"; tick: number; fighter: number; rule: number; on: boolean; subject: number }
  /** a mid-round plan update took effect (#8): the fighter plays its new plan from this tick */
  | { type: "plan"; tick: number; fighter: number };

/**
 * How a seat looks: its generated identity (identity.ts). Purely visual: all
 * fighters have the same body, speed, health and fists.
 */
/** Looks for a Sim made without any (tests, tools): the identities of seed 0. */
export const SEAT_LOOKS: Look[] = generateIdentities(0);
