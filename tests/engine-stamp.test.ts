/**
 * The engine stamp covers every map (#88, #146): one reference round per theme in the registry, each forced to its
 * theme and long enough for its liquids and physics to play. A change that touches one map only moves the stamp.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLASSIC, initPhysics, type Ruleset } from "../src/sim";
import { engineStamp, referenceHash, referenceRounds, stampOf } from "../src/sim/engine";
import { generateLevel } from "../src/sim/levelgen";
import { ALL_THEMES, THEMES, type Theme } from "../src/sim/themes";

beforeAll(async () => {
  await initPhysics();
});

/** CLASSIC with one theme's rules changed. */
function retheme(t: Theme, change: (r: Ruleset["arena"]["themes"][Theme]) => Ruleset["arena"]["themes"][Theme]): Ruleset {
  return { ...CLASSIC, arena: { ...CLASSIC.arena, themes: { ...CLASSIC.arena.themes, [t]: change(CLASSIC.arena.themes[t]) } } };
}

describe("engine stamp on every map", () => {
  const hashes = {} as Record<Theme, string>;

  test("every theme in the registry (and so every map in the rotation) has a reference round that plays on it", () => {
    for (const t of THEMES) expect(ALL_THEMES).toContain(t);
    const one: Ruleset = { ...CLASSIC, round: { ...CLASSIC.round, maxRounds: 1, winsToTake: 1 } };
    for (const t of ALL_THEMES) {
      const f = referenceRounds()[t];
      expect(f.level.theme).toBe(t);
      expect(f.ticks).toBeGreaterThanOrEqual(20 * 60); // a whole round: liquids flow, fighters fall in, low gravity plays
      // a theme with pools has them on its reference map
      const lv = generateLevel(f.seed, undefined, { ...one, arena: { ...one.arena, enabledThemes: [t] } });
      expect(lv.theme).toBe(t);
      if (CLASSIC.arena.themes[t].hazards.pools[0] > 0) expect(lv.pools?.length ?? 0).toBeGreaterThan(0);
      hashes[t] = f.finalHash;
    }
    expect(Object.keys(hashes)).toEqual([...ALL_THEMES]);
    expect(engineStamp()).toBe(stampOf(hashes));
    expect(engineStamp()).toMatch(/^e-[0-9a-f]{8}$/);
  });

  test("a change to one map only moves its reference round and the stamp, not the other maps' rounds", () => {
    // low gravity on the space map, a little lower
    const space = retheme("space", (r) => ({ ...r, physics: { ...r.physics, gravity: r.physics.gravity * 0.9 } }));
    const moved = referenceHash("space", space);
    expect(moved).not.toBe(hashes.space);
    expect(referenceHash("warehouse", space)).toBe(hashes.warehouse);
    expect(stampOf({ ...hashes, space: moved })).not.toBe(engineStamp());

    // the beach's water pools, a cell deeper
    const beach = retheme("beach", (r) => ({ ...r, hazards: { ...r.hazards, depth: [r.hazards.depth[0] + 1, r.hazards.depth[1] + 1] } }));
    const wet = referenceHash("beach", beach);
    expect(wet).not.toBe(hashes.beach);
    expect(stampOf({ ...hashes, beach: wet })).not.toBe(engineStamp());
  });

  test("the stamp folds every theme's hash: any one moving moves it", () => {
    for (const t of ALL_THEMES) expect(stampOf({ ...hashes, [t]: "00000000" })).not.toBe(stampOf(hashes));
  });
});
