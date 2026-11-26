/**
 * Smooth liquid motion between sim steps (#143): the part of the liquid renderer (liquidview.ts) that has no drawing in
 * it, so tests can run it on a bare grid.
 *
 * The sim settles liquid whole cells at a time, one step every few ticks (liquid-flow.ts). Drawn as it is, a pool that
 * drains steps down in cell-sized chunks and a pour is a block that jumps a cell at a time. Here:
 * - scanRuns() splits each column's liquid into runs: a run with a free cell under it is FALLING (it moves down next
 *   step); the rest are pool runs with an open surface, or hidden runs under an overhang.
 * - Levels eases each pool column's surface from where it was drawn towards the sim's level, at a fixed step, never past
 *   it, and reaching it in a bounded number of steps. A column that newly holds liquid rises from its floor; a column
 *   that lost its liquid drains to its floor (a "ghost") before it goes.
 * - Streams turns falling runs into one continuous stream per column, from its top (or the lip it pours over) down to
 *   where it lands. A stream fades in, and when the liquid stops falling its tail drops away and it fades out.
 *
 * Visual only: this reads the grid and never writes to it. Deterministic: it advances only by step(), at a fixed rate,
 * from the scene's time; after a time jump the caller syncs with `snap` and everything stands where the sim is.
 */
import { CELL, Mat, type Grid } from "../sim/grid";

/** the fixed step (s) every motion advances by */
export const STEP = 1 / 60;
/** the slowest a level or a landing point moves (m/s) while not at its target: easing ends in bounded time */
export const MIN_SPEED = 0.9;
/** how fast a stream's tail falls once nothing feeds it (m/s): the sim drops a cell (0.5 m) per flow step (0.1 s) */
export const TAIL_SPEED = 5;
/** seconds for a stream to fade in and out */
export const FADE_IN = 0.12;
export const FADE_OUT = 0.3;

/** a vertical run of one liquid in a column, in rows (top >= bot) */
export interface Run {
  cx: number;
  L: number;
  top: number;
  bot: number;
}

export interface Scan {
  /** runs with open air (or another liquid) above: a pool's surface */
  surf: Run[];
  /** runs with ground right above (under an overhang) */
  hidden: Run[];
  /** runs with a free cell under them: falling */
  falling: Run[];
}

const free = (g: Grid, cx: number, cy: number) => g.inside(cx, cy) && g.matAt(cx, cy) === Mat.Empty && !g.liqAt(cx, cy);

/** Each column's runs of one liquid, sorted into surface, hidden and falling ones. */
export function scanRuns(g: Grid): Scan {
  const out: Scan = { surf: [], hidden: [], falling: [] };
  for (let cx = 0; cx < g.cols; cx++) {
    let cy = g.rows - 1;
    while (cy >= 0) {
      const L = g.liqAt(cx, cy);
      if (!L) { cy--; continue; }
      const top = cy;
      while (cy >= 0 && g.liqAt(cx, cy) === L) cy--;
      const bot = cy + 1;
      const run = { cx, L, top, bot };
      // the floor row of the grid is open (a pit): liquid there runs out, like a fall
      if (bot === 0 ? g.matAt(cx, 0) === Mat.Empty : free(g, cx, bot - 1)) out.falling.push(run);
      else if (top + 1 >= g.rows || !g.solid(cx, top + 1)) out.surf.push(run);
      else out.hidden.push(run);
    }
  }
  return out;
}

/** What a stream is made from: one column's falling liquid, top (world y) to where it lands (world y). */
export interface StreamSource {
  cx: number;
  L: number;
  top: number;
  land: number;
  /** the side (-1, 1) a pool next to its top pours over from, or 0 */
  lip: number;
}

/** The streams in the grid now: per column, its falling runs, joined where one falls onto the next, to the landing. */
export function streamSources(g: Grid, falling: Run[]): StreamSource[] {
  const out: StreamSource[] = [];
  // falling runs come per column from the top down (scanRuns' order)
  for (let i = 0; i < falling.length; ) {
    const first = falling[i]!;
    let last = first;
    let land = landRow(g, last);
    i++;
    while (i < falling.length && falling[i]!.cx === first.cx && falling[i]!.top === land) {
      last = falling[i]!;
      land = landRow(g, last);
      i++;
    }
    const lip = !g.liqAt(first.cx, first.top + 1) ? (g.liqAt(first.cx - 1, first.top) ? -1 : g.liqAt(first.cx + 1, first.top) ? 1 : 0) : 0;
    out.push({ cx: first.cx, L: first.L, top: g.wy(first.top) + CELL, land: land < 0 ? g.wy(0) - 2 * CELL : g.wy(land) + CELL, lip });
  }
  return out;
}

/** the first row under a falling run that is not free (ground or liquid); -1: it falls out of the grid */
function landRow(g: Grid, r: Run) {
  let y = r.bot - 1;
  while (y >= 0 && free(g, r.cx, y)) y--;
  return y;
}

/** Move `cur` towards `target` by one step: exponential with time constant `tau`, at least MIN_SPEED, never past it. */
export function ease(cur: number, target: number, tau: number) {
  const d = target - cur;
  const a = Math.abs(d);
  if (a < 1e-5) return target;
  const k = 1 - Math.exp(-STEP / Math.max(1e-3, tau));
  return cur + Math.sign(d) * Math.min(a, Math.max(a * k, MIN_SPEED * STEP));
}

/** one pool column's surface: drawn at `lvl`, easing towards the sim's `target`; `floor` is its bottom (world y) */
export interface Level {
  cx: number;
  L: number;
  floor: number;
  lvl: number;
  target: number;
  /** its liquid left (drained, or fell): it drains to its floor and goes */
  ghost: boolean;
}

export interface LevelTarget {
  cx: number;
  L: number;
  floor: number;
  top: number;
}

/** The pool columns' drawn levels, easing towards the sim's. */
export class Levels {
  private all: Level[] = [];

  constructor(private readonly tauOf: (L: number) => number) {}

  /**
   * The sim's columns now (after a grid change). Each keeps the level drawn for the run it was (same column and
   * liquid, overlapping), else starts at its floor (it fills up); a run that has none now drains away. With `snap`
   * (the first frame, or after a time jump) every level stands at the sim's and nothing drains.
   * Returns the levels in the order of `targets`.
   */
  sync(targets: readonly LevelTarget[], snap: boolean): Level[] {
    const old = this.all;
    const used = new Set<Level>();
    const now: Level[] = [];
    for (const t of targets) {
      let best: Level | null = null;
      if (!snap) {
        for (const o of old) {
          if (used.has(o) || o.cx !== t.cx || o.L !== t.L) continue;
          if (o.floor <= t.top + 1e-6 && Math.max(o.lvl, o.target) >= t.floor - 1e-6 && (!best || o.lvl > best.lvl)) best = o;
        }
      }
      if (best) used.add(best);
      now.push({ cx: t.cx, L: t.L, floor: t.floor, target: t.top, lvl: snap ? t.top : best ? best.lvl : t.floor, ghost: false });
    }
    this.all = now.slice();
    if (!snap) {
      for (const o of old) {
        if (used.has(o) || o.lvl <= o.floor + 1e-3) continue;
        this.all.push({ ...o, target: o.floor, ghost: true });
      }
    }
    return now;
  }

  step() {
    let gone = false;
    for (const l of this.all) {
      l.lvl = ease(l.lvl, l.target, this.tauOf(l.L));
      if (l.ghost && l.lvl <= l.floor + 1e-3) gone = true;
    }
    if (gone) this.all = this.all.filter((l) => !(l.ghost && l.lvl <= l.floor + 1e-3));
  }

  ghosts(): Level[] {
    return this.all.filter((l) => l.ghost);
  }

  /** every level, ghosts included */
  list(): readonly Level[] {
    return this.all;
  }
}

/** a stream as drawn: column, liquid, top and landing (world y, eased), strength 0..1 */
export interface Stream {
  cx: number;
  L: number;
  top: number;
  shown: number;
  land: number;
  landShown: number;
  lip: number;
  I: number;
  /** liquid falls here now (else it is fading out) */
  live: boolean;
  /** droplets owed (fractional, carried between steps) */
  owe: number;
}

/** The falling liquid's streams, one per column, fading in and out. */
export class Streams {
  list: Stream[] = [];

  constructor(private readonly tauOf: (L: number) => number) {}

  /** The streams in the grid now (after a grid change). With `snap` they stand at full strength, and the dead are gone. */
  sync(sources: readonly StreamSource[], snap: boolean) {
    const old = this.list;
    const used = new Set<Stream>();
    const now: Stream[] = [];
    for (const s of sources) {
      const o = old.find((o) => !used.has(o) && o.cx === s.cx && o.L === s.L && o.landShown <= s.top + 1e-6 && Math.max(o.shown, o.top) >= s.land - 1e-6);
      if (o && !snap) {
        used.add(o);
        Object.assign(o, { top: s.top, land: s.land, lip: s.lip, live: true });
        now.push(o);
      } else {
        now.push({ cx: s.cx, L: s.L, top: s.top, shown: s.top, land: s.land, landShown: s.land, lip: s.lip, I: snap ? 1 : 0, live: true, owe: 0 });
      }
    }
    if (!snap) for (const o of old) if (!used.has(o)) { o.live = false; now.push(o); }
    this.list = now;
  }

  /** One fixed step. `drops(s, n)`: whole droplets a stream throws where it lands this step (n per `rate` per second). */
  step(rateOf: (L: number) => number, drops?: (s: Stream, n: number) => void) {
    let gone = false;
    for (const s of this.list) {
      s.landShown = ease(s.landShown, s.land, this.tauOf(s.L));
      if (s.live) {
        s.I = Math.min(1, s.I + STEP / FADE_IN);
        // new liquid over the lip shows at once; when the top drops, the tail falls at the sim's speed
        s.shown = s.top >= s.shown ? s.top : Math.max(s.top, s.shown - TAIL_SPEED * STEP);
      } else {
        s.I = Math.max(0, s.I - STEP / FADE_OUT);
        s.shown -= TAIL_SPEED * STEP;
        if (s.I <= 0 || s.shown <= s.landShown) { s.I = 0; gone = true; continue; }
      }
      s.owe += rateOf(s.L) * s.I * STEP;
      const n = Math.floor(s.owe);
      if (n > 0) { s.owe -= n; drops?.(s, n); }
    }
    if (gone) this.list = this.list.filter((s) => s.I > 0);
  }
}
