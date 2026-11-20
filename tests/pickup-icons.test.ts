import { describe, expect, test } from "bun:test";
import type { Graphics } from "pixi.js";
import { ITEM } from "../src/sim/constants";
import { POWER_LIST, WEAPON_LIST } from "../src/sim/sim-types";
import { drawPickup, PICKUP_R } from "../src/viewer/props";

/** A Graphics stand-in that records every call, so the drawing can be checked without a renderer. */
function recorder() {
  const calls: string[] = [];
  const g: any = new Proxy({}, {
    get: (_t, k: string) => (...args: unknown[]) => {
      calls.push(`${k}(${JSON.stringify(args.map((a) => (typeof a === "number" ? Math.round(a * 1000) / 1000 : a)))})`);
      return g;
    },
  });
  return { g: g as Graphics, calls };
}

const WEAPONS = WEAPON_LIST;

describe("pickup icons (#15)", () => {
  test("the badge is at least twice the 0.5 m physics box, which stays unchanged", () => {
    expect(ITEM.size).toBe(0.5);
    expect(PICKUP_R * 2).toBeGreaterThanOrEqual(ITEM.size * 2);
  });

  test("every weapon and power-up draws its own icon", () => {
    const sigs = new Map<string, string>();
    for (const it of [...WEAPONS, ...POWER_LIST]) {
      const { g, calls } = recorder();
      drawPickup(g, it, 0);
      // badge (glow, rim, disc) plus at least two icon shapes
      expect(calls.filter((c) => /^(poly|circle|roundRect|rect|moveTo)\(/.test(c)).length).toBeGreaterThanOrEqual(5);
      sigs.set(it, calls.join(";"));
    }
    expect(new Set(sigs.values()).size).toBe(WEAPONS.length + POWER_LIST.length);
  });

  test("weapons and power-ups use different badges", () => {
    const w = recorder();
    drawPickup(w.g, "rocket", 0);
    const p = recorder();
    drawPickup(p.g, "health", 0);
    expect(w.calls.slice(0, 4).join()).not.toBe(p.calls.slice(0, 4).join());
  });
});
