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
import { Match, type CheckinMeta, type DecisionMeta, type MatchRecord, type PlanUpdate } from "../sim/match";
import type { RoundFacts } from "../sim/morale";
import type { Soul } from "../sim/soul";
import { houseBrain, type Decision } from "../sim/voice";
import { decideRound, type RoundAsk, type Seat } from "./decide";
import { fightSecondsAt, playbackAt, roundPlayback, tickAtFightSeconds, type RoundPlayback } from "../flow/pacing";
import { DEFAULT_TIMING } from "../flow/beats";
import { applyTick, buildCheckinPrompt, CHECKIN, checkinStatus, checkinTicks, parseCheckin, type CheckinAsk, type CheckinConfig } from "./checkin";
import { checkinSummaryLines, planChangeSummary } from "./checkin-log";

/** The live stream events (the viewer reads `match`, `decisions` and `done`; others are ignored by it). */
export type RunnerEvent =
  | { type: "match"; seed: number; labels: string[]; names: string[]; souls: Match["souls"]; identities: Match["identities"]; theme: string }
  | { type: "decisions"; round: number; decisions: Decision[]; meta: DecisionMeta[]; checkinTicks?: number[] }
  | { type: "round"; round: number; winner: number; seconds: number; reason: string; wins: number[]; kos: RoundFacts["stats"]["kos"]; summary: string[] }
  | { type: "done"; record: string | null; winner: number; wins: number[] }
  | ({ type: "control" } & ControlEvent)
  /** a mid-round check-in started (#9): the seats asked; plan updates may follow until checkinEnd */
  | { type: "checkin"; round: number; tick: number; seats: number[]; deadlineMs: number; leadTicks: number }
  /** a check-in answer became a plan update (#8): it applies at update.tick */
  | { type: "planUpdate"; round: number; update: PlanUpdate }
  /** the check-in is over: no more updates from it */
  | { type: "checkinEnd"; round: number; tick: number }
  /** no more check-ins this round (the rest of the schedule was skipped: the round ended, or one fighter is left) */
  | { type: "checkinsDone"; round: number };

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
  /** a round has been played (with its mid-round plan updates, to store them) */
  onPlayed?: (round: number, finalHash: string, planUpdates: PlanUpdate[]) => Promise<void> | void;
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
  /**
   * Mid-round check-ins (#9): every AI seat (local provider or remote agent)
   * gets a status every ~10 s of fight and may change its plan. Off by
   * default; true = the CHECKIN defaults, or a partial config.
   */
  checkins?: boolean | Partial<CheckinConfig>;
  /** a seat that is on autopilot gets no check-in (the server's remote seats) */
  onAutopilot?: (seat: number) => boolean;
}

/** A stored round: what decideRound returned for it. */
export type StoredRound = Pick<RoundAsk, "decisions" | "meta" | "prompts" | "raw"> & { finalHash?: string | null; planUpdates?: PlanUpdate[] | null };

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
  /** check-in settings (null: no check-ins) */
  readonly checkin: CheckinConfig | null;
  /** a round being fought with check-ins at broadcast pace: when viewers see its tick 0 */
  private fighting: { round: number; fightAt: number } | null = null;
  /** the check-in being asked now */
  openCheckin: { round: number; tick: number } | null = null;
  /** per seat: how it answers a check-in (null: no check-ins, e.g. the house bot) */
  readonly checkinAsk: (CheckinAsk | null)[];
  /** every check-in prompt and answer, for the .checkins.json file */
  readonly checkinPrompts: { round: number; tick: number; seat: number; prompt: string; raw: string | null }[] = [];

  constructor(readonly opts: RunnerOptions) {
    const souls: Soul[] = opts.seats.map((s) => s.soul);
    this.match = new Match(opts.seed, { souls, ...(opts.identityWishes ? { identityWishes: opts.identityWishes } : {}) });
    this.labels = opts.labels ?? opts.seats.map((s) => s.provider?.label ?? "house");
    this.lineup = opts.lineup ?? opts.seats.map((s) => s.providerName);
    this.checkin = opts.checkins ? { ...CHECKIN, ...(typeof opts.checkins === "object" ? opts.checkins : {}) } : null;
    if (this.checkin && this.checkin.deadlineMs / 1000 + this.checkin.leadS >= this.checkin.everyS) throw new Error(`check-in deadline (${this.checkin.deadlineMs / 1000} s) plus lead must be shorter than the check-in interval (${this.checkin.everyS} s)`);
    this.checkinAsk = opts.seats.map((s) => s.checkin ?? (s.provider ? (prompt, _st, signal) => s.provider!.ask(prompt, signal) : null));
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
    if (this.openCheckin) return { round: this.openCheckin.round, phase: "checkin", tick: this.openCheckin.tick };
    const fg = this.fighting;
    if (fg) {
      const now = Date.now();
      return now < fg.fightAt ? { round: fg.round, phase: "plan", tick: null } : { round: fg.round, phase: "fight", tick: Math.min(this.match.fight?.sim.tick ?? 0, tickAtFightSeconds((now - fg.fightAt) / 1000)) };
    }
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
    const f = await this.applyRound(round, { decisions: stored.decisions, meta: stored.meta, prompts: stored.prompts, raw: stored.raw }, 0, true, stored.planUpdates ?? []);
    const hash = match.record.rounds[round - 1]!.fight.finalHash;
    if (stored.finalHash && stored.finalHash !== hash) throw new ResumeError(`round ${round} replayed to ${hash}, stored ${stored.finalHash}`);
    return f;
  }

  private async applyRound(round: number, ask: RoundAsk, askMs: number, replayed = false, storedUpdates: PlanUpdate[] = []): Promise<RoundFacts> {
    const match = this.match;
    const names = this.names;
    this.prompts.push({ round, prompts: ask.prompts, raw: ask.raw });
    const decidedAt = Date.now();
    // the round's check-in schedule: a live viewer holds at each tick until that check-in is open or over (#9)
    const schedule = !replayed && this.checkin && this.checkinAsk.some(Boolean) ? checkinTicks(this.checkin) : null;
    this.emit({ type: "decisions", round, decisions: ask.decisions, meta: ask.meta, ...(schedule ? { checkinTicks: schedule } : {}) });
    this.say(replayed ? `ROUND ${round} plans (replayed from storage)` : `ROUND ${round} plans (${formatSeconds(askMs)} to decide)`);
    ask.decisions.forEach((d, i) => {
      const m = ask.meta[i]!;
      const tag = m.outcome === "ok" ? `${m.provider} ${formatSeconds(m.ms)}` : `${m.provider} ${formatSeconds(m.ms)} ${m.outcome.toUpperCase()}${m.detail ? ` (${m.detail})` : ""}`;
      this.say(`  ${names[i]!.padEnd(12)} [${tag}] "${d.line}"`);
      this.say(`  ${" ".repeat(8)}  plan: ${this.stratText(d.strategy)}`);
    });
    match.prepareRound(ask.decisions, ask.meta);
    if (replayed) {
      // the stored round's plan updates, at their ticks (#8)
      for (const u of storedUpdates) {
        if (match.stepUntil(u.tick)) break;
        match.addUpdate(u);
      }
    } else if (schedule) await this.fightWithCheckins(round, ask, decidedAt);
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
    if (!replayed) await this.opts.onPlayed?.(round, match.record.rounds[round - 1]!.fight.finalHash, match.record.rounds[round - 1]!.planUpdates ?? []);
    return f;
  }

  /** When viewers see the start of this round's fight (tick 0), at broadcast pace. */
  private fightStartAt(round: number, lines: string[], decidedAt: number): number {
    let pre = roundPlayback({ round, lines, fightTicks: 0, kos: 0, endsWithKo: false }).preFight;
    if (round === 1) pre -= Math.min(DEFAULT_TIMING.level, (decidedAt - this.startedAtMs) / 1000);
    return decidedAt + pre * 1000 * (this.opts.paceScale ?? 1);
  }

  /**
   * Play the round up to each check-in tick and ask the AI seats (#9). At
   * broadcast pace a check-in waits until viewers reach its tick, so agents
   * react to what spectators see; an answer applies at the check-in tick
   * plus its latency (plus a lead for the viewers). In fast mode the same
   * rule simulates the latency. The sim waits at the check-in tick until
   * every answer is in or late; the record keeps each update's tick.
   */
  private async fightWithCheckins(round: number, ask: RoundAsk, decidedAt: number) {
    const cfg = this.checkin!;
    const match = this.match;
    const broadcast = this.opts.pace === "broadcast";
    const fightAt = this.fightStartAt(round, ask.decisions.map((d) => d.line), decidedAt);
    if (broadcast) this.fighting = { round, fightAt };
    try {
      for (const tick of checkinTicks(cfg)) {
        if (match.stepUntil(tick)) break;
        const fight = match.fight!;
        if (fight.sim.alive().length < 2) break;
        const seats = this.opts.seats.map((_, i) => i).filter((i) => this.checkinAsk[i] && fight.sim.fighters[i]!.alive && !(this.opts.onAutopilot?.(i) ?? false));
        if (!seats.length) continue;
        if (broadcast) {
          const kos = fight.result().koLog.length;
          const at = fightAt + fightSecondsAt(tick, kos) * 1000 * (this.opts.paceScale ?? 1);
          while (Date.now() < at && (this.opts.shouldPace?.() ?? true)) await Bun.sleep(Math.min(250, at - Date.now()));
        }
        await this.askCheckin(round, tick, seats, broadcast);
      }
    } finally {
      this.fighting = null;
      this.emit({ type: "checkinsDone", round });
    }
  }

  /** One check-in: ask `seats` in parallel; each valid change becomes a plan update at its apply tick. */
  private async askCheckin(round: number, tick: number, seats: number[], broadcast: boolean) {
    const cfg = this.checkin!;
    const match = this.match;
    const leadTicks = broadcast ? Math.round(cfg.leadS * 60) : 0;
    this.openCheckin = { round, tick };
    this.emit({ type: "checkin", round, tick, seats, deadlineMs: cfg.deadlineMs, leadTicks });
    const metas: CheckinMeta[] = [];
    try {
      await Promise.all(seats.map((seat) => this.askSeat(round, tick, seat, broadcast).then((m) => void metas.push(m))));
    } finally {
      this.openCheckin = null;
      const rec = match.record.rounds[round - 1]!;
      rec.checkins = [...(rec.checkins ?? []), ...metas.sort((a, b) => a.fighter - b.fighter)];
      this.emit({ type: "checkinEnd", round, tick });
    }
  }

  private async askSeat(round: number, tick: number, seat: number, broadcast: boolean): Promise<CheckinMeta> {
    const cfg = this.checkin!;
    const match = this.match;
    const fight = match.fight!;
    const names = this.names;
    const st = checkinStatus(fight, seat, names, round);
    const prompt = buildCheckinPrompt(st, this.opts.seats[seat]!.soul, cfg);
    const provider = this.labels[seat]!;
    const t0 = performance.now();
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      // settle as late before aborting, so the aborted ask's rejection doesn't count as an error
      timer = setTimeout(() => (resolve("late"), ctl.abort()), cfg.deadlineMs);
    });
    let raw: string | null = null;
    const meta: CheckinMeta = { tick, fighter: seat, provider, ms: 0, outcome: "missed", promptChars: prompt.length };
    try {
      const got = await Promise.race([this.checkinAsk[seat]!(prompt, st, ctl.signal), late]);
      meta.ms = Math.round(performance.now() - t0);
      if (got === "late") meta.detail = `no answer in ${cfg.deadlineMs / 1000} s`;
      else {
        raw = got;
        meta.answerChars = got.length;
        const current = fight.controllers[seat]!.strategy;
        const a = parseCheckin(got, seat, names, current, cfg);
        if (a.kind === "invalid") Object.assign(meta, { outcome: "invalid", detail: a.problems.join(", ").slice(0, 200) });
        else if (a.kind === "keep") Object.assign(meta, { outcome: "keep", ...(a.line ? { detail: `line: ${a.line}` } : {}) });
        else {
          const at = applyTick(tick, meta.ms, cfg, broadcast);
          if (fight.over || !fight.sim.fighters[seat]!.alive) Object.assign(meta, { outcome: "late", detail: `would apply at tick ${at}` });
          else {
            const u: PlanUpdate = { tick: at, fighter: seat, strategy: a.strategy, ...(a.line ? { line: a.line } : {}), ...(a.why ? { why: a.why } : {}), source: "checkin" };
            match.addUpdate(u);
            Object.assign(meta, { outcome: "update", applyTick: at, changed: a.changed, ...(a.ruleProblems ? { detail: `rules dropped: ${a.ruleProblems.join("; ").slice(0, 160)}` } : {}) });
            this.emit({ type: "planUpdate", round, update: u });
            this.say(`  check-in ${(tick / 60).toFixed(0)} s: ${names[seat]} [${provider} ${formatSeconds(meta.ms)}] ${planChangeSummary(current, a.strategy, names)}, applies at ${(at / 60).toFixed(1)} s${a.line ? ` "${a.line}"` : ""}${a.why ? ` (${a.why})` : ""}`);
          }
        }
      }
    } catch (e) {
      meta.ms = Math.round(performance.now() - t0);
      const msg = e instanceof Error ? e.message : String(e);
      Object.assign(meta, { outcome: /autopilot|left the match/.test(msg) ? "autopilot" : "error", detail: msg.slice(0, 200) });
    } finally {
      clearTimeout(timer);
    }
    if (meta.outcome !== "update") this.say(`  check-in ${(tick / 60).toFixed(0)} s: ${names[seat]} [${provider} ${formatSeconds(meta.ms)}] ${meta.outcome.toUpperCase()}${meta.detail ? ` (${meta.detail})` : ""}`);
    this.checkinPrompts.push({ round, tick, seat, prompt, raw });
    return meta;
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
    if (this.checkin) for (const l of checkinSummaryLines(match.record, this.labels)) this.say(l);
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
    if (this.checkinPrompts.length) writeFileSync(join(outDir, file.replace(/\.json$/, ".checkins.json")), JSON.stringify(this.checkinPrompts, null, 2));
    this.recordFile = file;
    this.emit({ type: "done", record: `/records/${file}`, winner: this.match.winner, wins: this.match.wins.slice() });
    return file;
  }
}
