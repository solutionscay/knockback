import type RAPIER from "@dimforge/rapier2d-deterministic-compat";
import type { PropKind } from "./levelgen";
import type { PieceCell } from "./terrain";
import { generateIdentities, type Look } from "./identity";

/** "fist" is what everyone starts with; the rest are picked up in the arena. */
export type Weapon = "rocket" | "shotgun" | "bat" | "grenade" | "grapple" | "fist";
/** Weapons that exist as pickups. */
export const WEAPON_LIST: readonly Weapon[] = ["rocket", "shotgun", "bat", "grenade", "grapple"];
export const ALL_WEAPONS: readonly Weapon[] = [...WEAPON_LIST, "fist"];

export function isPickupWeapon(value: unknown): value is Exclude<Weapon, "fist"> {
  return WEAPON_LIST.includes(value as Weapon);
}

export type PowerUp = "health" | "shield" | "speed" | "heavy" | "damage" | "jump";
export const POWER_LIST: readonly PowerUp[] = ["health", "shield", "speed", "heavy", "damage", "jump"];
export type ItemType = PowerUp | Weapon;
export type Stance = "rush" | "distance" | "cover" | "item";
export type EntityKind = PropKind | "fighter" | "chunk" | "item" | "grenade";
export type ExplosionKind = "rocket" | "barrel" | "grenade" | "tnt" | "gas";

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
export const RULE_WHEN = ["holds", "my_health_below", "health_below", "near_ledge", "near_barrel", "on_streak", "chasing_me", "hit_me", "item_near", "alone_with"] as const;
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
  /** for holds (a weapon) and item_near (any pickup) */
  item?: ItemType;
  /** for my_health_below / health_below (10-90 %) and on_streak (1-3 knockouts) */
  value?: number;
  do: RuleDo;
  /** for seek (any pickup) and use (a weapon) */
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
  /** cosmetic, from the generated identity (the engine never reads these) */
  color: number;
  look: Look;
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
  | { type: "propDrop"; tick: number; entity: number; kind: EntityKind; x: number; y: number }
  | { type: "suddenDeath"; tick: number; quietTicks: number }
  /** a platform chain snapped (#34); by = who damaged it last, or -1 */
  | { type: "chainBreak"; tick: number; chain: number; x: number; y: number; cause: string; by: number }
  /** a platform lost a chain and now hangs from its last one */
  | { type: "platformSwing"; tick: number; entity: number; chain: number; x: number; y: number }
  /** a platform lost its last chain and falls */
  | { type: "platformFall"; tick: number; entity: number; x: number; y: number; by: number }
  /** a plan rule started or stopped (#6); subject = the fighter that made it true, or -1 */
  | { type: "rule"; tick: number; fighter: number; rule: number; on: boolean; subject: number };

/**
 * How a seat looks: its generated identity (identity.ts). Purely visual: all
 * fighters have the same body, speed, health and fists.
 */
export type { Look };
/** Looks for a Sim made without any (tests, tools): the identities of seed 0. */
export const SEAT_LOOKS: Look[] = generateIdentities(0);
