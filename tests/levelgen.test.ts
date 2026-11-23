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
    // #100: generated pits are rare (themes.ts), so most levels changed
    expect(summary(CLASSIC)).toEqual([
      "junkyard/2/b1965910",
      "rooftop/1/4f2e6b56",
      "rooftop/0/5380c99b",
      "junkyard/0/5fd2a985",
      "junkyard/0/35a598e8",
      "warehouse/0/5b969fb4",
      "warehouse/0/7acfdcd4",
      "construction/0/67e4eaa3",
      "construction/1/6e2368f9",
      "warehouse/0/7ebf7587",
      "construction/0/a8ea1442",
      "junkyard/0/60563570",
      "junkyard/0/606d4608",
      "junkyard/0/0a36fd46",
      "construction/2/94f4d10c",
      "rooftop/1/e762aced",
      "warehouse/1/17f2724b",
      "warehouse/1/8306828c",
      "construction/6/f8af3279",
      "warehouse/2/08efb9fd",
      "rooftop/0/fb60ac3a",
      "junkyard/0/1ec26277",
      "junkyard/2/ff5cb984",
      "warehouse/5/8f90231c",
    ]);
    expect(summary(CLOSE_QUARTERS)).toEqual([
      "junkyard/3/72b4b6a6",
      "rooftop/2/e5b1b5c8",
      "rooftop/1/a1261398",
      "junkyard/2/744ea63c",
      "junkyard/0/a6909484",
      "warehouse/4/8881a199",
      "warehouse/5/8319afb9",
      "construction/0/1a11e804",
      "construction/5/a1016328",
      "warehouse/4/627549d8",
      "construction/2/fd276ac2",
      "junkyard/4/e3851160",
      "junkyard/0/48aff8e5",
      "junkyard/4/8b92424c",
      "construction/2/1e18df8c",
      "rooftop/0/00c7b2d9",
      "warehouse/0/778498ab",
      "warehouse/0/045afe91",
      "construction/0/40654848",
      "warehouse/3/8cb4430e",
      "rooftop/0/670e47a0",
      "junkyard/4/3d7b3d8a",
      "junkyard/0/9e9b8e59",
      "warehouse/7/8846a7f2",
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
