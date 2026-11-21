/**
 * The cut picker of bun run montage (docs/video.md): the big moments of every fight (from the sim pass) become
 * short bursts, the best ones are kept, and they are put in the montage order. Pure (tested in tests/montage.test.ts).
 *
 * A burst starts LEAD_S before a big moment (weight >= 1: an explosion or more) and takes the big moments that
 * follow it closely (no gap over GAP_S), ending TAIL_S after the last one; it is MIN_S to MAX_S long and stays
 * inside the fight; a cut with the fight's last K.O. ends on it. Kept bursts never share a moment: two cuts of one fight are SEP_S apart at least.
 * A cut's score favours variety: each K.O. counts in full; n moments of any other kind count weight * sqrt(n), so
 * a ring-out with a platform fall beats a ninth explosion.
 */
import type { Moment } from "../teaser/source";

const HZ = 60;
export const LEAD_S = 0.8;
export const TAIL_S = 1.2;
export const GAP_S = 1.0;
export const MIN_S = 2;
export const MAX_S = 4;
export const SEP_S = 0.5;
export const KO_END_S = 0;

export interface Burst {
  /** index of the record in the input */
  rec: number;
  /** round index in the record (0-based) */
  round: number;
  /** first and last sim tick of the cut */
  from: number;
  to: number;
  /** the cut's score (cutScore) */
  score: number;
  moments: Moment[];
}

/** K.O.s count in full; n moments of another kind count weight * sqrt(n). */
export function cutScore(moments: readonly Moment[]): number {
  const kinds = new Map<string, { w: number; n: number }>();
  let ko = 0;
  for (const m of moments) {
    if (m.kind.startsWith("ko.")) ko += m.weight;
    else {
      const k = kinds.get(m.kind) ?? { w: m.weight, n: 0 };
      k.n++;
      kinds.set(m.kind, k);
    }
  }
  return ko + [...kinds.values()].reduce((a, k) => a + k.w * Math.sqrt(k.n), 0);
}

/** Every candidate burst of one fight: one per big moment, as long as the action around it runs. */
export function bursts(rec: number, round: number, moments: readonly Moment[], endTick: number): Burst[] {
  const all = [...moments].sort((a, b) => a.tick - b.tick);
  const big = all.filter((m) => m.weight >= 1);
  const finalKo = all.filter((m) => m.kind.startsWith("ko.")).pop();
  const out: Burst[] = [];
  for (let i = 0; i < big.length; i++) {
    let from = big[i]!.tick - LEAD_S * HZ;
    let last = big[i]!;
    for (let j = i + 1; j < big.length; j++) {
      const m = big[j]!;
      if (m.tick - last.tick > GAP_S * HZ || m.tick + TAIL_S * HZ - from > MAX_S * HZ) break;
      last = m;
    }
    let to = Math.max(last.tick + TAIL_S * HZ, from + MIN_S * HZ);
    // after the fight's last K.O. nobody is left to frame: a cut that reaches it ends on it (the camera leaves at once) and grows backwards
    if (finalKo && big[i]!.tick > finalKo.tick) continue;
    if (finalKo && to > finalKo.tick + KO_END_S * HZ) {
      to = finalKo.tick + KO_END_S * HZ;
      from = Math.min(from, to - MIN_S * HZ);
    }
    // inside the fight: shift, never shrink below MIN_S unless the fight itself is shorter
    if (from < 0) {
      to -= from;
      from = 0;
    }
    if (to > endTick) {
      from = Math.max(0, from - (to - endTick));
      to = endTick;
    }
    const inCut = all.filter((m) => m.tick >= from && m.tick <= to);
    out.push({ rec, round, from, to, score: cutScore(inCut), moments: inCut });
  }
  return out;
}

export interface PickOpts {
  /** stop adding cuts once they make this many seconds (and there are minCuts) */
  targetS: number;
  minCuts: number;
  maxCuts: number;
  /** at most this many cuts from one record, so the montage takes many rounds */
  perRecord: number;
}

export const PICK: PickOpts = { targetS: 22, minCuts: 6, maxCuts: 8, perRecord: 2 };

const seconds = (b: Burst) => (b.to - b.from) / HZ;

/** The best bursts, biggest first; never two of the same moment (cuts of one fight at least SEP_S apart). */
export function pickCuts(cands: readonly Burst[], o: PickOpts = PICK): Burst[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score || a.rec - b.rec || a.round - b.round || a.from - b.from);
  const chosen: Burst[] = [];
  let total = 0;
  for (const c of sorted) {
    if (chosen.length >= o.maxCuts || (chosen.length >= o.minCuts && total >= o.targetS)) break;
    if (chosen.filter((x) => x.rec === c.rec).length >= o.perRecord) continue;
    const clash = chosen.some((x) => x.rec === c.rec && x.round === c.round && c.from < x.to + SEP_S * HZ && x.from < c.to + SEP_S * HZ);
    if (clash) continue;
    chosen.push(c);
    total += seconds(c);
  }
  return chosen;
}

/**
 * The montage order around the cards: the smaller half first (its strongest cut opens), then the cards, then the
 * bigger half rising to the biggest cut last. Two cuts of one record are not put next to each other when another
 * order of the same half avoids it (the biggest cut stays last).
 */
export function montageOrder<T extends { score: number; rec: number }>(cuts: readonly T[]): { before: T[]; after: T[] } {
  const s = [...cuts].sort((a, b) => b.score - a.score);
  const half = Math.ceil(s.length / 2);
  return { before: apart(s.slice(half), false), after: apart(s.slice(0, half).reverse(), true) };
}

function apart<T extends { rec: number }>(xs: T[], keepLast: boolean): T[] {
  const n = xs.length;
  for (let i = 1; i < n; i++) {
    if (xs[i]!.rec !== xs[i - 1]!.rec) continue;
    const ok = (k: number) => xs[k]!.rec !== xs[i - 1]!.rec;
    const j = [...Array(n).keys()].find((k) => k > i && (!keepLast || k < n - 1) && ok(k));
    if (j !== undefined) [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    else {
      // move the earlier one back instead
      const k = [...Array(i - 1).keys()].reverse().find((k) => xs[k]!.rec !== xs[i]!.rec && (k === 0 || xs[k - 1]!.rec !== xs[i - 1]!.rec));
      if (k !== undefined) [xs[i - 1], xs[k]] = [xs[k]!, xs[i - 1]!];
    }
  }
  return xs;
}

/** The frames of a cut: from the first frame at or past its first tick to the last frame at or before its last tick, inside the fight. */
export function cutFrames(ticks: readonly number[], fight: { from: number; to: number }, b: { from: number; to: number }): { from: number; to: number } {
  let from = fight.to;
  for (let f = fight.from; f <= fight.to; f++)
    if ((ticks[f - 1] ?? -1) >= b.from) {
      from = f;
      break;
    }
  let to = from;
  for (let f = fight.to; f >= from; f--)
    if ((ticks[f - 1] ?? Infinity) <= b.to) {
      to = f;
      break;
    }
  return { from, to };
}

/**
 * The left edge of a `cw`-wide crop of a `W`-wide frame, centred on the weighted median of the points' screen x
 * (the action), kept inside the frame. No points: the centre.
 */
export function cropLeft(points: readonly { x: number; weight: number }[], W: number, cw: number): number {
  const ps = points.filter((p) => Number.isFinite(p.x)).sort((a, b) => a.x - b.x);
  let cx = W / 2;
  if (ps.length) {
    const half = ps.reduce((a, p) => a + p.weight, 0) / 2;
    let acc = 0;
    for (const p of ps) {
      acc += p.weight;
      if (acc >= half) {
        cx = p.x;
        break;
      }
    }
  }
  return Math.round(Math.min(W - cw, Math.max(0, cx - cw / 2)));
}

/** What happens in a cut, in words: "2 explosions, a chain snaps, a platform falls, Luna rings out (by Pickle)". */
export function describe(b: Pick<Burst, "moments">, names: readonly string[]): string {
  const n = (k: string) => b.moments.filter((m) => m.kind === k).length;
  const name = (i: number | undefined) => (i !== undefined && i >= 0 ? (names[i] ?? `bot ${i + 1}`) : "?");
  const count = (k: string, one: string, many: (n: number) => string) => (n(k) === 0 ? [] : [n(k) === 1 ? one : many(n(k))]);
  const parts = [
    ...count("explosion", "an explosion", (k) => `${k} explosions`),
    ...count("chainBreak", "a chain snaps", (k) => `${k} chains snap`),
    ...count("platformFall", "a platform falls", (k) => `${k} platforms fall`),
    ...(n("ignite") ? ["fire"] : []),
    ...(n("suddenDeath") ? ["sudden death"] : []),
    ...b.moments
      .filter((m) => m.kind === "ko.ringout" || m.kind === "ko.hp")
      .map((m) => `${name(m.fighter)} ${m.kind === "ko.ringout" ? "rings out" : "is knocked out"}${m.by !== undefined && m.by >= 0 && m.by !== m.fighter ? ` (by ${name(m.by)})` : ""}`),
  ];
  return parts.length ? parts.join(", ") : "a brawl";
}
