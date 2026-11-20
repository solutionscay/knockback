import { describe, expect, test } from "bun:test";
import { contrast, darkenKeepChroma, fromOklch, oklab, oklabDistance, oklch } from "../src/sim/color";
import { generateIdentities } from "../src/sim/identity";
import { LIGHT_GROUNDS, nameInk } from "../src/viewer/palette";

describe("OKLab / OKLCH color math", () => {
  test("round trip and reference values", () => {
    expect(oklab(0xffffff)[0]).toBeCloseTo(1, 3);
    expect(oklab(0x000000)[0]).toBeCloseTo(0, 3);
    for (const c of [0xff4f4f, 0x47a3ff, 0x4fdc6a, 0xffc733, 0x8a9bff, 0x123456]) expect(fromOklch(oklch(c))).toBe(c);
    expect(oklabDistance(0xff0000, 0xff0000)).toBe(0);
    expect(oklabDistance(0xff0000, 0x00ff00)).toBeGreaterThan(0.3);
  });
  test("darkening keeps hue and chroma, stays in gamut", () => {
    const y = 0xe2ca5d, d = darkenKeepChroma(y, 0.17);
    expect(oklch(d).L).toBeCloseTo(oklch(y).L - 0.17, 2);
    expect(Math.abs(oklch(d).C - oklch(y).C)).toBeLessThan(0.02);
    expect(Math.abs(oklch(d).h - oklch(y).h)).toBeLessThan(0.05);
    expect(darkenKeepChroma(0x00ff00, 0.5)).toBeGreaterThanOrEqual(0);
  });
  test("contrast ratio", () => {
    expect(contrast(0xffffff, 0x000000)).toBeCloseTo(21, 0);
    expect(contrast(0x777777, 0x777777)).toBe(1);
  });
  test("name ink for light grounds: 4.5:1 on every light ground, same hue; the dark ground keeps the color", () => {
    for (let s = 0; s < 400; s++)
      for (const id of generateIdentities(s)) {
        const ink = nameInk(id.color);
        for (const g of LIGHT_GROUNDS) expect(contrast(ink, g)).toBeGreaterThanOrEqual(4.5);
        const d = Math.abs(oklch(ink).h - oklch(id.color).h);
        expect(Math.min(d, 2 * Math.PI - d)).toBeLessThan(0.2);
        expect(nameInk(id.color, "dark")).toBe(id.color);
      }
  });
});
