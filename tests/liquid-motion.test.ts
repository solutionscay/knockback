/**
 * Contract (#143): smooth liquid motion in the viewer (src/viewer/liquid-motion.ts). The sim moves whole cells per
 * flow step; the viewer eases each pool column's drawn level to the sim's and draws falling liquid as streams. Visual
 * only: these tests run it on hand-built grids settled by the sim's own flowStep, which they never change.
 */
import { describe, expect, test } from "bun:test";
import { CELL, Grid, Mat } from "../src/sim";
import { Liquid } from "../src/sim/grid";
import { flowStep } from "../src/sim/liquid-flow";
import { LIQUID_LOOKS } from "../src/viewer/liquid-looks";
import { ease, Levels, scanRuns, STEP, streamSources, Streams, type Level } from "../src/viewer/liquid-motion";

/** Dirt ground with its top at row 8, a water basin cx 10-15 four cells deep (rows 4-7). */
function basin() {
  const g = new Grid(60, 30, 0, 0);
  for (let cx = 0; cx < g.cols; cx++) for (let cy = 0; cy < 8; cy++) g.set(cx, cy, cy < 1 ? Mat.Bedrock : Mat.Dirt);
  for (let cx = 10; cx <= 15; cx++) for (let cy = 4; cy < 8; cy++) {
    g.clear(cx, cy);
    g.liq[g.idx(cx, cy)] = Liquid.Water;
  }
  return g;
}

/** A pool on a ledge (cx 10-15, rows 16-19, ground under it from row 15 down to row 12) over low ground (top at row 4). */
function ledge() {
  const g = new Grid(60, 30, 0, 0);
  for (let cx = 0; cx < g.cols; cx++) for (let cy = 0; cy < 4; cy++) g.set(cx, cy, cy < 1 ? Mat.Bedrock : Mat.Dirt);
  for (let cx = 6; cx <= 17; cx++) for (let cy = 4; cy < 20; cy++) g.set(cx, cy, Mat.Dirt);
  for (let cx = 10; cx <= 15; cx++) for (let cy = 16; cy < 20; cy++) {
    g.clear(cx, cy);
    g.liq[g.idx(cx, cy)] = Liquid.Water;
  }
  return g;
}

const tau = (L: number) => (L === Liquid.Lava ? LIQUID_LOOKS.lava!.ease : LIQUID_LOOKS.water!.ease);
const liquidCells = (g: Grid) => g.liq.reduce((n, l) => n + (l ? 1 : 0), 0);

/** the levels the viewer would sync for a grid: one per surface run (no lone-crest flattening; that is drawing) */
const targets = (g: Grid) => scanRuns(g).surf.map((r) => ({ cx: r.cx, L: r.L, floor: g.wy(r.bot), top: g.wy(r.top) + CELL }));

describe("liquid motion (#143)", () => {
  test("ease never overshoots and reaches the target within 30 frames for up to 4 cells, for every liquid", () => {
    for (const [name, look] of Object.entries(LIQUID_LOOKS)) {
      for (const d of [0.01, CELL, -CELL, 2 * CELL, -4 * CELL, 4 * CELL]) {
        let cur = 3, n = 0;
        const target = 3 + d;
        while (cur !== target) {
          const next = ease(cur, target, look.ease);
          expect(Math.abs(target - next)).toBeLessThan(Math.abs(target - cur)); // always closer
          expect(Math.sign(target - next) * Math.sign(d)).toBeGreaterThanOrEqual(0); // never past it
          cur = next;
          if (++n > 30) throw new Error(`${name}: ${d} m not reached in 30 frames (at ${cur})`);
        }
      }
      expect(look.ease).toBeGreaterThan(0);
      expect(look.streamWidth).toBeGreaterThan(0);
    }
  });

  test("a settled pool: no falling liquid, and its surface runs cover exactly the carved liquid cells", () => {
    const g = basin();
    // carve an uneven floor: a deeper notch and a step
    g.clear(12, 3); g.liq[g.idx(12, 3)] = Liquid.Water;
    g.set(15, 4, Mat.Dirt);
    const scan = scanRuns(g);
    expect(scan.falling).toEqual([]);
    expect(scan.hidden).toEqual([]);
    const covered = new Set<number>();
    for (const r of scan.surf) for (let cy = r.bot; cy <= r.top; cy++) covered.add(g.idx(r.cx, cy));
    expect(covered.size).toBe(liquidCells(g));
    for (const i of covered) expect(g.liq[i]).toBe(Liquid.Water);
    // each column's floor is its own carved bottom
    const floorOf = (cx: number) => scan.surf.find((r) => r.cx === cx)!.bot;
    expect([floorOf(11), floorOf(12), floorOf(15)]).toEqual([4, 3, 5]);
  });

  test("a pool draining into a crater: the levels ease, never past the sim's level; the crater fills from its floor", () => {
    const g = basin();
    const levels = new Levels(tau);
    levels.sync(targets(g), true);
    // a blast carves a crater under the pool's right end
    for (let cx = 14; cx <= 18; cx++) for (let cy = 1; cy < 4; cy++) g.clear(cx, cy);
    for (let cx = 16; cx <= 18; cx++) for (let cy = 4; cy < 8; cy++) g.clear(cx, cy);
    const seen = new Uint8Array(g.mat.length);
    let rose = false, fell = false;
    for (let s = 0; s < 200; s++) {
      seen.fill(0);
      const moved = flowStep(g, s, undefined, seen);
      const before = levels.list().map((l) => ({ cx: l.cx, lvl: l.lvl }));
      const now = levels.sync(targets(g), false);
      for (const l of now) {
        // a carried level starts where it was drawn in its column; a new one at its floor (it fills up)
        expect(l.lvl === l.floor || before.some((b) => b.cx === l.cx && b.lvl === l.lvl)).toBe(true);
      }
      for (let f = 0; f < 6; f++) {
        const prev = levels.list().map((l) => ({ l, d: l.target - l.lvl }));
        levels.step();
        for (const { l, d } of prev) {
          const d2 = l.target - l.lvl;
          expect(Math.abs(d2)).toBeLessThanOrEqual(Math.abs(d) + 1e-9);
          expect(Math.sign(d2) * Math.sign(d)).toBeGreaterThanOrEqual(0);
          if (d > 0) rose = true;
          if (d < 0) fell = true;
        }
      }
      if (!moved) break;
    }
    expect(rose).toBe(true); // the crater filled up
    expect(fell).toBe(true); // the pool went down
    // once the sim rests, every level reaches it, and the drained columns are gone
    for (let f = 0; f < 40; f++) levels.step();
    for (const l of levels.list()) expect(l.lvl).toBe(l.target);
    expect(levels.ghosts()).toEqual([]);
  });

  test("a column whose liquid left drains to its floor and goes; after a time jump it is gone at once", () => {
    const g = basin();
    const levels = new Levels(tau);
    levels.sync(targets(g), true);
    for (let cy = 4; cy < 8; cy++) g.liq[g.idx(10, cy)] = Liquid.None;
    levels.sync(targets(g), false);
    const gh = levels.ghosts();
    expect(gh.map((l) => l.cx)).toEqual([10]);
    let last = gh[0]!.lvl;
    for (let f = 0; f < 60 && levels.ghosts().length; f++) {
      levels.step();
      const now = levels.ghosts()[0];
      if (now) { expect(now.lvl).toBeLessThanOrEqual(last); expect(now.lvl).toBeGreaterThanOrEqual(now.floor); last = now.lvl; }
    }
    expect(levels.ghosts()).toEqual([]);
    // a jump: everything stands at the sim's level, no ghost
    for (let cy = 4; cy < 8; cy++) g.liq[g.idx(11, cy)] = Liquid.None;
    levels.sync(targets(g), true);
    expect(levels.ghosts()).toEqual([]);
    for (const l of levels.list()) expect(l.lvl).toBe(l.target);
  });

  test("a waterfall over a broken rim: streams only where liquid really falls, and they end after the pour", () => {
    const g = ledge();
    const streams = new Streams(tau);
    streams.sync(streamSources(g, scanRuns(g).falling), true);
    expect(streams.list).toEqual([]);
    // a blast breaks the ledge's right rim down to the pool's floor
    for (let cx = 16; cx <= 17; cx++) for (let cy = 16; cy < 20; cy++) g.clear(cx, cy);
    const seen = new Uint8Array(g.mat.length);
    let longest = 0, drops = 0, s = 0;
    for (; s < 400; s++) {
      seen.fill(0);
      if (!flowStep(g, s, undefined, seen)) break;
      const scan = scanRuns(g);
      const sources = streamSources(g, scan.falling);
      for (const src of sources) {
        // its top cell is liquid, and under the liquid there is at least one free cell before it lands
        expect(g.liqAt(src.cx, g.cy(src.top - CELL / 2))).not.toBe(Liquid.None);
        expect(src.top - src.land).toBeGreaterThanOrEqual(2 * CELL);
        const fallsHere = scan.falling.some((r) => r.cx === src.cx && g.matAt(r.cx, r.bot - 1) === Mat.Empty && !g.liqAt(r.cx, r.bot - 1));
        expect(fallsHere).toBe(true);
        longest = Math.max(longest, (src.top - src.land) / CELL);
      }
      streams.sync(sources, false);
      for (let f = 0; f < 6; f++) streams.step(() => LIQUID_LOOKS.water!.streamDrops, (_st, n) => void (drops += n));
      for (const st of streams.list) {
        expect(st.I).toBeGreaterThanOrEqual(0);
        expect(st.I).toBeLessThanOrEqual(1);
        // the stream is drawn between its top and its landing, never above the liquid that feeds it
        if (st.live) expect(st.shown).toBeLessThanOrEqual(st.top + 1e-9);
      }
    }
    expect(s).toBeLessThan(400); // it settled
    expect(longest).toBeGreaterThanOrEqual(10); // a real waterfall: the ledge is 16 cells over the low ground
    expect(drops).toBeGreaterThan(0);
    // the pour stopped: the streams fade (their tails fall) and are gone within the fade
    streams.sync(streamSources(g, scanRuns(g).falling), false);
    let f = 0;
    while (streams.list.length && f < 200) { streams.step(() => 14); f++; }
    expect(streams.list).toEqual([]);
    expect(f).toBeLessThanOrEqual(Math.ceil(0.3 / STEP) + 1);
  });

  test("the same grid changes and steps give the same levels and streams (replays and captures)", () => {
    const run = () => {
      const g = ledge();
      const levels = new Levels(tau), streams = new Streams(tau);
      levels.sync(targets(g), true);
      streams.sync([], true);
      for (let cx = 16; cx <= 17; cx++) for (let cy = 16; cy < 20; cy++) g.clear(cx, cy);
      const seen = new Uint8Array(g.mat.length);
      const out: number[] = [];
      for (let s = 0; s < 60; s++) {
        seen.fill(0);
        flowStep(g, s, undefined, seen);
        const sc = scanRuns(g);
        levels.sync(targets(g), false);
        streams.sync(streamSources(g, sc.falling), false);
        for (let f = 0; f < 6; f++) { levels.step(); streams.step(() => 14); }
        out.push(...levels.list().map((l: Level) => l.lvl), ...streams.list.flatMap((st) => [st.shown, st.landShown, st.I]));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
