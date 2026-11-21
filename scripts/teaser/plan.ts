/**
 * The segment planner: the operator's video rules, applied to a match's beat timeline (docs/video.md).
 * Pure (tested in tests/teaser.test.ts).
 *
 * - the arena card in full
 * - every trash-talk card before every round, from just before its line is fully typed to its end (at most
 *   CARD_MAX_S of it: readable, not a wait)
 * - 3, 2, 1, FIGHT! and every round in full, continuous; only dead stretches (from the sim: nobody near anyone,
 *   nothing happening) play at 2x, with a "2x" tag
 * - every round-end screen in full, then the win screen with the scoreboard (WIN_S of it)
 * - captions: the start caption over the first round's cards, the end caption over the last END_CAPTION_S
 */

/** Game time per capture step: the viewer always steps 1/60 s. */
export const STEP_HZ = 60;
export const CARD_MAX_S = 2.6;
/** show a card from this long before its line is fully typed */
export const CARD_LEAD_S = 0.6;
export const WIN_S = 8;
export const END_CAPTION_S = 3;

export interface TimelineBeat {
  /** first frame of the beat (1 = after the first step) */
  frame: number;
  kind: string;
  round: number;
  index: number;
}

export interface Timeline {
  beats: TimelineBeat[];
  /** sim tick after each frame (index 0 = frame 1) */
  ticks: number[];
  frames: number;
}

export type Caption = "start" | "end" | null;

export interface Segment {
  label: string;
  kind: string;
  /** fight number (1-based) for fight and round-end segments */
  round?: number;
  /** first and last source frame (inclusive) */
  from: number;
  to: number;
  /** 1 or 2 (a dead stretch) */
  speed: 1 | 2;
  /** source frames advanced per output frame */
  step: number;
  /** output time where the segment starts, seconds */
  outStart: number;
  /** output length, seconds */
  outLength: number;
}

export interface Plan {
  segments: Segment[];
  /** output length, seconds */
  length: number;
  fps: number;
  /** every captured source frame, in output order, with its caption and tag */
  frames: { src: number; out: number; caption: Caption; tag: boolean }[];
}

/** Each beat's frame range [from, to]. */
export function beatRanges(t: Timeline): (TimelineBeat & { from: number; to: number })[] {
  return t.beats.map((b, i) => ({ ...b, from: b.frame, to: (t.beats[i + 1]?.frame ?? t.frames + 1) - 1 }));
}

/** When a card's line is fully typed (the viewer types it over min(1.6 s, half the card) after 0.2 s). */
export function typedFrame(from: number, to: number): number {
  const dur = (to - from + 1) / STEP_HZ;
  return from + Math.ceil((0.2 + Math.min(1.6, dur * 0.5)) * STEP_HZ);
}

/** The part of a card beat [from, to] that is shown: from CARD_LEAD_S before its line is fully typed to its end, at most CARD_MAX_S. */
export function cardWindow(from: number, to: number): { from: number; to: number } {
  return { from: Math.max(from, typedFrame(from, to) - Math.round(CARD_LEAD_S * STEP_HZ), to - Math.round(CARD_MAX_S * STEP_HZ) + 1), to };
}

/**
 * Plan the video. deadTicks[r] = the dead stretches of fight r+1 as [fromTick, toTick] (sim ticks).
 */
export function planVideo(t: Timeline, deadTicks: [number, number][][], fps: 30 | 60): Plan {
  const base = STEP_HZ / fps;
  const parts: Omit<Segment, "outStart" | "outLength">[] = [];
  let fight = 0;
  let roundOfCards = 0;
  let lastWasCard = false;
  const ranges = beatRanges(t);
  for (const b of ranges) {
    const add = (from: number, to: number, label: string, speed: 1 | 2 = 1, round?: number) => {
      if (to >= from) parts.push({ label, kind: b.kind, from, to, speed, step: base * speed, ...(round !== undefined ? { round } : {}) });
    };
    if (b.kind !== "dialogue") lastWasCard = false;
    switch (b.kind) {
      case "level":
        add(b.from, b.to, "arena card");
        break;
      case "dialogue": {
        if (!lastWasCard) roundOfCards++;
        lastWasCard = true;
        add(cardWindow(b.from, b.to).from, b.to, `trash-talk card (round ${roundOfCards})`);
        break;
      }
      case "countdown":
      case "go":
        add(b.from, b.to, b.kind === "go" ? "FIGHT!" : "countdown");
        break;
      case "fight": {
        fight++;
        const dead = deadTicks[fight - 1] ?? [];
        const isDead = (f: number) => {
          const tick = t.ticks[f - 1] ?? -1;
          return dead.some(([a, z]) => tick >= a && tick <= z);
        };
        // split the fight into runs of normal and dead frames
        let runStart = b.from;
        for (let f = b.from + 1; f <= b.to + 1; f++) {
          if (f <= b.to && isDead(f) === isDead(runStart)) continue;
          const d = isDead(runStart);
          add(runStart, f - 1, d ? `round ${fight}: quiet stretch (2x)` : `round ${fight} fight`, d ? 2 : 1, fight);
          runStart = f;
        }
        break;
      }
      case "roundEnd":
        add(b.from, b.to, `round ${fight} end screen`, 1, fight);
        break;
      case "celebrate":
        add(b.from, Math.min(b.to, b.from + WIN_S * STEP_HZ - 1), "win screen and scoreboard");
        break;
    }
  }
  // output times and captured frames
  const segments: Segment[] = [];
  const frames: Plan["frames"] = [];
  let out = 0;
  for (const p of parts) {
    const n = Math.floor((p.to - p.from) / p.step) + 1;
    segments.push({ ...p, outStart: out / fps, outLength: n / fps });
    for (let i = 0; i < n; i++) frames.push({ src: p.from + i * p.step, out: out + i, caption: null, tag: p.speed === 2 });
    out += n;
  }
  const length = out / fps;
  // captions: the start one over round 1's cards, the end one over the last seconds
  const cards = segments.filter((s) => s.kind === "dialogue" && s.label.endsWith("(round 1)"));
  if (cards.length) {
    const a = Math.round(cards[0]!.outStart * fps);
    const z = Math.round((cards[cards.length - 1]!.outStart + cards[cards.length - 1]!.outLength) * fps);
    for (const f of frames) if (f.out >= a && f.out < z) f.caption = "start";
  }
  const endFrom = out - END_CAPTION_S * fps;
  for (const f of frames) if (f.out >= endFrom) f.caption = "end";
  return { segments, length, fps, frames };
}

/** Output time of a source frame, or null when the frame is cut. */
export function outTime(plan: Plan, srcFrame: number): number | null {
  for (const s of plan.segments) if (srcFrame >= s.from && srcFrame <= s.to) return s.outStart + (srcFrame - s.from) / STEP_HZ / s.speed;
  return null;
}

/** Split the captured frames into n contiguous chunks of near-equal size (one per capture page). */
export function chunks<T>(xs: T[], n: number): T[][] {
  const size = Math.ceil(xs.length / Math.max(1, n));
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Dead stretches in ticks: no action event within 1.5 s and no two fighters within 7 m, for 3 s or more. */
export function deadStretches(endTick: number, actionTicks: number[], near: boolean[], opts = { window: 90, minLen: 180, trim: 30 }): [number, number][] {
  const acts = [...actionTicks].sort((a, b) => a - b);
  let j = 0;
  const runs: [number, number][] = [];
  let s = -1;
  for (let tk = 0; tk <= endTick; tk++) {
    while (j < acts.length && acts[j]! < tk - opts.window) j++;
    const active = near[tk] === true || (j < acts.length && acts[j]! <= tk + opts.window);
    const dead = !active;
    if (dead && s < 0) s = tk;
    if ((!dead || tk === endTick) && s >= 0) {
      const e = dead ? tk : tk - 1;
      if (e - s + 1 >= opts.minLen) runs.push([s + opts.trim, e - opts.trim]);
      s = -1;
    }
  }
  return runs;
}
