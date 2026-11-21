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
    expect(summary(CLASSIC)).toEqual([
      "junkyard/0/370282a2",
      "rooftop/8/154acd7d",
      "rooftop/0/4fb83536",
      "junkyard/0/5fd2a985",
      "junkyard/0/dfab8d0c",
      "warehouse/0/0cdb0ddf",
      "warehouse/0/2b42d207",
      "construction/6/cd90d10d",
      "construction/4/19d5838c",
      "warehouse/1/e4029b57",
      "construction/12/f0907b4d",
      "junkyard/0/60563570",
      "junkyard/0/cdcdf4a6",
      "junkyard/3/c57f214f",
      "construction/0/c0aa4a0b",
      "rooftop/0/d8b78675",
      "warehouse/0/ce73dd97",
      "warehouse/5/fda5c1de",
      "construction/1/fd369398",
      "warehouse/2/07cfc0d4",
      "rooftop/2/ae35dbfb",
      "junkyard/0/89dd0dba",
      "junkyard/3/77afc1f7",
      "warehouse/4/f0519923",
    ]);
    expect(summary(CLOSE_QUARTERS)).toEqual([
      "junkyard/15/58ee2d54",
      "rooftop/11/58950cce",
      "rooftop/4/eb4dc5fc",
      "junkyard/2/37aaf7d0",
      "junkyard/1/1b245067",
      "warehouse/0/afc15a0a",
      "warehouse/5/a96a2e9a",
      "construction/1/bba60b1f",
      "construction/4/34c04f7d",
      "warehouse/2/7cc745db",
      "construction/12/c4ed38a1",
      "junkyard/7/a4cc6faa",
      "junkyard/9/f4cd7cc0",
      "junkyard/4/8b92424c",
      "construction/3/9da44794",
      "rooftop/5/eba30150",
      "warehouse/1/067f2ab0",
      "warehouse/0/a694f6dd",
      "construction/7/22016986",
      "warehouse/1/0f9d4679",
      "rooftop/0/34bc3178",
      "junkyard/0/99f023cf",
      "junkyard/4/2bfc08c1",
      "warehouse/6/b6afe7d6",
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
