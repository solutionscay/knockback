import { describe, expect, test } from "bun:test";
import { crossfade } from "../scripts/montage/audio";
import { bursts, cutFrames, KO_END_S, MAX_S, MIN_S, montageOrder, pickCuts, SEP_S } from "../scripts/montage/cuts";
import type { Moment } from "../scripts/teaser/source";

const m = (tick: number, kind = "explosion", weight = 1): Moment => ({ tick, kind, weight, x: 0 });

// a busy fight: a chain of explosions, a platform fall, a ring-out right at the end, and steady hits
const fight: Moment[] = [m(30), m(70), m(110, "platformFall", 4), m(400), m(430), m(900, "chainBreak", 1.5), m(1500), m(1530), m(1560), m(1590), m(1620), m(1650), m(1680), m(1710, "ko.ringout", 6), ...Array.from({ length: 80 }, (_, i) => m(i * 22, "hit", 0.1))];
const END = 1740;

describe("montage cut picker", () => {
  test("every burst stays inside its fight and is 2 to 5 s long", () => {
    for (const b of bursts(0, 0, fight, END)) {
      expect(b.from).toBeGreaterThanOrEqual(0);
      expect(b.to).toBeLessThanOrEqual(END);
      expect(b.to - b.from).toBeGreaterThanOrEqual(MIN_S * 60);
      expect(b.to - b.from).toBeLessThanOrEqual(MAX_S * 60);
    }
  });

  test("never two cuts of the same moment", () => {
    const cands = [...bursts(0, 0, fight, END), ...bursts(1, 0, fight, END)];
    const cuts = pickCuts(cands, { targetS: 999, minCuts: 1, maxCuts: 99, perRecord: 99 });
    expect(cuts.length).toBeGreaterThan(2);
    for (const a of cuts)
      for (const b of cuts) {
        if (a === b || a.rec !== b.rec) continue;
        expect(a.to + SEP_S * 60 <= b.from || b.to + SEP_S * 60 <= a.from).toBe(true);
        expect(a.moments.some((x) => b.moments.includes(x))).toBe(false);
      }
  });

  test("cuts per record are capped, so the montage takes many rounds", () => {
    const cands = [0, 1, 2, 3].flatMap((r) => bursts(r, 0, fight, END));
    const cuts = pickCuts(cands, { targetS: 999, minCuts: 1, maxCuts: 99, perRecord: 2 });
    for (const r of [0, 1, 2, 3]) expect(cuts.filter((c) => c.rec === r).length).toBeLessThanOrEqual(2);
  });

  test("the biggest cut comes last; two cuts of one record are not adjacent", () => {
    const o = montageOrder([{ score: 3, rec: 0 }, { score: 9, rec: 1 }, { score: 1, rec: 2 }, { score: 5, rec: 3 }, { score: 7, rec: 1 }, { score: 8, rec: 4 }]);
    expect(o.after[o.after.length - 1]!.score).toBe(9);
    expect(Math.min(...o.after.map((c) => c.score))).toBeGreaterThanOrEqual(Math.max(...o.before.map((c) => c.score)));
    for (const half of [o.before, o.after]) for (let i = 1; i < half.length; i++) expect(half[i]!.rec).not.toBe(half[i - 1]!.rec);
  });

  test("a cut with the fight's last K.O. ends right after it (nobody is left to show)", () => {
    const ending = bursts(0, 0, fight, END).filter((b) => b.moments.some((x) => x.kind === "ko.ringout"));
    expect(ending.length).toBeGreaterThan(0);
    for (const b of ending) expect(b.to).toBeLessThanOrEqual(1710 + KO_END_S * 60);
  });

  test("a cut's frames stay inside the fight's frames (impact pauses repeat ticks)", () => {
    const ticks = [0, 0, 0, 1, 2, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10];
    const fightRange = { from: 3, to: 15 };
    expect(cutFrames(ticks, fightRange, { from: 3, to: 6 })).toEqual({ from: 6, to: 11 });
    const late = cutFrames(ticks, fightRange, { from: 8, to: 99 });
    expect(late.to).toBeLessThanOrEqual(fightRange.to);
  });
});

describe("montage sound", () => {
  const flat = (n: number, v: number) => ({ left: new Float32Array(n).fill(v), right: new Float32Array(n).fill(v) });

  test("the cut is a crossfade, not a jump", () => {
    // part A (1.0) runs on xf samples past the cut at 100, fading out, while part B (0.0) starts
    const xf = 10;
    const out = crossfade([flat(100 + xf, 1), flat(100, 0)], [0, 100], xf, 200);
    for (let k = 100; k < 100 + xf; k++) expect(Math.abs(out.left[k]! - out.left[k - 1]!)).toBeLessThanOrEqual(1 / xf + 1e-6);
    expect(out.left[100 + xf]).toBe(0);
  });

  test("equal parts sum to a steady level through the crossfade", () => {
    const xf = 10;
    const out = crossfade([flat(100 + xf, 0.5), flat(100 + xf, 0.5)], [0, 100], xf, 200);
    for (let k = 100; k < 100 + xf; k++) expect(out.left[k]).toBeCloseTo(0.5, 5);
  });
});
