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
    expect(summary(CLASSIC)).toEqual([
      "rooftop/0/271be477",
      "forest/1/d9f5549c",
      "construction/5/14df6d3a",
      "forest/1/00b569e3",
      "cave/0/b878c384",
      "forest/0/d2979231",
      "cave/1/38b7dcaa",
      "forest/0/29f8d830",
      "forest/1/f8a61b60",
      "cave/0/9eadf872",
      "warehouse/0/6b6a24c1",
      "junkyard/0/b7c8ed5f",
      "warehouse/0/f26d3e89",
      "cave/0/4959ea05",
      "beach/0/8316716f",
      "junkyard/1/e567c8f4",
      "construction/1/cd460a77",
      "warehouse/0/49378237",
      "junkyard/1/2f69d4b3",
      "junkyard/0/4ab12ead",
      "cave/1/3292167b",
      "forest/2/44216b07",
      "construction/0/cd0bd8c6",
      "rooftop/0/22711fc7",
    ]);
    expect(summary(CLOSE_QUARTERS)).toEqual([
      "rooftop/3/d861fcfd",
      "forest/1/bf607c1f",
      "construction/1/bfe27f51",
      "forest/0/4fccb714",
      "cave/1/14ca6597",
      "forest/0/982d6775",
      "cave/4/34ec2156",
      "forest/2/e43c5733",
      "forest/1/46e7f3e8",
      "cave/1/53cd234c",
      "warehouse/2/e858dd58",
      "junkyard/2/195d3648",
      "warehouse/4/2c537df2",
      "cave/0/e35b214f",
      "beach/2/1b5cf7ca",
      "junkyard/2/ecff2a7c",
      "construction/0/b024a317",
      "warehouse/0/2bb00c6e",
      "junkyard/5/c2ad8b21",
      "junkyard/0/dfbfab9b",
      "cave/2/814deefd",
      "forest/0/5db7473b",
      "construction/1/35243527",
      "rooftop/4/99b94122",
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
