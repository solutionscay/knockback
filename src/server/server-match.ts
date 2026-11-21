/**
 * One Arena round on the match server (#64): a one-round match with 4 seats, each held by an agent ("remote") or a
 * house bot. The Arena (arena.ts) makes it, seats its agents and starts it at once; this class plays it: the runner,
 * presence and the house bot's takeovers (#22), spectator picks (#35), what it writes to the store, and the views
 * the API serves (turn, info, report). The server runs no model: agents think with their own.
 */
import type { Seat } from "../ai/decide";
import { MatchRunner, type ControlEvent, type RunnerEvent, type StoredRound } from "../ai/runner";
import { settleSuitUp, type SuitUpAnswer, type SuitUpResult } from "../ai/suitup";
import type { IdentityWish } from "../sim/identity";
import { parseSoul, type Soul } from "../sim/soul";
import { exampleSouls } from "../sim/souls";
import { modelOf, remoteLabel, seatEntries } from "../stats/models";
import { portraitSvg } from "../viewer/portrait";
import { AUTOPILOT_LINES, BACK_LINES, LEFT_LINES, pickLine } from "./autopilot";
import { HttpError } from "./limits";
import { LiveStream } from "./live";
import type { MatchRuleset } from "./match-rulesets";
import type { MatchServer } from "./match-server";
import { PICK_THROTTLE_MS, PickBook, soulOpeningLine } from "./picks";
import { checkinSchema, planSchema, RemoteSeat } from "./remote";
import { soulLine } from "./soul-guard";
import type { MatchRow, MatchStore, SeatRow } from "./store";

/** Who sits in an agent seat for this round. */
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
  /** sha256 (hex) of the agent's Arena seat token */
  tokenHash: string;
  joinedAt: number;
  leftAt: number | null;
  /** the round the house bot took over because the agent left (1: this round) */
  leftRound: number | null;
  /** long polls in flight */
  polls: number;
  /** last authenticated request from this agent (presence) */
  lastSeen: number;
  /** the house bot drives this fighter until the agent comes back (#22): why */
  autopilot: string | null;
  /** said at join, shown on spectators' pick cards (#35) */
  openingLine: string | null;
}

/** "remote" (an agent's seat) or "house" (a house bot). */
export type SeatKind = "remote" | "house";

export class ServerMatch {
  status: "open" | "running" | "over" | "failed" = "open";
  readonly remote: (RemoteSeat | null)[];
  readonly agents: (SeatAgent | null)[] = [null, null, null, null];
  readonly live = new LiveStream();
  readonly createdAt: number;
  runner: MatchRunner | null = null;
  error: string | null = null;
  /** called on every change (the Arena wakes its long polls with it) */
  onChange: () => void = () => {};
  /** resolves when the round is over or failed */
  readonly done: Promise<void>;
  private settle!: () => void;
  private waiters = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly arenaRound: number,
    readonly seed: number,
    readonly kinds: SeatKind[],
    readonly deadlineMs: number,
    protected server: MatchServer,
    createdAt: number,
    readonly selection: MatchRuleset,
  ) {
    this.remote = kinds.map(() => null);
    this.createdAt = createdAt;
    this.done = new Promise((resolve) => (this.settle = resolve));
  }

  /** Wake every long poll on this match. */
  changed() {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
    this.onChange();
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

  /** Spectators of this round: on its own stream and on the Arena stream it mirrors into. */
  watchers(): number {
    return this.live.size + (this.live.mirror?.size ?? 0);
  }

  remoteSeat(seat: number, agent: SeatAgent): RemoteSeat {
    const rs = new RemoteSeat(agent.name, this.deadlineMs, agent.model);
    rs.onChange = () => this.changed();
    // accepted plans are stored before the turn ends, so a restart in mid-ask keeps them
    rs.onAccept = (round, raw) => this.store.insertPlan({ matchId: this.id, round, seat, raw, at: Date.now() });
    rs.stored = async (round) => (await this.store.getPlan(this.id, round, seat))?.raw ?? null;
    rs.shown = (round) => this.arenaRound + round - 1;
    this.remote[seat] = rs;
    return rs;
  }

  seatRow(seat: number): SeatRow {
    const a = this.agents[seat]!;
    return { matchId: this.id, seat, name: a.name, soul: a.soul, owner: a.owner, look: a.look, model: a.model, tokenHash: a.tokenHash, joinedAt: a.joinedAt, leftAt: a.leftAt, leftRound: a.leftRound, openingLine: a.openingLine };
  }

  row(): MatchRow {
    return { ...this.selection, id: this.id, arenaRound: this.arenaRound, seed: this.seed, kinds: this.kinds, deadlineMs: this.deadlineMs, status: this.status, createdAt: this.createdAt, startedAt: null, endedAt: null, error: this.error, winner: null };
  }

  /** Put an agent in its seat (the Arena seats it before the start, or a resume from its stored row). */
  seatAgent(seat: number, a: Omit<SeatAgent, "polls" | "autopilot" | "leftAt" | "leftRound"> & Partial<Pick<SeatAgent, "leftAt" | "leftRound">>): SeatAgent {
    if (this.kinds[seat] !== "remote") throw new Error(`seat ${seat} of ${this.id} is a house seat`);
    const agent: SeatAgent = { leftAt: null, leftRound: null, ...a, polls: 0, autopilot: null };
    this.agents[seat] = agent;
    const rs = this.remoteSeat(seat, agent);
    if (agent.leftRound !== null) rs.left = true;
    return agent;
  }

  /** Put a stored agent back in its seat (resume). */
  restoreSeat(r: SeatRow) {
    this.seatAgent(r.seat, { name: r.name, soul: r.soul, owner: r.owner, soulId: soulIdOf(r.name), look: r.look, model: r.model, tokenHash: r.tokenHash, joinedAt: r.joinedAt, leftAt: r.leftAt, leftRound: r.leftRound, lastSeen: 0, openingLine: r.openingLine ?? null });
  }

  /** The agent in `seat` leaves: the house bot plays the rest of this round (the Arena gives the seat away for the next). */
  async leave(seat: number): Promise<void> {
    const a = this.agents[seat];
    if (!a || a.leftAt !== null) throw new HttpError(409, `seat ${seat} has no agent`);
    if (this.status === "over" || this.status === "failed") return;
    const rs = this.remote[seat]!;
    a.leftRound = 1;
    a.leftAt = Date.now();
    rs.leave();
    if (!a.autopilot && this.runner) this.control({ seat, mode: "autopilot", ...this.runner.position(), reason: "left the match", line: pickLine(LEFT_LINES, this.fighter(seat)) });
    a.autopilot = "left the match";
    this.server.log(`round ${this.arenaRound} (${this.id}): ${a.name} left seat ${seat}; the house bot plays it`);
    this.changed();
    await this.store.updateSeat(this.id, seat, { leftAt: a.leftAt, leftRound: a.leftRound });
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
   * viewers are (or `at`), streamed as a callout, saved in the record.
   */
  takeover(seat: number, reason: string, at?: Pick<ControlEvent, "round" | "phase" | "tick">, expect?: string) {
    const a = this.agents[seat];
    // `expect`: the seat token hash of the agent this is about
    if (!a || a.leftAt !== null || a.autopilot || (expect !== undefined && a.tokenHash !== expect)) return;
    if (this.status !== "running" || !this.runner) return;
    a.autopilot = reason;
    this.remote[seat]?.setAutopilot(reason);
    // during the seat's open check-in: stamped at that check-in's tick (phase "checkin")
    this.control({ seat, mode: "autopilot", ...(at ?? this.runner.checkinAt(seat) ?? this.runner.position()), reason, line: pickLine(AUTOPILOT_LINES, this.fighter(seat)) });
  }

  /** Any request from a seat: it is present; an agent on autopilot gets its fighter back (check-ins; a plan if one is still asked). */
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
      if (this.agents[seat] === a && a.lastSeen <= since && a.polls === 0) this.takeover(seat, reason, undefined, a.tokenHash);
    }, this.server.opts.dropGraceMs).unref?.();
  }

  /** Agents still in control of their fighters. */
  activeAgents(): number {
    return this.agents.filter((a) => a && a.leftAt === null && !a.autopilot).length;
  }

  // ---------------------------------------------------------------- spectator picks (#35)
  readonly picks = new PickBook();
  /** when the round started: the pick window stays open PICK_MIN_WINDOW_MS after it, at broadcast pace */
  startedAtMs: number | null = null;
  private picksTimer: ReturnType<typeof setTimeout> | undefined;
  private picksSentAt = 0;

  /** Tell spectators which match this stream is (before the start too), so they can show the pick cards. */
  lineup() {
    if (this.status === "open") this.live.broadcast({ type: "lineup", matchId: this.id, arenaRound: this.arenaRound });
  }

  /** Who plays a seat, as a model label (for the model badge): from the runner's label once running, from the seat before. */
  modelLabel(i: number): string {
    const a = this.agents[i];
    return this.runner?.labels[i] ?? (a ? remoteLabel(a.name, a.model) : "house");
  }

  /** The identities as they stand: the agents' join looks, settled in seat order (#19). */
  settledLooks(): SuitUpResult {
    const answers: SuitUpAnswer[] = [];
    this.agents.forEach((a, seat) => {
      if (a?.look && Object.keys(a.look).length) answers.push({ seat, by: "agent", outcome: "answered", wish: { ...a.look }, ...(a.openingLine ? { line: a.openingLine } : {}) });
    });
    return settleSuitUp(this.seed, answers);
  }

  /** The 4 fighters as spectators see them on the pick cards: name, look, who plays it, the opening line. */
  pickFighters() {
    const souls = this.souls();
    const ids = this.runner?.match.identities ?? this.settledLooks().identities;
    return this.kinds.map((_, i) => {
      const a = this.agents[i];
      const id = ids[i]!;
      const line = a?.openingLine ?? soulOpeningLine(souls[i]!.lines, souls[i]!.catchphrase || undefined, id.name, this.seed + i);
      return { seat: i, name: id.name, color: id.color, look: id, label: a ? `agent · ${a.name}` : "house bot", model: this.modelLabel(i), line, svg: portraitSvg(id, "fist", "fight", "full") };
    });
  }

  /** Everything a pick card needs, plus this spectator's pick. Never part of anything an agent sees. */
  picksView(spectator: string | null) {
    const t = this.picks.tally();
    const over = this.status === "over" && this.runner?.match.over;
    return {
      match: this.id,
      arenaRound: this.arenaRound,
      status: this.status,
      locked: this.picks.locked,
      lockedAt: this.picks.lockedAt,
      // the earliest the window can close: 30 s of picks after the start (at broadcast pace)
      locksAtEarliest: this.picks.locked ? this.picks.lockedAt : (this.startedAtMs ?? this.createdAt) + (this.server.opts.pace === "broadcast" ? this.server.opts.pickWindowMs : 0),
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
    if (this.picks.locked) throw new HttpError(409, "picks are locked: the fight has started");
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

  /** Close the pick window: right before the round's decisions go out (and before it is simulated). Persisted first. */
  async lockPicks() {
    if (this.picks.locked) return;
    this.picks.lockedAt = Date.now();
    clearTimeout(this.picksTimer);
    this.picksTimer = undefined;
    await this.store.updateMatch(this.id, { picksLockedAt: this.picks.lockedAt });
    this.live.broadcast({ type: "picksLocked", matchId: this.id, ...this.picks.tally() });
    this.server.log(`round ${this.arenaRound} (${this.id}): picks locked (${this.picks.tally().total} picks)`);
  }

  /** Build the seats (souls, agents or house bots) and the runner. */
  protected buildRunner(): MatchRunner {
    const souls = this.souls();
    const seats: Seat[] = this.kinds.map((_, i) => {
      const rs = this.remote[i];
      // a check-in goes to the agent with the runner's check-in deadline
      if (rs) return { providerName: "remote", provider: rs.provider, soul: souls[i]!, checkin: (prompt, st, signal) => rs.askCheckin(prompt, st, signal, runner.checkin?.capMs) };
      return { providerName: "house", provider: null, soul: souls[i]! };
    });
    // the agents' join looks (#19); the entries go into the record
    const su = this.settledLooks();
    const broadcast = this.server.opts.pace === "broadcast";
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
      // the Arena keeps broadcast time whether or not anyone watches: rounds never pile up
      shouldPace: () => true,
      // picks (#35): at broadcast pace, while someone watches, at least 30 s of picks after the start, then the
      // window closes right before the round's decisions are broadcast and simulated (the agents plan meanwhile)
      beforeBroadcast: async () => {
        const until = (this.startedAtMs ?? Date.now()) + this.server.opts.pickWindowMs;
        while (broadcast && !this.picks.locked && Date.now() < until && this.watchers() > 0) await Bun.sleep(Math.min(250, until - Date.now()));
        await this.lockPicks();
      },
      onPlayed: (round, hash, updates) => this.store.setRoundHash(this.id, round, hash, updates),
      checkins: this.server.opts.checkins,
      // a fighter on autopilot (or whose agent left) gets no check-in; the house bot's plan plays on
      onAutopilot: (seat) => !!this.remote[seat] && (!!this.agents[seat]?.autopilot || this.agents[seat]?.leftAt != null),
    });
    this.remote.forEach((rs, i) => rs?.bind(runner.match, i));
    return runner;
  }

  /**
   * Play the round in the background. `away`: agent seats that start on autopilot (seat -> why), e.g. an agent
   * that missed the last round and has not been heard from since: the house bot plays at once, nobody waits.
   */
  async start(away: Map<number, string> = new Map()) {
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
    this.server.log(`round ${this.arenaRound} (${this.id}): started, seed ${this.seed}, seats ${this.runner.labels.join(", ")}`);
    this.runner.start();
    this.awayAtStart(away);
    this.changed();
    this.play();
  }

  /** Autopilot before the first ask (a takeover once asking has started could race the ask). */
  private awayAtStart(away: Map<number, string>) {
    for (const [seat, reason] of away) {
      const a = this.agents[seat];
      if (!a || a.leftAt !== null || a.autopilot) continue;
      a.autopilot = reason;
      this.remote[seat]?.setAutopilot(reason);
      this.control({ seat, mode: "autopilot", round: 1, phase: "plan", tick: null, reason, line: pickLine(AUTOPILOT_LINES, this.fighter(seat)) });
    }
  }

  /**
   * Resume a running round after a restart: replay its stored decisions (same fight), then play on. The agents are
   * gone with the old process (they join the Arena again): `away` seats without an accepted plan start on autopilot.
   */
  async resumeRunning(rounds: StoredRound[], away: Map<number, string> = new Map()) {
    this.status = "running";
    try {
      this.runner = this.buildRunner();
      this.runner.start();
      // the round was decided before the restart: its decisions go out again now, so picks must be closed
      if (rounds.length) await this.lockPicks();
      for (const r of rounds) await this.runner.replayRound(r);
      await this.restoreControl();
      if (!rounds.length) {
        for (const seat of [...away.keys()]) if (await this.store.getPlan(this.id, 1, seat)) away.delete(seat);
        this.awayAtStart(away);
      }
    } catch (e) {
      this.fail(e);
      return;
    }
    this.server.log(`round ${this.arenaRound} (${this.id}): resumed after ${rounds.length} stored round${rounds.length === 1 ? "" : "s"} (hashes ${this.runner.match.record.rounds.map((r) => r.fight.finalHash).join(",") || "-"})`);
    this.changed();
    this.play();
  }

  /** Rebuild a finished round from storage (for its report and replay); not played on. */
  async loadFinished(row: MatchRow, rounds: StoredRound[], recordPath: string | null) {
    this.status = row.status;
    this.error = row.error;
    this.settle();
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
    try {
      const r = this.runner!;
      const file = r.save(this.server.opts.outDir, "arena");
      const m = r.match;
      // the per-seat model stats go into the record index too: GET /api/models reads them without opening files
      const stats = JSON.stringify(seatEntries(r.savedRecord()));
      await this.store.insertRecord({ matchId: this.id, path: `/records/${file}`, seed: this.seed, hashes: m.record.rounds.map((x) => x.fight.finalHash), winner: m.winner, createdAt: Date.now(), stats });
      this.server.modelsCache = null;
      await this.store.updateMatch(this.id, { status: "over", winner: m.winner, endedAt: Date.now() });
      this.status = "over";
      this.server.log(`round ${this.arenaRound} (${this.id}): ${r.names[m.winner]} wins; record ${r.recordFile}`);
      this.changed();
      this.settle();
    } catch (e) {
      this.fail(e);
    }
  }

  protected fail(e: unknown) {
    this.status = "failed";
    this.error = e instanceof Error ? e.message : String(e);
    this.server.log(`round ${this.arenaRound} (${this.id}): failed: ${this.error}`);
    this.store.updateMatch(this.id, { status: "failed", error: this.error, endedAt: Date.now() }).catch((x) => this.server.log(`store: ${x}`));
    this.live.broadcast({ type: "error", error: this.error });
    this.changed();
    this.settle();
  }

  private onEvent(e: RunnerEvent) {
    // the stream says which match and Arena round it is, so spectators can fetch the pick cards (#35)
    this.live.broadcast(e.type === "match" ? { ...e, matchId: this.id, arenaRound: this.arenaRound } : e);
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

  /**
   * What the agent in `seat` should do now in this round. `round` in the answer is the Arena round: plans and
   * check-ins name it (the match inside is always round 1).
   */
  turnFor(seat: number) {
    const base = { match: this.id, round: this.arenaRound, seat };
    if (this.status === "open") return { ...base, status: "waiting", message: "the round is about to start" };
    if (this.status === "failed") return { ...base, status: "over", error: this.error };
    const m = this.runner!.match;
    if (this.status === "over") return { ...base, status: "over", ...this.resultFor(seat) };
    if (this.agents[seat]?.leftAt) return { ...base, status: "left", message: "you left; the house bot plays this round" };
    const c = this.remote[seat]?.checkinTurn;
    if (c)
      return {
        ...base,
        status: "checkin",
        tick: c.tick,
        second: Math.round(c.tick / 60),
        deadlineAt: new Date(c.deadlineAt).toISOString(),
        msLeft: Math.max(0, c.deadlineAt - Date.now()),
        attempts: c.attempts,
        checkin: c.status,
        prompt: c.prompt,
        schema: checkinSchema(this.selection.ruleset),
        submit: `POST /api/arena/checkin with {"round":${this.arenaRound},"tick":${c.tick},"keep":true} or {"round":${this.arenaRound},"tick":${c.tick}, ...only the plan fields to change, "line":"..."}; the check-in waits for your answer and the change applies when it arrives (a slow answer applies late)`,
      };
    const t = this.remote[seat]?.turn;
    if (t)
      return {
        ...base,
        status: "turn",
        deadlineAt: new Date(t.deadlineAt).toISOString(),
        msLeft: Math.max(0, t.deadlineAt - Date.now()),
        attempts: t.attempts,
        context: t.context,
        prompt: t.prompt,
        schema: planSchema(this.selection.ruleset),
        submit: `POST /api/arena/plan with {"round":${this.arenaRound}, ...plan} or {"round":${this.arenaRound},"answer":"<model reply with the JSON>"}`,
      };
    return { ...base, status: "waiting", message: m.phase === "fighting" ? "the round is being fought" : "the other seats are planning" };
  }

  /** The round's result for one seat: winner, the seat's place (1-4), links. */
  resultFor(seat: number) {
    const r = this.runner;
    if (!r || this.status !== "over") return {};
    const m = r.match;
    const order = placing(m.facts[0]!);
    return { winner: m.names[m.winner], youWon: m.winner === seat, place: order.indexOf(seat) + 1, record: r.recordFile ? `/records/${r.recordFile}` : null, report: `/api/matches/${this.id}/report` };
  }

  info() {
    const r = this.runner;
    return {
      id: this.id,
      arenaRound: this.arenaRound,
      status: this.status,
      seed: this.seed,
      ruleset: this.selection.preset ?? "Custom",
      ...(this.selection.presetVersion !== undefined ? { rulesetVersion: this.selection.presetVersion } : {}),
      deadlineSec: this.deadlineMs / 1000,
      createdAt: new Date(this.createdAt).toISOString(),
      seats: this.kinds.map((k, i) => {
        const a = this.agents[i];
        return {
          seat: i,
          kind: k,
          agent: a?.name ?? null,
          ...(a ? { owner: a.owner, soulLine: soulLine(a.soul) } : {}),
          ...(a?.leftRound ? { houseFromRound: a.leftRound } : {}),
          ...(a?.autopilot ? { autopilot: a.autopilot, ...(this.status === "over" ? { finishedOnAutopilot: true } : {}) } : {}),
          fighter: r?.names[i] ?? null,
          label: r?.labels[i] ?? null,
          // who plays it, for the model badge
          model: modelOf(this.modelLabel(i)),
        };
      }),
      round: r ? r.match.round : 0,
      wins: r ? r.match.wins.slice() : null,
      winner: r && r.match.over ? r.names[r.match.winner] : null,
      placing: r && r.match.over ? placing(r.match.facts[0]!) : null,
      record: r?.recordFile ? `/records/${r.recordFile}` : null,
      watch: `/watch/${this.id}`,
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
    // the crowd's final split (#35), once the round is over: never while agents still play
    const over = this.status === "over" && m.over;
    return { ...this.info(), rounds, ...(over ? { picks: this.picks.split(m.winner) } : {}) };
  }
}

/** A soul id from an agent name. */
export const soulIdOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";

/**
 * The seats of a played round from first to last place (#64): the winner first, then the fighters still standing at
 * the bell by health left, then the knocked-out ones, the last to go first. Rotation sends the last one to the back
 * of the queue.
 */
export function placing(f: { winner: number; fighters: { hpEnd: number }[]; stats: { kos: { victim: number; tick?: number }[] } }): number[] {
  const seats = f.fighters.map((_, i) => i);
  const koAt = new Map<number, number>();
  f.stats.kos.forEach((k, i) => koAt.set(k.victim, k.tick ?? i));
  const standing = seats.filter((s) => s !== f.winner && !koAt.has(s)).sort((a, b) => f.fighters[b]!.hpEnd - f.fighters[a]!.hpEnd || a - b);
  const out = seats.filter((s) => s !== f.winner && koAt.has(s)).sort((a, b) => koAt.get(b)! - koAt.get(a)! || a - b);
  return [f.winner, ...standing, ...out];
}
