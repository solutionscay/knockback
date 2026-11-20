/**
 * Morale: per fighter, derived from what happened in each round, carried
 * between rounds of a match. Pure functions so it can be tested in isolation.
 *
 *   score  -100..100  pride vs shame (wins, knockouts, health, streaks, comebacks)
 *   anger    0..100   from humiliations and being knocked out (decays fast)
 *   grudge            who wronged you most recently (-1 = nobody)
 *
 * States, checked in this order:
 *   furious    anger >= 50                         (rushes, aims a bit worse)
 *   desperate  no round wins, someone else on match point, score < -20
 *   cocky      score >= 45                         (overconfident: slightly worse aim)
 *   confident  score >= 0
 *   rattled    otherwise                           (shaky aim)
 */
import type { FightResult } from "./fight";
import type { RoundStats } from "./roundstats";

export type MoraleState = "cocky" | "confident" | "rattled" | "furious" | "desperate";
export const MORALE_STATES: readonly MoraleState[] = ["cocky", "confident", "rattled", "furious", "desperate"];

/**
 * Behavior nudges. Kept small on purpose (batch stats check they do not
 * dominate win rates). aim multiplies the fighter's aim noise.
 */
export const MORALE_EFFECT: Record<MoraleState, { aim: number }> = {
  cocky: { aim: 1.12 },
  confident: { aim: 0.94 },
  rattled: { aim: 1.3 },
  furious: { aim: 1.15 },
  desperate: { aim: 0.92 },
};

export type HumiliationKind = "own-explosive" | "bat-ringout" | "hook-ringout" | "crushed" | "barrel";

export interface FighterRoundFacts {
  id: number;
  won: boolean;
  survived: boolean;
  hpEnd: number;
  /** order knocked out this round: 1 = first out, 0 = survived */
  outOrder: number;
  kosDealt: { victim: number; weapon: string; cause: "ringout" | "hp" }[];
  koBy: { by: number; weapon: string; cause: "ringout" | "hp" } | null;
  damageDealt: number;
  damageTaken: number;
  humiliations: { kind: HumiliationKind; by: number }[];
}

export interface RoundFacts {
  round: number;
  winner: number;
  reason: FightResult["reason"];
  seconds: number;
  fighters: FighterRoundFacts[];
  chainReactions: number;
  platformsFallen: number;
  /** Biggest single launch of the round. */
  biggestHit: { by: number; target: number; kb: number; weapon: string } | null;
  /** damage matrix, time near rivals, targets, pickups, one plain line per fighter */
  stats: RoundStats;
}

export interface Morale {
  score: number;
  anger: number;
  grudge: number;
  state: MoraleState;
  baseline: number;
  /** consecutive round wins */
  streak: number;
  comeback: boolean;
  /** short human-readable reasons for the last change (for the viewer and logs) */
  reasons: string[];
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function moraleState(m: Pick<Morale, "score" | "anger">, myWins: number, bestOtherWins: number): MoraleState {
  if (m.anger >= 50) return "furious";
  if (myWins === 0 && bestOtherWins >= 1 && m.score < -20) return "desperate";
  if (m.score >= 45) return "cocky";
  if (m.score >= 0) return "confident";
  return "rattled";
}

export function initialMorale(baselines: readonly number[]): Morale[] {
  return baselines.map((b) => {
    const m: Morale = { score: b, anger: 0, grudge: -1, state: "confident", baseline: b, streak: 0, comeback: false, reasons: [] };
    m.state = moraleState(m, 0, 0);
    return m;
  });
}

/** Morale after a round, given its facts and the round wins so far (including this round). */
export function updateMorale(prev: readonly Morale[], facts: RoundFacts, wins: readonly number[]): Morale[] {
  return prev.map((p, i) => {
    const f = facts.fighters[i]!;
    const reasons: string[] = [];
    // drift back toward character baseline, anger cools
    let score = p.baseline + (p.score - p.baseline) * 0.8;
    let anger = p.anger * 0.5;
    let grudge = anger < 20 ? -1 : p.grudge;
    let streak = p.streak;
    let comeback = false;
    if (f.won) {
      const lostBefore = p.streak === 0 && facts.round > 1;
      streak++;
      score += 30;
      reasons.push("won the round");
      if (streak >= 2) {
        score += 12;
        reasons.push("on a streak");
      }
      if (lostBefore) {
        score += 15;
        comeback = true;
        reasons.push("comeback");
      }
      if (f.hpEnd >= 70) {
        score += 8;
        reasons.push("barely scratched");
      }
    } else {
      streak = 0;
      score -= 8;
    }
    if (f.kosDealt.length) {
      score += 10 * f.kosDealt.length;
      reasons.push(`${f.kosDealt.length} knockout${f.kosDealt.length > 1 ? "s" : ""}`);
    }
    if (f.koBy) {
      score -= f.outOrder === 1 ? 26 : 18;
      reasons.push(f.outOrder === 1 ? "first one out" : "knocked out");
      if (f.koBy.by >= 0 && f.koBy.by !== i) {
        anger += 15;
        grudge = f.koBy.by;
      }
    } else if (!f.won) {
      score += (f.hpEnd - 50) * 0.2;
    }
    for (const h of f.humiliations) {
      score -= 14;
      anger += h.by === i ? 12 : 40; // a self-own rattles more than it enrages
      if (h.by >= 0 && h.by !== i) grudge = h.by;
      reasons.push(`humiliated (${h.kind})`);
    }
    score = clamp(score, -100, 100);
    anger = clamp(anger, 0, 100);
    const best = Math.max(...wins.filter((_, j) => j !== i));
    const m: Morale = { score, anger, grudge, state: "confident", baseline: p.baseline, streak, comeback, reasons };
    m.state = moraleState(m, wins[i]!, best);
    return m;
  });
}
