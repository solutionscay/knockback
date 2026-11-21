import * as C from "./constants";
import { AIM_NOISE, PATIENCE, PICKUP, RULE_EVAL, WALL_PURSUIT } from "./controller-tuning";
import { MAT_DENSITY, MAT_HP, Mat } from "./grid";
import { LEVEL, LEVEL_THEMES, PROP_HALF, SPAWNS, THEMES, WALLS } from "./level-config";
import { POWER_LIST, WEAPON_LIST, type Weapon } from "./sim-types";

export const MORALE_EFFECT = {
  cocky: { aim: 1.12 }, confident: { aim: 0.94 }, rattled: { aim: 1.3 },
  furious: { aim: 1.15 }, desperate: { aim: 0.92 },
};

export const MORALE = {
  aim: MORALE_EFFECT, furiousAt: 50, desperateBelow: -20, cockyAt: 45, confidentAt: 0,
  scoreRetention: 0.8, angerRetention: 0.5, grudgeAnger: 20, win: 30, streak: 12, comeback: 15,
  highHealth: 70, highHealthBonus: 8, loss: 8, knockout: 10, firstOut: 26, out: 18,
  knockoutAnger: 15, surviveHealthCenter: 50, surviveHealthWeight: 0.2, humiliation: 14,
  selfAnger: 12, rivalAnger: 40, scoreLimit: 100, angerLimit: 100,
};

const { size: _blockSize, ...block } = C.BLOCK;
const { size: _crateSize, ...crate } = C.CRATE;

export const CLOSE_ARMORY = {
  ...C.ARMORY,
  spread: {
    enabled: false, zoneCaches: 1, minSpawnDistance: 9, starterRise: 2.5, preferLocalTicks: 7 * C.TICK_RATE, otherQuarterCost: 26,
    powerWeapons: ["railgun", "sniper"] as readonly Exclude<Weapon, "fist">[], powerMinDistance: 10, powerMinHeight: 4,
  },
};

/** AI effective reach in meters. Physical damage and range remain in the weapon table. */
const TACTICAL_WEAPONS = {
  enabled: true,
  readyMarginTicks: 4,
  aimHeight: 0.25,
  wallSampleDepth: 0.15,
  wallAdvance: 0.6,
  lobCheckStep: 0.12,
  rushGap: 1.1,
  terrainPenalty: 3,
  reach: {
    fist: { min: 0, max: 1.45, maxDy: 1.3, standOff: 1.1 },
    bat: { min: 0, max: 1.95, maxDy: 1.6, standOff: 1.4 },
    hammer: { min: 0, max: 4, maxDy: 1.4, standOff: 2.2 },
    shotgun: { min: 0, max: 6.9, maxDy: 0, standOff: 4.5 },
    rocket: { min: 3, max: 34, maxDy: 0, standOff: 12 },
    grenade: { min: 3, max: 14, maxDy: 0, standOff: 9 },
    grapple: { min: 3.5, max: 14, maxDy: 0, standOff: 8 },
    mine: { min: 2.8, max: 9, maxDy: 0, standOff: 5 },
    railgun: { min: C.WEAPONS.railgun.minRange, max: C.WEAPONS.railgun.range, maxDy: 0, standOff: 12 },
    flamethrower: { min: 0, max: 3.5, maxDy: 0, standOff: 2.6 },
    rifle: { min: 0, max: C.WEAPONS.rifle.range, maxDy: 0, standOff: 12 },
    sniper: { min: C.WEAPONS.sniper.minRange, max: C.WEAPONS.sniper.range, maxDy: 0, standOff: 20 },
    crossbow: { min: 1.5, max: C.WEAPONS.crossbow.range, maxDy: 0, standOff: 11 },
  },
};

/**
 * Stances (#38), all distances in meters.
 *   longGuns      what `has_long_gun` rules, overwatch and the round context count as a long gun
 *   openRange     `in_open`: a clear line to the fighter within this distance
 *   map           the tactical map: coverReach / coverMinHeight (a wall this close and this tall beside a nav
 *                 point makes it a cover spot), highRise (meters above the median floor within localSpan that
 *                 count as high ground), viewRange / viewStep (sightline sampling)
 *   cover         reach: something this close to me blocking my nearest rival's line = I am in cover;
 *                 peekEvery / peekFor: of every peekEvery ticks spend peekFor at a spot with a clear shot;
 *                 coverBonus / spotRange / rangeWeight: score for a computed cover spot (a wall or crate beside it), how
 *                 far (path cost) to go for shelter, how much the weapon's ideal range counts against travel
 *   overwatch     riseWeight / maxRise / viewWeight / reachWeight: how a perch is scored (height, sightlines, the
 *                 long gun's stand-off); longGunLimit: how far (path cost) to go for a long gun first;
 *                 holdTicks: stay on a chosen perch at least this long; calmTicks: quiet this long before closing in
 *   flank         gap: where to arrive beside the target (far side); corridorPenalty: the straight line between us,
 *                 avoided while going around; behindBonus: score for being on the side the target faces away from;
 *                 giveUpTicks: not round after this long = attack from where I am, then try again
 *   hold          radius: stay within this of the held spot; leash: chase a target only this far past it;
 *                 riseWeight / coverBonus / itemBonus / homeWeight: how the spot is chosen (high ground, cover,
 *                 a weapon cache, close to the start); calmTicks: quiet this long before closing in
 */
const STANCES = {
  longGuns: ["rifle", "sniper", "crossbow", "railgun"] as readonly Exclude<Weapon, "fist">[],
  openRange: 42,
  map: { coverReach: 1.5, coverMinHeight: 1, highRise: 2.5, localSpan: 10, viewRange: 34, viewStep: 2 },
  cover: { reach: 2.5, peekEvery: 240, peekFor: 60, coverBonus: 3, spotRange: 24, rangeWeight: 0.15 },
  overwatch: { riseWeight: 1.2, maxRise: 8, viewWeight: 9, reachWeight: 0.35, longGunLimit: 40, holdTicks: 240, calmTicks: 660 },
  flank: { gap: 3.5, corridorPenalty: 7, behindBonus: 4, giveUpTicks: 420 },
  hold: { radius: 3.5, leash: 9, riseWeight: 0.8, coverBonus: 3, itemBonus: 5, homeWeight: 0.25, calmTicks: 600 },
};

export const RULESET_DEFAULTS = {
  schemaVersion: 1,
  combat: { gravity: C.GRAVITY, fighter: { ...C.FIGHTER, ringOutMargin: 6 }, launch: C.LAUNCH, density: C.FIGHTER_DENSITY, swapTicks: C.SWAP_TICKS, blastCarveScale: 1.12, attributionTicks: 120 },
  weapons: {
    enabled: WEAPON_LIST,
    table: { ...C.WEAPONS, shotgun: { ...C.WEAPONS.shotgun, spread: 0.16, jitter: 0.03 }, flamethrower: { ...C.WEAPONS.flamethrower, spreadScale: 1 } },
    accuracy: C.ACCURACY,
    melee: { bat: { propDamage: 15, propMassCap: 4, terrainOffset: 0.3 }, fist: { propDamage: 4, propMassCap: 3, terrainOffset: 0.2 } },
  },
  pickups: {
    enabled: POWER_LIST as readonly (typeof POWER_LIST)[number][],
    item: C.ITEM, power: C.POWER, armory: { ...CLOSE_ARMORY, spawnOffset: 11, spread: { ...CLOSE_ARMORY.spread, enabled: true } },
    supply: { ...C.SUPPLY, firstTick: 8 * C.TICK_RATE, itemHeight: 16, propEvery: 2, tntChance: 0.3, propHeight: 15, extraBarrelHeight: 16.4, barrelOffset: 0.75, avoidDistance: 7 },
    weights: { health: 3, shield: 2.5, speed: 2, heavy: 1.5, damage: 2, jump: 2, jetpack: 2 },
  },
  arena: {
    layout: LEVEL, enabledThemes: THEMES, themes: LEVEL_THEMES, spawns: SPAWNS, walls: WALLS,
    propHalf: PROP_HALF, chain: C.CHAIN,
    props: { barrel: C.BARREL, block, crate, crush: C.CRUSH, gas: C.GAS, glass: C.GLASS, pad: C.PAD, steel: C.STEEL, tnt: C.TNT, weight: C.WEIGHT },
    terrain: { hitPoints: MAT_HP.map(n => Number.isFinite(n) ? n : 0), density: MAT_DENSITY, crumbleDps: C.CRUMBLE_DPS, debris: C.DEBRIS },
    navigation: { headroomCells: 4, jumpMargin: 0.55, maxGap: 4.6, dropFall: 3 },
  },
  zone: { boundary: { ...C.ZONE, edgeInset: 1, maxSpeed: 14, shockStun: 18 }, suddenDeath: { ...C.STALEMATE, graceTicks: 20 * C.TICK_RATE } },
  fire: { ...C.FIRE, materials: [Mat.Wood, Mat.Crumble] as readonly Mat[], props: ["crate", "barrel", "tnt", "gas"] as readonly string[] },
  morale: MORALE,
  round: { maxRounds: 3, winsToTake: 2, fightTicks: C.FIGHT_TICKS, finishTicks: C.FINISH_TICKS },
  tactics: { weapons: TACTICAL_WEAPONS, stances: STANCES, aimNoise: AIM_NOISE, patience: PATIENCE, pickup: PICKUP, wall: WALL_PURSUIT, ruleEval: RULE_EVAL, reflex: C.REFLEX },
};
