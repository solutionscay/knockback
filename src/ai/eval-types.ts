import type { DecisionMeta } from "../sim/match";
import type { Strategy } from "../sim/sim";

import type { CheckinMeta } from "../sim/match";
import type { CheckinStats } from "./checkin-log";
export interface EvalDecision {
  strategy: Strategy;
  line: string;
  meta: DecisionMeta;
  /** what the house bot would have planned in the same situation (AI seats; for comparison) */
  house?: Strategy;
}

/** What happened in a round, as far as the metrics need it. */
export interface EvalRoundFacts {
  winner: number;
  kos: { victim: number; by: number; weapon: string; cause: "ringout" | "hp" }[];
  /** damage[attacker][victim] */
  damage: number[][];
  /** hits from behind: behind[attacker][victim] */
  behind: number[][];
  /** weapons that did damage: weapons[attacker][victim] */
  weapons: string[][][];
  /** plan rule firings (#6): rules[seat][rule index] */
  rules?: { fires: number; activeTicks: number }[][];
}

export interface EvalRound {
  /** decisions made before this round, per seat */
  decisions: EvalDecision[];
  facts: EvalRoundFacts;
  /** mid-round check-ins (#9) and how many became plan updates; absent when check-ins were off */
  checkins?: CheckinMeta[];
  planUpdates?: number;
}

/** One seat's suit-up (#19) as the eval sees it: who chose, how it went, the identity it ended with. */
export interface EvalLook {
  seat: number;
  /** the soul's id ("brawler"): does the look fit the soul? */
  soul: string;
  /** provider name ("claude") */
  provider: string;
  outcome: "ok" | "partial" | "fallback-timeout" | "fallback-error" | "fallback-invalid";
  ms?: number;
  kept: string[];
  name: string;
  shape: string;
  eyes: string;
  mark: string;
  minor: string;
  color: number;
}

export interface LookStats {
  /** AI seats asked to suit up */
  asked: number;
  ok: number;
  partial: number;
  fallbacks: { timeout: number; error: number; invalid: number };
  fallbackRate: number;
  /** of the fields asked for (6 a seat), the share kept */
  keptRate: number;
  /** distinct values over the AI's own choices (ok or partial), and how many choices */
  variety: { choices: number; names: number; shapes: number; eyes: number; marks: number; hues: number; topShape: string | null; topShapeShare: number };
  /** per soul: its most common shape and mark across matches */
  bySoul: Record<string, { choices: number; shapes: Record<string, number>; marks: Record<string, number> }>;
  samples: string[];
}

export interface EvalMatch {
  seed: number;
  /** suit-up of the AI seats (#19); absent when the match had no suit-up */
  looks?: EvalLook[];
  /** fighter names per seat (from the souls) */
  names: string[];
  /** provider name per seat ("house" = house bot) */
  seats: string[];
  rounds: EvalRound[];
  winner: number;
}

export const NA = "n/a" as const;
export type NA = typeof NA;

export interface FieldVariety {
  n: number;
  /** value -> count */
  dist: Record<string, number>;
  /** Shannon entropy in bits */
  entropy: number;
  top: string;
  topShare: number;
}

export interface VarietyGroup {
  answers: number;
  stance: FieldVariety;
  target: FieldVariety;
  retaliate: FieldVariety;
  weapon1: FieldVariety;
  weapons: FieldVariety;
}

export interface ChangeStats {
  /** consecutive-round pairs (same seat, same match) */
  transitions: number;
  changed: number;
  changeRate: number;
  /** field -> times it changed */
  fields: Record<string, number>;
}

export interface FollowStats {
  /** decisions after a round (round 2+) judged */
  decisions: number;
  /** knocked out by a rival last round, and targeted that rival by name */
  targetedKiller: { chances: number; hits: number; rate: number };
  /** targeted last round's winner (when it was someone else) */
  targetedWinner: { chances: number; hits: number; rate: number };
  /** targeted the rival who did the most damage to it */
  targetedTopDamager: { chances: number; hits: number; rate: number };
  /** named any rival as target */
  namedTarget: { chances: number; hits: number; rate: number };
  /** knocked out by a pickup weapon it did not want: did that weapon enter the wish list? */
  killerWeaponAdded: { chances: number; hits: number; rate: number };
}

export interface RulesStats {
  plans: number;
  plansWithRules: number;
  plansWithRulesRate: number;
  rulesWritten: number;
  rulesPerPlan: number;
  /** rules the parser dropped (decision meta ruleProblems) */
  rejected: number;
  /** rejected / (written + rejected) */
  rejectedRate: number;
  /** rules that fired at least once in their round */
  fired: number;
  firedRate: number;
  firingsPerRound: number;
  activeSecondsPerRule: number;
  /** by trigger and by action: written, fired at least once, total firings */
  byWhen: Record<string, { written: number; fired: number; firings: number }>;
  byDo: Record<string, { written: number; fired: number; firings: number }>;
  neverFired: string[];
}

export interface FactCheck {
  /** lines (round 2+) that name a rival together with an event */
  checked: number;
  /** decisions whose meta carries a fact warning (the post-check in decideRound) */
  warnings: number;
  mismatches: { seed: number; round: number; fighter: string; line: string; claim: string; facts: string }[];
}

export interface ProviderReliability {
  calls: number;
  /** calls where a second, hedged call was made (#14) */
  hedged: number;
  ok: number;
  timeouts: number;
  errors: number;
  invalid: number;
  fallbacks: number;
  ms: { median: number; p90: number; max: number };
}

export interface EvalReport {
  matches: number;
  /** true when the house columns are the house bot's plans in the AI's place (no house seats in the run) */
  houseInAiPlace: boolean;
  rounds: number;
  seeds: number[];
  lineups: string[];
  variety: { ai: VarietyGroup | NA; house: VarietyGroup | NA };
  /** checkinsPerRound: plan updates from check-ins per round (#9), n/a when check-ins were off */
  change: { ai: ChangeStats | NA; house: ChangeStats | NA; byFighter: Record<string, ChangeStats>; checkinsPerRound: number | NA };
  /** check-in numbers per provider (#9): answers, updates, misses, latency, estimated tokens; n/a when check-ins were off */
  checkins?: CheckinStats[] | NA;
  rules: { ai: RulesStats | NA; house: RulesStats | NA };
  follows: { ai: FollowStats | NA; house: FollowStats | NA };
  facts: FactCheck;
  /** the optional "why" (#3): how many of the AI's own plans gave one, and a few of them */
  why: { answers: number; withWhy: number; rate: number; samples: string[] } | NA;
  /** the suit-up (#19): look-choice variety and fallbacks over the AI seats; n/a without one */
  looks?: LookStats | NA;
  reliability: Record<string, ProviderReliability>;
  results: {
    ai: { seats: number; roundWins: number; roundWinRate: number; matchWins: number; matchWinRate: number } | NA;
    house: { seats: number; roundWins: number; roundWinRate: number; matchWins: number; matchWinRate: number } | NA;
    /** a fair share for one seat: 1 / 4 */
    fairShare: number;
  };
}
