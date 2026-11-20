import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assignIdentities,
  EYES,
  Fight,
  generateIdentities,
  hueLight,
  initPhysics,
  legacyIdentities,
  luminance,
  MARKS,
  Match,
  MIN_HUE_GAP,
  NAME_MAX,
  NAME_POOL_SIZE,
  SHAPES,
  validName,
} from "../src/sim";
import { PALETTES } from "../src/viewer/palette";

beforeAll(async () => {
  await initPhysics();
});

const hueGap = (a: number, b: number) => {
  const d = Math.abs(hueLight(a).h - hueLight(b).h);
  return Math.min(d, 360 - d);
};
const contrast = (a: number, b: number) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("generated identities (#17)", () => {
  test("the pools are big enough", () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(16);
    expect(EYES.length).toBeGreaterThanOrEqual(8);
    expect(MARKS.length).toBeGreaterThanOrEqual(12);
    expect(NAME_POOL_SIZE).toBeGreaterThanOrEqual(400);
    expect(new Set(SHAPES).size).toBe(SHAPES.length);
    expect(new Set(MARKS).size).toBe(MARKS.length);
  });

  test("the same seed gives the same identities; different seeds give different ones", () => {
    expect(generateIdentities(42)).toEqual(generateIdentities(42));
    expect(new Match(42).identities).toEqual(generateIdentities(42));
    const a = generateIdentities(1), b = generateIdentities(2);
    expect(a.map((i) => i.name)).not.toEqual(b.map((i) => i.name));
    expect(a.map((i) => i.shape)).not.toEqual(b.map((i) => i.shape));
    expect(a.map((i) => i.color)).not.toEqual(b.map((i) => i.color));
    // over many seeds the four seats see many different looks
    const seen = { name: new Set<string>(), shape: new Set<string>(), mark: new Set<string>(), eyes: new Set<string>() };
    for (let s = 0; s < 300; s++) for (const id of generateIdentities(s)) for (const k of ["name", "shape", "mark", "eyes"] as const) seen[k].add(id[k]);
    expect(seen.shape.size).toBe(SHAPES.length);
    expect(seen.mark.size).toBe(MARKS.length);
    expect(seen.eyes.size).toBe(EYES.length);
    expect(seen.name.size).toBeGreaterThan(300);
  });

  test("in every match: distinct names, shapes and marks; colors apart and readable on every theme", () => {
    const backgrounds = Object.values(PALETTES).flatMap((p) => [...p.sky, ...p.hills]);
    for (let s = 0; s < 1000; s++) {
      const ids = generateIdentities(s * 7919 + 13);
      expect(ids.length).toBe(4);
      expect(new Set(ids.map((i) => i.name.slice(0, 3).toLowerCase())).size).toBe(4);
      expect(new Set(ids.map((i) => i.shape)).size).toBe(4);
      expect(new Set(ids.map((i) => i.mark)).size).toBe(4);
      for (const id of ids) {
        expect(validName(id.name)).toBe(true);
        expect(id.name.length).toBeLessThanOrEqual(NAME_MAX);
        for (const bg of backgrounds) expect(contrast(id.color, bg)).toBeGreaterThanOrEqual(3);
      }
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(hueGap(ids[i]!.color, ids[j]!.color)).toBeGreaterThanOrEqual(MIN_HUE_GAP - 1);
    }
  });

  test("wishes (#19): a valid, unclaimed wish is kept; an invalid or taken one is replaced", () => {
    const base = generateIdentities(5);
    const free = SHAPES.find((s) => !base.some((b) => b.shape === s))!;
    const got = assignIdentities(5, [{ name: "Captain", shape: free, eyes: "plus", mark: "halo", color: 0xff5ab4 }]);
    expect(got[0]).toEqual({ name: "Captain", shape: free, eyes: "plus", mark: "halo", color: 0xff5ab4 });
    const bad = assignIdentities(5, [{ name: "x", shape: "blob", eyes: 7, mark: "jetpack", color: "red" }]);
    expect(bad[0]).toEqual(base[0]!);
    // seat 1 asks for seat 0's shape and name: seat 0 keeps them, seat 1 gets others
    const clash = assignIdentities(5, [undefined, { name: base[0]!.name, shape: base[0]!.shape }]);
    expect(clash[0]).toEqual(base[0]!);
    expect(clash[1]!.shape).not.toBe(base[0]!.shape);
    expect(clash[1]!.name).not.toBe(base[0]!.name);
    // a too-dark or too-close color is refused
    expect(assignIdentities(5, [{ color: 0x101010 }])[0]!.color).toBe(base[0]!.color);
    expect(assignIdentities(5, [undefined, { color: base[0]!.color }])[1]!.color).not.toBe(base[0]!.color);
  });

  test("old records keep their names and colors; their marks pick familiar head shapes", () => {
    const souls = [
      { name: "Brick", color: 0xff4f4f, mark: "headband" },
      { name: "Pike", color: 0x47a3ff, mark: "antenna" },
      { name: "Squeaks", color: 0x4fdc6a, mark: "ears" },
      { name: "Goldie", color: 0xffc733, mark: "crown" },
    ];
    const ids = legacyIdentities(9, souls);
    expect(ids.map((i) => i.name)).toEqual(["Brick", "Pike", "Squeaks", "Goldie"]);
    expect(ids.map((i) => i.color)).toEqual([0xff4f4f, 0x47a3ff, 0x4fdc6a, 0xffc733]);
    expect(ids.map((i) => i.shape)).toEqual(["keystone", "dome", "bun", "shield"]);
    expect(ids.map((i) => i.mark)).toEqual(["headband", "antenna", "ears", "crown"]);
  });

  test("identity is display data: it never changes a fight", () => {
    const strategies = [0, 1, 2, 3].map(() => ({ target: "nearest" as const, stance: "rush" as const, weapons: ["bat" as const, "rocket" as const], line: "" }));
    const run = (seed: number) => {
      const f = new Fight(77, strategies, { looks: generateIdentities(seed) });
      while (!f.step()) {
        /* fight */
      }
      return f.record.finalHash;
    };
    expect(run(1)).toBe(run(2));
  });

  test("no fighter name, color or look is hardcoded in souls/ or src/", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const OLD_NAMES = /\b(Brick|Pike|Squeaks|Goldie|Percival|Malone|Ruckus)\b/;
    const OLD_COLORS = /(ff4f4f|47a3ff|4fdc6a|ffc733)/i;
    for (const f of files("souls")) {
      const t = readFileSync(f, "utf8");
      const front = /^---\n([\s\S]*?)\n---/.exec(t)?.[1] ?? "";
      expect(front).not.toMatch(/^(name|title|color|mark)\s*:/m);
      expect(t).not.toMatch(OLD_NAMES);
      expect(t).not.toMatch(OLD_COLORS);
      expect(t).not.toMatch(/#[0-9a-f]{6}\b/i);
    }
    for (const f of files("src").filter((x) => x.endsWith(".ts"))) {
      // "Brick" is also a terrain material (Mat.Brick)
      const t = readFileSync(f, "utf8").replace(/Mat\.Brick|\bBrick = \d+/g, "");
      expect(`${f}: ${OLD_NAMES.exec(t)?.[0] ?? ""}`).toBe(`${f}: `);
      expect(`${f}: ${OLD_COLORS.exec(t)?.[0] ?? ""}`).toBe(`${f}: `);
    }
  });
});
