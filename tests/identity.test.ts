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
  luminance,
  MARKS,
  Match,
  familyOf,
  MAJOR_MARKS,
  MIN_COLOR_DISTANCE,
  MINOR_MARKS,
  NAME_MAX,
  NAME_POOL_SIZE,
  SHAPES,
  validName,
} from "../src/sim";
import { oklabDistance } from "../src/sim/color";
import { PALETTES } from "../src/viewer/palette";

beforeAll(async () => {
  await initPhysics();
});

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
    const seen = { name: new Set<string>(), shape: new Set<string>(), mark: new Set<string>(), eyes: new Set<string>(), minor: new Set<string>() };
    for (let s = 0; s < 300; s++) for (const id of generateIdentities(s)) for (const k of ["name", "shape", "mark", "eyes", "minor"] as const) seen[k].add(String(id[k]));
    expect(seen.shape.size).toBe(SHAPES.length);
    expect(seen.mark.size).toBe(MAJOR_MARKS.length);
    expect(seen.minor.size).toBe(MINOR_MARKS.length + 1); // and "none"
    expect(seen.eyes.size).toBe(EYES.length);
    expect(seen.name.size).toBeGreaterThan(300);
  });

  test("in every match: distinct name starts, silhouette families and major marks; colors apart and readable on every theme", () => {
    const backgrounds = Object.values(PALETTES).flatMap((p) => [...p.sky, ...p.hills]);
    for (let s = 0; s < 1000; s++) {
      const ids = generateIdentities(s * 7919 + 13);
      expect(ids.length).toBe(4);
      expect(new Set(ids.map((i) => i.name.slice(0, 3).toLowerCase())).size).toBe(4);
      expect(new Set(ids.map((i) => familyOf(i.shape))).size).toBe(4);
      expect(new Set(ids.map((i) => i.mark)).size).toBe(4);
      for (const id of ids) expect((MAJOR_MARKS as readonly string[]).includes(id.mark)).toBe(true);
      for (const id of ids) expect(["none", ...MINOR_MARKS]).toContain(id.minor!);
      for (const id of ids) {
        expect(validName(id.name)).toBe(true);
        expect(id.name.length).toBeLessThanOrEqual(NAME_MAX);
        for (const bg of backgrounds) expect(contrast(id.color, bg)).toBeGreaterThanOrEqual(3);
      }
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(oklabDistance(ids[i]!.color, ids[j]!.color)).toBeGreaterThanOrEqual(MIN_COLOR_DISTANCE);
    }
  });

  test("wishes (#19): a valid, unclaimed wish is kept; an invalid or taken one is replaced", () => {
    const base = generateIdentities(5);
    const free = SHAPES.find((s) => !base.some((b) => b.shape === s))!;
    const freeFamily = SHAPES.find((s) => !base.some((b) => familyOf(b.shape) === familyOf(s)))!;
    const got = assignIdentities(5, [{ name: "Captain", shape: freeFamily, eyes: "plus", mark: "halo", minor: "scarf", color: 0xff5ab4 }]);
    expect(got[0]).toEqual({ name: "Captain", shape: freeFamily, eyes: "plus", mark: "halo", minor: "scarf", color: 0xff5ab4 });
    expect(free).toBeDefined();
    const bad = assignIdentities(5, [{ name: "x", shape: "blob", eyes: 7, mark: "jetpack", minor: "crown", color: "red" }]);
    expect(bad[0]).toEqual(base[0]!);
    // a minor mark is not a major one, and a pool word is not a name
    expect(assignIdentities(5, [{ mark: "scratch", name: "Pebble" }])[0]!.mark).toBe(base[0]!.mark);
    expect(assignIdentities(5, [{ name: "Pebble" }])[0]!.name).toBe(base[0]!.name);
    // seat 1 asks for seat 0's shape and name: seat 0 keeps them, seat 1 gets others
    const clash = assignIdentities(5, [undefined, { name: base[0]!.name, shape: base[0]!.shape }]);
    expect(clash[0]).toEqual(base[0]!);
    expect(clash[1]!.shape).not.toBe(base[0]!.shape);
    expect(clash[1]!.name).not.toBe(base[0]!.name);
    // a too-dark or too-close color is refused
    expect(assignIdentities(5, [{ color: 0x101010 }])[0]!.color).toBe(base[0]!.color);
    // colors are settled for the whole match: a wished color wins over a generated one, the others draw around it
    const wished = assignIdentities(5, [undefined, { color: base[0]!.color }]);
    expect(wished[1]!.color).toBe(base[0]!.color);
    expect(wished[0]!.color).not.toBe(base[0]!.color);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(oklabDistance(wished[i]!.color, wished[j]!.color)).toBeGreaterThanOrEqual(MIN_COLOR_DISTANCE);
    // two wishes for the same color: the first seat keeps it
    const twice = assignIdentities(5, [{ color: 0xff5ab4 }, { color: 0xff5ab4 }]);
    expect(twice[0]!.color).toBe(0xff5ab4);
    expect(twice[1]!.color).not.toBe(0xff5ab4);
  });

  test("colors cover the whole hue circle, evenly for every seat (blues included)", () => {
    const N = 3000;
    const bins = Array.from({ length: 4 }, () => new Array(12).fill(0));
    for (let k = 0; k < N; k++) generateIdentities((k * 2654435761) >>> 0).forEach((id, s) => bins[s]![Math.floor(hueLight(id.color).h / 30) % 12]++);
    for (let b = 0; b < 12; b++) {
      const all = bins.reduce((a, s) => a + s[b]!, 0) / (4 * N);
      expect(all).toBeGreaterThan(0.045); // every 30° band, blue (240-270°) too
      for (let s = 0; s < 4; s++) expect(Math.abs(bins[s]![b]! / N - all)).toBeLessThan(0.035); // no seat leans to leftover hues
    }
  });

  test("names never equal a shape, eye or mark word; most names are syllable names", () => {
    const words = new Set([...SHAPES, ...EYES, ...MARKS].flatMap((w) => [w, w.replace(/s$/, ""), `${w}s`]));
    let n = 0;
    for (let s = 0; s < 500; s++) for (const id of generateIdentities(s)) {
      expect(words.has(id.name.toLowerCase())).toBe(false);
      n++;
    }
    expect(validName("Pebble")).toBe(false);
    expect(validName("Bolt")).toBe(false);
    expect(n).toBe(2000);
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
