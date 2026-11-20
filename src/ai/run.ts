/**
 * Play one AI match with no viewer (used by scripts/ai-eval.ts): ask every
 * seat before each round, play the round, collect prompts, raw answers, a
 * readable log and the eval input. Engine-driven fights; deterministic
 * given the decisions.
 */
import { formatSeconds } from "../format";
import { checkRecordEngine } from "../sim/engine-version";
import { Match, ReplayDivergedError, type MatchRecord } from "../sim/match";
import { Rng } from "../sim/rng";
import type { Strategy } from "../sim/sim";
import { houseStrategy } from "../sim/voice";
import type { Soul } from "../sim/soul";
import { decideRound, type Seat } from "./decide";
import { evalMatchFrom, targetLabel, type EvalMatch } from "./eval";

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
}

/**
 * Rebuild the eval input from a saved match record (exact replay, no AI
 * calls): lets new metrics run over old runs. `lineup` is the provider per seat.
 */
export function rescoreRecord(rec: MatchRecord, lineup: string[]): EvalMatch {
  checkRecordEngine(rec);
  const match = new Match(rec.seed, { recorded: rec });
  const housePlans: (Strategy | undefined)[][] = [];
  while (!match.over) {
    const round = match.round + 1;
    housePlans.push(lineup.map((p, i) => (p !== "house" ? shadowPlan(match, round, i) : undefined)));
    match.prepareRound();
    while (!match.step()) {
      /* replay */
    }
    match.finishRound();
  }
  if (match.diverged >= 0) throw new ReplayDivergedError(match.diverged);
  return evalMatchFrom(match, lineup, housePlans);
}

export async function playAiMatch(seed: number, seats: Seat[], souls: Soul[], deadlineMs?: number): Promise<PlayedMatch> {
  const t0 = performance.now();
  const match = new Match(seed, { souls });
  const names = match.names;
  const log: string[] = [`seed ${seed}: ${names.map((n, i) => `${n}=${seats[i]!.provider?.label ?? "house"}`).join(", ")}; level ${match.level.theme}`];
  const prompts: PlayedMatch["prompts"] = [];
  const housePlans: (Strategy | undefined)[][] = [];
  while (!match.over) {
    const round = match.round + 1;
    // for comparison: the house bot's plan in each AI seat's place (own rng: the match is unchanged)
    housePlans.push(seats.map((s, i) => (s.provider ? shadowPlan(match, round, i) : undefined)));
    const ask = await decideRound(match, seats, deadlineMs);
    prompts.push({ round, prompts: ask.prompts, raw: ask.raw });
    ask.decisions.forEach((d, i) => {
      const m = ask.meta[i]!;
      const s = d.strategy;
      log.push(`  r${round} ${names[i]!.padEnd(12)} [${m.provider}${m.outcome === "house" ? "" : ` ${formatSeconds(m.ms)}`}${m.outcome === "ok" || m.outcome === "house" ? "" : ` ${m.outcome}${m.detail ? ` (${m.detail})` : ""}`}] ${s.stance}, wants ${s.weapons.join(">")}, -> ${targetLabel(s, names)}, retaliate ${s.retaliate ?? "turn"}: "${d.line}"`);
    });
    match.prepareRound(ask.decisions, ask.meta);
    while (!match.step()) {
      /* the engine plays the round */
    }
    const f = match.finishRound();
    log.push(`  r${round} -> ${names[f.winner]} wins after ${f.seconds.toFixed(0)} s; ${f.stats.kos.map((k) => `${names[k.victim]} ${k.cause === "ringout" ? "rung out" : "KO"}${k.by >= 0 && k.by !== k.victim ? ` by ${names[k.by]}` : ""} (${k.weapon})`).join(", ")}`);
  }
  log.push(`  match -> ${names[match.winner]} (${match.wins.join("-")})`);
  return { match, eval: evalMatchFrom(match, seats.map((s) => (s.provider ? s.providerName : "house")), housePlans), prompts, log, ms: performance.now() - t0 };
}
