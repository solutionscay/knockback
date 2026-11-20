/**
 * AI match evaluation: pure metric functions (#2).
 *
 * Input: a list of EvalMatch (what was decided before each round, by whom,
 * and the facts of each round). Output: a report object. No I/O, no
 * randomness: unit tests feed fixed matches; scripts/ai-eval.ts feeds real
 * ones (evalMatchFrom builds an EvalMatch from a finished Match).
 *
 * Groups: variety, change, rules, follows the stats, facts, reliability,
 * results. Groups for features that do not exist yet (rules, check-ins)
 * report "n/a".
 */
import type { Match } from "../sim/match";
import type { Strategy } from "../sim/sim";
import { checkFactsFromStats } from "./factcheck";
import { changeOf, factsOf, followsOf, hasHouseSeats, reliabilityOf, resultsOf, rulesOf, varietyOf, whyOf } from "./eval-metrics";
import { NA, type EvalMatch, type EvalReport } from "./eval-types";
import { checkinStats } from "./checkin-log";

export * from "./eval-types";
export { changeOf, factsOf, followsOf, hasHouseSeats, quantile, reliabilityOf, resultsOf, rulesOf, targetLabel, variety, varietyOf, whyOf } from "./eval-metrics";
export * from "./eval-report";

/** The whole report. Pure. */
/** Plan updates from check-ins per round (#9), over the rounds that had check-ins on; n/a when none did. */
function checkinsPerRound(matches: EvalMatch[]): number | NA {
  const rounds = matches.flatMap((m) => m.rounds).filter((r) => r.checkins);
  return rounds.length ? Math.round((rounds.reduce((a, r) => a + (r.planUpdates ?? 0), 0) / rounds.length) * 100) / 100 : NA;
}

export function computeReport(matches: EvalMatch[]): EvalReport {
  const ai = changeOf(matches, "ai");
  const house = changeOf(matches, "house");
  return {
    version: 1,
    matches: matches.length,
    houseInAiPlace: !hasHouseSeats(matches),
    rounds: matches.reduce((a, m) => a + m.rounds.length, 0),
    seeds: matches.map((m) => m.seed),
    lineups: [...new Set(matches.map((m) => m.seats.join(",")))],
    variety: { ai: varietyOf(matches, "ai"), house: varietyOf(matches, "house") },
    change: { ai: ai.all, house: house.all, byFighter: { ...ai.byFighter, ...house.byFighter }, checkinsPerRound: checkinsPerRound(matches) },
    checkins: matches.some((m) => m.rounds.some((r) => r.checkins)) ? checkinStats(matches.map((m) => ({ rounds: m.rounds.map((r) => ({ checkins: r.checkins })) as never }))) : NA,
    rules: { ai: rulesOf(matches, "ai"), house: rulesOf(matches, "house") },
    follows: { ai: followsOf(matches, "ai"), house: followsOf(matches, "house") },
    facts: factsOf(matches),
    why: whyOf(matches),
    reliability: reliabilityOf(matches),
    results: resultsOf(matches),
  };
}

// ------------------------------------------------------------------ from a real match

/**
 * Build the eval input from a finished Match (its record meta and round
 * facts). `housePlans[round][seat]`: what the house bot would have planned.
 */
export function evalMatchFrom(match: Match, seats: string[], housePlans?: (Strategy | undefined)[][]): EvalMatch {
  return {
    seed: match.seed,
    names: match.names,
    seats: seats.slice(),
    winner: match.winner,
    rounds: match.record.rounds.map((rd, r) => {
      const f = match.facts[r]!;
      return {
        decisions: rd.strategies.map((s, i) => ({ strategy: s, line: rd.lines[i]!, meta: rd.meta?.[i] ?? { provider: "house", ms: 0, outcome: "house" as const }, ...(housePlans?.[r]?.[i] ? { house: housePlans[r]![i]! } : {}) })),
        facts: { winner: f.winner, ...checkFactsFromStats(f.stats), rules: f.stats.rules?.map((row) => row.map((x) => ({ ...x }))), kos: f.stats.kos.map((k) => ({ victim: k.victim, by: k.by, weapon: k.weapon, cause: k.cause })) },
        ...(rd.checkins ? { checkins: rd.checkins.map((c) => ({ ...c })), planUpdates: rd.planUpdates?.length ?? 0 } : {}),
      };
    }),
  };
}

// ------------------------------------------------------------------ compare
