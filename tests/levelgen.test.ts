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
    // #111: the beach joins the rotation: seeds pick their theme from five (a seed that keeps its theme keeps its level)
    // #114: the forest joins it: seeds pick from six (every other theme's levels are bit-identical when forced to it)
    // #125: the cave joins: seeds pick from seven (again, a seed that keeps its theme keeps its level)
    // #127: space joins: seeds pick from eight (again, a seed that keeps its theme keeps its level)
    expect(summary(CLASSIC)).toEqual([
      "junkyard/0/57f7b54e",
      "rooftop/1/f7287435",
      "rooftop/0/ab4f3adb",
      "cave/0/0e4533d6",
      "cave/0/b878c384",
      "warehouse/0/5dac12fd",
      "warehouse/1/1e2a2414",
      "construction/5/6e0cb299",
      "construction/0/5ed96ddf",
      "warehouse/1/c90f8b2c",
      "space/0/a13f266f",
      "junkyard/0/b7c8ed5f",
      "cave/8/6e431863",
      "cave/0/4959ea05",
      "construction/0/073aaf11",
      "forest/0/a713fda5",
      "warehouse/2/337cfbbb",
      "beach/0/2389a1e2",
      "space/0/4cbf2556",
      "warehouse/2/d40c9187",
      "rooftop/0/d229b012",
      "cave/2/8080d4be",
      "junkyard/0/e9bb02c7",
      "warehouse/1/e16896df",
    ]);
    expect(summary(CLOSE_QUARTERS)).toEqual([
      "junkyard/0/71079647",
      "rooftop/3/4b74f8f7",
      "rooftop/0/250465ad",
      "cave/0/e9302f4c",
      "cave/1/14ca6597",
      "warehouse/1/fa66af04",
      "warehouse/1/9c32bdef",
      "construction/1/7bdf4696",
      "construction/1/a5be1c3c",
      "warehouse/5/8644a1fd",
      "space/0/2bf8522f",
      "junkyard/2/195d3648",
      "cave/1/794e8fdc",
      "cave/0/e35b214f",
      "construction/1/34e96e44",
      "forest/1/6bc9c412",
      "warehouse/0/867a26d6",
      "beach/0/6f05e74e",
      "space/2/97aaf668",
      "warehouse/2/76d57405",
      "rooftop/1/61b0fed0",
      "cave/1/416583d8",
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
