/** All simulation tuning lives here. Units: meters, seconds, y up. */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const GRAVITY = 20;

export const ROUND_SECONDS = 6;
export const ROUND_TICKS = ROUND_SECONDS * TICK_RATE;
export const ROUNDS = 7;
/** Once one fighter is left, the round runs this many more ticks, then the match ends. */
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
  kbGrowth: 2.0,
  impactThreshold: 13,
  impactDamagePerMs: 1.0,
  ringOutY: -10,
  ringOutX: 44,
};

export const WEAPONS = {
  rocket: {
    cooldown: 140,
    speed: 19,
    gravity: 7,
    radius: 2.7,
    damage: 6,
    knockback: 8.5,
    blockDamage: 34,
    minRange: 2.8,
    maxLife: 240,
  },
  shotgun: {
    cooldown: 54,
    range: 7.5,
    pellets: 6,
    pelletDamage: 1.4,
    pelletKnock: 2.1,
    pelletBlockDamage: 5,
    pelletImpulse: 1.6,
  },
  grenade: {
    cooldown: 50,
    speed: 13,
    fuse: 100,
    radius: 3.0,
    damage: 13,
    knockback: 11,
    blockDamage: 40,
  },
} as const;

export const BARREL = {
  hp: 12,
  radius: 3.7,
  damage: 15,
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

/** Safe zone half-widths per round (index 0 = round 1). */
export const ZONE_HALF_WIDTHS = [40, 27, 20, 14.5, 10, 7, 5, 4];
export const ZONE_SHRINK_TICKS = 180;
export function zoneDps(round: number): number {
  return 4 + 2 * round;
}
