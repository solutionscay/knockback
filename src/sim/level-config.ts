import { Mat } from "./grid";

export type Theme = "warehouse" | "rooftop" | "junkyard" | "construction";
export const THEMES: readonly Theme[] = ["warehouse", "rooftop", "junkyard", "construction"];

export type PropKind = "block" | "crate" | "barrel" | "gas" | "tnt" | "steel" | "glass" | "pad" | "weight";

/** Half extents per prop kind (meters). */
export const PROP_HALF: Record<PropKind, [number, number]> = {
  block: [0.45, 0.45],
  crate: [0.4, 0.4],
  barrel: [0.34, 0.5],
  gas: [0.22, 0.55],
  tnt: [0.4, 0.3],
  steel: [0.5, 0.5],
  glass: [0.08, 0.9],
  pad: [0.6, 0.15],
  weight: [0.5, 0.5],
};

interface ThemeSpec {
  body: Mat;
  surface: Mat;
  platform: Mat[];
  tower: Mat;
  bridge: Mat[];
  pitChance: number;
  extraPits: [number, number];
  towers: [number, number];
  platforms: [number, number];
  crumble: number;
  props: Partial<Record<PropKind, [number, number]>>;
  stepy: boolean;
}

export const LEVEL_THEMES: Record<Theme, ThemeSpec> = {
  warehouse: {
    body: Mat.Concrete,
    surface: Mat.Concrete,
    platform: [Mat.Steel, Mat.Wood, Mat.Wood],
    tower: Mat.Steel,
    bridge: [Mat.Steel, Mat.Wood],
    pitChance: 0.6,
    extraPits: [0, 1],
    towers: [2, 3],
    platforms: [11, 15],
    crumble: 0.08,
    props: { crate: [6, 9], steel: [2, 4], barrel: [4, 6], gas: [2, 4], glass: [1, 3], weight: [1, 3], pad: [1, 2], tnt: [0, 1] },
    stepy: false,
  },
  rooftop: {
    body: Mat.Brick,
    surface: Mat.Concrete,
    platform: [Mat.Concrete, Mat.Wood, Mat.Steel],
    tower: Mat.Brick,
    bridge: [Mat.Wood, Mat.Wood, Mat.Steel],
    pitChance: 0.85,
    extraPits: [1, 2],
    towers: [1, 2],
    platforms: [10, 14],
    crumble: 0.12,
    props: { glass: [4, 6], gas: [2, 3], barrel: [3, 5], crate: [3, 5], pad: [2, 3], tnt: [1, 2], weight: [1, 2], steel: [1, 2] },
    stepy: false,
  },
  junkyard: {
    body: Mat.Dirt,
    surface: Mat.Dirt,
    platform: [Mat.Steel, Mat.Wood, Mat.Steel],
    tower: Mat.Steel,
    bridge: [Mat.Wood, Mat.Steel],
    pitChance: 0.55,
    extraPits: [0, 1],
    towers: [1, 2],
    platforms: [10, 13],
    crumble: 0.15,
    props: { barrel: [7, 10], steel: [3, 5], tnt: [1, 3], crate: [3, 5], gas: [1, 3], pad: [1, 2], glass: [0, 1], weight: [0, 1] },
    stepy: true,
  },
  construction: {
    body: Mat.Dirt,
    surface: Mat.Dirt,
    platform: [Mat.Steel, Mat.Wood, Mat.Crumble],
    tower: Mat.Steel,
    bridge: [Mat.Steel, Mat.Wood],
    pitChance: 0.6,
    extraPits: [0, 1],
    towers: [2, 3],
    platforms: [11, 15],
    crumble: 0.22,
    props: { tnt: [2, 4], weight: [2, 3], crate: [3, 5], barrel: [3, 5], gas: [1, 3], steel: [1, 3], pad: [1, 2], glass: [0, 2] },
    stepy: true,
  },
};

export const LEVEL = {
  halfWidth: [28, 38], rows: 64, bottom: -8, top: 13, attempts: 30,
  edgeInset: [1.5, 4], mainPitWidth: [3.5, 6], mainPitWindow: 5,
  extraPitWidth: [3.5, 5.5], extraPitOffset: 11, pitEdgeMargin: 6, pitSpacing: 7,
  groundHeight: [-0.5, 1], rooftopHeight: [-1, 3.5], groundRun: [3, 7],
  groundStep: [-1, 0, 0, 1], groundMin: -1, groundMax: 2, bedrockRows: 2,
  junkRockChance: 0.12, parapetChance: 0.5,
  bridgeCenter: 6, bridgeHeightGap: 1, bridgeCenterChance: 0.85, bridgeChance: 0.5, bridgeMaxWidth: 7,
  overhangChance: 0.4, overhangCells: [2, 4], overhangGap: 3,
  platformAttempts: 160, platformLength: [3, 7], platformHeights: [3, 3, 3.5, 5.5, 6, 8, 8.5, 10.5],
  thickPlatformChance: 0.25, platformXClearCells: 2, platformYClearCells: 4,
  coverStacks: [3, 5], groundCoverStacks: 3, coverColumns: [1, 2], coverRows: [1, 2],
  propEdgeInset: 0.8, propClearance: 0.3, blockApproach: 0.75, groundCoverHeight: 2.5, barrelPairDivisor: 3,
  weightAttempts: 200, weightMinAnchorY: 3, weightFloorClearCells: 10, weightSpawnGap: 2, weightLength: [1.5, 2.5],
  zonePitReach: 12, zoneCenterJitter: 4,
  minimumCover: 6, minimumProps: 18, minimumPlatforms: 7, centerDropReach: 16,
} as const;

export const SPAWNS = {
  centerWindow: 12, minSurfaceWidth: 2.5, ledgeMargin: 1.2, minXGap: 3.5,
  minYGap: 2, bodyClearance: 0.7, propClearance: 1.4, minHeight: -1.5,
  maxSpread: 24, minDropMargin: 1,
};

export const WALLS = {
  approach: 1.5, clearance: 5.5, attemptsPerWall: 50, widthCells: [1, 3],
  heights: [1.5, 2], spacing: 5, crackedHp: 0.3, regularHp: 0.65,
} as const;
