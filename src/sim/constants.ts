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
};

/**
 * Launch height (#41): keeps fighters near the fight so the camera can follow it. Heights are meters above the
 * round's highest walkable surface at the start (Sim.topY).
 * maxUpSpeed: knockback and blasts never leave a fighter rising faster than this (m/s); sideways speed is kept.
 * stackRetention: the n-th extra kick in the same tick (shotgun pellets, chain blasts) keeps retention^n of its upward push.
 * ceilingAbove / ceilingDrag: above this height upward speed decays by ceilingDrag per second (air drag, no wall).
 */
export const LAUNCH = { maxUpSpeed: 15, stackRetention: 0.5, ceilingAbove: 5, ceilingDrag: 4 };

/** Explosion shape: fighters (damage, knockback), props (blockDamage) and terrain cells (terrainDamage). */
export interface Blast {
  radius: number;
  damage: number;
  knockback: number;
  blockDamage: number;
  terrainDamage: number;
}

export const WEAPONS = {
  mine: {
    ammo: 3, cooldown: 98, speed: 14, gravity: 20, throwLift: 0.6,
    armTicks: 24, fuse: 165, proximity: 1.45, range: 9,
    radius: 2.8, damage: 10, knockback: 12.5, blockDamage: 41, terrainDamage: 105,
  },
  railgun: {
    ammo: 3, chargeTicks: 40, cooldown: 157, range: 27, minRange: 3,
    terrainPenetration: 0.85, terrainDamage: 48, propDamage: 22,
    damage: 13, knockback: 11.5, lift: 0.38,
  },
  hammer: {
    ammo: 6, cooldown: 57, range: 4, damage: 8.5, knockback: 12, lift: 5,
    groundStep: 0.55, feetReach: 0.85, terrainRadius: 1.5, terrainDamage: 98, propDamage: 30,
  },
  rocket: {
    cooldown: 155,
    speed: 19,
    gravity: 7,
    radius: 2.7,
    damage: 10,
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
  /**
   * Flamethrower (#32): a short cone of fire, fired in pulses while the
   * trigger is held. Each pulse casts 5 fixed rays across the cone (no trig:
   * the spread is fixed rotation coefficients), hurts and lightly pushes
   * fighters it reaches, sets them and anything flammable alight, and uses one
   * pulse of fuel. Empty: the weapon is dropped (gone).
   */
  flamethrower: {
    cooldown: 4,
    range: 3.8,
    damage: 0.9,
    push: 1.6,
    fuel: 60,
    /** chance per pulse that a ray sets the flammable cell or prop it reaches alight */
    igniteChance: 0.45,
    chainDamage: 1.2,
  },
  /**
   * Precision weapons (#38). All three are hitscan: the round stops at the first fighter, prop or terrain cell.
   * Their aim follows the accuracy model (ACCURACY below), not the controller's aim noise.
   * Rifle: the workhorse. Steady semi-auto, medium damage, a light shove.
   */
  rifle: {
    ammo: 16, cooldown: 22, range: 24, damage: 3.4, knockback: 3, lift: 0.18,
    propDamage: 6, terrainDamage: 9,
  },
  /**
   * Sniper: very long range, slow, one big hit. Aiming takes aimTicks with the trigger held (the laser sight is on
   * meanwhile); letting go cancels the aim. Pierces nothing.
   */
  sniper: {
    ammo: 4, aimTicks: 36, cooldown: 100, range: 42, minRange: 4,
    damage: 15, knockback: 13, lift: 0.3, propDamage: 24, terrainDamage: 30,
  },
  /**
   * Crossbow (marksman): in between. A heavy bolt that knocks the target back, or pins it for pinTicks when a wall
   * or prop is within pinReach behind it.
   */
  crossbow: {
    ammo: 6, cooldown: 72, range: 28, damage: 6, knockback: 10, lift: 0.32,
    pinReach: 1.1, pinTicks: 40, propDamage: 14, terrainDamage: 16,
  },
  /**
   * Lightning sword (#72): a sword with bolts. Fire slashes when the first thing on the aim line is closer than
   * boltMinRange or no bolt is left; otherwise it casts a bolt (ammo = bolts per pickup; the sword stays when they
   * are gone). The slash is a melee ball like the bat's (reach, radius, damage, knockback, lift, propImpulse,
   * terrainRadius, terrainDamage; cooldown). A bolt is hitscan, straight, out to range: it hits the first fighter,
   * prop or surface (bolt* values), then the floor there (the fighter's feet, or the surface hit, up to groundDrop
   * below) goes live: groundWidth meters wide, following steps up to groundStep, for groundTicks. Everyone standing
   * on it (feet within feetReach), the owner too, takes pulseDamage every pulseTicks (credited to the bolt's owner),
   * and is stunned for stunTicks, at most once every stunGap ticks.
   */
  lightning: {
    ammo: 3, cooldown: 34, reach: 0.85, radius: 0.8, damage: 7.5, knockback: 10.5, lift: 0.6,
    propImpulse: 6, terrainRadius: 1, terrainDamage: 55,
    range: 12, boltMinRange: 2.4, boltCooldown: 70, boltDamage: 5, boltKnockback: 4, boltLift: 0.3,
    boltPropDamage: 14, boltTerrainDamage: 12,
    groundWidth: 3, groundDrop: 2.5, groundStep: 0.55, groundTicks: 180, feetReach: 0.4,
    pulseTicks: 20, pulseDamage: 1.5, stunTicks: 16, stunGap: 50,
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
 * Accuracy model for precision weapons (#38). Deterministic: the shot's direction is turned by a perpendicular
 * offset of spread * gauss() from the seeded sim RNG (sum of uniforms, no trig). Spread per weapon, in offset per
 * meter: `still` when standing still on the ground, plus `move` when walking (scaled by speed / walk speed), `air`
 * when jumping or falling, `jet` when the jetpack burns. Behind cover (`inCover`) the total is multiplied by
 * coverMul. stillSpeed: below this horizontal speed (m/s) a grounded fighter counts as still.
 */
export const ACCURACY = {
  stillSpeed: 0.6,
  coverMul: 0.5,
  rifle: { still: 0.012, move: 0.07, air: 0.12, jet: 0.16 },
  sniper: { still: 0.003, move: 0.11, air: 0.2, jet: 0.25 },
  crossbow: { still: 0.008, move: 0.08, air: 0.14, jet: 0.18 },
};

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
/**
 * Fire (#33, sim-fire.ts). Updated every `step` ticks; times are in fire
 * steps. Burning cells and props lose hit points, spread to flammable
 * neighbours by chance (seeded RNG), then burn out (charred) or are destroyed.
 * Barrels, TNT and gas cans light their fuse when they catch. Burning anchor
 * cells eat their chain. Fighters touching fire catch it for fighterTicks.
 */
export const FIRE = {
  step: 6,
  burnMin: 25,
  burnMax: 45,
  /** hit points per fire step lost by a burning cell (wood has 20, crumble 24) */
  cellDamage: 0.5,
  /** chance per step that a burning cell lights each flammable 4-neighbour */
  spread: 0.09,
  /** props: hit points per step, and the reach of their flames (m) */
  propDamage: 0.5,
  propReach: 0.7,
  /** chain hit points per step while its anchor cell burns */
  chainDamage: 1.6,
  /** a blast lights flammable cells (out to the rim its carve leaves) and props within this share of its radius, each by chance */
  blastReach: 1.3,
  blastChance: 0.45,
  /** fighters: ticks on fire after touching it, damage per second while burning */
  fighterTicks: 150,
  fighterDps: 4,
  /** how close (m) a fighter's body must be to a burning cell to catch */
  touch: 0.25,
  /** chance per step that a burning fighter lights the flammable cell under its feet */
  feetChance: 0.12,
};

/** Crumbling cells lose this many hit points per second while stood on. */
export const CRUMBLE_DPS = 20;

export const BLOCK = { size: 0.9, hp: 24, density: 1.4 };
export const CRATE = { size: 0.8, hp: 14, density: 0.6, dropChance: 0.9 };
export const ITEM = { size: 0.5, pickupRange: 1.1, healAmount: 35, reachBelow: 0.6 };

/** Power-up durations (ticks) and strengths. */
/** The Speed power-up's acceleration multiplier (ground and air). */
export const SPEED_ACCEL_MUL = 1.3;

export const POWER = {
  shield: { ticks: 7 * 60, hits: 3, damageMul: 0.15, kbMul: 0.25 },
  speed: { ticks: 8 * 60, mul: 1.45 },
  heavy: { ticks: 10 * 60, kbMul: 0.5, speedMul: 0.82, densityMul: 3 },
  damage: { ticks: 8 * 60, mul: 2, kbMul: 1.25 },
  jump: { ticks: 12 * 60 },
  /** ceiling: meters above the highest platform where thrust has faded out (#41); fade: meters below it where thrust starts to fade */
  jetpack: { fuelTicks: 90, thrust: 44, riseSpeed: 9, speedMul: 1.35, ceiling: 4, fade: 1.5 },
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
