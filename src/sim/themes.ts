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
  /**
   * #114: a muddy creek. 0: none. Otherwise mud lines each basin's walls (one cell thick, not its floor) and tops this
   * many ground cells on each side of it (the banks): mud slows whoever stands on it. No RNG draw either way.
   */
  bankCells: number;
  /** #125: cave slime (thick, glowing water: a fighter floats and swims out) */
  slime: number;
  /** #127: a station's coolant (cold, glowing water: a fighter floats and swims out) */
  coolant: number;
}

export interface ThemeRules {
  /** the ground's body and its top row */
  body: Mat;
  surface: Mat;
  platform: Mat[];
  tower: Mat;
  bridge: Mat[];
  /**
   * #100: at most one generated gap, near the middle (this chance), always with a jump-through catwalk over it (stage);
   * no extra pits (0 0 in every theme). With the edges and the zone, ring-outs stay about a third of the knockouts.
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
  /**
   * #100 stage design. oneWay: the chance a hanging platform is jump-through (2-row platforms stay solid: cover).
   * catwalk: a gap's crossing is a hanging jump-through catwalk catwalkHeight m above the lower rim (instead of a bridge
   * at ground level), so a knocked fighter can still fall in. frame: the hard material under the ground's soft top
   * (softDepth rows of `body`, its top row `surface`); 0: the whole ground is `body`. topRows (#111): how many rows of
   * `surface` top the ground (1 in the first themes; the beach's dry sand is 2 deep over its wet sand).
   * ceiling (#125): a rock ceiling's underside, in m above y 0 (0: open sky, and the generator draws nothing for it); it
   * reaches the grid's top: ceilingRock rows of rock (carvable) under bedrock. stalactites: rock spikes hung from it,
   * clear of everything under them (levelgen.ts STALACTITE_CLEAR). Platforms stay CEILING_CLEAR under it.
   */
  stage: {
    oneWay: number; catwalk: boolean; catwalkHeight: number; frame: number; softDepth: [number, number]; topRows: [number, number];
    ceiling: number; ceilingRock: [number, number]; stalactites: [number, number];
  };
}

export interface ThemeLook {
  /** the sky gradient (top, horizon) and the two hill rows (far, near) */
  sky: [number, number];
  hills: [number, number];
  /**
   * the backdrop drawn behind the level: "hills" (two rows of code-drawn hills), "beach" (#111: the sun, clouds and the
   * sea on the horizon from the theme's atlas, `hills` the sea's fallback color and the near dunes), "forest" (#114: a moon
   * and two rows of pine silhouettes from the atlas, darker than the level; `hills` the far and near rows' colors, the
   * pines tinted to match so the fill below each row and its trees are one mass), "cave" (#125: the cave's back wall: rock
   * columns in the two `hills` colors and glowing crystals from the theme's atlas), "space" (#127: a starfield, a ringed
   * planet and a far station from the theme's atlas; `hills` tint the drifting asteroids; no ground)
   */
  background: "hills" | "beach" | "forest" | "cave" | "space";
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

const NO_HAZARDS: Hazards = { pools: [0, 0], width: [2.5, 4], depth: [2, 3], water: 0, oil: 0, lava: 0, acid: 0, bankCells: 0, slime: 0, coolant: 0 };
const EARTH = { gravity: 1, friction: 1 };
const NO_SPECKLE = { on: Mat.Dirt, mat: Mat.Rock, chance: 0 };

export const THEME_DEFS = {
  warehouse: {
    rules: {
      body: Mat.Concrete, surface: Mat.Concrete, platform: [Mat.Steel, Mat.Wood, Mat.Wood], tower: Mat.Steel, bridge: [Mat.Steel, Mat.Wood],
      pitChance: 0.7, extraPits: [0, 0], towers: [2, 3], platforms: [11, 15], crumble: 0.08,
      props: { crate: [6, 9], steel: [2, 4], barrel: [4, 6], gas: [2, 4], glass: [1, 3], weight: [1, 3], pad: [1, 2], tnt: [0, 1] },
      stepy: false, ground: { heights: "ground", runs: "random", steps: true }, speckle: NO_SPECKLE, parapet: 0,
      hazards: NO_HAZARDS, physics: EARTH,
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Steel, softDepth: [3, 4], topRows: [1, 1], ceiling: 0, ceilingRock: [0, 0], stalactites: [0, 0] },
    },
    look: {
      sky: [0x111522, 0x262a3d], hills: [0x1d2234, 0x252b40], background: "hills",
      mat: { concrete: 0x7c818c, steel: 0x4f6a8c }, top: { concrete: 0xe8c44a, steel: 0x9fb6d6, wood: 0xc8955a }, atlas: "warehouse",
    },
  },
  rooftop: {
    rules: {
      body: Mat.Brick, surface: Mat.Concrete, platform: [Mat.Concrete, Mat.Wood, Mat.Steel], tower: Mat.Brick, bridge: [Mat.Wood, Mat.Wood, Mat.Steel],
      pitChance: 0.9, extraPits: [0, 0], towers: [1, 2], platforms: [10, 14], crumble: 0.12,
      props: { glass: [4, 6], gas: [2, 3], barrel: [3, 5], crate: [3, 5], pad: [2, 3], tnt: [1, 2], weight: [1, 2], steel: [1, 2] },
      stepy: false, ground: { heights: "roof", runs: "random", steps: true }, speckle: NO_SPECKLE, parapet: Mat.Brick,
      hazards: NO_HAZARDS, physics: EARTH,
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Steel, softDepth: [3, 4], topRows: [1, 1], ceiling: 0, ceilingRock: [0, 0], stalactites: [0, 0] },
    },
    look: {
      sky: [0x161b38, 0x5a3550], hills: [0x2a2547, 0x352b52], background: "hills",
      mat: { concrete: 0x9a9aa4 }, top: { concrete: 0xcfcfd6, brick: 0xb86a55, wood: 0xc8955a, steel: 0xa8b4c6 }, atlas: "rooftop",
    },
  },
  junkyard: {
    rules: {
      body: Mat.Dirt, surface: Mat.Dirt, platform: [Mat.Steel, Mat.Wood, Mat.Steel], tower: Mat.Steel, bridge: [Mat.Wood, Mat.Steel],
      pitChance: 0.65, extraPits: [0, 0], towers: [1, 2], platforms: [10, 13], crumble: 0.15,
      props: { barrel: [7, 10], steel: [3, 5], tnt: [1, 3], crate: [3, 5], gas: [1, 3], pad: [1, 2], glass: [0, 1], weight: [0, 1] },
      stepy: true, ground: { heights: "ground", runs: "random", steps: true }, speckle: { on: Mat.Dirt, mat: Mat.Rock, chance: 0.12 }, parapet: 0,
      hazards: NO_HAZARDS, physics: EARTH,
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Rock, softDepth: [3, 4], topRows: [1, 1], ceiling: 0, ceilingRock: [0, 0], stalactites: [0, 0] },
    },
    look: {
      sky: [0x1a1a22, 0x4a3a2c], hills: [0x2a2620, 0x342e26], background: "hills",
      mat: { dirt: 0x5e4d38, steel: 0x7a5a48 }, top: { dirt: 0x8a9a5a, steel: 0xb08066, wood: 0xc8955a }, atlas: "junkyard",
    },
  },
  construction: {
    rules: {
      body: Mat.Dirt, surface: Mat.Dirt, platform: [Mat.Steel, Mat.Wood, Mat.Crumble], tower: Mat.Steel, bridge: [Mat.Steel, Mat.Wood],
      pitChance: 0.7, extraPits: [0, 0], towers: [2, 3], platforms: [11, 15], crumble: 0.22,
      props: { tnt: [2, 4], weight: [2, 3], crate: [3, 5], barrel: [3, 5], gas: [1, 3], steel: [1, 3], pad: [1, 2], glass: [0, 2] },
      stepy: true, ground: { heights: "ground", runs: "random", steps: true }, speckle: NO_SPECKLE, parapet: 0,
      hazards: NO_HAZARDS, physics: EARTH,
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Rock, softDepth: [3, 4], topRows: [1, 1], ceiling: 0, ceilingRock: [0, 0], stalactites: [0, 0] },
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
      pitChance: 0.6, extraPits: [0, 0], towers: [1, 2], platforms: [11, 14], crumble: 0.1,
      props: { barrel: [4, 6], steel: [2, 4], tnt: [1, 2], crate: [3, 5], gas: [1, 3], pad: [1, 2], glass: [0, 1], weight: [0, 1] },
      stepy: false, ground: { heights: "ground", runs: "random", steps: true }, speckle: { on: Mat.Dirt, mat: Mat.Rock, chance: 0.15 }, parapet: 0,
      hazards: { pools: [2, 3], width: [2.5, 4], depth: [2, 3], water: 3, oil: 2, lava: 1, acid: 1, bankCells: 0, slime: 0, coolant: 0 }, physics: EARTH,
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Rock, softDepth: [3, 4], topRows: [1, 1], ceiling: 0, ceilingRock: [0, 0], stalactites: [0, 0] },
    },
    look: {
      sky: [0x15202a, 0x3c4a4a], hills: [0x1f2c30, 0x28363a], background: "hills",
      mat: { dirt: 0x5e4d38 }, top: { dirt: 0x8a9a5a, wood: 0xc8955a }, atlas: "junkyard",
    },
  },
  /**
   * The beach (#111), the first of the new maps. Dry sand on top (2 rows: it falls into a hole dug under it), wet sand
   * below (dirt, in the beach's colors: it holds its shape), a rock frame, bedrock. Tide pools of water fill dips in the
   * sand: they slow a fighter and put out fire, and a fighter swims out (no instant death). The jump-through platforms
   * are boardwalk planks (a pier over the central gap), the walls and the scatter in the wet sand are rock, and cover
   * blocks, crates and barrels wear the beach's skins (driftwood logs, driftwood crates, buoys; the same props).
   * Physics as on every map.
   */
  beach: {
    rules: {
      body: Mat.Dirt, surface: Mat.Sand, platform: [Mat.Wood, Mat.Wood, Mat.Wood, Mat.Rock], tower: Mat.Rock, bridge: [Mat.Wood],
      pitChance: 0.7, extraPits: [0, 0], towers: [1, 2], platforms: [11, 14], crumble: 0.12,
      props: { crate: [4, 6], barrel: [4, 6], gas: [1, 2], pad: [1, 2], tnt: [0, 1], steel: [0, 1], weight: [0, 1] },
      stepy: false, ground: { heights: "ground", runs: "random", steps: true }, speckle: { on: Mat.Dirt, mat: Mat.Rock, chance: 0.06 }, parapet: 0,
      hazards: { pools: [1, 2], width: [3, 5], depth: [2, 3], water: 1, oil: 0, lava: 0, acid: 0, bankCells: 0, slime: 0, coolant: 0 }, physics: EARTH,
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Rock, softDepth: [4, 5], topRows: [2, 2], ceiling: 0, ceilingRock: [0, 0], stalactites: [0, 0] },
    },
    look: {
      sky: [0x1d3a66, 0xe59a6a], hills: [0x184e62, 0x3e3a3c], background: "beach",
      mat: { sand: 0xe2c48a, dirt: 0xa5865a, rock: 0x7a6e66, wood: 0x8e7658, crumble: 0x9a8566, bedrock: 0x221f2a },
      top: { sand: 0xf4e3b4, dirt: 0xc2a271, rock: 0x6f8a52, wood: 0xc2a77e, crumble: 0xb39c78 }, atlas: "beach",
    },
  },
  /**
   * The forest (#114), the second of the new maps. Forest soil over a rock frame, bedrock under. Muddy creeks: water
   * pools lined with mud (the floor, the walls and two cells of bank each side), so the banks slow a fighter and the
   * water slows, puts out fire and is swum out of. The walls are tree trunks (wood: they burn), the jump-through
   * platforms are branches and leafy canopy (crumbling planks in the forest's art: the canopy gives way fast and burns),
   * the catwalk over the central gap a log bridge; stones in the soil. Cover blocks, crates and barrels wear the
   * forest's skins (a stacked log pile, a tree stump, a beehive; the same props). Physics as on every map.
   */
  forest: {
    rules: {
      body: Mat.Dirt, surface: Mat.Dirt, platform: [Mat.Wood, Mat.Wood, Mat.Wood, Mat.Rock], tower: Mat.Wood, bridge: [Mat.Wood],
      pitChance: 0.7, extraPits: [0, 0], towers: [1, 2], platforms: [11, 14], crumble: 0.2,
      props: { crate: [4, 6], steel: [1, 3], barrel: [3, 5], gas: [1, 2], pad: [1, 2], tnt: [0, 1], weight: [0, 1] },
      stepy: false, ground: { heights: "ground", runs: "random", steps: true }, speckle: { on: Mat.Dirt, mat: Mat.Rock, chance: 0.08 }, parapet: 0,
      hazards: { pools: [1, 2], width: [3, 4.5], depth: [2, 3], water: 1, oil: 0, lava: 0, acid: 0, bankCells: 2, slime: 0, coolant: 0 }, physics: EARTH,
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Rock, softDepth: [3, 4], topRows: [1, 1], ceiling: 0, ceilingRock: [0, 0], stalactites: [0, 0] },
    },
    look: {
      sky: [0x0e1a26, 0x5a6f5c], hills: [0x112017, 0x0c1610], background: "forest",
      mat: { dirt: 0x5a4632, rock: 0x6c7068, wood: 0x6e5038, crumble: 0x4f7a3a, mud: 0x3a2a1e, bedrock: 0x1a1c20 },
      top: { dirt: 0x5f8a3a, rock: 0x5f7e46, wood: 0x8c6a4a, crumble: 0x6f9e4a, mud: 0x7a5c3c }, atlas: "forest",
    },
  },
  /**
   * The cave (#125). Gravel over a dark rock frame, bedrock under, and a low rock ceiling over everything (rock under
   * bedrock, carvable) with stalactites hanging from it: they break off when the rock holding them is blasted, and fall.
   * Pools of glowing slime (thick water: slower, a fighter floats and swims out, it smothers fire) fill dips in the
   * floor. Rock ledges, mine-timber and ice ledges (slippery, they shatter) as jump-through platforms, a timber catwalk
   * over the central gap, rock pillars as walls, mining TNT. Crates, barrels and cover blocks wear the cave's skins
   * (mine carts, crystal clusters, boulders; the same props). Physics as on every map.
   */
  cave: {
    rules: {
      body: Mat.Dirt, surface: Mat.Dirt, platform: [Mat.Rock, Mat.Rock, Mat.Wood, Mat.Ice], tower: Mat.Rock, bridge: [Mat.Wood],
      pitChance: 0.7, extraPits: [0, 0], towers: [1, 2], platforms: [10, 13], crumble: 0.12,
      props: { crate: [4, 6], barrel: [3, 5], steel: [1, 3], gas: [1, 2], pad: [1, 2], tnt: [1, 2], weight: [0, 1] },
      stepy: false, ground: { heights: "ground", runs: "random", steps: true }, speckle: { on: Mat.Dirt, mat: Mat.Rock, chance: 0.1 }, parapet: 0,
      hazards: { pools: [1, 2], width: [3, 4.5], depth: [2, 3], water: 0, oil: 0, lava: 0, acid: 0, bankCells: 0, slime: 1, coolant: 0 }, physics: EARTH,
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Rock, softDepth: [3, 4], topRows: [1, 1], ceiling: 13, ceilingRock: [3, 4], stalactites: [5, 8] },
    },
    look: {
      sky: [0x07080d, 0x17141f], hills: [0x151320, 0x1d1a2a], background: "cave",
      mat: { dirt: 0x4f453b, rock: 0x515666, wood: 0x7a5a3a, crumble: 0x6a5236, ice: 0x9fd8ee, bedrock: 0x15141c },
      top: { dirt: 0x6e6252, rock: 0x77809a, wood: 0xa88052, crumble: 0x8e7350, ice: 0xdaf4ff }, atlas: "cave",
    },
  },
  /**
   * Space (#127): an asteroid station. Grey regolith over a dark asteroid-rock frame, bedrock under, chunks of ice in the
   * regolith (where one tops the floor it is slippery and shatters). Steel girders, hull panels and ice ledges as
   * jump-through platforms, rusted grating as the crumbling ones, a steel catwalk over the central gap, steel bulkheads
   * as walls, the void below. Pools of coolant (cold, glowing: slower than water, a fighter floats and swims out, it puts
   * out fire) fill dips in the floor. Low gravity (physics.gravity): higher jumps, longer flights. Crates, barrels and
   * cover blocks wear the station's skins (cargo pods, fuel canisters, stacked hull plates; the same props).
   */
  space: {
    rules: {
      body: Mat.Dirt, surface: Mat.Dirt, platform: [Mat.Steel, Mat.Steel, Mat.Concrete, Mat.Ice], tower: Mat.Steel, bridge: [Mat.Steel],
      pitChance: 0.7, extraPits: [0, 0], towers: [1, 2], platforms: [11, 14], crumble: 0.1,
      props: { crate: [4, 6], barrel: [3, 5], steel: [2, 3], gas: [1, 2], pad: [1, 2], glass: [0, 1], tnt: [0, 1], weight: [0, 1] },
      stepy: false, ground: { heights: "ground", runs: "random", steps: true }, speckle: { on: Mat.Dirt, mat: Mat.Ice, chance: 0.08 }, parapet: 0,
      hazards: { pools: [1, 2], width: [3, 4.5], depth: [2, 3], water: 0, oil: 0, lava: 0, acid: 0, bankCells: 0, slime: 0, coolant: 1 }, physics: { gravity: 0.85, friction: 1 },
      stage: { oneWay: 0.75, catwalk: true, catwalkHeight: 2.5, frame: Mat.Rock, softDepth: [3, 4], topRows: [1, 1], ceiling: 0, ceilingRock: [0, 0], stalactites: [0, 0] },
    },
    look: {
      sky: [0x03040a, 0x0b1022], hills: [0x2a2838, 0x353246], background: "space",
      mat: { dirt: 0x6e6a74, rock: 0x4c4856, steel: 0x7c8aa0, concrete: 0x9aa0ac, crumble: 0x8a6a4e, ice: 0xb4e2f2, bedrock: 0x141420 },
      top: { dirt: 0x8e8a96, rock: 0x6c687a, steel: 0xe8c44a, concrete: 0xd0d6e0, crumble: 0xb08a62, ice: 0xe6f8ff }, atlas: "space",
    },
  },
} satisfies Record<string, ThemeDef>;

export type Theme = keyof typeof THEME_DEFS;
/** Every theme a ruleset may enable. */
export const ALL_THEMES = Object.keys(THEME_DEFS) as Theme[];
/** The default rotation. */
export const THEMES: readonly Theme[] = ["warehouse", "rooftop", "junkyard", "construction", "beach", "forest", "cave", "space"];

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
  const mats = [r.body, r.surface, r.tower, ...r.platform, ...r.bridge, r.speckle.chance > 0 ? r.speckle.mat : 0, r.parapet, r.hazards.bankCells > 0 ? Mat.Mud : 0];
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
