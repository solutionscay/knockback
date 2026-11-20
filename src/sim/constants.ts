/** All simulation tuning lives here. Units: meters, seconds, y up. */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const GRAVITY = 20;

/** A fight is one continuous brawl; time-out after this many seconds. */
export const FIGHT_SECONDS = 90;
export const FIGHT_TICKS = FIGHT_SECONDS * TICK_RATE;
/** Once one fighter is left, the fight runs this many more ticks, then it ends. */
export const FINISH_TICKS = 90;

export const FIGHTER_DENSITY = 2.2;

export const FIGHTER = {
  radius: 0.42,
  halfHeight: 0.42, // capsule half segment; total height = 2*(hh+r) = 1.68 m
  maxHp: 100,
  walkSpeed: 6.2,
  groundAccel: 70,
  airAccel: 28,
  jumpSpeed: 12,
  /** Knockback multiplier = 1 + (missing hp / 100) * kbGrowth */
  kbGrowth: 2.5,
  impactThreshold: 13,
  impactDamagePerMs: 0.55,
  ringOutY: -10,
  ringOutX: 44,
};

/** Explosion shape: fighters (damage, knockback), props (blockDamage) and terrain cells (terrainDamage). */
export interface Blast {
  radius: number;
  damage: number;
  knockback: number;
  blockDamage: number;
  terrainDamage: number;
}

export const WEAPONS = {
  rocket: {
    cooldown: 155,
    speed: 19,
    gravity: 7,
    radius: 2.7,
    damage: 2.7,
    knockback: 9,
    blockDamage: 34,
    terrainDamage: 95,
    minRange: 1.5,
    maxLife: 240,
  },
  shotgun: {
    cooldown: 46,
    range: 7.5,
    pellets: 6,
    pelletDamage: 1.0,
    pelletKnock: 2.3,
    pelletBlockDamage: 5,
    pelletTerrainDamage: 11,
    pelletImpulse: 1.6,
  },
  /** Melee launch: the ring-out tool. */
  bat: {
    cooldown: 38,
    reach: 0.95,
    radius: 0.95,
    damage: 7,
    knockback: 11.8,
    lift: 0.75,
    propImpulse: 9,
    terrainRadius: 1.3,
    terrainDamage: 75,
  },
  grenade: {
    cooldown: 130,
    speed: 13,
    fuse: 85,
    radius: 3.0,
    damage: 8,
    knockback: 12,
    blockDamage: 40,
    terrainDamage: 105,
  },
  /**
   * Fists: what every fighter starts with (and never loses). A weak, short
   * jab with a small shove: enough to defend yourself and to scrap over a
   * pickup, never enough to win a round on its own. Go find a weapon.
   */
  fist: {
    cooldown: 24,
    reach: 0.7,
    radius: 0.7,
    damage: 3.5,
    knockback: 6.5,
    lift: 0.45,
    propImpulse: 3,
    /** a punch chips terrain a little: enough to dig out of a pocket, slowly */
    terrainRadius: 0.65,
    terrainDamage: 24,
  },
  /** Hook: yanks a fighter (or a prop) toward the shooter. */
  grapple: {
    cooldown: 110,
    range: 15,
    pull: 15,
    lift: 5,
    damage: 2,
    stun: 26,
  },
} as const;

/**
 * Back-attack reflex (house bots and AI fighters alike): being hit this many
 * times from behind by someone who is not your target, within the window,
 * makes you turn. Then the strategy's retaliate rule decides:
 *   ignore    glance back (aim at them) for glanceTicks, keep moving to your target
 *   turn      fight them for fightTicks, then resume (the default)
 *   attacker  make them your target for switchTicks
 */
export const REFLEX = { windowTicks: 240, hits: 3, glanceTicks: 50, fightTicks: 180, switchTicks: 600 };

/** Ticks to swap weapons (no firing meanwhile). */
export const SWAP_TICKS = 10;

export const BARREL = {
  hp: 12,
  radius: 3.7,
  damage: 8,
  knockback: 14,
  blockDamage: 55,
  terrainDamage: 135,
  fuseMin: 6,
  fuseMax: 20,
};

/** TNT: lights on any hit, long visible fuse, the biggest crater. */
export const TNT = { hp: 6, fuse: 150, chainFuse: 40, radius: 4.6, damage: 16, knockback: 16, blockDamage: 90, terrainDamage: 220 };
/** Gas canister: when hit, it rockets away spinning, then bursts. */
export const GAS = { hp: 8, thrustTicks: 85, thrust: 30, radius: 2.4, damage: 7, knockback: 10, blockDamage: 40, terrainDamage: 85 };
export const STEEL = { density: 7 };
/** Heavy bodies (steel crates, weights, big terrain pieces) falling on a fighter. */
export const CRUSH = { minSpeed: 5, minMass: 4, perUnit: 1.4, max: 30 };
export const GLASS = { hp: 1, shatterSpeed: 8 };
export const PAD = { launch: 17.5, cooldown: 20, density: 6 };
export const WEIGHT = { density: 7, ropeHp: 30 };
/**
 * Platform chains (#34, sim-chains.ts). hp: hit points per chain. length: the
 * physical chain from the anchor up to its fixed pivot (how far a platform
 * swings). Damage: explosions blockDamage * (1 - distance / radius); a pellet
 * pelletBlockDamage; bat batDamage; fists only with the heavy power-up;
 * heavy flying things (mass, speed) like CRUSH.
 */
export const CHAIN = {
  hp: 40,
  length: 6,
  reachAbove: 40,
  hitRadius: 0.15,
  batDamage: 20,
  heavyFistDamage: 6,
  heavyMinMass: 4,
  heavyMinSpeed: 6,
  heavyPerUnit: 1.2,
};
/** Crumbling cells lose this many hit points per second while stood on. */
export const CRUMBLE_DPS = 20;

export const BLOCK = { size: 0.9, hp: 24, density: 1.4 };
export const CRATE = { size: 0.8, hp: 14, density: 0.6, dropChance: 0.9 };
export const ITEM = { size: 0.5, pickupRange: 1.1, healAmount: 35, reachBelow: 0.6 };

/** Power-up durations (ticks) and strengths. */
export const POWER = {
  shield: { ticks: 7 * 60, hits: 3, damageMul: 0.15, kbMul: 0.25 },
  speed: { ticks: 8 * 60, mul: 1.45 },
  heavy: { ticks: 10 * 60, kbMul: 0.5, speedMul: 0.82, densityMul: 3 },
  damage: { ticks: 8 * 60, mul: 2, kbMul: 1.25 },
  jump: { ticks: 12 * 60 },
  jetpack: { fuelTicks: 90, thrust: 44, riseSpeed: 9, speedMul: 1.35 },
};

/** Loose terrain pieces this small are cleared after this long (keeps body count down). */
export const DEBRIS = { smallCells: 2, smallTicks: 6 * 60 };

/** Collision groups. */
export const G = {
  TERRAIN: 0x0001,
  FIGHTER: 0x0002,
  PROP: 0x0004,
  ITEM: 0x0008,
  GRENADE: 0x0010,
};
export function groups(member: number, filter: number): number {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}

/**
 * Safe zone: holds, then shrinks steadily toward a seeded center. Outside it,
 * fighters are pushed inward (no health drain), which can shove them into the pit.
 */
export const ZONE = {
  startHalf: 26,
  endHalf: 4.5,
  holdTicks: 10 * TICK_RATE,
  shrinkEndTicks: 80 * TICK_RATE,
  pushSpeed: 4.5, // m/s inward on foot at the edge
  pushSpeedPerMeter: 1.5,
  pushAccel: 34, // m/s^2 in the air at the edge
  pushPerMeter: 10, // extra m/s^2 per meter beyond the edge
  shockAfter: 120, // ticks outside before the zone starts flinging you back in
  shockEvery: 90,
  shockX: 9,
  shockY: 13,
  shockDamage: 4,
};

/**
 * Anti-stalemate: when no fighter has damaged another for quietTicks (and 2+
 * are alive), SUDDEN DEATH for the rest of the round: everyone goes for the
 * nearest rival, the zone closes fast down to endHalf, and a weapon drops
 * between the survivors every dropEvery ticks. Outside the zone the shocks
 * come sooner, more often and harder (nobody waits it out in a hole).
 */
export const STALEMATE = { quietTicks: 7 * TICK_RATE, shrinkPerSec: 2.4, endHalf: 2.5, dropEvery: 3 * TICK_RATE, shockAfter: 60, shockEvery: 40, shockDamage: 8 };

/** Supply drops: every interval an item (often a weapon) inside the zone, barrels every other drop. */
export const SUPPLY = { firstTick: 4 * TICK_RATE, interval: 6 * TICK_RATE, weaponChance: 0.65, maxLooseWeapons: 8 };

/**
 * Weapons waiting in the arena when a round starts. Everyone starts with
 * fists only: one weapon a few meters from each spawn (toward the middle, so
 * neighbours can contest it) and a few more in the middle and up high.
 */
export const ARMORY = { nearSpawn: 1, spawnOffset: 3.5, middle: 3, minGap: 1.5, high: 1, jetpackOffset: 1.2, crateWeaponChance: 0.55, pickupGraceTicks: 45 };
