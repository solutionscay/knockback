/**
 * One match on the match server: its seats and agents, the runner that plays it, presence and the house bot's
 * takeovers (#22), spectator picks (#35), the AI seats' suit-up (#19), what it writes to the store, and the views
 * the API serves (turn, info, report).
 */
import type { Seat } from "../ai/decide";
import { MatchRunner, type ControlEvent, type RunnerEvent, type StoredRound } from "../ai/runner";
import { PROVIDERS } from "../ai/providers";
import { settleSuitUp, suitUp, type SuitUpAnswer, type SuitUpResult } from "../ai/suitup";
import type { IdentityWish } from "../sim/identity";
import { CLASSIC } from "../sim/ruleset";
import { parseSoul, type Soul } from "../sim/soul";
import { exampleSouls } from "../sim/souls";
import { modelOf, remoteLabel, seatEntries } from "../stats/models";
import { portraitSvg } from "../viewer/portrait";
import { AUTOPILOT_LINES, BACK_LINES, LEFT_LINES, pickLine } from "./autopilot";
import { HttpError } from "./limits";
import { LiveStream } from "./live";
import type { checkJoin } from "./match-input";
import type { MatchRuleset } from "./match-rulesets";
import type { MatchServer } from "./match-server";
import { PICK_THROTTLE_MS, PickBook, soulOpeningLine } from "./picks";
import { checkinSchema, planSchema, RemoteSeat } from "./remote";
import { hashToken, hex } from "./seat-tokens";
import { soulLine } from "./soul-guard";
import type { MatchRow, MatchStore, SeatRow } from "./store";

/** The model badge data of a seat label; null for an open seat. */
const seatModel = (label: string | null) => (label === null ? null : modelOf(label));

/** Who sits in a remote seat. */
export interface SeatAgent {
  name: string;
  /** soul.md: the fighter persona the agent wrote (personal data stripped) */
  soul: string;
  /** the owner whose key joined this agent */
  owner: string;
  soulId: string;
  look: IdentityWish | null;
  /** the model the agent says it runs (reported at join, shown as reported) */
  model: string;
  /** sha256 (hex) of the seat token */
  tokenHash: string;
  joinedAt: number;
  leftAt: number | null;
  /** the first round the house bot plays for this seat (null: still here, or left before the start) */
  leftRound: number | null;
  /** joining address (per-address cap; not persisted) */
  ip: string;
  /** long polls in flight */
  polls: number;
  /** last authenticated request from this seat (presence) */
  lastSeen: number;
  /** the house bot drives this fighter until the agent comes back (#22): why */
  autopilot: string | null;
  /** said at join, shown on spectators' pick cards (#35) */
  openingLine: string | null;
}

/** "remote" (an agent's seat), "house" (the house bot), or a local provider name (CLI only). */
export type SeatKind = string;

export class ServerMatch {
  status: "open" | "running" | "over" | "failed" = "open";
  readonly remote: (RemoteSeat | null)[];
  readonly agents: (SeatAgent | null)[] = [null, null, null, null];
  readonly live = new LiveStream();
  readonly createdAt: number;
  startsAt: number;
  runner: MatchRunner | null = null;
  error: string | null = null;
  /** the built-in AI seats' suit-up answers (#19); null until they are in (or with no AI seat) */
  suitAnswers: SuitUpAnswer[] | null = null;
  /** the AI seats' suit-up, running from the match's creation; the start waits for it */
  private suitPromise: Promise<void> | null = null;
  private starting = false;
  private waiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    readonly seed: number,
    readonly kinds: SeatKind[],
    readonly deadlineMs: number,
    readonly fillAfterMs: number,
    protected server: MatchServer,
    /** the address that created it over HTTP (none for CLI matches) */
    readonly creator: string | null = null,
    createdAt = Date.now(),
    readonly selection: MatchRuleset = { ruleset: CLASSIC, preset: "Classic", presetVersion: 1 },
  ) {
    this.remote = kinds.map(() => null);
    this.createdAt = createdAt;
    this.startsAt = createdAt + fillAfterMs;
  }

  /**
   * Start now if there is nobody to wait for, else when the fill timer ends. An open match with agent seats that
   * nobody took by then expires instead of playing with house bots only (#22: nothing runs without agents).
   */
  armFillTimer() {
    const wait = this.startsAt - Date.now();
    const fill = () => (this.kinds.includes("remote") && !this.agents.some(Boolean) ? void this.cancelEmpty("nobody joined before the fill timer") : void this.start());
    if (!this.kinds.includes("remote") || this.full) queueMicrotask(() => void this.start());
    else if (wait <= 0) queueMicrotask(fill);
    else this.timer = setTimeout(fill, wait);
  }

  /** Retire an open match that has no agent (seating failed, or nobody joined), including its fill timer. */
  async cancelEmpty(reason = "lobby join failed") {
    if (this.status !== "open" || this.agents.some(Boolean)) return;
    clearTimeout(this.timer);
    this.status = "failed";
    this.error = reason;
    this.server.log(`match ${this.id}: ${reason}`);
    this.server.forgetEmpty(this);
    this.live.close();
    this.changed();
    await this.store.updateMatch(this.id, { status: "failed", error: this.error, endedAt: Date.now() });
  }

  /** Wake every long poll on this match. */
  changed() {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }

  /** Resolves on the next change, or after `ms`. */
  nextChange(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  get store(): MatchStore {
    return this.server.store;
  }

  /** True when every remote seat has an agent. */
  get full(): boolean {
    return this.kinds.every((k, i) => k !== "remote" || this.agents[i]);
  }

  remoteSeat(seat: number, agent: SeatAgent): RemoteSeat {
    const rs = new RemoteSeat(agent.name, this.deadlineMs, agent.model);
    rs.onChange = () => this.changed();
    // accepted plans are stored before the turn ends, so a restart in mid-ask keeps them
    rs.onAccept = (round, raw) => this.store.insertPlan({ matchId: this.id, round, seat, raw, at: Date.now() });
    rs.stored = async (round) => (await this.store.getPlan(this.id, round, seat))?.raw ?? null;
    this.remote[seat] = rs;
    return rs;
  }

  seatRow(seat: number): SeatRow {
    const a = this.agents[seat]!;
    return { matchId: this.id, seat, name: a.name, soul: a.soul, owner: a.owner, look: a.look, model: a.model, tokenHash: a.tokenHash, joinedAt: a.joinedAt, leftAt: a.leftAt, leftRound: a.leftRound, openingLine: a.openingLine };
  }

  row(): MatchRow {
    return { ...this.selection, id: this.id, seed: this.seed, kinds: this.kinds, deadlineMs: this.deadlineMs, fillAfterMs: this.fillAfterMs, status: this.status, createdAt: this.createdAt, startedAt: null, endedAt: null, creator: this.creator, error: this.error, winner: null };
  }

  /** Put a stored agent back in its seat (resume). */
  restoreSeat(r: SeatRow) {
    const agent: SeatAgent = { name: r.name, soul: r.soul, owner: r.owner, soulId: r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent", look: r.look, model: r.model, tokenHash: r.tokenHash, joinedAt: r.joinedAt, leftAt: r.leftAt, leftRound: r.leftRound, ip: "(restored)", polls: 0, lastSeen: Date.now(), autopilot: null, openingLine: r.openingLine ?? null };
    this.agents[r.seat] = agent;
    const rs = this.remoteSeat(r.seat, agent);
    if (r.leftRound !== null) rs.left = true;
    this.server.tokens.set(r.tokenHash, { match: this.id, seat: r.seat });
  }

  /** Seat an agent; returns the seat and its token (shown once, stored hashed). */
  join(j: ReturnType<typeof checkJoin>, owner: string, ip: string): { seat: number; token: string } {
    if (this.status !== "open") throw new HttpError(409, `match ${this.id} is ${this.status}; join an open match`);
    const free = this.kinds.map((k, i) => (k === "remote" && !this.agents[i] ? i : -1)).filter((i) => i >= 0);
    if (j.seat !== undefined && !free.includes(j.seat)) throw new HttpError(409, `seat ${j.seat} is not a free remote seat (free: ${free.join(", ") || "none"})`);
    const seat = j.seat ?? free[0];
    if (seat === undefined) throw new HttpError(409, "no free remote seat");
    const token = `st_${hex(24)}`;
    const agent: SeatAgent = { name: j.name, soul: j.soul, owner, soulId: j.soulId, look: j.look, model: j.model, tokenHash: hashToken(token), joinedAt: Date.now(), leftAt: null, leftRound: null, ip, polls: 0, lastSeen: Date.now(), autopilot: null, openingLine: j.line };
    this.agents[seat] = agent;
    this.remoteSeat(seat, agent);
    this.server.tokens.set(agent.tokenHash, { match: this.id, seat });
    this.server.log(`match ${this.id}: ${agent.name} (owner ${owner}) joined seat ${seat} (says it runs ${agent.model})`);
    this.changed();
    this.lineup();
    return { seat, token };
  }

  /** The agent in `seat` leaves: before the start the seat is free again; after it, the house bot plays it. */
  leave(seat: number): { seat: number; status: string; houseFromRound: number | null } {
    const a = this.agents[seat];
    if (!a || a.leftAt !== null) throw new HttpError(409, `seat ${seat} has no agent`);
    if (this.status === "open") {
      this.agents[seat] = null;
      this.remote[seat] = null;
      this.server.tokens.delete(a.tokenHash);
      this.server.log(`match ${this.id}: ${a.name} left seat ${seat} before the start`);
      this.changed();
      this.lineup();
      return { seat, status: "open", houseFromRound: null };
    }
    if (this.status !== "running") throw new HttpError(409, `match ${this.id} is ${this.status}`);
    const m = this.runner!.match;
    const rs = this.remote[seat]!;
    // a turn still open is the first round the house bot plays; otherwise the next one
    a.leftRound = rs.turn ? rs.turn.round : m.round + 1;
    a.leftAt = Date.now();
    rs.leave();
    if (!a.autopilot) this.control({ seat, mode: "autopilot", ...this.runner!.position(), reason: "left the match", line: pickLine(LEFT_LINES, this.fighter(seat)) });
    a.autopilot = "left the match";
    this.server.log(`match ${this.id}: ${a.name} left seat ${seat}; the house bot plays it from round ${a.leftRound}`);
    this.changed();
    return { seat, status: "running", houseFromRound: a.leftRound };
  }

  /** The fighter's name in the match (the agent's name before the start). */
  fighter(seat: number): string {
    return this.runner?.names[seat] ?? this.agents[seat]?.name ?? `seat ${seat}`;
  }

  /** Record, persist and stream a change of control. */
  control(e: ControlEvent) {
    const r = this.runner!;
    r.recordControl(e);
    this.store.insertControl(this.id, r.control.length - 1, e).catch((x) => this.server.log(`store: ${x}`));
    this.changed();
  }

  /**
   * The house bot takes this agent's fighter from now on (#22): a dropped
   * connection, a closed session or a missed deadline. Stamped with where the
   * viewers are (or `at`), streamed as a callout, saved in the record. Before
   * the start the seat goes back to the queue instead. A missed mid-round
   * check-in (#8/#9) will call this with phase "checkin" and its tick.
   */
  takeover(seat: number, reason: string, at?: Pick<ControlEvent, "round" | "phase" | "tick">, expect?: string) {
    const a = this.agents[seat];
    // `expect`: the seat token hash of the agent this is about; a seat freed and taken by someone else is left alone
    if (!a || a.leftAt !== null || a.autopilot || (expect !== undefined && a.tokenHash !== expect)) return;
    if (this.status === "open") {
      this.server.log(`match ${this.id}: ${a.name} dropped before the start (${reason}); the seat is free again`);
      void this.server.freeSeat(this, seat);
      return;
    }
    if (this.status !== "running" || !this.runner) return;
    a.autopilot = reason;
    this.remote[seat]?.setAutopilot(reason);
    // during the seat's open check-in: stamped at that check-in's tick (phase "checkin")
    this.control({ seat, mode: "autopilot", ...(at ?? this.runner.checkinAt(seat) ?? this.runner.position()), reason, line: pickLine(AUTOPILOT_LINES, this.fighter(seat)) });
  }

  /** Any request from a seat: it is present; an agent on autopilot gets its fighter back from the next round it can still plan. */
  seen(seat: number) {
    const a = this.agents[seat];
    if (!a) return;
    a.lastSeen = Date.now();
    if (!a.autopilot || a.leftAt !== null || this.status !== "running" || !this.runner || this.runner.match.over) return;
    a.autopilot = null;
    this.remote[seat]?.setAutopilot(null);
    this.control({ seat, mode: "agent", ...this.runner.position(), fromRound: this.runner.nextAskRound(), reason: "reconnected", line: pickLine(BACK_LINES, this.fighter(seat)) });
  }

  /** A seat's connection dropped mid-request: autopilot unless it sends something within the grace period. */
  dropped(seat: number, reason = "connection lost", expect?: string) {
    const since = Date.now();
    const a = this.agents[seat];
    if (!a || (expect !== undefined && a.tokenHash !== expect)) return;
    setTimeout(() => {
      // the same agent (not a newcomer in a freed seat), silent since the drop
      if (this.agents[seat] === a && a.lastSeen <= since && a.polls === 0) this.takeover(seat, reason, undefined, a.tokenHash);
    }, this.server.opts.dropGraceMs).unref?.();
  }

  /** Agents still in control of their fighters. */
  activeAgents(): number {
    return this.agents.filter((a) => a && a.leftAt === null && !a.autopilot).length;
  }

  // ---------------------------------------------------------------- spectator picks (#35)
  readonly picks = new PickBook();
  /** when the match started (all seats filled): the pick window stays open PICK_MIN_WINDOW_MS after it, at broadcast pace */
  startedAtMs: number | null = null;
  private picksTimer: ReturnType<typeof setTimeout> | undefined;
  private picksSentAt = 0;

  /** Tell spectators which match this stream is (before the start too), so they can show the pick cards. */
  lineup() {
    if (this.status === "open") this.live.broadcast({ type: "lineup", matchId: this.id });
  }

  /** The 4 fighters as spectators see them on the pick cards: name, look, who plays it, the opening line. */
  /** Who plays a seat, as a model label (for the model badge): from the runner's label once running, from the join before. */
  modelLabel(i: number): string | null {
    const k = this.kinds[i]!;
    const a = this.agents[i];
    return this.runner?.labels[i] ?? (a ? remoteLabel(a.name, a.model) : k === "remote" ? null : k === "house" ? "house" : (PROVIDERS[k]?.label ?? k));
  }

  /**
   * The suit-up (#19) of the built-in AI seats: started when the match is made (it has its seats), so the
   * pick cards show the chosen looks and lines before the start. Answers are stored: a restart keeps them.
   */
  beginSuitUp(): Promise<void> {
    if (this.suitPromise) return this.suitPromise;
    const ai = this.kinds.map((k) => (k !== "remote" && k !== "house" ? (PROVIDERS[k] ?? null) : null));
    if (this.suitAnswers || !this.server.opts.suitUp || !ai.some(Boolean)) return (this.suitPromise = Promise.resolve());
    const souls = this.souls();
    this.suitPromise = suitUp(this.seed, ai.map((provider, i) => ({ provider, soul: souls[i]! })), { ruleset: this.selection.ruleset, log: (l) => this.server.log(`match ${this.id}: ${l}`) })
      .then(async (r) => {
        this.suitAnswers = r.answers.map(({ raw: _raw, ...a }) => a);
        await this.store.updateMatch(this.id, { suitUp: JSON.stringify(this.suitAnswers) });
        this.lineup(); // spectators reload the pick cards with the chosen looks
      })
      .catch((e) => this.server.log(`match ${this.id}: suit up failed: ${e instanceof Error ? e.message : String(e)}`));
    return this.suitPromise;
  }

  /** The identities as they stand: the AI seats' suit-up answers plus the agents' join looks, settled in seat order. */
  settledLooks(): SuitUpResult {
    const answers: SuitUpAnswer[] = [...(this.suitAnswers ?? [])];
    this.agents.forEach((a, seat) => {
      if (a?.look && Object.keys(a.look).length) answers.push({ seat, by: "agent", outcome: "answered", wish: { ...a.look }, ...(a.openingLine ? { line: a.openingLine } : {}) });
    });
    return settleSuitUp(this.seed, answers);
  }

  pickFighters() {
    const souls = this.souls();
    const su = this.runner ? null : this.settledLooks();
    const ids = this.runner?.match.identities ?? su!.identities;
    const aiLines = (this.runner?.match.record.suitUp ?? su?.entries ?? []).filter((e) => e.by === "ai");
    return this.kinds.map((k, i) => {
      const a = this.agents[i];
      const id = ids[i]!;
      const line = a?.openingLine ?? aiLines.find((e) => e.seat === i)?.line ?? soulOpeningLine(souls[i]!.lines, souls[i]!.catchphrase || undefined, id.name, this.seed + i);
      const label = a ? `agent · ${a.name}` : k === "remote" && this.status === "open" ? "open seat" : k === "remote" || k === "house" ? "house bot" : k;
      // model: the label the model badge reads (modelOf), null for an open seat
      return { seat: i, name: id.name, color: id.color, look: id, label, model: this.modelLabel(i), line, svg: portraitSvg(id, "fist", "fight", "full") };
    });
  }

  /** Everything a pick card needs, plus this spectator's pick. Never part of anything an agent sees. */
  picksView(spectator: string | null) {
    const t = this.picks.tally();
    const over = this.status === "over" && this.runner?.match.over;
    return {
      match: this.id,
      status: this.status,
      locked: this.picks.locked,
      lockedAt: this.picks.lockedAt,
      // the earliest the window can close: the fill timer, then 30 s of picks (at broadcast pace)
      locksAtEarliest: this.picks.locked ? this.picks.lockedAt : (this.startedAtMs ?? this.startsAt) + (this.server.opts.pace === "broadcast" ? this.server.opts.pickWindowMs : 0),
      now: Date.now(),
      counts: t.counts,
      total: t.total,
      yours: spectator ? this.picks.yours(spectator) : null,
      fighters: this.pickFighters(),
      ...(over ? { winner: this.runner!.match.winner, calledIt: this.picks.split(this.runner!.match.winner).calledIt } : {}),
    };
  }

  /** A spectator picks (or changes) a fighter; the tally goes out on the stream, throttled. */
  async pick(spectator: string, seat: number, ip: string) {
    if (this.picks.locked) throw new HttpError(409, "picks are locked: round 1 has started");
    if (this.status !== "open" && this.status !== "running") throw new HttpError(409, `match ${this.id} is ${this.status}`);
    const changed = this.picks.pick(spectator, seat, ip, this.server.opts.picksPerAddress);
    const now = Date.now();
    await this.store.upsertPick({ matchId: this.id, spectator, seat, ip, createdAt: now, updatedAt: now });
    if (changed) this.schedulePicksEvent();
  }

  private schedulePicksEvent() {
    if (this.picksTimer) return;
    const wait = Math.max(0, this.picksSentAt + PICK_THROTTLE_MS - Date.now());
    this.picksTimer = setTimeout(() => {
      this.picksTimer = undefined;
      if (this.picks.locked) return;
      this.picksSentAt = Date.now();
      this.live.broadcast({ type: "picks", matchId: this.id, ...this.picks.tally() });
    }, wait);
  }

  /** Close the pick window: right before round 1's decisions go out (and before round 1 is simulated). Persisted first. */
  async lockPicks() {
    if (this.picks.locked) return;
    this.picks.lockedAt = Date.now();
    clearTimeout(this.picksTimer);
    this.picksTimer = undefined;
    await this.store.updateMatch(this.id, { picksLockedAt: this.picks.lockedAt });
    this.live.broadcast({ type: "picksLocked", matchId: this.id, ...this.picks.tally() });
    this.server.log(`match ${this.id}: picks locked (${this.picks.tally().total} picks)`);
  }

  /** Build the seats (souls, providers) and the runner. */
  protected buildRunner(): MatchRunner {
    const souls = this.souls();
    const seats: Seat[] = this.kinds.map((k, i) => {
      const rs = this.remote[i];
      // a check-in goes to the agent with the runner's check-in deadline
      if (rs) return { providerName: "remote", provider: rs.provider, soul: souls[i]!, checkin: (prompt, st, signal) => rs.askCheckin(prompt, st, signal, runner.checkin?.capMs) };
      if (k === "remote" || k === "house") return { providerName: "house", provider: null, soul: souls[i]! };
      return { providerName: k, provider: PROVIDERS[k]!, soul: souls[i]! };
    });
    // the settled suit-up (#19): the AI seats' answers and the agents' join looks; the entries go into the record
    const su = this.settledLooks();
    const runner = new MatchRunner({
      seed: this.seed,
      ...this.selection,
      seats,
      ...(su.wishes.some(Boolean) ? { suitUp: su } : {}),
      onEvent: (e) => this.onEvent(e),
      onDecided: async (round, ask) => {
        await this.store.insertRound({ matchId: this.id, round, decisions: ask.decisions, meta: ask.meta, prompts: ask.prompts, raw: ask.raw, finalHash: null });
        // a missed deadline hands the fighter to the house bot (it already played this round)
        ask.meta.forEach((m, seat) => {
          if (m.outcome === "fallback-timeout" && this.remote[seat]) this.takeover(seat, "missed the deadline", { round, phase: "plan", tick: null }, this.agents[seat]?.tokenHash);
        });
      },
      pace: this.server.opts.pace,
      // nobody to wait for: no spectator and no agent in control
      shouldPace: () => this.live.size > 0 || this.activeAgents() > 0,
      // picks (#35): at broadcast pace, at least 30 s of picks after the start before round 1 is asked ...
      beforeAsk: async (round) => {
        if (round !== 1 || this.server.opts.pace !== "broadcast" || this.picks.locked) return;
        const until = (this.startedAtMs ?? Date.now()) + this.server.opts.pickWindowMs;
        while (Date.now() < until && (this.live.size > 0 || this.activeAgents() > 0)) await Bun.sleep(Math.min(250, until - Date.now()));
      },
      // ... and the window closes right before round 1's decisions are broadcast and simulated
      beforeBroadcast: async (round) => {
        if (round === 1) await this.lockPicks();
      },
      onPlayed: (round, hash, updates) => this.store.setRoundHash(this.id, round, hash, updates),
      checkins: this.server.opts.checkins,
      // a fighter on autopilot (or whose agent left) gets no check-in; the house bot's plan plays on
      onAutopilot: (seat) => !!this.remote[seat] && (!!this.agents[seat]?.autopilot || this.agents[seat]?.leftAt != null),
    });
    this.remote.forEach((rs, i) => rs?.bind(runner.match, i));
    return runner;
  }

  /** Play the match in the background. */
  async start() {
    if (this.status !== "open" || this.starting) return;
    this.starting = true;
    clearTimeout(this.timer);
    try {
      await this.beginSuitUp(); // the AI seats choose their looks first (#19; bounded by the providers' deadlines)
    } finally {
      this.starting = false;
    }
    if (this.status !== "open") return;
    this.status = "running";
    this.startedAtMs = Date.now();
    try {
      this.runner = this.buildRunner();
      await this.store.updateMatch(this.id, { status: "running", startedAt: this.startedAtMs });
    } catch (e) {
      this.fail(e);
      return;
    }
    this.server.log(`match ${this.id}: started, seed ${this.seed}, seats ${this.runner.labels.join(", ")}`);
    this.runner.start();
    this.changed();
    this.play();
  }

  /** Resume a running match: replay its stored rounds (same decisions, same fights), then play on. */
  async resumeRunning(rounds: StoredRound[]) {
    this.status = "running";
    try {
      this.runner = this.buildRunner();
      this.runner.start();
      // round 1 was decided before the restart: its decisions go out again now, so picks must be closed
      if (rounds.length) await this.lockPicks();
      for (const r of rounds) await this.runner.replayRound(r);
      await this.restoreControl();
    } catch (e) {
      this.fail(e);
      return;
    }
    const m = this.runner.match;
    this.server.log(`match ${this.id}: resumed after ${rounds.length} stored round${rounds.length === 1 ? "" : "s"} (wins ${m.wins.join("-")}, hashes ${m.record.rounds.map((r) => r.fight.finalHash).join(",") || "-"})`);
    this.changed();
    this.play();
  }

  /** Rebuild a finished match from storage (for its report and its agents' last poll); not played on. */
  async loadFinished(row: MatchRow, rounds: StoredRound[], recordPath: string | null) {
    this.status = row.status;
    this.error = row.error;
    if (row.status === "failed" && !rounds.length) return;
    this.runner = this.buildRunner();
    this.runner.start();
    for (const r of rounds) await this.runner.replayRound(r);
    await this.restoreControl();
    this.runner.recordFile = recordPath ? recordPath.replace(/^\/records\//, "") : null;
  }

  /** After a restart: the control timeline and who is on autopilot (the last event per seat). */
  private async restoreControl() {
    const events = await this.store.listControl(this.id);
    this.runner!.control.push(...events);
    for (const e of events) {
      const a = this.agents[e.seat];
      if (!a) continue;
      a.autopilot = e.mode === "autopilot" ? e.reason : null;
      if (a.leftAt === null) this.remote[e.seat]?.setAutopilot(a.autopilot);
    }
  }

  protected play() {
    this.runner!
      .run()
      .then(() => this.finish())
      .catch((e) => this.fail(e));
  }

  protected async finish() {
    const r = this.runner!;
    const file = r.save(this.server.opts.outDir, "remote");
    const m = r.match;
    // the per-seat model stats go into the record index too: GET /api/models reads them without opening files
    const stats = JSON.stringify(seatEntries(r.savedRecord()));
    await this.store.insertRecord({ matchId: this.id, path: `/records/${file}`, seed: this.seed, hashes: m.record.rounds.map((x) => x.fight.finalHash), winner: m.winner, createdAt: Date.now(), stats });
    this.server.modelsCache = null;
    await this.store.updateMatch(this.id, { status: "over", winner: m.winner, endedAt: Date.now() });
    this.status = "over";
    this.server.log(`match ${this.id}: ${r.names[m.winner]} wins ${m.wins.join("-")}; record ${r.recordFile}`);
    this.changed();
  }

  protected fail(e: unknown) {
    this.status = "failed";
    this.error = e instanceof Error ? e.message : String(e);
    this.server.log(`match ${this.id}: failed: ${this.error}`);
    this.store.updateMatch(this.id, { status: "failed", error: this.error, endedAt: Date.now() }).catch((x) => this.server.log(`store: ${x}`));
    this.live.broadcast({ type: "error", error: this.error });
    this.changed();
  }

  private onEvent(e: RunnerEvent) {
    // the stream says which match it is, so spectators can fetch the pick cards (#35)
    this.live.broadcast(e.type === "match" ? { ...e, matchId: this.id } : e);
    if (e.type === "round") this.changed();
  }

  /** One soul per seat: the agent's soul.md, or the example soul of that seat; ids made unique. */
  protected souls(): Soul[] {
    const base = exampleSouls();
    const used = new Set<string>();
    return this.kinds.map((_, i) => {
      const a = this.agents[i];
      let soul = a ? parseSoul(a.soul, i, a.soulId).soul : base[i]!;
      let sid = soul.id;
      for (let n = 2; used.has(sid); n++) sid = `${soul.id}-${n}`;
      used.add(sid);
      if (sid !== soul.id) soul = { ...soul, id: sid };
      return soul;
    });
  }

  /** What the agent in `seat` should do now. */
  turnFor(seat: number) {
    const base = { match: this.id, seat, status: this.status as string };
    if (this.status === "open") return { ...base, status: "open", startsInSec: Math.max(0, Math.ceil((this.startsAt - Date.now()) / 1000)), message: "waiting for players; empty seats get the house bot when the match starts" };
    if (this.status === "failed") return { ...base, status: "over", error: this.error };
    const m = this.runner!.match;
    if (this.status === "over") return { ...base, status: "over", winner: m.names[m.winner], wins: m.wins.slice(), youWon: m.winner === seat, record: this.runner!.recordFile ? `/records/${this.runner!.recordFile}` : null, report: `/api/matches/${this.id}/report` };
    if (this.agents[seat]?.leftAt) return { ...base, status: "left", message: `you left; the house bot plays this seat from round ${this.agents[seat]!.leftRound}` };
    const c = this.remote[seat]?.checkinTurn;
    if (c)
      return {
        ...base,
        status: "checkin",
        round: c.round,
        tick: c.tick,
        second: Math.round(c.tick / 60),
        deadlineAt: new Date(c.deadlineAt).toISOString(),
        msLeft: Math.max(0, c.deadlineAt - Date.now()),
        attempts: c.attempts,
        checkin: c.status,
        prompt: c.prompt,
        schema: checkinSchema(this.selection.ruleset),
        submit: `POST /api/matches/${this.id}/checkin with {"round":${c.round},"tick":${c.tick},"keep":true} or {"round":${c.round},"tick":${c.tick}, ...only the plan fields to change, "line":"..."}; the check-in waits for your answer and the change applies when it arrives (a slow answer applies late)`,
      };
    const t = this.remote[seat]?.turn;
    if (t)
      return {
        ...base,
        status: "turn",
        round: t.round,
        deadlineAt: new Date(t.deadlineAt).toISOString(),
        msLeft: Math.max(0, t.deadlineAt - Date.now()),
        attempts: t.attempts,
        context: t.context,
        prompt: t.prompt,
        schema: planSchema(this.selection.ruleset),
        submit: `POST /api/matches/${this.id}/plan with {"round":${t.round}, ...plan} or {"round":${t.round},"answer":"<model reply with the JSON>"}`,
      };
    return { ...base, status: "waiting", round: m.round + (m.phase === "fighting" ? 0 : 1), message: "the other seats are planning or the round is being played" };
  }

  info() {
    const r = this.runner;
    return {
      id: this.id,
      status: this.status,
      seed: this.seed,
      ruleset: this.selection.preset ?? "Custom",
      ...(this.selection.presetVersion !== undefined ? { rulesetVersion: this.selection.presetVersion } : {}),
      deadlineSec: this.deadlineMs / 1000,
      createdAt: new Date(this.createdAt).toISOString(),
      ...(this.status === "open" ? { startsInSec: Math.max(0, Math.ceil((this.startsAt - Date.now()) / 1000)) } : {}),
      seats: this.kinds.map((k, i) => {
        const a = this.agents[i];
        return {
          seat: i,
          kind: k === "remote" && !a && this.status !== "open" ? "house" : k,
          agent: a?.name ?? null,
          ...(a ? { owner: a.owner, soulLine: soulLine(a.soul) } : {}),
          ...(a?.leftRound ? { houseFromRound: a.leftRound } : {}),
          ...(a?.autopilot ? { autopilot: a.autopilot, ...(this.status === "over" ? { finishedOnAutopilot: true } : {}) } : {}),
          fighter: r?.names[i] ?? null,
          label: r?.labels[i] ?? null,
          // who plays it, for the model badge: from the label once running, from the join before
          model: seatModel(this.modelLabel(i)),
        };
      }),
      round: r ? r.match.round : 0,
      wins: r ? r.match.wins.slice() : null,
      winner: r && r.match.over ? r.names[r.match.winner] : null,
      record: r?.recordFile ? `/records/${r.recordFile}` : null,
      watch: `/?live&match=${this.id}`,
      live: `/api/live?match=${this.id}`,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  report(round?: number) {
    const r = this.runner;
    if (!r) return { ...this.info(), rounds: [] };
    const m = r.match;
    const names = m.names;
    const rounds = m.record.rounds
      .map((rec, i) => {
        const f = m.facts[i];
        return {
          round: i + 1,
          plans: rec.strategies.map((s, seat) => ({
            fighter: names[seat],
            line: rec.lines[seat],
            strategy: { ...s, ...(s.grudge !== undefined ? { target: names[s.grudge] } : {}) },
            meta: rec.meta?.[seat] ?? null,
          })),
          result: f
            ? {
                winner: names[f.winner],
                reason: f.reason,
                seconds: Math.round(f.seconds),
                knockouts: f.stats.kos.map((k) => ({ victim: names[k.victim], by: k.by >= 0 && k.by !== k.victim ? names[k.by] : null, weapon: k.weapon, cause: k.cause, tick: k.tick ?? null })),
                ticks: rec.fight.ticks,
                summary: Object.fromEntries(names.map((n, s) => [n, f.stats.summary[s]])),
                finalHash: rec.fight.finalHash,
              }
            : null,
        };
      })
      .filter((x) => round === undefined || x.round === round);
    // the crowd's final split (#35), once the match is over: never while agents still play
    const over = this.status === "over" && m.over;
    return { ...this.info(), rounds, ...(over ? { picks: this.picks.split(m.winner) } : {}) };
  }
}
