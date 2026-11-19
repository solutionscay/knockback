/** All simulation tuning lives here. Units: meters, seconds, y up. */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const GRAVITY = 20;

/** A fight is one continuous brawl; time-out after this many seconds. */
export const FIGHT_SECONDS = 90;
export const FIGHT_TICKS = FIGHT_SECONDS * TICK_RATE;
/** Once one fighter is left, the fight runs this many more ticks, then it ends. */
export const FINISH_TICKS = 90;

export const FIGHTER = {
  radius: 0.42,
  halfHeight: 0.42, // capsule half segment; total height = 2*(hh+r) = 1.68 m
  maxHp: 100,
  walkSpeed: 6.2,
  groundAccel: 70,
  airAccel: 28,
  jumpSpeed: 12,
  /** Knockback multiplier = 1 + (missing hp / 100) * kbGrowth */
  kbGrowth: 2.8,
  impactThreshold: 13,
  impactDamagePerMs: 0.65,
  ringOutY: -10,
  ringOutX: 44,
};

export const WEAPONS = {
  rocket: {
    cooldown: 170,
    speed: 19,
    gravity: 7,
    radius: 2.7,
    damage: 3.3,
    knockback: 8.5,
    blockDamage: 34,
    minRange: 1.5,
    maxLife: 240,
  },
  shotgun: {
    cooldown: 46,
    range: 7.5,
    pellets: 6,
    pelletDamage: 1.2,
    pelletKnock: 2.3,
    pelletBlockDamage: 5,
    pelletImpulse: 1.6,
  },
  grenade: {
    cooldown: 50,
    speed: 13,
    fuse: 100,
    radius: 3.0,
    damage: 8,
    knockback: 11,
    blockDamage: 40,
  },
} as const;

export const BARREL = {
  hp: 12,
  radius: 3.7,
  damage: 10,
  knockback: 14,
  blockDamage: 55,
  fuseMin: 6,
  fuseMax: 20,
};

export const BLOCK = { size: 0.9, hp: 40, density: 1.4 };
export const CRATE = { size: 0.8, hp: 14, density: 0.6, dropChance: 0.65 };
export const PLANK = { w: 0.75, h: 0.22, hp: 16 };
export const ITEM = { size: 0.5, pickupRange: 1.1, healAmount: 35 };

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
};
export function zoneHalfAt(tick: number): number {
  const k = Math.min(1, Math.max(0, (tick - ZONE.holdTicks) / (ZONE.shrinkEndTicks - ZONE.holdTicks)));
  return ZONE.startHalf + (ZONE.endHalf - ZONE.startHalf) * k;
}

/** Supply drops: every interval, alternating barrels and an item, inside the zone. */
export const SUPPLY = { firstTick: 9 * TICK_RATE, interval: 9 * TICK_RATE };
