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
import { playbackAt, roundPlayback, type RoundPlayback } from "../flow/pacing";
import { DEFAULT_TIMING } from "../flow/beats";

/** The live stream events (the viewer reads `match`, `decisions` and `done`; others are ignored by it). */
export type RunnerEvent =
  | { type: "match"; seed: number; labels: string[]; names: string[]; souls: Match["souls"]; identities: Match["identities"]; theme: string }
  | { type: "decisions"; round: number; decisions: Decision[]; meta: DecisionMeta[] }
  | { type: "round"; round: number; winner: number; seconds: number; reason: string; wins: number[]; kos: RoundFacts["stats"]["kos"]; summary: string[] }
  | { type: "done"; record: string | null; winner: number; wins: number[] }
  | ({ type: "control" } & ControlEvent);

/**
 * Who controls a fighter, as it changes (#22): the house bot takes over a
 * remote seat whose agent dropped or missed a deadline ("autopilot"), and the
 * agent gets it back at a later round ("agent"). Saved in the record, so a
 * replay shows the same callouts at the same moment.
 *
 * `round`/`phase`/`tick` say when it happened in the viewer's timeline: while
 * a round's plans were asked ("plan", tick null), during a round's fight at a
 * fight tick ("fight"), or at its round end ("roundEnd"). Agents only steer
 * between rounds today, so a takeover changes plans from the next decision
 * on; a missed mid-round check-in (#8/#9) will be phase "checkin" at its tick,
 * with the house bot's plan update applied at that tick.
 */
export interface ControlEvent {
  seat: number;
  mode: "autopilot" | "agent";
  round: number;
  phase: "plan" | "fight" | "roundEnd" | "checkin";
  tick: number | null;
  /** why: "connection lost", "missed the deadline", "session closed", "reconnected" */
  reason: string;
  /** the callout spectators see */
  line: string;
  /** for "agent": the first round the agent plans again */
  fromRound?: number;
}

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
  /**
   * "broadcast" (#22): after a round is streamed, wait until viewers have seen
   * it (src/flow/pacing.ts) before asking for the next one. "fast" (default):
   * no waiting, as tests, batches, evals and ai-match need.
   */
  pace?: "fast" | "broadcast";
  /** broadcast mode: return false to skip the wait (nobody to wait for) */
  shouldPace?: () => boolean;
  /** broadcast mode: scale the waits (tests only; default 1) */
  paceScale?: number;
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
  /** control changes (autopilot / agent back), in order; saved in the record */
  readonly control: ControlEvent[] = [];
  /** the round whose plans are being asked, while asking */
  asking: number | null = null;
  /** the round the viewers are watching: when its playback started and how long it runs */
  playback: { round: number; startedAt: number; p: RoundPlayback; ticks: number } | null = null;
  private startedAtMs = 0;

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
    this.startedAtMs = Date.now();
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
    this.asking = round;
    let ask: RoundAsk;
    try {
      ask = await decideRound(match, this.opts.seats, this.opts.deadlineMs);
    } finally {
      this.asking = null;
    }
    const askMs = Math.round(performance.now() - askStart);
    await this.opts.onDecided?.(round, ask);
    const f = await this.applyRound(round, ask, askMs);
    if (this.opts.pace === "broadcast") await this.waitForViewers();
    return f;
  }

  /** Broadcast pace: sleep until the viewers have played the current round (or pacing is no longer wanted). */
  private async waitForViewers() {
    const pb = this.playback;
    if (!pb) return;
    const end = pb.startedAt + pb.p.total * 1000 * (this.opts.paceScale ?? 1);
    while (Date.now() < end && (this.opts.shouldPace?.() ?? true)) await Bun.sleep(Math.min(250, end - Date.now()));
  }

  /** Where the viewers are now: the round being asked, or a moment in the round being played back. */
  position(): { round: number; phase: ControlEvent["phase"]; tick: number | null } {
    if (this.asking !== null) return { round: this.asking, phase: "plan", tick: null };
    const pb = this.playback;
    if (!pb) return { round: this.match.round + 1, phase: "plan", tick: null };
    const at = playbackAt(pb.p, (Date.now() - pb.startedAt) / 1000, pb.ticks);
    // after the round end the next thing viewers see is the next round's plans
    if (at.phase === "roundEnd" && Date.now() >= pb.startedAt + pb.p.total * 1000 && !this.match.over) return { round: pb.round + 1, phase: "plan", tick: null };
    return { round: pb.round, ...at };
  }

  /** The first round a seat can still be asked for: the next one, or the one after if this round's plans are being asked. */
  nextAskRound(): number {
    return this.asking !== null ? this.asking + 1 : this.match.round + 1;
  }

  /** Record and stream a change of control. */
  recordControl(e: ControlEvent) {
    this.control.push(e);
    this.say(`  [${e.mode === "autopilot" ? "AUTOPILOT" : "BACK"}] ${this.names[e.seat]} (${e.reason}) round ${e.round} ${e.phase}${e.tick !== null ? ` tick ${e.tick}` : ""}: "${e.line}"`);
    this.emit({ type: "control", ...e });
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
    const decidedAt = Date.now();
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
    const ticks = match.record.rounds[round - 1]!.fight.ticks;
    const p = roundPlayback({ round, lines: ask.decisions.map((d) => d.line), fightTicks: ticks, kos: f.stats.kos.length, endsWithKo: f.reason !== "time-out" });
    if (round === 1) {
      // the level card started when the match was announced; only what's left of it is still ahead
      const shown = Math.min(DEFAULT_TIMING.level, (decidedAt - this.startedAtMs) / 1000);
      p.preFight -= shown;
      p.total -= shown;
    }
    this.playback = { round, startedAt: decidedAt, p, ticks };
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
  savedRecord(): MatchRecord & { labels: string[]; lineup: string[]; totalMs: number; control?: ControlEvent[] } {
    return { ...this.match.record, labels: this.labels, lineup: this.lineup, totalMs: Math.round(this.totalMs), ...(this.control.length ? { control: this.control.map((c) => ({ ...c })) } : {}) };
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
