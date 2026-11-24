/**
 * Palettes per theme: the sky and hills, and each material's color (the debris of broken cells). Since #94 they are
 * the themes' data (src/sim/themes.ts, `look`); the terrain itself is plush art per theme (#92, level-art.ts).
 */
import { contrast, fromOklch, oklch } from "../sim/color";
import { ALL_THEMES, MAT_NAMES, THEME_DEFS, themeMatColors, type MatName, type Theme } from "../sim/themes";

export interface Palette {
  sky: [number, number];
  hills: [number, number];
  /** the backdrop (#111: "beach" draws the sun, clouds, island and sea from the theme's atlas; #114: "forest" a moon and pines) */
  background: "hills" | "beach" | "forest";
  /** Mat ID -> color */
  mat: Record<number, number>;
}

function palette(t: Theme): Palette {
  const look = THEME_DEFS[t].look;
  const colors = themeMatColors(t);
  const mat: Record<number, number> = {};
  MAT_NAMES.forEach((n, id) => {
    if (n) mat[id] = colors[n as MatName];
  });
  return { sky: [...look.sky] as [number, number], hills: [...look.hills] as [number, number], background: look.background, mat };
}

export const PALETTES: Record<Theme, Palette> = Object.fromEntries(ALL_THEMES.map((t) => [t, palette(t)])) as Record<Theme, Palette>;

/** #94: each liquid's color (splashes, the fallback before its art loads), by grid.ts Liquid. */
export const LIQUID_COLOR: readonly number[] = [0, 0x3d93dc, 0x2c2240, 0xe2481a, 0x6ad83a];

export function shade(color: number, k: number): number {
  const r = Math.min(255, Math.max(0, ((color >> 16) & 255) * k));
  const g = Math.min(255, Math.max(0, ((color >> 8) & 255) * k));
  const b = Math.min(255, Math.max(0, (color & 255) * k));
  return ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
}

export const WEAPON_ACCENT = {
  mine: 0xf763aa,
  railgun: 0x68dcff,
  hammer: 0xffb34d,
  /** precision weapons (#38): rifle tracer, sniper laser and round, crossbow fletching */
  rifle: 0xffe28a,
  sniper: 0xff3b4e,
  crossbow: 0x9cff6b,
  /** the lightning sword (#72): the blade's glow, the bolt and the live ground */
  lightning: 0xb08cff,
} as const;

export const POWER_COLOR: Record<string, number> = {
  health: 0x7dffa0,
  shield: 0x6ee7ff,
  speed: 0xffe14d,
  heavy: 0xa0a8b8,
  damage: 0xff4d5e,
  jump: 0xffffff,
  jetpack: 0x60f4d1,
};

/** Light page grounds the name ink is checked against (none in the game today: websites, light themes, printed sheets). */
export const LIGHT_GROUNDS = [0xffffff, 0xeef0f6] as const;

/**
 * A fighter's name color for a light ground (art-sheet fix 5): identity
 * colors are tuned for the dark arenas and all fall below 3:1 as text on
 * white. This keeps the hue and as much chroma as fits, and lowers OKLCH
 * lightness until the name reaches 4.5:1 on every light ground. On dark
 * grounds (the game) the identity color is used as it is.
 */
export function nameInk(color: number, ground: "light" | "dark" = "light"): number {
  if (ground === "dark") return color;
  const p = oklch(color);
  let L = Math.min(p.L, 0.56);
  let c = fromOklch({ L, C: p.C, h: p.h });
  while (L > 0.2 && LIGHT_GROUNDS.some((g) => contrast(c, g) < 4.5)) {
    L -= 0.01;
    c = fromOklch({ L, C: p.C, h: p.h });
  }
  return c;
}
