/**
 * Perceptual color math (OKLab / OKLCH, Björn Ottosson 2020) for fighter
 * identities and the bot drawing. Pure and display-only: nothing here touches
 * the simulation state.
 */

const toLin = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const toByte = (v: number) => {
  const x = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, x)) * 255);
};

export type Lab = [L: number, a: number, b: number];

/** 0xrrggbb to OKLab. */
export function oklab(c: number): Lab {
  const r = toLin((c >> 16) & 255), g = toLin((c >> 8) & 255), b = toLin(c & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab to linear sRGB (may be out of gamut). */
function labToLinear([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** Perceptual distance between two colors (OKLab Euclidean; about 0.02 is just noticeable). */
export function oklabDistance(x: number, y: number): number {
  const a = oklab(x), b = oklab(y);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export interface Lch {
  L: number;
  C: number;
  h: number;
}

export function oklch(c: number): Lch {
  const [L, a, b] = oklab(c);
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

/** OKLCH to 0xrrggbb; out-of-gamut colors keep L and h and lose chroma until they fit. */
export function fromOklch({ L, C, h }: Lch): number {
  const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let lo = 0, hi = C;
  let rgb = labToLinear([L, C * Math.cos(h), C * Math.sin(h)]);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(labToLinear([L, mid * Math.cos(h), mid * Math.sin(h)]))) lo = mid;
      else hi = mid;
    }
    rgb = labToLinear([L, lo * Math.cos(h), lo * Math.sin(h)]);
  }
  return (toByte(rgb[0]) << 16) | (toByte(rgb[1]) << 8) | toByte(rgb[2]);
}

/** WCAG relative luminance of 0xrrggbb. */
export function luminance(c: number): number {
  return 0.2126 * toLin((c >> 16) & 255) + 0.7152 * toLin((c >> 8) & 255) + 0.0722 * toLin(c & 255);
}

/** WCAG contrast ratio. */
export function contrast(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
