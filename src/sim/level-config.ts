import { ALL_THEMES, THEME_DEFS, THEMES, type Theme, type ThemeRules } from "./themes";

export { ALL_THEMES, THEMES, type Theme };

export type PropKind = "block" | "crate" | "barrel" | "gas" | "tnt" | "steel" | "glass" | "pad" | "weight" | "waterTank" | "oilTank";

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
  waterTank: [0.34, 0.5],
  oilTank: [0.34, 0.5],
  weight: [0.5, 0.5],
};

/** Each theme's generator rules: the data in themes.ts (#94). */
export const LEVEL_THEMES: Record<Theme, ThemeRules> = Object.fromEntries(ALL_THEMES.map((t) => [t, THEME_DEFS[t].rules])) as Record<Theme, ThemeRules>;

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

export const CLOSE_SPAWNS = {
  centerWindow: 12, minSurfaceWidth: 2.5, ledgeMargin: 1.2, minXGap: 3.5,
  minYGap: 2, bodyClearance: 0.7, propClearance: 1.4, minHeight: -1.5,
  maxSpread: 24, minDropMargin: 1,
  spread: { enabled: false, jitter: 0.16, innerOutset: 0, outerOutset: 0.18, minDistance: 14, zoneMargin: 2, heightDifference: 1.5, ledgeHeight: 1.5 },
};

export const SPAWNS = { ...CLOSE_SPAWNS, maxSpread: 150, spread: { ...CLOSE_SPAWNS.spread, enabled: true } };

export const WALLS = {
  approach: 1.5, clearance: 5.5, attemptsPerWall: 50, widthCells: [1, 3],
  heights: [1.5, 2], spacing: 5, crackedHp: 0.3, regularHp: 0.65,
} as const;
