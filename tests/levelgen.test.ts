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
    expect(summary(CLASSIC)).toEqual([
      "beach/2/fcd32b74",
      "construction/3/d340c1e5",
      "junkyard/0/e90a4beb",
      "construction/0/4d0aa786",
      "construction/0/8f1c5d4a",
      "beach/0/6dac47bf",
      "construction/1/58ceb2ab",
      "warehouse/1/0bffe741",
      "rooftop/0/cf11f31d",
      "warehouse/1/c90f8b2c",
      "rooftop/1/f7da5844",
      "junkyard/0/b7c8ed5f",
      "rooftop/1/75fc383c",
      "beach/1/f1110776",
      "junkyard/0/357e8af4",
      "rooftop/1/0846e57f",
      "rooftop/0/ce9bfe98",
      "warehouse/0/49378237",
      "rooftop/1/d2858db8",
      "construction/0/7eb7c2cf",
      "beach/0/91ce8992",
      "junkyard/0/339cb873",
      "beach/0/1c5bfe64",
      "beach/1/ff92b961",
    ]);
    expect(summary(CLOSE_QUARTERS)).toEqual([
      "beach/2/c198de74",
      "construction/3/5e7a60c6",
      "junkyard/0/9b8900d8",
      "construction/0/03783d54",
      "construction/4/1ac9c1ba",
      "beach/4/3c6d6b77",
      "construction/2/47827696",
      "warehouse/4/142dd299",
      "rooftop/0/5d784fae",
      "warehouse/5/8644a1fd",
      "rooftop/1/6dc13891",
      "junkyard/2/195d3648",
      "rooftop/4/cc3e325c",
      "beach/0/ef961e4a",
      "junkyard/0/48724bbc",
      "rooftop/2/86b24a68",
      "rooftop/3/cfbb9d53",
      "warehouse/0/2bb00c6e",
      "rooftop/1/43125613",
      "construction/0/de8e55b4",
      "beach/3/c9b4d2af",
      "junkyard/1/2dde76ca",
      "beach/2/743f9349",
      "beach/1/50dd1820",
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
