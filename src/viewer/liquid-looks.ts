/**
 * How each liquid looks and moves on screen (#116): the one parameter set the liquid renderer (liquidview.ts) reads.
 * Viewer only: the sim's liquids (grid.ts Liquid) keep their own physics; this is paint and motion.
 *
 * A map that adds a liquid adds its name to grid.ts LIQUID_NAMES (the sim side) and an entry here under that name.
 * Nothing else in the viewer changes. `mud` is here ready for a map that brings it; no liquid in the sim uses it yet
 * (the forest's mud is a material). `slime` is the cave's (#125), `coolant` the space map's (#127).
 */

export interface LiquidLook {
  /** colour at the surface and colour at depth (the body shades from one to the other) */
  color: number;
  deep: number;
  /** opacity at the surface and at the bottom of the pool (translucent on top, denser below) */
  alpha: number;
  deepAlpha: number;
  /** depth (m) over which the body goes from `color` to `deep` */
  depthM: number;
  /** the line along the top: colour, opacity, width (m) */
  foam: number;
  foamAlpha: number;
  foamWidth: number;
  /** a lighter band just under the surface, 0..1 (light caught in the top of the liquid) */
  band: number;
  /** a thin bright line just under the foam (gloss: oil, slime) */
  gloss: number;
  /** resting swell (m): the height of the layered ambient waves */
  waveHeight: number;
  /** how fast the swell rolls and ripples travel (1 = water) */
  waveSpeed: number;
  /** motion viscosity, 0..1: how fast a ripple dies (thick liquids settle at once) and how high it rises */
  viscosity: number;
  /** a glow over the surface (lava): colour and strength 0..1 */
  glow: number;
  glowAlpha: number;
  /** caustic shimmer on the pool floor, 0..1 (clear liquids) */
  caustics: number;
  /** droplet colour and how many a splash throws (1 = water) */
  drop: number;
  drops: number;
  /**
   * #143: moving liquid. `ease` (s): how fast a column's drawn level follows the sim's when it fills or drains (the
   * time constant; thick liquids settle a little slower, but always reach it within a few flow steps).
   * Falling liquid is a stream: its width (m) at full flow (a lone column; side by side they join into a sheet), how fast its streaks run down it (1 = water), how many
   * droplets a second it throws where it lands, its gloss 0..1 (the bright core line) and glow 0..1 (lava, coolant).
   */
  ease: number;
  streamWidth: number;
  streamSpeed: number;
  streamDrops: number;
  streamGloss: number;
  streamGlow: number;
}

export const LIQUID_LOOKS: Record<string, LiquidLook> = {
  // light and fast: clear at the top, deep sea blue at depth, white foam, caustics on the floor
  water: { color: 0x6fdcec, deep: 0x123f7a, alpha: 0.38, deepAlpha: 0.9, depthM: 1.2, foam: 0xf2fdff, foamAlpha: 0.75, foamWidth: 0.045, band: 0.55, gloss: 0, waveHeight: 0.045, waveSpeed: 1, viscosity: 0.12, glow: 0, glowAlpha: 0, caustics: 0.5, drop: 0xbfefff, drops: 1, ease: 0.05, streamWidth: 0.3, streamSpeed: 1, streamDrops: 14, streamGloss: 0.6, streamGlow: 0 },
  // dark, glossy, slow: nearly opaque, a sheen line instead of foam
  oil: { color: 0x3a2f55, deep: 0x120c1e, alpha: 0.82, deepAlpha: 0.96, depthM: 1.2, foam: 0x8f7fc4, foamAlpha: 0.55, foamWidth: 0.05, band: 0.1, gloss: 0.75, waveHeight: 0.025, waveSpeed: 0.45, viscosity: 0.55, glow: 0, glowAlpha: 0, caustics: 0, drop: 0x2c2240, drops: 0.6, ease: 0.08, streamWidth: 0.34, streamSpeed: 0.55, streamDrops: 4, streamGloss: 0.85, streamGlow: 0 },
  // glowing, slow and thick: bright crust line, orange glow above, near-opaque body
  lava: { color: 0xff8a2a, deep: 0xa8200c, alpha: 0.95, deepAlpha: 1, depthM: 1.5, foam: 0xffe08a, foamAlpha: 0.95, foamWidth: 0.08, band: 0.5, gloss: 0, waveHeight: 0.03, waveSpeed: 0.35, viscosity: 0.75, glow: 0xff7a1a, glowAlpha: 0.35, caustics: 0, drop: 0xffb347, drops: 0.5, ease: 0.1, streamWidth: 0.38, streamSpeed: 0.4, streamDrops: 4, streamGloss: 0.35, streamGlow: 0.8 },
  // bright, mid-speed: toxic green, light foam
  acid: { color: 0x9cf04a, deep: 0x2f8a1e, alpha: 0.6, deepAlpha: 0.9, depthM: 1.8, foam: 0xeaffb0, foamAlpha: 0.85, foamWidth: 0.06, band: 0.3, gloss: 0.2, waveHeight: 0.035, waveSpeed: 0.7, viscosity: 0.3, glow: 0, glowAlpha: 0, caustics: 0.2, drop: 0xb6ff66, drops: 0.8, ease: 0.06, streamWidth: 0.3, streamSpeed: 0.8, streamDrops: 10, streamGloss: 0.45, streamGlow: 0 },
  // (no sim liquid yet) slow and thick: brown, opaque, barely moves, a dull crust line
  mud: { color: 0x7a5a36, deep: 0x3b2814, alpha: 0.9, deepAlpha: 0.98, depthM: 1, foam: 0xa8865a, foamAlpha: 0.6, foamWidth: 0.06, band: 0.1, gloss: 0.1, waveHeight: 0.015, waveSpeed: 0.3, viscosity: 0.85, glow: 0, glowAlpha: 0, caustics: 0, drop: 0x6b4a2a, drops: 0.5, ease: 0.1, streamWidth: 0.36, streamSpeed: 0.4, streamDrops: 3, streamGloss: 0.1, streamGlow: 0 },
  // the cave's (#125): glossy and slow: bright green, a strong sheen
  slime: { color: 0x7be06a, deep: 0x2a7a3a, alpha: 0.75, deepAlpha: 0.95, depthM: 1.4, foam: 0xd8ffc8, foamAlpha: 0.7, foamWidth: 0.06, band: 0.25, gloss: 0.9, waveHeight: 0.025, waveSpeed: 0.5, viscosity: 0.6, glow: 0, glowAlpha: 0, caustics: 0, drop: 0x8ef07a, drops: 0.7, ease: 0.08, streamWidth: 0.36, streamSpeed: 0.5, streamDrops: 5, streamGloss: 0.85, streamGlow: 0.15 },
  // the space map's (#127): cold and glowing: cyan over deep blue, a soft glow, slower than water
  coolant: { color: 0x5ae0ff, deep: 0x0e5a8a, alpha: 0.55, deepAlpha: 0.92, depthM: 1.4, foam: 0xe8fcff, foamAlpha: 0.8, foamWidth: 0.05, band: 0.45, gloss: 0.4, waveHeight: 0.035, waveSpeed: 0.75, viscosity: 0.25, glow: 0x3ad8ff, glowAlpha: 0.22, caustics: 0.3, drop: 0xc8f6ff, drops: 0.8, ease: 0.06, streamWidth: 0.3, streamSpeed: 0.85, streamDrops: 10, streamGloss: 0.55, streamGlow: 0.5 },
};

/** The look for a liquid name; an unknown name gets water's look (a new liquid shows before its entry exists). */
export function liquidLook(name: string): LiquidLook {
  return LIQUID_LOOKS[name] ?? LIQUID_LOOKS.water!;
}
