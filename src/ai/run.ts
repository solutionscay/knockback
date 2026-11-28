/**
 * Play one AI match with no viewer (used by scripts/ai-eval.ts): ask every
 * seat before each round, play the round, collect prompts, raw answers, a
 * readable log and the eval input. Sim-driven fights; deterministic
 * given the decisions.
 */
import { decisionTag, knockoutText } from "./runner-log";
import { Match, ReplayDivergedError, type MatchRecord } from "../sim/match";
import { Rng } from "../sim/rng";
import type { Strategy } from "../sim/sim-types";
import { houseStrategy } from "../sim/voice";
import type { Soul } from "../sim/soul";
import type { Seat } from "./decide";
import { evalMatchFrom } from "./eval";
import { targetLabel } from "./eval-metrics";
import { type EvalMatch } from "./eval-types";
import type { CheckinConfig } from "./checkin";
import { playRoundHeadless } from "./round";
import { MatchRunner } from "./runner";
import { suitUp } from "./suitup";

/** For comparison, use an independent strategy RNG for the house plan in an AI seat. */
function shadowPlan(match: Match, round: number, seat: number): Strategy {
  return houseStrategy({ ...match.contextFor(seat), strategyRng: new Rng((match.seed ^ (round * 0x9e37) ^ (seat * 0x85eb)) >>> 0) });
}

export interface PlayedMatch {
  match: Match;
  eval: EvalMatch;
  prompts: { round: number; prompts: string[]; raw: (string | null)[] }[];
  log: string[];
  ms: number;
  /** check-in prompts and answers (#9), when check-ins were on */
  checkinPrompts?: MatchRunner["checkins"]["prompts"];
}

/**
 * Rebuild the eval input from a saved match record (exact replay, no AI
 * calls): lets new metrics run over old runs. `lineup` is the provider per seat.
 */
export function rescoreRecord(rec: MatchRecord, lineup: string[]): EvalMatch {
  const match = new Match(rec.seed, { recorded: rec });
  const housePlans: (Strategy | undefined)[][] = [];
  while (!match.over) {
    const round = match.round + 1;
    housePlans.push(lineup.map((p, i) => (p !== "house" ? shadowPlan(match, round, i) : undefined)));
    playRoundHeadless(match);
  }
  if (match.diverged >= 0) throw new ReplayDivergedError(match.diverged);
  return evalMatchFrom(match, lineup, housePlans);
}

/** Run an evaluation and collect the comparison plans before each fight. */
export async function playAiMatch(seed: number, seats: Seat[], souls: Soul[], deadlineMs?: number, checkins?: false | Partial<CheckinConfig>, opts: { suitUp?: boolean } = {}): Promise<PlayedMatch> {
  // the suit-up (#19): each AI seat chooses its name and look first (off: the seeded identities)
  const suitLog: string[] = [];
  const su = opts.suitUp === false || !seats.some((s) => s.provider) ? null : await suitUp(seed, seats.map((s, i) => ({ provider: s.provider, soul: souls[i] ?? s.soul })), { log: (l) => suitLog.push(`  ${l}`) });
  const t0 = performance.now();
  const housePlans: (Strategy | undefined)[][] = [];
  const log: string[] = [];
  const shadow = (round: number) => {
    housePlans.push(seats.map((s, i) => s.provider ? shadowPlan(runner.match, round, i) : undefined));
  };
  const runner: MatchRunner = new MatchRunner({
    seed, seats, deadlineMs, checkins, ...(su ? { suitUp: su } : {}),
    ...(!checkins ? { souls, beforeAsk: shadow } : {}),
    onDecided(round, ask) {
      if (checkins) return shadow(round);
      ask.decisions.forEach((d, i) => {
        const strategy = d.strategy;
        log.push(`  r${round} ${names[i]!.padEnd(12)} [${decisionTag(ask.meta[i]!, true)}] ${strategy.stance}, wants ${strategy.weapons.join(">")}, -> ${targetLabel(strategy, names)}, retaliate ${strategy.retaliate ?? "turn"}: "${d.line}"`);
      });
    },
    onPlayed(round) {
      if (checkins) return;
      const f = runner.match.facts[round - 1]!;
      log.push(`  r${round} -> ${names[f.winner]} wins after ${f.seconds.toFixed(0)} s; ${f.stats.kos.map((k) => knockoutText(k, names, "KO")).join(", ")}`);
    },
  });
  const names = runner.names;
  log.push(`seed ${seed}: ${names.map((n, i) => `${n}=${seats[i]!.provider?.label ?? "house"}`).join(", ")}; level ${runner.match.level.theme}${checkins ? "; check-ins on" : ""}`, ...suitLog);
  const match = await runner.run();
  if (checkins) log.push(...runner.log.map((line) => `  ${line}`));
  else log.push(`  match -> ${names[match.winner]} (${match.wins.join("-")})`);
  return {
    match, eval: evalMatchFrom(match, seats.map((s) => s.provider ? s.providerName : "house"), housePlans),
    prompts: runner.prompts, log, ms: performance.now() - t0,
    ...(checkins ? { checkinPrompts: runner.checkins.prompts } : {}),
  };
}
