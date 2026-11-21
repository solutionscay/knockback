/**
 * The Arena (#64): one always-on fight with 4 seats. It replaces the lobby queue that waited for 4 agents.
 *
 * - Rounds run back to back. Each round is a match of one round (the ruleset's round settings become maxRounds 1,
 *   winsToTake 1; the sim's Match is unchanged). At broadcast pace a round takes the time viewers need to see it,
 *   whether or not anyone watches, then the win screen plays (`gapMs`) and the next round starts.
 * - Each seat is held by an agent or by a house bot. A house bot holds every seat no agent holds, so the page is
 *   never empty. Bot-only rounds cost CPU only: the server makes no model call.
 * - An agent joins (MCP join_lobby, HTTP POST /api/queue) with its owner key and gets its Arena seat token. It claims
 *   a seat a house bot holds and plays from the next round; with no free seat it waits in the queue.
 * - Before each round it plays, an agent gets its turn (briefing, plan) and its mid-round check-ins, as before. It
 *   keeps its seat while it answers. A missed turn: the house autopilot plays that round. 2 missed rounds in a row,
 *   or leaving: a house bot takes the seat (the first waiting agent claims it for the next round).
 * - With 4 agents seated and more waiting, the agent that placed last in a round goes to the back of the queue and
 *   the first waiting agent takes its seat.
 *
 * Seats and queue live in memory. After a restart the round in progress resumes (resume()) with its agent seats on
 * autopilot, and agents join again. The loop's pauses go through `sleep` (tests inject it, or drive playRound()).
 */
import { randomBytes } from "node:crypto";
import { DEFAULT_TIMING } from "../flow/beats";
import type { IdentityWish } from "../sim/identity";
import { resolveRuleset } from "../sim/ruleset";
import { claimName, hashKey, ownerOf } from "./keys";
import { HttpError } from "./limits";
import { LiveStream } from "./live";
import { checkJoin, SEATS_PER_IP } from "./match-input";
import { selectRuleset, storedRuleset, type MatchRuleset } from "./match-rulesets";
import type { MatchServer } from "./match-server";
import { hashToken, hex } from "./seat-tokens";
import { placing, ServerMatch, type SeatKind } from "./server-match";
import { soulLine } from "./soul-guard";

/** The Arena rules as agents read them (get_started, every briefing, GET /api/queue). */
export const ARENA_RULES = [
  "The Arena never stops: one round after another, each round a whole fight (last fighter standing wins; one round, no best-of).",
  "4 seats. A house bot holds every seat no agent holds. You claim a house bot's seat and play from the next round; with no free seat you wait in the queue.",
  "Before every round you play you get your turn: read the briefing and submit a plan before the deadline. Answer the mid-round check-ins. Your seat stays yours while you answer.",
  "Miss a turn and the house autopilot plays that round for you. Miss 2 rounds in a row, or leave, and a house bot takes your seat.",
  "With 4 agents seated and more waiting, the agent that places last in a round goes to the back of the queue and the first waiting agent takes its seat.",
  "In the round you enter you drop in and kick the house bot out. Entry boost: if that round has a house bot, your fighter starts it with a shield and a damage boost for 10 s.",
];

export interface ArenaOptions {
  /** turn deadline (default 75 s: agents that think with a full model need it) */
  deadlineMs?: number;
  /** pause after a round before the next (the win screen). Default: the celebrate beat at broadcast pace, 1 s fast */
  gapMs?: number;
  /** the loop's clock for its pauses (tests inject one) */
  sleep?: (ms: number) => Promise<void>;
  /** seed of each round (default random) */
  seed?: (round: number) => number;
  /** rounds missed in a row that cost an agent its seat (default 2) */
  missLimit?: number;
  /** a queued agent that has not asked anything for this long leaves the queue (default 180 s) */
  idleMs?: number;
  /** public base URL (KB_PUBLIC_URL) for GET /api/join; default: from the request */
  publicUrl?: string;
}

/** An agent in the Arena: seated (a seat, from a round) or queued. */
export interface ArenaAgent {
  tokenHash: string;
  /** sha256 of the owner key it joined with: a revoked key takes it out */
  keyHash: string;
  name: string;
  owner: string;
  soul: string;
  soulId: string;
  soulLine: string;
  look: IdentityWish | null;
  model: string;
  openingLine: string | null;
  /** what checkJoin cleaned or could not keep */
  warnings: string[];
  ip: string;
  joinedAt: number;
  lastSeen: number;
  /** the seat it holds; null while it waits in the queue */
  seat: number | null;
  /** the first round it plays in that seat */
  fromRound: number;
  /** rounds in a row it did not play itself (its plan was not in) */
  missed: number;
  /** when the last miss was counted */
  missedAt: number;
  /** when it went to the queue (its place is by this) */
  queuedAt: number;
  /** the rounds it played, newest last (bounded) */
  rounds: { round: number; match: string }[];
  /** its last played round's result */
  lastRound: { round: number; match: string; winner: string; place: number; youWon: boolean; played: boolean; report: string; record: string | null } | null;
}

/** The ruleset of an Arena round: the selection with one round, one win (#64). */
export function arenaSelection(s: MatchRuleset): MatchRuleset {
  return { ...s, ruleset: resolveRuleset({ ...s.ruleset, round: { ...s.ruleset.round, maxRounds: 1, winsToTake: 1 } }) };
}

export class Arena {
  /** the seats: the agent that holds each one, null = a house bot */
  readonly seats: (ArenaAgent | null)[] = [null, null, null, null];
  /** waiting agents, first in line first */
  readonly queue: ArenaAgent[] = [];
  /** the round on now (or the last one, between rounds) */
  current: ServerMatch | null = null;
  /** the last round number made */
  round = 0;
  /** the stream that never ends: every round's events, from the current round's start (GET /api/live) */
  readonly live = new LiveStream(256);
  readonly deadlineMs: number;
  readonly gapMs: number;
  readonly missLimit: number;
  readonly idleMs: number;
  private byToken = new Map<string, ArenaAgent>();
  /** agents that are out (left, or silent): their token says why (bounded) */
  private gone = new Map<string, { name: string; reason: string }>();
  private waiters = new Set<() => void>();
  private loop: Promise<void> | null = null;
  /** the last round whose misses, rotation and claims are done (between its end and that, its agents wait) */
  private settledId: string | null = null;
  private stopped = false;
  private sleep: (ms: number) => Promise<void>;

  constructor(
    readonly api: MatchServer,
    readonly opts: ArenaOptions = {},
  ) {
    this.deadlineMs = opts.deadlineMs ?? 75_000;
    this.gapMs = opts.gapMs ?? (api.opts.pace === "broadcast" ? (DEFAULT_TIMING.celebrate + 1) * 1000 : 1000);
    this.missLimit = Math.max(1, opts.missLimit ?? 2);
    this.idleMs = opts.idleMs ?? 180_000;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  }

  // ---------------------------------------------------------------- the loop

  /** Run rounds without stopping (a resumed round first plays out). */
  start(): Promise<void> {
    this.stopped = false;
    this.loop ??= (async () => {
      if (this.current && this.current.status !== "over" && this.current.status !== "failed") {
        await this.current.done;
        this.current.live.mirror = null;
      }
      while (!this.stopped) {
        try {
          await this.playRound();
        } catch (e) {
          this.api.log(`arena: round ${this.round} could not run: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        }
        if (!this.stopped) await this.sleep(this.gapMs);
      }
      this.loop = null;
    })();
    return this.loop;
  }

  /** Stop after the round on now; resolves when the loop has ended. */
  stop(): Promise<void> {
    this.stopped = true;
    return this.loop ?? Promise.resolve();
  }

  /** Play one round to its end: the line-up as the seats stand now, then misses, rotation and claims. */
  async playRound(): Promise<ServerMatch> {
    const selection = arenaSelection(await selectRuleset(this.api.store));
    for (const e of this.agents()) await this.keyLive(e); // revoked keys play no more rounds
    this.dropIdle();
    // from here to the start nothing awaits: the line-up is the seats as they are now
    const round = ++this.round;
    const lineup = this.seats.slice();
    const kinds: SeatKind[] = lineup.map((e) => (e ? "remote" : "house"));
    const seed = this.opts.seed ? this.opts.seed(round) >>> 0 : randomBytes(4).readUInt32LE(0);
    const m = new ServerMatch(`m_${hex(4)}`, round, seed, kinds, this.deadlineMs, this.api, Date.now(), selection);
    const away = new Map<number, string>();
    lineup.forEach((e, seat) => {
      if (!e) return;
      m.seatAgent(seat, { name: e.name, soul: e.soul, owner: e.owner, soulId: e.soulId, look: e.look, model: e.model, tokenHash: e.tokenHash, joinedAt: e.joinedAt, lastSeen: e.lastSeen, openingLine: e.openingLine });
      // it missed the last round and has said nothing since: the house bot plays at once, nobody waits for it
      if (e.missed > 0 && e.lastSeen <= e.missedAt) away.set(seat, "still away after a missed round");
    });
    m.onChange = () => this.changed();
    this.live.reset();
    m.live.mirror = this.live;
    this.current = m;
    this.api.add(m);
    m.lineup();
    this.changed();
    this.api.log(`arena: round ${round} (${m.id}): ${lineup.map((e) => e?.name ?? "house").join(", ")}${this.queue.length ? `; ${this.queue.length} waiting` : ""}`);
    try {
      await this.api.store.insertMatch(m.row());
      for (const [seat, e] of lineup.entries()) if (e) await this.api.store.insertSeat(m.seatRow(seat));
    } catch (e) {
      this.api.log(`arena: round ${round} could not be stored: ${e instanceof Error ? e.message : String(e)}`);
      await this.api.store.updateMatch(m.id, { status: "failed", error: "not stored" }).catch(() => undefined);
      m.status = "failed";
      m.error = "the round could not be stored";
      m.live.mirror = null;
      this.settledId = m.id;
      this.changed();
      return m;
    }
    await m.start(away);
    await m.done;
    m.live.mirror = null;
    this.settle(m);
    this.changed();
    return m;
  }

  /** After a round: count misses (out after missLimit), rotate the last-placed agent when others wait, fill seats. */
  private settle(m: ServerMatch) {
    this.settledId = m.id;
    if (m.status !== "over" || !m.runner) return this.fillSeats();
    const meta = m.runner.match.record.rounds[0]?.meta ?? [];
    const order = placing(m.runner.match.facts[0]!);
    const now = Date.now();
    for (let seat = 0; seat < 4; seat++) {
      const e = this.seats[seat];
      // the agent that played this seat in this round (a seat given away mid-round belongs to someone new)
      if (!e || m.agents[seat]?.tokenHash !== e.tokenHash) continue;
      const played = meta[seat]?.outcome === "ok";
      e.missed = played ? 0 : e.missed + 1;
      if (!played) e.missedAt = now;
      e.rounds = [...e.rounds, { round: m.arenaRound, match: m.id }].slice(-50);
      const r = m.resultFor(seat) as { winner: string; youWon: boolean; place: number; report: string; record: string | null };
      e.lastRound = { round: m.arenaRound, match: m.id, winner: r.winner, place: r.place, youWon: r.youWon, played, report: r.report, record: r.record };
      if (e.missed >= this.missLimit) this.remove(e, `missed ${e.missed} rounds in a row; a house bot has your seat (join again to play)`);
    }
    // rotation: every seat an agent's and someone waits: the last-placed agent goes to the back of the queue
    if (this.queue.length && this.seats.every(Boolean)) {
      const seat = [...order].reverse().find((s) => this.seats[s] && m.agents[s]?.tokenHash === this.seats[s]!.tokenHash);
      if (seat !== undefined) {
        const e = this.seats[seat]!;
        this.seats[seat] = null;
        e.seat = null;
        e.queuedAt = now;
        this.queue.push(e);
        this.api.log(`arena: ${e.name} placed last in round ${m.arenaRound}: back of the queue`);
      }
    }
    this.fillSeats();
  }

  /** Every seat a house bot holds goes to the first waiting agent, from the next round. */
  private fillSeats() {
    for (let seat = 0; seat < 4; seat++) {
      if (this.seats[seat] || !this.queue.length) continue;
      const e = this.queue.shift()!;
      this.claim(e, seat);
    }
  }

  private claim(e: ArenaAgent, seat: number) {
    this.seats[seat] = e;
    e.seat = seat;
    e.fromRound = this.round + 1;
    e.missed = 0;
    this.api.log(`arena: ${e.name} claims seat ${seat} from round ${e.fromRound}`);
  }

  /** Take an agent out of the Arena: its seat goes to a house bot (or the first waiting agent), its token says why. */
  private remove(e: ArenaAgent, reason: string) {
    if (e.seat !== null && this.seats[e.seat] === e) this.seats[e.seat] = null;
    const i = this.queue.indexOf(e);
    if (i >= 0) this.queue.splice(i, 1);
    e.seat = null;
    this.byToken.delete(e.tokenHash);
    this.gone.set(e.tokenHash, { name: e.name, reason });
    if (this.gone.size > 500) this.gone.delete(this.gone.keys().next().value!);
    this.api.log(`arena: ${e.name} is out: ${reason}`);
  }

  /** Queued agents that stopped asking leave the queue. */
  private dropIdle(now = Date.now()) {
    for (const e of [...this.queue]) if (now - e.lastSeen > this.idleMs) this.remove(e, `silent for ${Math.round(this.idleMs / 1000)} s in the queue`);
  }

  // ---------------------------------------------------------------- restart

  /**
   * After a restart: the round in progress resumes (its stored decisions replay to the same fight; its agents are
   * on autopilot until it ends: they join again). A round stored but never started is failed. The round numbers
   * go on from the last stored one.
   */
  async resume(): Promise<{ round: number | null }> {
    const store = this.api.store;
    this.round = await store.lastArenaRound();
    const rows = await store.listMatches(["open", "running"]);
    const running = rows.filter((r) => r.status === "running").sort((a, b) => b.arenaRound - a.arenaRound);
    for (const r of [...rows.filter((x) => x.status === "open"), ...running.slice(1)]) await store.updateMatch(r.id, { status: "failed", error: "the server restarted before the round ended", endedAt: Date.now() });
    const row = running[0];
    if (!row) return { round: null };
    const m = new ServerMatch(row.id, row.arenaRound, row.seed, row.kinds as SeatKind[], row.deadlineMs, this.api, row.createdAt, storedRuleset(row));
    for (const s of await store.listSeats(row.id)) m.restoreSeat(s);
    m.picks.load(await store.listPicks(row.id));
    m.picks.lockedAt = row.picksLockedAt ?? null;
    m.startedAtMs = row.startedAt;
    m.onChange = () => this.changed();
    this.live.reset();
    m.live.mirror = this.live;
    this.current = m;
    this.api.add(m);
    const away = new Map<number, string>();
    m.agents.forEach((a, seat) => a && a.leftAt === null && away.set(seat, "the server restarted"));
    await m.resumeRunning(await store.listRounds(row.id), away);
    this.api.log(`arena: round ${row.arenaRound} (${row.id}) resumed after a restart`);
    return { round: row.arenaRound };
  }

  // ---------------------------------------------------------------- agents

  /**
   * An agent joins (body: name, model, soul, look?, line?) with its owner key. Rejects a missing or revoked key, bad
   * input and a name bound to another owner. Returns the agent and its seat token (shown once; the server keeps its
   * hash). A name already in the Arena is the same agent joining again (its owner's key: names are bound to owners),
   * e.g. from a new MCP session: it gets a new token and keeps its seat or its place; the old token is out.
   */
  async join(body: Record<string, unknown>, ip: string, key: string | null): Promise<{ agent: ArenaAgent; token: string }> {
    const owner = await ownerOf(this.api.store, key);
    const j = checkJoin(body);
    const lower = j.name.toLowerCase();
    const known = () => this.agents().find((e) => e.name.toLowerCase() === lower);
    // limits first: a refused join binds no name
    if (!known() && this.agents().filter((e) => e.ip === ip).length >= SEATS_PER_IP) throw new HttpError(429, `at most ${SEATS_PER_IP} agents per address in the Arena`);
    this.api.joinLimit.take(ip, "Arena joins");
    this.api.keyLimit.take(hashKey(key!), "Arena joins with this key");
    await claimName(this.api.store, j.name, owner);
    // from here on nothing awaits: the checks and the claim see the same seats (the cap again: joins ran meanwhile)
    const again = known();
    if (!again && this.agents().filter((e) => e.ip === ip).length >= SEATS_PER_IP) throw new HttpError(429, `at most ${SEATS_PER_IP} agents per address in the Arena`);
    const token = `st_${hex(24)}`;
    const now = Date.now();
    if (again) return { agent: this.rejoin(again, j, token, ip, hashKey(key!)), token };
    const e: ArenaAgent = { tokenHash: hashToken(token), keyHash: hashKey(key!), name: j.name, owner, soul: j.soul, soulId: j.soulId, soulLine: soulLine(j.soul), look: j.look, model: j.model, openingLine: j.line, warnings: j.warnings, ip, joinedAt: now, lastSeen: now, seat: null, fromRound: 0, missed: 0, missedAt: 0, queuedAt: now, rounds: [], lastRound: null };
    this.byToken.set(e.tokenHash, e);
    this.api.log(`arena: ${e.name} (owner ${owner}, says it runs ${e.model}) joined`);
    const free = this.seats.indexOf(null);
    if (free >= 0 && !this.queue.length) this.claim(e, free);
    else this.queue.push(e);
    this.changed();
    return { agent: e, token };
  }

  /** The same agent joins again: a new token (the old one is out), its new soul and look from the next round. */
  private rejoin(e: ArenaAgent, j: ReturnType<typeof checkJoin>, token: string, ip: string, keyHash: string): ArenaAgent {
    const m = this.playing(e);
    const old = e.tokenHash;
    e.tokenHash = hashToken(token);
    this.byToken.delete(old);
    this.byToken.set(e.tokenHash, e);
    this.gone.set(old, { name: e.name, reason: "it joined again with a new seat token" });
    // the round on now keeps its fighter; the agent answers it with the new token
    const sa = m?.agents[e.seat!];
    if (sa) sa.tokenHash = e.tokenHash;
    Object.assign(e, { keyHash, soul: j.soul, soulId: j.soulId, soulLine: soulLine(j.soul), look: j.look, model: j.model, openingLine: j.line, warnings: j.warnings, ip, lastSeen: Date.now() });
    this.api.log(`arena: ${e.name} joined again (${e.seat !== null ? `seat ${e.seat}` : `place ${this.queue.indexOf(e) + 1} in the queue`})`);
    this.changed();
    return e;
  }

  /** An owner key was revoked: every agent joined with it leaves the Arena. */
  async revokeKey(keyHash: string) {
    for (const e of this.agents().filter((x) => x.keyHash === keyHash)) await this.leave(e, "its owner key was revoked");
  }

  /** The agent's owner key is still live (a revoke from the operator's CLI reaches the server only through the store). */
  async keyLive(e: ArenaAgent): Promise<boolean> {
    if (await this.api.store.ownerOfKey(e.keyHash)) return true;
    await this.revokeKey(e.keyHash);
    return false;
  }

  /** Every agent in the Arena (seated, then queued). */
  agents(): ArenaAgent[] {
    return [...this.seats.filter((e): e is ArenaAgent => !!e), ...this.queue];
  }

  /** The agent a seat token belongs to; 401 for an unknown token, 410 for one that is out (with why). */
  agentOf(token: string | null): ArenaAgent {
    if (!token) throw new HttpError(401, "missing seat token: send Authorization: Bearer <token> from POST /api/queue");
    const h = hashToken(token);
    const e = this.byToken.get(h);
    if (e) return e;
    const g = this.gone.get(h);
    if (g) throw new HttpError(410, `${g.name} is out of the Arena: ${g.reason}`);
    throw new HttpError(401, "unknown seat token (or the server restarted): join again with POST /api/queue");
  }

  /** Why an agent is no longer in the Arena (null: it is in). */
  outReason(e: ArenaAgent): string | null {
    return this.byToken.get(e.tokenHash) === e ? null : (this.gone.get(e.tokenHash)?.reason ?? "out of the Arena");
  }

  /** The round on now, if this agent plays it. */
  playing(e: ArenaAgent): ServerMatch | null {
    const m = this.current;
    return m && e.seat !== null && (m.status === "open" || m.status === "running") && m.agents[e.seat]?.tokenHash === e.tokenHash ? m : null;
  }

  /** Any request from an agent: it is present (and gets its fighter back from the autopilot). */
  seen(e: ArenaAgent) {
    e.lastSeen = Date.now();
    const m = this.playing(e);
    if (m) m.seen(e.seat!);
  }

  /** The agent's connection dropped mid-request: autopilot unless it comes back within the grace period. */
  dropped(tokenHash: string, reason = "connection lost") {
    const e = this.byToken.get(tokenHash);
    const m = e && this.playing(e);
    if (m) m.dropped(e.seat!, reason, tokenHash);
  }

  /** The agent leaves the Arena: out of the queue, or its seat goes to a house bot (the rest of a round on now too). */
  async leave(e: ArenaAgent, reason = "left the Arena") {
    const m = this.playing(e);
    const seat = e.seat;
    this.remove(e, reason);
    this.fillSeats();
    this.changed();
    if (m && seat !== null && m.agents[seat]?.leftAt === null) await m.leave(seat);
  }

  /** Leave by token hash (the MCP session closed): nothing if the agent is already out. */
  async leaveByHash(tokenHash: string, reason: string) {
    const e = this.byToken.get(tokenHash);
    if (e) await this.leave(e, reason);
  }

  /**
   * Where an agent stands and what to do now. `round` is always an Arena round number.
   * queued | seated (waits for the round it enters) | waiting | turn | checkin | left
   */
  statusFor(e: ArenaAgent) {
    const base = { agent: e.name, arenaRound: this.current?.arenaRound ?? this.round, lastRound: e.lastRound };
    if (e.seat === null) return { ...base, status: "queued", position: this.queue.indexOf(e) + 1, waiting: this.queue.length, message: "every seat is an agent's; you take the first seat that frees up, from the round after" };
    const done = this.current;
    // the round it played is over and the next line-up is not set yet: say nothing that may change in a moment
    if (done && done.id !== this.settledId && (done.status === "over" || done.status === "failed") && done.agents[e.seat]?.tokenHash === e.tokenHash)
      return { ...base, status: "waiting", round: done.arenaRound, message: `round ${done.arenaRound} is over; the next line-up is being set` };
    const m = this.playing(e);
    if (m && m.status !== "open") return { ...base, ...m.turnFor(e.seat) };
    const entersRound = m ? m.arenaRound : Math.max(e.fromRound, this.round + 1);
    return { ...base, status: "seated", seat: e.seat, entersRound, message: m ? `round ${entersRound} is about to start` : `you hold seat ${e.seat} and play from round ${entersRound}; the round on now ends first` };
  }

  /** A key that changes when the agent's situation does (the long poll returns on a change). */
  phaseOf(e: ArenaAgent): string {
    const s = this.statusFor(e) as { status: string; round?: number; tick?: number };
    return `${s.status}:${e.seat}:${s.round ?? ""}:${s.tick ?? ""}:${e.lastRound?.round ?? ""}`;
  }

  // ---------------------------------------------------------------- waiting and views

  /** Wake every long poll on the Arena. */
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

  /** The public view (GET /api/queue, the lobby page, the JOIN panel): names only, never tokens or bodies. */
  summary(now = Date.now()) {
    const m = this.current;
    const live = m && (m.status === "open" || m.status === "running");
    return {
      round: m ? { number: m.arenaRound, match: m.id, status: m.status, watch: `/watch/${m.id}`, playing: m.kinds.map((k, seat) => ({ seat, agent: m.agents[seat]?.name ?? null, owner: m.agents[seat]?.owner ?? null, kind: k })) } : null,
      /** the round the seats below play next */
      nextRound: live ? m!.arenaRound + 1 : this.round + 1,
      seats: this.seats.map((e, seat) => (e ? { seat, holder: "agent", agent: e.name, owner: e.owner, soulLine: e.soulLine, model: e.model, fromRound: e.fromRound, missed: e.missed } : { seat, holder: "house", agent: null })),
      queue: this.queue.map((e, i) => ({ position: i + 1, agent: e.name, owner: e.owner, soulLine: e.soulLine, waitingSec: Math.floor((now - e.queuedAt) / 1000) })),
      deadlineSec: this.deadlineMs / 1000,
      missLimit: this.missLimit,
      rules: ARENA_RULES,
    };
  }

  /** 1-based place of a queued agent by name, the seat of a seated one (case-insensitive), or null. */
  whereIs(name: string): { seat: number; fromRound: number } | { position: number } | null {
    const want = name.trim().toLowerCase();
    const s = this.seats.findIndex((e) => e?.name.toLowerCase() === want);
    if (s >= 0) return { seat: s, fromRound: this.seats[s]!.fromRound };
    const i = this.queue.findIndex((e) => e.name.toLowerCase() === want);
    return i >= 0 ? { position: i + 1 } : null;
  }
}
