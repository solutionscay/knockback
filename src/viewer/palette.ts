/** Placeholder palettes per theme (the art-direction task replaces these). */
import { Mat } from "../sim/grid";
import type { Theme } from "../sim/levelgen";

export interface Palette {
  sky: [number, number];
  hills: [number, number];
  mat: Record<number, number>;
  top: Record<number, number>;
}

const BASE: Record<number, number> = {
  [Mat.Dirt]: 0x6b5a45,
  [Mat.Rock]: 0x6f7480,
  [Mat.Wood]: 0x9a6a3c,
  [Mat.Steel]: 0x56657e,
  [Mat.Concrete]: 0x8a8f99,
  [Mat.Crumble]: 0xb59a6a,
  [Mat.Bedrock]: 0x1c1a26,
  [Mat.Brick]: 0x8e4a3a,
};

export const PALETTES: Record<Theme, Palette> = {
  warehouse: {
    sky: [0x111522, 0x262a3d],
    hills: [0x1d2234, 0x252b40],
    mat: { ...BASE, [Mat.Concrete]: 0x7c818c, [Mat.Steel]: 0x4f6a8c },
    top: { [Mat.Concrete]: 0xe8c44a, [Mat.Steel]: 0x9fb6d6, [Mat.Wood]: 0xc8955a },
  },
  rooftop: {
    sky: [0x161b38, 0x5a3550],
    hills: [0x2a2547, 0x352b52],
    mat: { ...BASE, [Mat.Concrete]: 0x9a9aa4 },
    top: { [Mat.Concrete]: 0xcfcfd6, [Mat.Brick]: 0xb86a55, [Mat.Wood]: 0xc8955a, [Mat.Steel]: 0xa8b4c6 },
  },
  junkyard: {
    sky: [0x1a1a22, 0x4a3a2c],
    hills: [0x2a2620, 0x342e26],
    mat: { ...BASE, [Mat.Dirt]: 0x5e4d38, [Mat.Steel]: 0x7a5a48 },
    top: { [Mat.Dirt]: 0x8a9a5a, [Mat.Steel]: 0xb08066, [Mat.Wood]: 0xc8955a },
  },
  construction: {
    sky: [0x14192c, 0x40364a],
    hills: [0x22253a, 0x2b2e45],
    mat: { ...BASE, [Mat.Steel]: 0xc76a2a, [Mat.Dirt]: 0x705a40 },
    top: { [Mat.Dirt]: 0xa58a5a, [Mat.Steel]: 0xf0a050, [Mat.Wood]: 0xd9a560 },
  },
};

export function shade(color: number, k: number): number {
  const r = Math.min(255, Math.max(0, ((color >> 16) & 255) * k));
  const g = Math.min(255, Math.max(0, ((color >> 8) & 255) * k));
  const b = Math.min(255, Math.max(0, (color & 255) * k));
  return ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
}

export const POWER_COLOR: Record<string, number> = {
  health: 0x7dffa0,
  shield: 0x6ee7ff,
  speed: 0xffe14d,
  heavy: 0xa0a8b8,
  damage: 0xff4d5e,
  jump: 0xffffff,
};
