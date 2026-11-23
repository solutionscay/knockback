/**
 * Map styles as data (#94). A theme is one record: what the level generator builds (`rules`: materials, ground shape,
 * hazards, physics, props) and how it looks (`look`: palette, background, terrain art). A new map style is a new
 * record here plus its art (tools/art/plush_level.py reads the look from tools/art/themes.json, written from this file
 * by `bun scripts/themes-json.ts`; a test checks the two agree).
 *
 * `rules` is the ruleset's `arena.themes.<name>` (validated, embedded in match records: keys are only ever added).
 * Material IDs are grid.ts `Mat`; colors are 0xRRGGBB.
 */
import { Mat } from "./grid";
import type { PropKind } from "./level-config";

/** Liquid pools (#94): basins dug into flat ground and filled to the rim. The weights pick each pool's liquid. */
export interface Hazards {
  /** how many pools (0 0: none, and the generator draws nothing for them) */
  pools: [number, number];
  /** basin width in meters and depth in cells */
  width: [number, number];
  depth: [number, number];
  water: number;
  oil: number;
  lava: number;
  acid: number;
}

export interface ThemeRules {
  /** the ground's body and its top row */
  body: Mat;
  surface: Mat;
  platform: Mat[];
  tower: Mat;
  bridge: Mat[];
  /**
   * #100: generated pits (holes in the ground to fall through) are rare: chance of the one main pit near the middle,
   * and how many extra pits (0 0 in every theme now). Ring-outs come from the arena's edges and the zone.
   */
  pitChance: number;
  extraPits: [number, number];
  towers: [number, number];
  platforms: [number, number];
  /** chance a platform is crumbling planks */
  crumble: number;
  props: Partial<Record<PropKind, [number, number]>>;
  /** legacy (records): steps in the ground; ORed with `ground.steps` */
  stepy: boolean;
  /**
   * The ground's shape: `heights` "ground" (layout.groundHeight) or "roof" (layout.rooftopHeight); `runs` "random"
   * (layout.groundRun) or "whole" (one height per segment between pits); `steps`: each run steps up or down.
   */
  ground: { heights: "ground" | "roof"; runs: "random" | "whole"; steps: boolean };
  /** a material scattered through the ground in place of `on` (chance per cell; 0: none) */
  speckle: { on: Mat; mat: Mat; chance: number };
  /** a low wall at pit edges (layout.parapetChance), or 0 */
  parapet: number;
  hazards: Hazards;
  /** multipliers: gravity (the fall and the jump), friction (how fast a fighter changes speed on the ground) */
  physics: { gravity: number; friction: number };
}

export interface ThemeLook {
  /** the sky gradient (top, horizon) and the two hill rows (far, near) */
  sky: [number, number];
  hills: [number, number];
  /** the backdrop drawn behind the level */
  background: "hills";
  /** material colors (debris; the art bakes the same), over the base colors */
  mat: Partial<Record<MatName, number>>;
  /** the top edge's color per material (default: the material 35% lighter) */
  top: Partial<Record<MatName, number>>;
  /** the terrain atlas (art/level/level-<atlas>); "nature" (#94: sand, mud, ice, liquids) loads with it when used */
  atlas: string;
}

export interface ThemeDef {
  rules: ThemeRules;
  look: ThemeLook;
}

export const MAT_NAMES = ["", "dirt", "rock", "wood", "steel", "concrete", "crumble", "bedrock", "brick", "sand", "mud", "ice"] as const;
export type MatName = Exclude<(typeof MAT_NAMES)[number], "">;

/** Base material colors (each look overrides some). */
export const BASE_MAT: Record<MatName, number> = {
  dirt: 0x6b5a45,
  rock: 0x6f7480,
  wood: 0x9a6a3c,
  steel: 0x56657e,
  concrete: 0x8a8f99,
  crumble: 0xb59a6a,
  bedrock: 0x1c1a26,
  brick: 0x8e4a3a,
  sand: 0xd8bf86,
  mud: 0x5a4330,
  ice: 0xa9dcef,
};

const NO_HAZARDS: Hazards = { pools: [0, 0], width: [2.5, 4], depth: [2, 3], water: 0, oil: 0, lava: 0, acid: 0 };
const EARTH = { gravity: 1, friction: 1 };
const NO_SPECKLE = { on: Mat.Dirt, mat: Mat.Rock, chance: 0 };

export const THEME_DEFS = {
  warehouse: {
    rules: {
      body: Mat.Concrete, surface: Mat.Concrete, platform: [Mat.Steel, Mat.Wood, Mat.Wood], tower: Mat.Steel, bridge: [Mat.Steel, Mat.Wood],
      pitChance: 0, extraPits: [0, 0], towers: [2, 3], platforms: [11, 15], crumble: 0.08,
      props: { crate: [6, 9], steel: [2, 4], barrel: [4, 6], gas: [2, 4], glass: [1, 3], weight: [1, 3], pad: [1, 2], tnt: [0, 1] },
      stepy: false, ground: { heights: "ground", runs: "random", steps: true }, speckle: NO_SPECKLE, parapet: 0,
      hazards: NO_HAZARDS, physics: EARTH,
    },
    look: {
      sky: [0x111522, 0x262a3d], hills: [0x1d2234, 0x252b40], background: "hills",
      mat: { concrete: 0x7c818c, steel: 0x4f6a8c }, top: { concrete: 0xe8c44a, steel: 0x9fb6d6, wood: 0xc8955a }, atlas: "warehouse",
    },
  },
  rooftop: {
    rules: {
      body: Mat.Brick, surface: Mat.Concrete, platform: [Mat.Concrete, Mat.Wood, Mat.Steel], tower: Mat.Brick, bridge: [Mat.Wood, Mat.Wood, Mat.Steel],
      pitChance: 0.3, extraPits: [0, 0], towers: [1, 2], platforms: [10, 14], crumble: 0.12,
      props: { glass: [4, 6], gas: [2, 3], barrel: [3, 5], crate: [3, 5], pad: [2, 3], tnt: [1, 2], weight: [1, 2], steel: [1, 2] },
      stepy: false, ground: { heights: "roof", runs: "random", steps: true }, speckle: NO_SPECKLE, parapet: Mat.Brick,
      hazards: NO_HAZARDS, physics: EARTH,
    },
    look: {
      sky: [0x161b38, 0x5a3550], hills: [0x2a2547, 0x352b52], background: "hills",
      mat: { concrete: 0x9a9aa4 }, top: { concrete: 0xcfcfd6, brick: 0xb86a55, wood: 0xc8955a, steel: 0xa8b4c6 }, atlas: "rooftop",
    },
  },
  junkyard: {
    rules: {
      body: Mat.Dirt, surface: Mat.Dirt, platform: [Mat.Steel, Mat.Wood, Mat.Steel], tower: Mat.Steel, bridge: [Mat.Wood, Mat.Steel],
      pitChance: 0, extraPits: [0, 0], towers: [1, 2], platforms: [10, 13], crumble: 0.15,
      props: { barrel: [7, 10], steel: [3, 5], tnt: [1, 3], crate: [3, 5], gas: [1, 3], pad: [1, 2], glass: [0, 1], weight: [0, 1] },
      stepy: true, ground: { heights: "ground", runs: "random", steps: true }, speckle: { on: Mat.Dirt, mat: Mat.Rock, chance: 0.12 }, parapet: 0,
      hazards: NO_HAZARDS, physics: EARTH,
    },
    look: {
      sky: [0x1a1a22, 0x4a3a2c], hills: [0x2a2620, 0x342e26], background: "hills",
      mat: { dirt: 0x5e4d38, steel: 0x7a5a48 }, top: { dirt: 0x8a9a5a, steel: 0xb08066, wood: 0xc8955a }, atlas: "junkyard",
    },
  },
  construction: {
    rules: {
      body: Mat.Dirt, surface: Mat.Dirt, platform: [Mat.Steel, Mat.Wood, Mat.Crumble], tower: Mat.Steel, bridge: [Mat.Steel, Mat.Wood],
      pitChance: 0, extraPits: [0, 0], towers: [2, 3], platforms: [11, 15], crumble: 0.22,
      props: { tnt: [2, 4], weight: [2, 3], crate: [3, 5], barrel: [3, 5], gas: [1, 3], steel: [1, 3], pad: [1, 2], glass: [0, 2] },
      stepy: true, ground: { heights: "ground", runs: "random", steps: true }, speckle: NO_SPECKLE, parapet: 0,
      hazards: NO_HAZARDS, physics: EARTH,
    },
    look: {
      sky: [0x14192c, 0x40364a], hills: [0x22253a, 0x2b2e45], background: "hills",
      mat: { steel: 0xc76a2a, dirt: 0x705a40 }, top: { dirt: 0xa58a5a, steel: 0xf0a050, wood: 0xd9a560 }, atlas: "construction",
    },
  },
  /**
   * The proving ground (#94), not in the default rotation: every liquid and the new materials (sand ground, rock
   * through it, ice and mud platforms) on the junkyard's art. Sims and the level lab play it; new maps start here.
   */
  testbed: {
    rules: {
      body: Mat.Dirt, surface: Mat.Sand, platform: [Mat.Ice, Mat.Mud, Mat.Rock, Mat.Wood], tower: Mat.Rock, bridge: [Mat.Ice, Mat.Wood],
      pitChance: 0, extraPits: [0, 0], towers: [1, 2], platforms: [11, 14], crumble: 0.1,
      props: { barrel: [4, 6], steel: [2, 4], tnt: [1, 2], crate: [3, 5], gas: [1, 3], pad: [1, 2], glass: [0, 1], weight: [0, 1] },
      stepy: false, ground: { heights: "ground", runs: "random", steps: true }, speckle: { on: Mat.Dirt, mat: Mat.Rock, chance: 0.15 }, parapet: 0,
      hazards: { pools: [2, 3], width: [2.5, 4], depth: [2, 3], water: 3, oil: 2, lava: 1, acid: 1 }, physics: EARTH,
    },
    look: {
      sky: [0x15202a, 0x3c4a4a], hills: [0x1f2c30, 0x28363a], background: "hills",
      mat: { dirt: 0x5e4d38 }, top: { dirt: 0x8a9a5a, wood: 0xc8955a }, atlas: "junkyard",
    },
  },
} satisfies Record<string, ThemeDef>;

export type Theme = keyof typeof THEME_DEFS;
/** Every theme a ruleset may enable. */
export const ALL_THEMES = Object.keys(THEME_DEFS) as Theme[];
/** The default rotation. */
export const THEMES: readonly Theme[] = ["warehouse", "rooftop", "junkyard", "construction"];

/** A theme's material colors, base colors filled in. */
export function themeMatColors(t: Theme): Record<MatName, number> {
  return { ...BASE_MAT, ...THEME_DEFS[t].look.mat };
}

function shade(c: number, k: number): number {
  const r = Math.min(255, Math.floor(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.floor(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.floor((c & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** A theme's top-edge colors (default: the material 35% lighter, as plush_level.py renders them). */
export function themeTopColors(t: Theme): Record<MatName, number> {
  const m = themeMatColors(t);
  const top = THEME_DEFS[t].look.top as Partial<Record<MatName, number>>;
  return Object.fromEntries((Object.keys(m) as MatName[]).map((k) => [k, top[k] ?? shade(m[k], 1.35)])) as Record<MatName, number>;
}

/** Does a theme use the #94 materials or liquids (and so the "nature" atlas)? */
export function themeUsesNature(t: Theme): boolean {
  const r: ThemeRules = THEME_DEFS[t].rules as ThemeRules;
  const mats = [r.body, r.surface, r.tower, ...r.platform, ...r.bridge, r.speckle.chance > 0 ? r.speckle.mat : 0, r.parapet];
  return r.hazards.pools[1] > 0 || mats.some((m) => m >= Mat.Sand);
}

/** The looks as JSON for the art tools (tools/art/themes.json; scripts/themes-json.ts writes it). */
export function themesJson(): string {
  const themes = Object.fromEntries(ALL_THEMES.map((t) => {
    const l = THEME_DEFS[t].look as ThemeLook;
    return [t, { sky: l.sky, hills: l.hills, background: l.background, atlas: l.atlas, mat: l.mat, top: l.top }];
  }));
  return JSON.stringify({ note: "Generated from src/sim/themes.ts by scripts/themes-json.ts (#94). Do not edit.", base: BASE_MAT, themes }, null, 1) + "\n";
}
