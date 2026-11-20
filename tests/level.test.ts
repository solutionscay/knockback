import { describe, expect, test } from "bun:test";
import { CELL, Mat } from "../src/sim/grid";
import { generateLevel, THEMES, themeFor, validateLevel, type LevelDef } from "../src/sim/levelgen";
import { NavGraph } from "../src/sim/nav";

const sig = (lv: LevelDef) =>
  JSON.stringify({ t: lv.theme, w: lv.width, a: lv.attempt, p: lv.props, s: lv.spawns, z: lv.zoneCenter }) + Buffer.from(lv.grid.mat).toString("base64") + Buffer.from(lv.grid.flags).toString("base64");

describe("level generator", () => {
  test("same seed, same level (many seeds)", () => {
    for (let seed = 1; seed <= 60; seed++) expect(sig(generateLevel(seed))).toBe(sig(generateLevel(seed)));
  });

  test("different seeds give different levels", () => {
    const set = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) set.add(sig(generateLevel(seed)));
    expect(set.size).toBe(40);
  });

  test("every level passes validation (300 seeds)", () => {
    let worst = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const lv = generateLevel(seed);
      const v = validateLevel(lv);
      if (!v.ok) throw new Error(`seed ${seed}: ${v.reasons.join(", ")}`);
      worst = Math.max(worst, lv.attempt);
    }
    expect(worst).toBeLessThan(30);
  });

  test("validation: 4 spawns close together, on solid ground, all connected", () => {
    for (let seed = 100; seed < 140; seed++) {
      const lv = generateLevel(seed);
      expect(lv.spawns.length).toBe(4);
      const xs = lv.spawns.map((s) => s.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(24);
      const nav = NavGraph.fromGrid(lv.grid);
      const surf = lv.spawns.map((s) => nav.surfaceAt(s.x, s.y + 0.05, 0)!);
      for (const s of surf) expect(s).toBeTruthy();
      for (let i = 0; i < 4; i++) {
        const plan = nav.plan(surf[i]!.id, lv.spawns[i]!.x);
        for (let j = 0; j < 4; j++) expect(plan.cost[surf[j]!.id]!).toBeLessThan(Infinity);
      }
      // the cell under each spawn is solid (not a pit)
      for (const s of lv.spawns) expect(lv.grid.solidAt(s.x, s.y - CELL / 2)).toBe(true);
    }
  });

  test("generated walls have open approaches and links across the cap", () => {
    const lv = generateLevel(1);
    const wall = lv.walls![0]!;
    expect(wall.top - wall.y).toBeLessThanOrEqual(2);
    expect(validateLevel(lv).ok).toBe(true);
    const blocked = lv.grid.clone();
    blocked.set(blocked.cx(wall.x0 - 0.25), blocked.cy(wall.y), Mat.Concrete);
    expect(validateLevel({ ...lv, grid: blocked }).reasons).toContain(`wall at ${wall.x0} has no route`);
  });

  test("levels fit the camera and have many platforms, cover and props", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const lv = generateLevel(seed);
      expect(lv.width).toBeGreaterThanOrEqual(56);
      expect(lv.width).toBeLessThanOrEqual(76);
      expect(lv.platforms).toBeGreaterThanOrEqual(7);
      expect(lv.props.filter((p) => p.kind === "block").length).toBeGreaterThanOrEqual(6);
      expect(lv.props.length).toBeGreaterThanOrEqual(18);
      for (let cy = lv.grid.cy(13.01); cy < lv.grid.rows; cy++) for (let cx = 0; cx < lv.grid.cols; cx++) expect(lv.grid.solid(cx, cy)).toBe(false);
    }
  });

  test("only the bottom rows are bedrock (~10% of solid cells)", () => {
    let solid = 0;
    let bed = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const g = generateLevel(seed).grid;
      solid += g.countSolid();
      bed += g.countMat(Mat.Bedrock);
      for (let cy = 2; cy < g.rows; cy++) for (let cx = 0; cx < g.cols; cx++) expect(g.matAt(cx, cy)).not.toBe(Mat.Bedrock);
    }
    expect(bed / solid).toBeGreaterThan(0.05);
    expect(bed / solid).toBeLessThan(0.15);
  });

  test("themes change the prop mix", () => {
    const count: Record<string, Record<string, number>> = {};
    const n: Record<string, number> = {};
    for (let seed = 1; seed <= 200; seed++) {
      const lv = generateLevel(seed);
      n[lv.theme] = (n[lv.theme] ?? 0) + 1;
      count[lv.theme] ??= {};
      for (const p of lv.props) count[lv.theme]![p.kind] = (count[lv.theme]![p.kind] ?? 0) + 1;
    }
    for (const t of THEMES) expect(n[t]).toBeGreaterThan(20);
    const per = (t: string, k: string) => (count[t]![k] ?? 0) / n[t]!;
    expect(per("junkyard", "barrel")).toBeGreaterThan(per("rooftop", "barrel"));
    expect(per("rooftop", "glass")).toBeGreaterThan(per("junkyard", "glass"));
    expect(per("construction", "tnt")).toBeGreaterThan(per("warehouse", "tnt"));
    expect(per("warehouse", "crate")).toBeGreaterThan(per("junkyard", "crate"));
    expect(themeFor(7)).toBe(generateLevel(7).theme);
  });
});
