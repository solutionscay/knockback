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
import { checkRecordEngine, ENGINE_VERSION } from "./engine-version";
import { Fight, type FightRecord, type FightResult, type PlanUpdate } from "./fight";
import { generateLevel, type LevelDef } from "./levelgen";
import { initialMorale, updateMorale, type Morale, type RoundFacts } from "./morale";
import { Rng } from "./rng";
import type { SimEvent, Strategy } from "./sim";
import { assignIdentities, legacyIdentities, sanitizeIdentity, type Identity, type IdentityWish } from "./identity";
import { soulRecord, TEMPERAMENT_MORALE, type Soul } from "./soul";
import { exampleSouls } from "./souls";
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
  /** the AI's short reason for its plan, in game terms (#3; optional) */
  why?: string;
  /** the line accuses someone in a way last round's facts don't support (#4; logged, never rejected) */
  factWarnings?: string[];
  /** rules the parser dropped, and why (#5; the plan stays valid) */
  ruleProblems?: string[];
  /** a second, hedged call was made because the first was slow (#14) */
  hedged?: boolean;
}

/** A plan update during a round (#8): applied by the engine at its tick (fight.ts), shown by the viewer (#10). */
export type { PlanUpdate };

/** One fighter's mid-round check-in (#9) and how it went: logged in the round record, never replayed. */
export interface CheckinMeta {
  /** the check-in tick (the fight paused for nobody: the answer applies later) */
  tick: number;
  fighter: number;
  provider: string;
  /** answer time (wall clock) */
  ms: number;
  outcome: "update" | "keep" | "missed" | "invalid" | "error" | "late" | "autopilot";
  /** the tick the update applies at (outcome "update") */
  applyTick?: number;
  /** the plan fields that changed */
  changed?: string[];
  detail?: string;
  /** prompt and answer size in characters (cost: about 4 characters a token) */
  promptChars?: number;
  answerChars?: number;
}

export interface RoundRecord {
  physicsSeed: number;
  /** provider/timing per fighter, when decisions came from outside (AI) */
  meta?: DecisionMeta[];
  phase: "intro" | "between";
  /** mid-round plan updates (#8), sorted by tick then fighter; the engine applies them at their ticks */
  planUpdates?: PlanUpdate[];
  /** every mid-round check-in and its outcome (#9; log only) */
  checkins?: CheckinMeta[];
  strategies: Strategy[];
  lines: string[];
  fight: FightRecord;
  winner: number;
}

export interface MatchRecord {
  /**
   * 4: generated identities (#17); souls have no name or look.
   * 3: plans may carry rules (#5). 2: no rules. Versions 2 and 3 still load:
   * their souls' names, colors and marks become the identities.
   */
  version: 2 | 3 | 4;
  /** engine version that made the record (src/sim/engine-version.ts); missing = 0. Not hashed. */
  engine?: number;
  /** the souls that played (personality, voice, lines): a replay needs no files */
  souls: Soul[];
  /** each seat's generated name and look (version 4) */
  identities?: Identity[];
  /** match seed: makes the level; round physics seeds derive from it */
  seed: number;
  rounds: RoundRecord[];
  winner: number;
  wins: number[];
}

export interface MatchOptions {
  /** one soul per seat (default: the four example souls in souls/) */
  souls?: Soul[];
  /** identity wishes per seat (#19: an AI picks its own name or look); the rest comes from the seed */
  identityWishes?: (IdentityWish | undefined)[];
  /** one decision function per fighter (default: houseBrain for all) */
  brains?: Brain[];
  session?: VoiceSession;
  /** replay these recorded decisions instead of asking the brains */
  recorded?: MatchRecord;
  /** A/B switch: morale still tracked, but no behavior nudges */
  noMoraleEffect?: boolean;
  /** house bots add plan rules from their souls (#6; default on) */
  houseRules?: boolean;
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
  readonly souls: Soul[];
  /** each seat's generated name and look for this match (#17) */
  readonly identities: Identity[];
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
  /** replaying a record: the first round whose end state differs from the record (-1 = none) */
  diverged = -1;
  winner = -1;
  private lineRng: Rng;
  private strategyRng: Rng;
  onEvent: ((e: SimEvent) => void) | null = null;

  constructor(
    readonly seed: number,
    readonly opts: MatchOptions = {},
  ) {
    this.level = generateLevel(seed);
    if (opts.recorded) checkRecordVersion(opts.recorded);
    this.souls = (opts.recorded?.souls ?? opts.souls ?? exampleSouls()).map(soulRecord);
    if (this.souls.length !== 4) throw new Error("a match needs 4 souls");
    this.identities = matchIdentities(seed, opts);
    this.brains = opts.brains ?? this.souls.map(() => houseBrain);
    this.session = opts.session ?? new VoiceSession();
    this.morale = initialMorale(this.souls.map((s) => TEMPERAMENT_MORALE[s.temperament]));
    this.lineRng = new Rng((seed ^ 0x11e5f00d) >>> 0);
    this.strategyRng = new Rng((seed ^ 0x57a7e9) >>> 0);
    this.record = { version: 4, engine: ENGINE_VERSION, seed, souls: this.souls.map(soulRecord), identities: this.identities.map((i) => ({ ...i })), rounds: [], winner: -1, wins: this.wins };
  }

  get names(): string[] {
    return this.identities.map((i) => i.name);
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
      souls: this.souls,
      wins: this.wins.slice(),
      morale: this.morale.map((m) => ({ ...m })),
      last: this.facts[this.facts.length - 1] ?? null,
      history: this.facts.slice(),
      session: this.session,
      lineRng: this.lineRng,
      strategyRng: this.strategyRng,
      houseRules: this.opts.houseRules ?? true,
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
        ? rec.strategies.map((s, i) => ({ line: rec.lines[i]!, strategy: { ...s, weapons: (s.weapons ?? []).slice() } }))
        : this.brains.map((brain, me) => brain(this.contextFor(me)));
    if (!meta && rec?.meta) meta = rec.meta;
    this.round++;
    const phase = this.round === 1 ? "intro" : "between";
    this.decisions = decisions;
    const ps = physicsSeed(this.seed, this.round);
    this.moraleAtStart.push(this.morale.map((m) => ({ ...m })));
    // a replay applies the record's mid-round plan updates at their ticks (#8)
    const updates = rec ? (rec.planUpdates ?? rec.fight?.updates ?? []) : [];
    this.fight = new Fight(
      ps,
      decisions.map((d) => d.strategy),
      { level: this.level, morale: this.morale.map((m) => m.state), noMoraleEffect: this.opts.noMoraleEffect, looks: this.identities },
      updates,
    );
    this.fight.onEvent = (e) => this.onEvent?.(e);
    this.record.rounds.push({
      physicsSeed: ps,
      phase,
      strategies: decisions.map((d) => ({ ...d.strategy, weapons: d.strategy.weapons.slice() })),
      lines: decisions.map((d) => d.line),
      fight: this.fight.record,
      winner: -1,
      ...(meta ? { meta: meta.map((m) => ({ ...m })) } : {}),
      // the fight's own sorted list: updates added later (addUpdate) show up here too
      ...(this.fight.planUpdates.length ? { planUpdates: this.fight.planUpdates as PlanUpdate[] } : {}),
      ...(rec?.checkins?.length ? { checkins: rec.checkins.map((c) => ({ ...c })) } : {}),
    });
    this.phase = "fighting";
    return decisions;
  }

  /** One physics tick of the current round. True once the round is over. */
  step(): boolean {
    if (!this.fight || this.phase !== "fighting") return true;
    return this.fight.step();
  }

  /**
   * Run the current round until its sim reaches `tick` (or the round ends).
   * True once the round is over. With addUpdate this lets the check-in loop
   * stop the sim at a check-in tick and go on later (#8).
   */
  stepUntil(tick: number): boolean {
    const f = this.fight;
    if (!f || this.phase !== "fighting") return true;
    while (!f.over && f.sim.tick < tick) f.step();
    return f.over;
  }

  /**
   * Add a plan update to the current round: it applies at its tick and is
   * saved in the round record (sorted). A tick that has passed is an error.
   */
  addUpdate(u: PlanUpdate) {
    const f = this.fight;
    if (!f || this.phase !== "fighting") throw new Error("no round is being fought");
    f.addUpdate(u);
    this.record.rounds[this.round - 1]!.planUpdates = f.planUpdates as PlanUpdate[];
  }

  /** Close the round: facts, wins, morale, match result. */
  finishRound(): RoundFacts {
    const fight = this.fight!;
    const res = fight.result();
    const facts = fight.facts(this.round);
    // replaying a record: it must end in the recorded state, or the record came from another engine version
    const want = this.opts.recorded?.rounds[this.round - 1]?.fight.finalHash;
    if (want && want !== fight.record.finalHash && this.diverged < 0) this.diverged = this.round;
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

/**
 * The identities of a match: a record's own (version 4), an old record's
 * souls (versions 2 and 3), or generated from the seed and any wishes.
 */
export function matchIdentities(seed: number, opts: Pick<MatchOptions, "recorded" | "identityWishes">): Identity[] {
  const rec = opts.recorded;
  if (rec && Array.isArray(rec.identities) && rec.identities.length === 4) {
    const gen = assignIdentities(seed);
    return rec.identities.map((v, i) => sanitizeIdentity(v, i, gen[i]!));
  }
  if (rec) return legacyIdentities(seed, rec.souls);
  return assignIdentities(seed, opts.identityWishes);
}

/** Match record versions this engine loads; anything else is refused with a clear message. */
export const RECORD_VERSIONS = [2, 3, 4] as const;
export function checkRecordVersion(rec: { version?: unknown; souls?: unknown }) {
  if (!(RECORD_VERSIONS as readonly unknown[]).includes(rec.version) || !Array.isArray(rec.souls))
    throw new Error(`can't load this match record: version ${JSON.stringify(rec.version)}${Array.isArray(rec.souls) ? "" : " without souls"}; this engine loads versions ${RECORD_VERSIONS.slice(0, -1).join(", ")} and ${RECORD_VERSIONS[RECORD_VERSIONS.length - 1]} (version 1 records come from the classes engine)`);
}

/** Replay a whole match from its record (recorded decisions, same seeds). */
export function replayMatch(record: MatchRecord): Match {
  checkRecordEngine(record); // another engine's physics can't replay it: refuse before simulating
  const m = new Match(record.seed, { recorded: record });
  m.playToEnd();
  if (m.diverged >= 0) throw new ReplayDivergedError(m.diverged);
  return m;
}

/** A record that no longer replays to its recorded state (made by an older engine). */
export class ReplayDivergedError extends Error {
  constructor(readonly round: number) {
    super(`this record does not replay with the current engine: round ${round} ends in a different state than recorded (it was made by an older engine version); replay it from the commit that made it`);
  }
}
