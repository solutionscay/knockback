/**
 * The headless round (#48): how the eval loop (run.ts) and the match runner
 * (runner.ts) play a round. The round is prepared with the seats' decisions,
 * the sim steps it to its end at once (no viewer, deterministic), and the
 * round is closed. The runner's mid-round work (check-ins, stored plan
 * updates) goes between prepareRound and playOutRound.
 */
import type { DecisionMeta, Match } from "../sim/match";
import type { RoundFacts } from "../sim/morale";
import type { Decision } from "../sim/voice";

/** Step the round being fought to its end at once and close it. */
export function playOutRound(match: Match): RoundFacts {
  while (!match.step()) {
    /* the sim plays the round */
  }
  return match.finishRound();
}

/** Prepare the next round with these decisions (none: the replay record's), play it out and close it. */
export function playRoundHeadless(match: Match, decisions?: Decision[], meta?: DecisionMeta[]): RoundFacts {
  match.prepareRound(decisions, meta);
  return playOutRound(match);
}
