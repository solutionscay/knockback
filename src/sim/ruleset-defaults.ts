import * as C from "./constants";
import { AIM_NOISE, PATIENCE, PICKUP, RULE_EVAL, WALL_PURSUIT } from "./controller-tuning";
import { MAT_DENSITY, MAT_HP, Mat } from "./grid";
import { LEVEL, LEVEL_THEMES, PROP_HALF, SPAWNS, THEMES, WALLS } from "./level-config";
import { POWER_LIST, WEAPON_LIST } from "./sim-types";

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

const { ringOutX: _legacyRingOutX, ...fighter } = C.FIGHTER;
const { startHalf: _legacyStartHalf, ...boundary } = C.ZONE;
const { size: _blockSize, ...block } = C.BLOCK;
const { size: _crateSize, ...crate } = C.CRATE;

export const RULESET_DEFAULTS = {
  schemaVersion: 1,
  combat: { gravity: C.GRAVITY, fighter: { ...fighter, ringOutMargin: 6 }, density: C.FIGHTER_DENSITY, swapTicks: C.SWAP_TICKS, blastCarveScale: 1.12, attributionTicks: 120 },
  weapons: {
    enabled: WEAPON_LIST,
    table: { ...C.WEAPONS, shotgun: { ...C.WEAPONS.shotgun, spread: 0.16, jitter: 0.03 }, flamethrower: { ...C.WEAPONS.flamethrower, spreadScale: 1 } },
    melee: { bat: { propDamage: 15, propMassCap: 4, terrainOffset: 0.3 }, fist: { propDamage: 4, propMassCap: 3, terrainOffset: 0.2 } },
  },
  pickups: {
    enabled: POWER_LIST as readonly (typeof POWER_LIST)[number][],
    item: C.ITEM, power: C.POWER, armory: C.ARMORY,
    supply: { ...C.SUPPLY, itemHeight: 16, propEvery: 2, tntChance: 0.3, propHeight: 15, extraBarrelHeight: 16.4, barrelOffset: 0.75 },
    weights: { health: 3, shield: 2.5, speed: 2, heavy: 1.5, damage: 2, jump: 2, jetpack: 2 },
  },
  arena: {
    layout: LEVEL, enabledThemes: THEMES, themes: LEVEL_THEMES, spawns: SPAWNS, walls: WALLS,
    propHalf: PROP_HALF, chain: C.CHAIN,
    props: { barrel: C.BARREL, block, crate, crush: C.CRUSH, gas: C.GAS, glass: C.GLASS, pad: C.PAD, steel: C.STEEL, tnt: C.TNT, weight: C.WEIGHT },
    terrain: { hitPoints: MAT_HP.map(n => Number.isFinite(n) ? n : 0), density: MAT_DENSITY, crumbleDps: C.CRUMBLE_DPS, debris: C.DEBRIS },
    navigation: { headroomCells: 4, jumpMargin: 0.55, maxGap: 4.6, dropFall: 3 },
  },
  zone: { boundary: { ...boundary, edgeInset: 1, maxSpeed: 14, shockStun: 18 }, suddenDeath: C.STALEMATE },
  fire: { ...C.FIRE, materials: [Mat.Wood, Mat.Crumble] as readonly Mat[], props: ["crate", "barrel", "tnt", "gas"] as readonly string[] },
  morale: MORALE,
  round: { maxRounds: 3, winsToTake: 2, fightTicks: C.FIGHT_TICKS, finishTicks: C.FINISH_TICKS },
  tactics: { aimNoise: AIM_NOISE, patience: PATIENCE, pickup: PICKUP, wall: WALL_PURSUIT, ruleEval: RULE_EVAL, reflex: C.REFLEX },
};
