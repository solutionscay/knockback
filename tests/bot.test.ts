import { describe, expect, test } from "bun:test";
import { oklch } from "../src/sim/color";
import { EYES, generateIdentities, MAJOR_MARKS, MARKS, MINOR_MARKS, SHAPES, type Identity } from "../src/sim/identity";
import { ALL_FACES, blinkClosed, COLS, darkPartsOf, drawBody, drawSilhouette, drawVisor, EYE_CELLS, faceFor, hash, HEADS, koFace, lodFor, ROWS } from "../src/viewer/bot";
import { portraitSvg } from "../src/viewer/portrait";
import { SvgPen } from "../src/viewer/svgPen";

const WEAPONS = ["rocket", "shotgun", "bat", "grenade", "grapple", "fist"] as const;

describe("bot fighters (#18)", () => {
  test("every shape, eye style and mark in the identity pools has a drawing", () => {
    for (const s of SHAPES) expect(HEADS[s]).toBeDefined();
    for (const e of EYES) expect(EYE_CELLS[e]?.length).toBeGreaterThan(0);
    expect(Object.keys(HEADS).sort()).toEqual([...SHAPES].sort());
    expect(Object.keys(EYE_CELLS).sort()).toEqual([...EYES].sort());
  });

  test("every face stays on the 11 x 6 grid, at many moments and with the eyes looking around", () => {
    for (const eyes of EYES)
      for (const mood of ALL_FACES)
        for (let t = 0; t < 8; t += 0.137)
          for (const lookX of [-1, 0, 1])
            for (const lookY of [-1, 0, 1]) {
              const f = faceFor(mood, t, hash(eyes), eyes, { lookX, lookY, koT: t / 2 });
              for (const [c, r] of f.bits) {
                expect(c >= 0 && c < COLS && r >= 0 && r < ROWS).toBe(true);
                expect(Number.isInteger(c) && Number.isInteger(r)).toBe(true);
              }
            }
  });

  test("the KO screen: X X, then the dots fall in their columns and pile up, then it powers down", () => {
    const x = koFace(0.2).bits;
    expect(x.length).toBe(16);
    const fallen = koFace(1.6).bits;
    expect(fallen.length).toBe(16);
    const cols = (bits: typeof x) => bits.map((b) => b[0]).sort((a, b) => a - b);
    expect(cols(fallen)).toEqual(cols(x));
    expect(Math.min(...fallen.map((b) => b[1]))).toBeGreaterThanOrEqual(ROWS - 2);
    expect(koFace(3.6).bits).toEqual([]);
    expect(koFace(3.6).screen).toBe("off");
  });

  test("the blink rhythm comes from the identity's hash", () => {
    const ids = generateIdentities(3);
    const closedAt = (name: string) => Array.from({ length: 600 }, (_, i) => blinkClosed(i / 30, hash(name)));
    expect(closedAt(ids[0]!.name)).toEqual(closedAt(ids[0]!.name));
    expect(closedAt(ids[0]!.name).some(Boolean)).toBe(true);
    expect(closedAt(ids[0]!.name)).not.toEqual(closedAt(ids[1]!.name));
  });

  test("level of detail by dot pitch: full for portraits, game at 1080p, tiny at 720p", () => {
    expect(lodFor(130)).toBe("full");
    expect(lodFor(71)).toBe("game");
    expect(lodFor(47)).toBe("tiny");
  });

  test("every shape x mark x face draws clean SVG (no NaN, no undefined)", () => {
    let n = 0;
    SHAPES.forEach((shape, si) => {
      for (const mark of [...MARKS, "none" as const]) {
        const id: Identity = { name: `${shape}-${mark}`, shape, eyes: EYES[si % EYES.length]!, mark, color: 0x3fa9f5 };
        const pen = new SvgPen();
        drawBody(pen, id, { t: 0.5, air: si % 2 === 0, aiming: true });
        for (const mood of ALL_FACES) drawVisor(pen, id, faceFor(mood, 1, 7, id.eyes), (["full", "game", "tiny"] as const)[n++ % 3]);
        drawSilhouette(pen, id);
        const svg = pen.toSvg();
        expect(svg).not.toMatch(/NaN|undefined|Infinity/);
        expect(svg.length).toBeGreaterThan(500);
      }
    });
  });

  test("portraits: every weapon and mood, the full bot and the head-only chip", () => {
    const id = generateIdentities(11)[2]!;
    for (const w of WEAPONS)
      for (const mood of ["fight", "win", "cocky", "confident", "rattled", "furious", "desperate", "ko"] as const) {
        const svg = portraitSvg(id, w, mood);
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg).not.toMatch(/NaN|undefined/);
      }
    expect(portraitSvg(id, "bat", "fight", "tiny")).toContain('viewBox="-0.66');
  });

  test("a major and a minor mark draw together, for every pair", () => {
    for (const mark of MAJOR_MARKS)
      for (const minor of MINOR_MARKS) {
        const id: Identity = { name: `${mark}+${minor}`, shape: "squircle", eyes: "tall", mark, minor, color: 0xe2ca5d };
        const pen = new SvgPen();
        drawBody(pen, id, { t: 0.2 });
        drawVisor(pen, id, faceFor("confident", 1, 7, id.eyes), "game");
        const solo = new SvgPen();
        drawBody(solo, { ...id, minor: "none" }, { t: 0.2 });
        drawVisor(solo, { ...id, minor: "none" }, faceFor("confident", 1, 7, id.eyes), "game");
        expect(pen.toSvg()).not.toMatch(/NaN|undefined/);
        expect(pen.toSvg().length).toBeGreaterThan(solo.toSvg().length); // the minor mark adds shapes
      }
  });

  test("torso and feet darken in OKLCH: hue and chroma stay (a yellow stays gold, not khaki)", () => {
    for (const c of [0xe2ca5d, 0xeedc58, 0x7be451, 0x8a9bff, 0xf357cf]) {
      const { torso, feet } = darkPartsOf(c);
      const a = oklch(c), t1 = oklch(torso), f1 = oklch(feet);
      expect(t1.L).toBeLessThan(a.L - 0.1);
      expect(f1.L).toBeLessThan(t1.L);
      expect(t1.C).toBeGreaterThan(a.C * 0.8);
      expect(Math.abs(t1.h - a.h)).toBeLessThan(0.12);
    }
  });
});
