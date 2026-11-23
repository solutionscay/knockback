// Art trial (#85): the plush bot's gradient map keeps a color's hue in shade (yellow never goes olive).
import { expect, test } from "bun:test";
import { oklch } from "../src/sim/color";
import { hsl } from "../src/sim/identity";
import { plushRamp } from "../src/viewer/plush-ramp";

const deg = (c: number) => ((oklch(c).h * 180) / Math.PI + 360) % 360;

test("the ramp runs dark to light and the lit stop is the color itself", () => {
  for (let h = 0; h < 360; h += 30) {
    const c = hsl(h, 0.8, 0.6);
    const r = plushRamp(c);
    expect(r[2]).toBe(c);
    const L = r.map((x) => oklch(x).L);
    expect(L[0]!).toBeLessThan(L[1]!);
    expect(L[1]!).toBeLessThan(L[2]!);
    expect(L[2]!).toBeLessThan(L[3]! + 1e-6);
  }
});

test("yellow shadows turn warm (toward orange), not olive; other hues keep their hue", () => {
  const yellow = hsl(52, 0.85, 0.58);
  const [, shadow] = plushRamp(yellow);
  expect(deg(shadow)).toBeLessThan(deg(yellow) - 8); // toward orange (lower OKLCH hue), away from olive (higher)
  expect(oklch(shadow).C).toBeGreaterThan(0.08); // still saturated
  const blue = hsl(220, 0.8, 0.62);
  expect(Math.abs(deg(plushRamp(blue)[1]) - deg(blue))).toBeLessThan(4);
});
