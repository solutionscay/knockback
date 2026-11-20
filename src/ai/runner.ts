/**
 * MatchRunner: one best-of-3 match with any mix of seats (house bot, local AI
 * provider, remote agent), the loop that scripts/ai-match.ts used to own.
 *
 * Before each round every seat is asked in parallel (decideRound: per-seat
 * deadline, house-bot fallback), the engine plays the round headless at once
 * (deterministic), and the runner emits the same events the viewer's live
 * stream understands (`match`, `decisions`, `done`) plus a `round` summary.
 * The record (seed + every decision) replays with no network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSeconds } from "../format";
import type { IdentityWish } from "../sim/identity";
import { Match, type DecisionMeta, type MatchRecord } from "../sim/match";
import type { RoundFacts } from "../sim/morale";
import type { Soul } from "../sim/soul";
import { houseBrain, type Decision } from "../sim/voice";
import { decideRound, type RoundAsk, type Seat } from "./decide";

/** The live stream events (the viewer reads `match`, `decisions` and `done`; others are ignored by it). */
export type RunnerEvent =
  | { type: "match"; seed: number; labels: string[]; names: string[]; souls: Match["souls"]; identities: Match["identities"]; theme: string }
  | { type: "decisions"; round: number; decisions: Decision[]; meta: DecisionMeta[] }
  | { type: "round"; round: number; winner: number; seconds: number; reason: string; wins: number[]; kos: RoundFacts["stats"]["kos"]; summary: string[] }
  | { type: "done"; record: string | null; winner: number; wins: number[] };

export interface RunnerOptions {
  seed: number;
  seats: Seat[];
  /** overrides every seat's own deadline (the --deadline flag) */
  deadlineMs?: number;
  /** label per seat (default: the provider label, or "house") */
  labels?: string[];
  /** provider name per seat, saved in the record (default: seat.providerName) */
  lineup?: string[];
  identityWishes?: (IdentityWish | undefined)[];
  /** called for every live event, in order */
  onEvent?: (e: RunnerEvent) => void;
  /** called for every log line (default: nothing) */
  onLog?: (line: string) => void;
  /** a round's decisions are in, before it is played (persist them here: the round can be replayed from them) */
  onDecided?: (round: number, ask: RoundAsk) => Promise<void> | void;
  /** a round has been played */
  onPlayed?: (round: number, finalHash: string) => Promise<void> | void;
}

/** A stored round: what decideRound returned for it. */
export type StoredRound = Pick<RoundAsk, "decisions" | "meta" | "prompts" | "raw"> & { finalHash?: string | null };

/** Replaying stored rounds did not reproduce the match (a different engine, or a corrupt store). */
export class ResumeError extends Error {}

export interface RoundPrompts {
  round: number;
  prompts: string[];
  raw: (string | null)[];
}

export class MatchRunner {
  readonly match: Match;
  readonly labels: string[];
  readonly lineup: string[];
  readonly log: string[] = [];
  readonly prompts: RoundPrompts[] = [];
  readonly events: RunnerEvent[] = [];
  totalMs = 0;
  /** file name of the saved record, once saved */
  recordFile: string | null = null;
  private t0 = 0;

  constructor(readonly opts: RunnerOptions) {
    const souls: Soul[] = opts.seats.map((s) => s.soul);
    this.match = new Match(opts.seed, { souls, ...(opts.identityWishes ? { identityWishes: opts.identityWishes } : {}) });
    this.labels = opts.labels ?? opts.seats.map((s) => s.provider?.label ?? "house");
    this.lineup = opts.lineup ?? opts.seats.map((s) => s.providerName);
  }

  get names(): string[] {
    return this.match.names;
  }

  private emit(e: RunnerEvent) {
    this.events.push(e);
    this.opts.onEvent?.(e);
  }

  /** A line for the saved log (and onLog). */
  say(s: string) {
    this.log.push(s);
    this.opts.onLog?.(s);
  }

  /** Announce the match (the viewer starts drawing the level and the intro). */
  start() {
    this.t0 = performance.now();
    const m = this.match;
    this.emit({ type: "match", seed: m.seed, labels: this.labels, names: m.names, souls: m.souls, identities: m.identities, theme: m.level.theme });
  }

  private stratText(s: { stance: string; weapons: string[]; target: string; grudge?: number; retaliate?: string }) {
    return `${s.stance}, wants ${s.weapons.join(" > ")} -> ${s.target === "grudge" && s.grudge !== undefined ? this.names[s.grudge] : s.target}, retaliate ${s.retaliate ?? "turn"}`;
  }

  /** Ask every seat, then play one round. */
  async playRound(): Promise<RoundFacts> {
    const match = this.match;
    const names = this.names;
    const round = match.round + 1;
    const askStart = performance.now();
    const ask = await decideRound(match, this.opts.seats, this.opts.deadlineMs);
    const askMs = Math.round(performance.now() - askStart);
    await this.opts.onDecided?.(round, ask);
    return this.applyRound(round, ask, askMs);
  }

  /**
   * Play a stored round again (resuming after a restart): the same decisions
   * give the same fight. The house bot draws from the match's shared random
   * streams when it plans, so its draws for that round are made again, in
   * decideRound's order (every seat that did not answer "ok", by seat), and
   * checked against the stored decisions; otherwise later rounds would
   * differ. Throws ResumeError if the decisions or the final hash differ.
   */
  async replayRound(stored: StoredRound): Promise<RoundFacts> {
    const match = this.match;
    const round = match.round + 1;
    const ctxs = this.opts.seats.map((_, me) => match.contextFor(me));
    stored.meta.forEach((m, me) => {
      if (m.outcome === "ok") return;
      const bot = JSON.stringify(houseBrain(ctxs[me]!));
      // fallback-invalid keeps the AI's usable half of the answer, so only the others must equal the bot exactly
      if (m.outcome !== "fallback-invalid" && bot !== JSON.stringify(stored.decisions[me])) throw new ResumeError(`round ${round}, seat ${me}: the house bot's plan differs from the stored one`);
    });
    const f = await this.applyRound(round, { decisions: stored.decisions, meta: stored.meta, prompts: stored.prompts, raw: stored.raw }, 0, true);
    const hash = match.record.rounds[round - 1]!.fight.finalHash;
    if (stored.finalHash && stored.finalHash !== hash) throw new ResumeError(`round ${round} replayed to ${hash}, stored ${stored.finalHash}`);
    return f;
  }

  private async applyRound(round: number, ask: RoundAsk, askMs: number, replayed = false): Promise<RoundFacts> {
    const match = this.match;
    const names = this.names;
    this.prompts.push({ round, prompts: ask.prompts, raw: ask.raw });
    this.emit({ type: "decisions", round, decisions: ask.decisions, meta: ask.meta });
    this.say(replayed ? `ROUND ${round} plans (replayed from storage)` : `ROUND ${round} plans (${formatSeconds(askMs)} to decide)`);
    ask.decisions.forEach((d, i) => {
      const m = ask.meta[i]!;
      const tag = m.outcome === "ok" ? `${m.provider} ${formatSeconds(m.ms)}` : `${m.provider} ${formatSeconds(m.ms)} ${m.outcome.toUpperCase()}${m.detail ? ` (${m.detail})` : ""}`;
      this.say(`  ${names[i]!.padEnd(12)} [${tag}] "${d.line}"`);
      this.say(`  ${" ".repeat(8)}  plan: ${this.stratText(d.strategy)}`);
    });
    match.prepareRound(ask.decisions, ask.meta);
    while (!match.step()) {
      /* the engine plays the round */
    }
    const f = match.finishRound();
    this.say(`  -> ${names[f.winner]} wins round ${round} after ${f.seconds.toFixed(0)} s (wins ${match.wins.join("-")})`);
    for (const k of f.stats.kos) this.say(`     ${names[k.victim]} ${k.cause === "ringout" ? "rung out" : "knocked out"}${k.by >= 0 && k.by !== k.victim ? ` by ${names[k.by]}` : ""} (${k.weapon})`);
    f.stats.summary.forEach((s, i) => this.say(`     ${names[i]}: ${s}`));
    const reflexes = match.fight!.controllers.flatMap((c, i) => c.reflexLog.map((r) => `${names[i]} turned on ${names[r.attacker]} (${r.mode}) at ${(r.tick / 60).toFixed(0)} s`));
    if (reflexes.length) this.say(`     reflexes: ${reflexes.join("; ")}`);
    this.say("");
    this.emit({ type: "round", round, winner: f.winner, seconds: f.seconds, reason: f.reason, wins: match.wins.slice(), kos: f.stats.kos, summary: f.stats.summary.slice() });
    if (!replayed) await this.opts.onPlayed?.(round, match.record.rounds[round - 1]!.fight.finalHash);
    return f;
  }

  /** Play the whole match (start() first if not started) and write the summary lines. */
  async run(): Promise<Match> {
    if (!this.t0) this.start();
    while (!this.match.over) await this.playRound();
    this.totalMs = performance.now() - this.t0;
    this.summary();
    return this.match;
  }

  private summary() {
    const match = this.match;
    const names = this.names;
    this.say(`MATCH: ${names[match.winner]} wins ${match.wins.join("-")} (${match.decidedBy()}), ${match.round} rounds, ${formatSeconds(this.totalMs)} total`);
    this.say(`\nResponse times and fallbacks:`);
    names.forEach((n, i) => {
      const ms = match.record.rounds.map((r) => r.meta?.[i]).filter((m) => m && m.outcome !== "house");
      const okMs = ms.filter((m) => m!.outcome === "ok").map((m) => m!.ms);
      const fb = ms.filter((m) => m!.outcome.startsWith("fallback"));
      const avg = okMs.length ? okMs.reduce((a, b) => a + b, 0) / okMs.length : 0;
      this.say(
        `  ${n.padEnd(12)} ${this.labels[i]!.padEnd(18)} ${okMs.map(formatSeconds).join(", ") || "-"}${okMs.length ? `  (avg ${formatSeconds(avg)})` : ""}  fallbacks: ${fb.length}${fb.length ? " " + fb.map((m) => `${m!.outcome}${m!.detail ? ` [${m!.detail}]` : ""}`).join("; ") : ""}`,
      );
    });
  }

  /** The record as saved: the match record plus labels, lineup and total time. */
  savedRecord(): MatchRecord & { labels: string[]; lineup: string[]; totalMs: number } {
    return { ...this.match.record, labels: this.labels, lineup: this.lineup, totalMs: Math.round(this.totalMs) };
  }

  /**
   * Write `<prefix>-<seed>-<time>.json` (+ .log.txt, .prompts.json) to `outDir`
   * and emit `done`. Returns the record's file name.
   */
  save(outDir: string, prefix = "ai"): string {
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = `${prefix}-${this.match.seed}-${stamp}.json`;
    writeFileSync(join(outDir, file), JSON.stringify(this.savedRecord(), null, 2));
    writeFileSync(join(outDir, file.replace(/\.json$/, ".log.txt")), this.log.join("\n") + "\n");
    writeFileSync(join(outDir, file.replace(/\.json$/, ".prompts.json")), JSON.stringify(this.prompts, null, 2));
    this.recordFile = file;
    this.emit({ type: "done", record: `/records/${file}`, winner: this.match.winner, wins: this.match.wins.slice() });
    return file;
  }
}
