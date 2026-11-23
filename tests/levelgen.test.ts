/**
 * Contract: level generation. A seed (stored in the match record) always gives the same level, and the generator only
 * returns a level that passes validation, retrying with the next attempt number until one does.
 *
 * The fingerprints below move only when the generator, its validation or the ruleset's arena data change on purpose.
 */
import { describe, expect, test } from "bun:test";
import { CLASSIC, CLOSE_QUARTERS, generateLevel, Mat, NavGraph, validateLevel, type LevelDef, type Ruleset } from "../src/sim";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

/** FNV-1a over everything a level is made of. */
function fingerprint(lv: LevelDef): string {
  let h = 0x811c9dc5;
  const mix = (b: number) => {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const b of lv.grid.mat) mix(b);
  for (const b of lv.grid.flags) mix(b);
  for (const ch of JSON.stringify({ ...lv, grid: null })) mix(ch.charCodeAt(0));
  return h.toString(16).padStart(8, "0");
}

const levels = (ruleset: Ruleset) => SEEDS.map((seed) => generateLevel(seed, undefined, ruleset));

describe("level generation", () => {
  test("golden levels: theme, attempt and fingerprint per seed", () => {
    const summary = (ruleset: Ruleset) => levels(ruleset).map((lv) => `${lv.theme}/${lv.attempt}/${fingerprint(lv)}`);
    // #100: the stage (one gap with a catwalk, jump-through platforms, soft over hard ground): every level changed
    expect(summary(CLASSIC)).toEqual([
      "junkyard/0/57f7b54e",
      "rooftop/1/f7287435",
      "rooftop/0/ab4f3adb",
      "junkyard/0/4d29a085",
      "junkyard/0/e861d1d9",
      "warehouse/0/5dac12fd",
      "warehouse/1/1e2a2414",
      "construction/5/6e0cb299",
      "construction/0/5ed96ddf",
      "warehouse/1/c90f8b2c",
      "construction/0/76335f31",
      "junkyard/0/b7c8ed5f",
      "junkyard/0/8fc10205",
      "junkyard/1/ac5e1a1a",
      "construction/0/073aaf11",
      "rooftop/1/0846e57f",
      "warehouse/2/337cfbbb",
      "warehouse/0/49378237",
      "construction/0/1f95c81a",
      "warehouse/2/d40c9187",
      "rooftop/0/d229b012",
      "junkyard/0/339cb873",
      "junkyard/0/e9bb02c7",
      "warehouse/1/e16896df",
    ]);
    expect(summary(CLOSE_QUARTERS)).toEqual([
      "junkyard/0/71079647",
      "rooftop/3/4b74f8f7",
      "rooftop/0/250465ad",
      "junkyard/0/d4a27815",
      "junkyard/0/a01f9bd2",
      "warehouse/1/fa66af04",
      "warehouse/1/9c32bdef",
      "construction/1/7bdf4696",
      "construction/1/a5be1c3c",
      "warehouse/5/8644a1fd",
      "construction/2/a4a19016",
      "junkyard/2/195d3648",
      "junkyard/0/0bc20115",
      "junkyard/0/54026c7f",
      "construction/1/34e96e44",
      "rooftop/2/86b24a68",
      "warehouse/0/867a26d6",
      "warehouse/0/2bb00c6e",
      "construction/0/b3066dec",
      "warehouse/2/76d57405",
      "rooftop/1/61b0fed0",
      "junkyard/1/2dde76ca",
      "junkyard/0/c7aa2f19",
      "warehouse/5/fec54927",
    ]);
  });

  test("every Classic level passes its own validation", () => {
    for (const lv of levels(CLASSIC)) expect(validateLevel(lv)).toEqual({ ok: true, reasons: [] });
  });

  test("validation names each defect", () => {
    const lv = generateLevel(1);
    const reasons = (change: Partial<LevelDef>) => validateLevel({ ...lv, ...change }).reasons;
    expect(reasons({ width: 10 })).toContain("width 10");
    expect(reasons({ spawns: lv.spawns.slice(1) })).toContain("spawns 3");
    expect(reasons({ spawns: [{ x: lv.maxX + 20, y: 0 }, ...lv.spawns.slice(1)] })).toContain("spawn off a surface");
    expect(reasons({ props: lv.props.filter((p) => p.kind !== "block") })).toContain("cover 0");
    expect(reasons({ props: [] })).toContain("props 0");
    expect(reasons({ platforms: 0 })).toContain("platforms 0");
    expect(reasons({ zoneCenter: 1000 })).toContain("no drop near the center");
    const tall = lv.grid.clone();
    tall.set(3, tall.rows - 1, Mat.Concrete);
    expect(reasons({ grid: tall })).toContain("too tall");
  });

  test("validation names each spawn and wall defect", () => {
    const lv = generateLevel(1);
    const reasons = (change: Partial<LevelDef>, ruleset: Ruleset = CLASSIC) => validateLevel({ ...lv, ...change }, ruleset).reasons;
    const [first, ...rest] = lv.spawns as [{ x: number; y: number }, ...{ x: number; y: number }[]];
    // a shaft dug down to the bedrock under the first spawn
    const pit = lv.grid.clone();
    const cx = pit.cx(first.x);
    pit.fillRect(cx - 4, CLASSIC.arena.layout.bedrockRows, cx + 4, pit.rows - 1, Mat.Empty);
    expect(reasons({ grid: pit, spawns: [{ x: first.x, y: pit.wy(CLASSIC.arena.layout.bedrockRows) }, ...rest] })).toContain("spawn in a pit");
    const ledge = NavGraph.fromGrid(lv.grid, 2, CLASSIC).surfaces.find((s) => s.dropLeft && s.x1 - s.x0 > 3)!;
    expect(reasons({ spawns: [{ x: ledge.x0 + 0.25, y: ledge.y }, ...rest] })).toContain("spawn at a drop");
    // Classic spreads its spawns over the arena; Close Quarters keeps them together
    expect(reasons({}, CLOSE_QUARTERS)).toContain("spawns too spread");
    expect(reasons({ spawns: generateLevel(1, undefined, CLOSE_QUARTERS).spawns })).toContain("need one spawn per arena quarter");
    // something solid over a wall's cap: no way over it
    const wall = lv.walls![0]!;
    const capped = lv.grid.clone();
    capped.set(capped.cx(wall.x0), capped.cy(wall.top + 0.25), Mat.Concrete);
    expect(reasons({ grid: capped })).toContain(`wall at ${wall.x0} has no route`);
  });
});
