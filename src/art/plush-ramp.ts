/**
 * The plush bot's gradient map (plush-bot.ts rampFilter). The suit is rendered neutral grey; its
 * luminance maps onto four colors made from the fighter's color, so a color keeps its hue in shade.
 */
import { fromOklch, oklch } from "../sim/color";

/** Luminance stops of the neutral render: deep shadow, shadow, the lit suit (median), the highlight. */
export const RAMP_STOPS = [0.38, 0.68, 0.8] as const;

/**
 * The four colors the neutral suit's luminance maps onto, from the fighter's color: a deep shadow, a shadow, the
 * color itself on the lit suit, a highlight. Darker in OKLCH lightness keeping the chroma; yellows and limes turn
 * toward orange in shade (a warm shadow), never toward olive. Every other hue keeps its hue.
 */
export function plushRamp(color: number): [number, number, number, number] {
  const p = oklch(color);
  const deg = ((p.h * 180) / Math.PI + 360) % 360;
  // yellow is about 110 degrees in OKLCH, lime 125, orange 60: pull those shadows toward orange
  const pull = deg > 70 && deg < 145 ? Math.min(24, (deg - 60) * 0.4) : 0;
  const hue = (dDeg: number) => p.h - (dDeg * Math.PI) / 180;
  return [
    fromOklch({ L: Math.max(0.12, p.L * 0.38), C: p.C * 0.75, h: hue(pull * 1.3) }),
    fromOklch({ L: Math.max(0.2, p.L - 0.2), C: p.C * 1.05, h: hue(pull) }),
    color,
    fromOklch({ L: Math.min(0.97, p.L + 0.09), C: p.C * 0.8, h: p.h }),
  ];
}

