/**
 * Broadcast pacing (#22): how long the viewer takes to play one round, so the
 * match server can wait for viewers before it asks agents for the next round.
 *
 * Built from the viewer's own beats (beats.ts: level card, dialogue lines,
 * countdown, FIGHT!, round end), so the server and the viewer cannot drift
 * apart when those change. The fight itself runs in real time (ticks / 60)
 * plus the viewer's knockout slow motion (see VIEWER_KO_EXTRA_S).
 */
import { TICK_RATE } from "../sim/constants";
import { betweenBeats, DEFAULT_TIMING, openingBeats, roundBeats, type Beat, type BeatTiming } from "./beats";

/**
 * Extra real time the viewer spends per knockout that doesn't end the round:
 * src/viewer/game.ts slows the sim to 16% and eases back over 1.6 s (cubic,
 * 1.6 x (1 - 0.37) = 1.01 s behind) and holds a 0.14 s hit pause. The
 * round-ending knockout's slow motion runs in the round-end beat instead.
 */
export const VIEWER_KO_EXTRA_S = 1.15;

/**
 * The viewer's fight also pauses on big hits (up to 0.125 s each) and barrel
 * explosions (0.05 s), which the server doesn't count. Measured on a live
 * 3-agent match at broadcast pace (#22): the viewer finished rounds of 34 s
 * and 36 s fights 3.0 s and 1.8 s after the plain estimate. 4% of the fight
 * covers most of it while staying a little early: agents then get their turn
 * just before the round-end card closes, rather than viewers waiting.
 */
export const VIEWER_FIGHT_STRETCH = 1.04;

export interface RoundPlayback {
  /** level card (round 1), dialogue lines, countdown: before the fight starts */
  preFight: number;
  /** FIGHT! plus the fight in real time, with knockout slow motion */
  fight: number;
  roundEnd: number;
  total: number;
}

export interface RoundPlaybackInput {
  round: number;
  /** each fighter's line for this round (intro lines in round 1) */
  lines: string[];
  fightTicks: number;
  /** knockouts in the round */
  kos: number;
  /** the round ended on a knockout (last one standing), not on time */
  endsWithKo: boolean;
  timing?: BeatTiming;
}

const sum = (beats: Beat[]) => beats.reduce((a, b) => a + (b.duration ?? 0), 0);

/** Seconds the viewer needs to play one round, from receiving its decisions to the end of the round-end callout. */
export function roundPlayback(x: RoundPlaybackInput): RoundPlayback {
  const t = x.timing ?? DEFAULT_TIMING;
  const order = x.lines.map((_, i) => i);
  const talk = x.round === 1 ? openingBeats(order, x.lines, t) : betweenBeats(order, x.lines, x.round, t);
  const beats = roundBeats(x.round, t);
  const countdown = sum(beats.filter((b) => b.kind === "countdown"));
  const roundEnd = sum(beats.filter((b) => b.kind === "roundEnd"));
  const slowmo = Math.max(0, x.kos - (x.endsWithKo ? 1 : 0)) * VIEWER_KO_EXTRA_S;
  const preFight = sum(talk) + countdown;
  const fight = Math.max(t.go, (x.fightTicks / TICK_RATE) * VIEWER_FIGHT_STRETCH + slowmo);
  return { preFight, fight, roundEnd, total: preFight + fight + roundEnd };
}

/** Where the viewer is, `elapsed` seconds into a round's playback: before the fight, at a fight tick, or at the round end. */
export function playbackAt(p: RoundPlayback, elapsed: number, fightTicks: number): { phase: "plan" | "fight" | "roundEnd"; tick: number | null } {
  if (elapsed < p.preFight) return { phase: "plan", tick: null };
  if (elapsed < p.preFight + p.fight) return { phase: "fight", tick: Math.min(fightTicks, Math.max(0, Math.round(((elapsed - p.preFight) / p.fight) * fightTicks))) };
  return { phase: "roundEnd", tick: fightTicks };
}
