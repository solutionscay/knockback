/**
 * A match: best of 3 rounds on one generated level. First to 2 round wins
 * takes it; round 3 is played only if needed. Each round is a fresh Fight on
 * the same level (destruction and health reset), with its own physics seed.
 * Morale carries over between rounds.
 *
 * Before each round every fighter's Brain (voice.ts) returns { line, strategy }.
 * The MatchRecord stores those decisions, so a replay is exact even when an
 * AI (nondeterministic) made them.
 *
 * Round 3 is the decider: if nobody has 2 wins after it (with four fighters,
 * three rounds can have three different winners), the round-3 winner still
 * takes the match. Winner takes all.
 */
import { CHARACTERS } from "./characters";
import { Fight, type FightRecord, type FightResult } from "./fight";
import { generateLevel, type LevelDef } from "./levelgen";
import { initialMorale, updateMorale, type Morale, type RoundFacts } from "./morale";
import { Rng } from "./rng";
import type { SimEvent, Strategy } from "./sim";
import { houseBrain, VoiceSession, type Brain, type Decision, type DecideContext } from "./voice";

export const ROUNDS_TO_WIN = 2;
export const MAX_ROUNDS = 3;

/** Who made a decision and how it went (AI matches). */
export interface DecisionMeta {
  /** e.g. "claude/haiku", or "house" */
  provider: string;
  ms: number;
  outcome: "ok" | "fallback-timeout" | "fallback-invalid" | "fallback-error" | "house";
  /** what was wrong, for the log */
  detail?: string;
  /** the AI's own line, when its plan was rejected but the line was usable */
  aiLine?: string;
}

export interface RoundRecord {
  physicsSeed: number;
  /** provider/timing per fighter, when decisions came from outside (AI) */
  meta?: DecisionMeta[];
  phase: "intro" | "between";
  strategies: Strategy[];
  lines: string[];
  fight: FightRecord;
  winner: number;
}

export interface MatchRecord {
  version: 1;
  /** match seed: makes the level; round physics seeds derive from it */
  seed: number;
  rounds: RoundRecord[];
  winner: number;
  wins: number[];
}

export interface MatchOptions {
  /** one decision function per fighter (default: houseBrain for all) */
  brains?: Brain[];
  session?: VoiceSession;
  /** replay these recorded decisions instead of asking the brains */
  recorded?: MatchRecord;
  /** A/B switch: morale still tracked, but no behavior nudges */
  noMoraleEffect?: boolean;
}

export type MatchPhase = "planning" | "fighting" | "between" | "over";

/** Who has won the match so far (or -1 if it continues). Pure. */
export function matchWinner(wins: readonly number[], roundWinners: readonly number[]): number {
  const top = Math.max(...wins);
  if (top >= ROUNDS_TO_WIN) return wins.indexOf(top);
  if (roundWinners.length >= MAX_ROUNDS) return roundWinners[roundWinners.length - 1]!; // the decider
  return -1;
}

export function physicsSeed(seed: number, round: number): number {
  return (Math.imul((seed >>> 0) ^ 0x6a09e667, 0x9e3779b1) + round * 0x85ebca6b) >>> 0;
}

export class Match {
  readonly level: LevelDef;
  readonly brains: Brain[];
  readonly session: VoiceSession;
  readonly record: MatchRecord;
  round = 0;
  wins = [0, 0, 0, 0];
  kos = [0, 0, 0, 0];
  damage = [0, 0, 0, 0];
  morale: Morale[];
  /** morale state at the start of each round (for stats) */
  moraleAtStart: Morale[][] = [];
  facts: RoundFacts[] = [];
  results: FightResult[] = [];
  fight: Fight | null = null;
  decisions: Decision[] = [];
  phase: MatchPhase = "planning";
  winner = -1;
  private lineRng: Rng;
  private strategyRng: Rng;
  onEvent: ((e: SimEvent) => void) | null = null;

  constructor(
    readonly seed: number,
    readonly opts: MatchOptions = {},
  ) {
    this.level = generateLevel(seed);
    this.brains = opts.brains ?? CHARACTERS.map(() => houseBrain);
    this.session = opts.session ?? new VoiceSession();
    this.morale = initialMorale(CHARACTERS.map((c) => c.moraleBaseline));
    this.lineRng = new Rng((seed ^ 0x11e5f00d) >>> 0);
    this.strategyRng = new Rng((seed ^ 0x57a7e9) >>> 0);
    this.record = { version: 1, seed, rounds: [], winner: -1, wins: this.wins };
  }

  get names(): string[] {
    return CHARACTERS.map((c) => c.name);
  }

  get over(): boolean {
    return this.phase === "over";
  }

  /**
   * Ask every fighter for { line, strategy } and set up the next round's fight.
   * Returns the decisions (the viewer shows the lines, one fighter at a time).
   */
  /** What a fighter's brain gets to see before the next round (also what the AI prompt is built from). */
  contextFor(me: number): DecideContext {
    const round = this.round + 1;
    return {
      phase: round === 1 ? "intro" : "between",
      round,
      me,
      names: this.names,
      wins: this.wins.slice(),
      morale: this.morale.map((m) => ({ ...m })),
      last: this.facts[this.facts.length - 1] ?? null,
      history: this.facts.slice(),
      session: this.session,
      lineRng: this.lineRng,
      strategyRng: this.strategyRng,
    };
  }

  /**
   * Set up the next round. Decisions come from (in order): `decisions` passed
   * in (e.g. AI answers gathered asynchronously), the replay record, or the
   * brains (house bots by default).
   */
  prepareRound(external?: Decision[], meta?: DecisionMeta[]): Decision[] {
    if (this.phase === "over") throw new Error("match is over");
    const rec = this.opts.recorded?.rounds[this.round];
    const decisions: Decision[] = external
      ? external.map((d) => ({ ...d, strategy: { ...d.strategy } }))
      : rec
        ? rec.strategies.map((s, i) => ({ line: rec.lines[i]!, strategy: { ...s } }))
        : this.brains.map((brain, me) => brain(this.contextFor(me)));
    if (!meta && rec?.meta) meta = rec.meta;
    this.round++;
    const phase = this.round === 1 ? "intro" : "between";
    this.decisions = decisions;
    const ps = physicsSeed(this.seed, this.round);
    this.moraleAtStart.push(this.morale.map((m) => ({ ...m })));
    this.fight = new Fight(
      ps,
      decisions.map((d) => d.strategy),
      { level: this.level, morale: this.morale.map((m) => m.state), noMoraleEffect: this.opts.noMoraleEffect },
    );
    this.fight.onEvent = (e) => this.onEvent?.(e);
    this.record.rounds.push({
      physicsSeed: ps,
      phase,
      strategies: decisions.map((d) => ({ ...d.strategy })),
      lines: decisions.map((d) => d.line),
      fight: this.fight.record,
      winner: -1,
      ...(meta ? { meta: meta.map((m) => ({ ...m })) } : {}),
    });
    this.phase = "fighting";
    return decisions;
  }

  /** One physics tick of the current round. True once the round is over. */
  step(): boolean {
    if (!this.fight || this.phase !== "fighting") return true;
    return this.fight.step();
  }

  /** Close the round: facts, wins, morale, match result. */
  finishRound(): RoundFacts {
    const fight = this.fight!;
    const res = fight.result();
    const facts = fight.facts(this.round);
    this.results.push(res);
    this.facts.push(facts);
    this.wins[res.winner]!++;
    for (let i = 0; i < 4; i++) {
      this.kos[i]! += res.kos[i]!;
      this.damage[i]! += res.damage[i]!;
    }
    this.morale = updateMorale(this.morale, facts, this.wins);
    this.record.rounds[this.round - 1]!.winner = res.winner;
    this.winner = matchWinner(
      this.wins,
      this.results.map((r) => r.winner),
    );
    if (this.winner >= 0) {
      this.phase = "over";
      this.record.winner = this.winner;
    } else this.phase = "between";
    return facts;
  }

  playRound(): RoundFacts {
    this.prepareRound();
    while (!this.step()) {
      /* step */
    }
    return this.finishRound();
  }

  playToEnd(): void {
    while (!this.over) this.playRound();
  }

  /** How the match was decided. */
  decidedBy(): "two-wins" | "decider" {
    return Math.max(...this.wins) >= ROUNDS_TO_WIN ? "two-wins" : "decider";
  }
}

/** Replay a whole match from its record (recorded decisions, same seeds). */
export function replayMatch(record: MatchRecord): Match {
  const m = new Match(record.seed, { recorded: record });
  m.playToEnd();
  return m;
}
