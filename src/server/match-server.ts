import { CLASSIC } from "../sim/ruleset";
import { selectRuleset, storedRuleset, type MatchRuleset } from "./match-rulesets";
/**
 * The match server (#20, #25): Knockback matches with remote agents as
 * players, over a plain JSON HTTP API. Empty or silent seats get the house bot.
 *
 *   POST /api/matches                 create: { seats?, seed?, deadlineSec?, fillAfterSec? }
 *   GET  /api/matches                 list
 *   GET  /api/matches/:id             status and seats
 *   POST /api/matches/:id/join        (owner key) { name, model, soul, look?, seat?, line? } -> { seat, token }
 *   GET  /api/models                  the model leaderboard (from the record index)
 *   GET  /api/matches/:id/turn        (seat token) long poll: ?wait=0-30 s -> open | turn | checkin | waiting | over
 *   POST /api/matches/:id/plan        (seat token) { round, weapons, target, stance, retaliate?, rules?, why?, line } or { round, answer }
 *   POST /api/matches/:id/checkin     (seat token) mid-round check-in answer (#9): { round, tick, keep? | plan fields to change, line?, why? }
 *   POST /api/matches/:id/leave       (seat token) the house bot takes the seat
 *   GET  /api/matches/:id/report      plans and results so far (?round=n for one round)
 *   GET  /api/live?match=:id          spectator stream (SSE); without ?match: the newest match
 *   GET  /api/replays, /api/agents/:name, /share/:id.svg   read-only data for the site pages (site.ts)
 *
 * Joining needs an owner key (src/server/keys.ts: `Authorization: Bearer kbk_...`) and returns a seat token valid for that match and seat only; turn, plan
 * and leave need it in `Authorization: Bearer <token>`. The server keeps only
 * its sha256. With `open: true` (the CLI's --open, for a trusted LAN) tokens
 * are not checked: those calls name the seat with ?seat=N instead.
 * Every body is JSON, at most MAX_BODY bytes; requests are rate limited per
 * address and per seat. The match itself runs in MatchRunner, exactly like a
 * local AI match.
 *
 * Storage (#27): every change is written through a MatchStore (default: an
 * in-memory SQLite). resume() rebuilds the server from it after a restart:
 * open matches wait again, running matches replay their stored rounds
 * (deterministic) and play on; finished ones load on demand.
 */
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_DEADLINE_MS, type Seat } from "../ai/decide";
import { MatchRunner, type RunnerEvent, type StoredRound } from "../ai/runner";
import { PROVIDERS } from "../ai/providers";
import type { IdentityWish } from "../sim/identity";
import { parseSoul, type Soul } from "../sim/soul";
import { exampleSouls } from "../sim/souls";
import { errorResponse, HttpError, json, MAX_BODY, RateLimiter, readJson } from "./limits";
import { LiveStream } from "./live";
import { lobbyPage } from "./lobby";
import { siteRoute } from "./site";
import { queueRoute } from "./queue-routes";
import type { Matchmaker } from "./matchmaker";
import { ENGINE_VERSION } from "../sim/engine-version";
import { checkinSchema, planSchema, RemoteSeat } from "./remote";
import type { CheckinConfig } from "../ai/checkin";
import { AUTOPILOT_LINES, BACK_LINES, LEFT_LINES, pickLine } from "./autopilot";
import type { ControlEvent } from "../ai/runner";
import { PICK_MIN_WINDOW_MS, PICK_THROTTLE_MS, PICKS_PER_ADDRESS, PickBook, soulOpeningLine, spectatorOf } from "./picks";
import { cleanLine } from "../ai/parse";
import { assignIdentities, EYES, luminance, MAJOR_MARKS, MIN_LUMINANCE, MINOR_MARKS, SHAPES, validName } from "../sim/identity";
import { portraitSvg } from "../viewer/portrait";
import { SqliteStore, type MatchRow, type MatchStore, type SeatRow } from "./store";
import { dedupe, headToHead, leaderboard, MODEL_RE, modelOf, remoteLabel, seatEntries, type SeatEntry } from "../stats/models";
import { modelsPage } from "./models-page";
import { lookOptions } from "../ai/looks";
import { settleSuitUp, suitUp, type SuitUpAnswer, type SuitUpResult } from "../ai/suitup";
import { checkOwnerHandle, claimName, hashKey, keyOf, newKey, ownerOf } from "./keys";
import { cleanSoul, MAX_SOUL, MIN_SOUL, soulLine } from "./soul-guard";

/** GET /api/models reads at most this many of the newest records */
const MODELS_MAX_RECORDS = 5000;

/** The model badge data of a seat label; null for an open seat. */
const seatModel = (label: string | null) => (label === null ? null : modelOf(label));

export const MAX_WAIT_S = 30;
/** per address: seats held in open or running matches, and open or running matches created over HTTP */
export const SEATS_PER_IP = 8;
export const MATCHES_PER_IP = 2;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
const LOOK_KEYS = ["name", "shape", "eyes", "mark", "minor", "color"] as const;
const JOIN_KEYS = ["name", "model", "soul", "look", "seat", "line"];

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

export interface CreateMatch {
  /** Preset name or inline JSON settings. */
  ruleset?: unknown;
  seats?: SeatKind[];
  seed?: number;
  deadlineMs?: number;
  fillAfterMs?: number;
  /** creating address (per-address cap on open matches; absent for CLI matches) */
  ip?: string;
}

export interface ServerOptions {
  /** where records are written */
  outDir: string;
  /** trusted LAN mode: no seat token checks (turn, plan and leave take ?seat=N) */
  open?: boolean;
  /** open or running matches at once */
  maxMatches?: number;
  defaultDeadlineMs?: number;
  /** an open match starts after this long, house bots in the empty seats */
  defaultFillAfterMs?: number;
  /** persistence (default: in-memory SQLite, i.e. nothing survives a restart) */
  store?: MatchStore;
  /** shown by GET /api/health (e.g. the image's git revision) */
  version?: string;
  /**
   * "broadcast" (#22): rounds run at viewer speed, the server waits until a
   * round has played out for spectators before asking for the next one.
   * "fast" (default here, for tests): no waiting.
   */
  pace?: "fast" | "broadcast";
  /** a dropped connection becomes autopilot if the seat sends nothing for this long (default 5 s) */
  dropGraceMs?: number;
  /**
   * Mid-round check-ins (#9) for every match: agents (and local AI seats) get
   * a status every ~10 s of fight and may change their plan. Default off.
   */
  checkins?: boolean | Partial<CheckinConfig>;
  /** the suit-up (#19): built-in AI seats choose their own name, look and opening line before the match (default on) */
  suitUp?: boolean;
  /** spectator picks (#35): different spectators one address may add to one match's tally (default 8) */
  picksPerAddress?: number;
  /** at broadcast pace, picks stay open at least this long after the match starts (default 30 s) */
  pickWindowMs?: number;
  log?: (s: string) => void;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Validate a join body: name, model, soul (soul.md: personal data stripped), optional look wishes, seat and line. */
export function checkJoin(body: Record<string, unknown>): { name: string; soul: string; look: IdentityWish | null; model: string; seat?: number; soulId: string; warnings: string[]; line: string | null } {
  const problems: string[] = [];
  const extra = Object.keys(body).filter((k) => !JOIN_KEYS.includes(k));
  if (extra.length) problems.push(`unknown fields: ${extra.join(", ")} (allowed: ${JOIN_KEYS.join(", ")})`);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME_RE.test(name)) problems.push("name: 1-24 characters: letters, digits, space, _ . - (starting with a letter or digit)");
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!MODEL_RE.test(model)) problems.push("model: the model you run, as you would name it (1-40 characters: letters, digits, space . _ : + ( ) / -), e.g. claude-opus-5-5");
  const cleaned = typeof body.soul === "string" ? cleanSoul(body.soul) : null;
  if (!cleaned || cleaned.soul.length < MIN_SOUL) problems.push(`soul: your fighter's soul.md, ${MIN_SOUL}-${MAX_SOUL} characters about the fighter (attitude, voice, what it goes for), not about a person${cleaned?.removed.length ? ` (after removing ${cleaned.removed.join(", ")})` : ""}`);
  const look = body.look === undefined ? null : (checkLook(body.look, problems) ?? null);
  const seat = body.seat;
  if (seat !== undefined && !(Number.isInteger(seat) && (seat as number) >= 0 && (seat as number) <= 3)) problems.push("seat: 0-3");
  // the opening line (#35): shown on spectators' pick cards before the match; validated like a plan's line
  const line = body.line === undefined ? null : typeof body.line === "string" && body.line.length <= 400 ? cleanLine(body.line) : null;
  if (body.line !== undefined && !line) problems.push("line: one short in-character sentence (a non-empty string, at most 400 characters; kept to 120)");
  if (problems.length) throw new HttpError(400, "invalid join", problems);
  const soulId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const soul = cleaned!.soul;
  const parsed = parseSoul(soul, 0, soulId);
  if (parsed.errors.length) throw new HttpError(422, "invalid soul", parsed.errors);
  const removed = cleaned!.removed.length ? [`soul: removed ${cleaned!.removed.join(", ")} (soul.md is about the fighter, not a person)`] : [];
  return { name, soul, look, model, soulId, warnings: [...removed, ...parsed.warnings, ...lookWarnings(look)], line, ...(seat !== undefined ? { seat: seat as number } : {}) };
}

/** Look wishes that cannot be kept as given (#19): they fall back to the seeded draw. Not errors: a warning each. */
export function lookWarnings(look: IdentityWish | null): string[] {
  if (!look) return [];
  const out: string[] = [];
  const known: Record<string, readonly string[]> = { shape: SHAPES, eyes: EYES, mark: MAJOR_MARKS, minor: [...MINOR_MARKS, "none"] };
  for (const [k, list] of Object.entries(known)) {
    const v = look[k as keyof IdentityWish];
    if (v !== undefined && !list.includes(String(v).toLowerCase())) out.push(`look.${k}: unknown "${String(v)}": a random one is used (GET /api/looks lists the options)`);
    else if (v !== undefined) (look as Record<string, unknown>)[k] = String(v).toLowerCase();
  }
  if (look.name !== undefined && !validName(typeof look.name === "string" ? look.name.trim() : look.name)) out.push(`look.name: "${String(look.name)}" breaks the name rules (2-12 letters, digits, space or dash, starting with a letter; not a plan, shape or mark word): a random name is used`);
  if (typeof look.color === "number" && luminance(look.color) < MIN_LUMINANCE) out.push("look.color: too dark for the arenas: the nearest readable color is used, or a random one");
  return out;
}

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
    await this.store.insertRecord({ matchId: this.id, path: `/records/${file}`, seed: this.seed, hashes: m.record.rounds.map((x) => x.fight.finalHash), winner: m.winner, createdAt: Date.now(), engine: m.record.engine, stats });
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

export class MatchServer {
  readonly matches = new Map<string, ServerMatch>();
  /** the lobby's matchmaker (#22), when this server has one: GET/POST /api/queue, GET /api/join */
  matchmaker: Matchmaker | null = null;
  /** sha256(seat token) -> its match and seat (dropped when the match leaves memory) */
  readonly tokens = new Map<string, { match: string; seat: number }>();
  protected newest: ServerMatch | null = null;
  readonly opts: Required<Omit<ServerOptions, "log" | "store">>;
  readonly store: MatchStore;
  readonly log: (s: string) => void;
  // per address: all requests; joins and match creation are scarcer
  readonly ipLimit = new RateLimiter(60, 10);
  readonly joinLimit = new RateLimiter(10, 1 / 6);
  /** per owner key: joins and queue entries (a key cannot flood the lobby from many addresses) */
  readonly keyLimit = new RateLimiter(10, 1 / 6);
  /** new owner keys per address */
  readonly keyCreateLimit = new RateLimiter(5, 1 / 120);
  readonly createLimit = new RateLimiter(5, 1 / 12);
  readonly seatLimit = new RateLimiter(30, 5);
  // spectator picks (#35): per address
  readonly pickLimit = new RateLimiter(20, 1);
  // rebuilding a finished match from storage replays its physics: scarce per address, one load per match at a time
  readonly loadLimit = new RateLimiter(5, 1 / 5);
  private loading = new Map<string, Promise<ServerMatch>>();

  constructor(opts: ServerOptions) {
    const { store, log, ...rest } = opts;
    this.opts = { open: false, maxMatches: 16, defaultDeadlineMs: DEFAULT_DEADLINE_MS, defaultFillAfterMs: 60_000, version: "dev", pace: "fast", dropGraceMs: 5000, checkins: false, picksPerAddress: PICKS_PER_ADDRESS, pickWindowMs: PICK_MIN_WINDOW_MS, suitUp: true, ...rest };
    this.store = store ?? new SqliteStore(":memory:");
    this.log = log ?? (() => {});
  }

  /**
   * Rebuild from storage after a restart: open matches wait for players again
   * (their seat tokens still work), running matches replay their stored rounds
   * and play on. Returns the ids.
   */
  async resume(): Promise<{ open: string[]; running: string[] }> {
    const out = { open: [] as string[], running: [] as string[] };
    const rows = (await this.store.listMatches(["open", "running"])).reverse(); // oldest first
    for (const row of rows) {
      if (this.matches.has(row.id)) continue;
      const m = await this.restore(row);
      if (row.status === "open") {
        m.armFillTimer();
        out.open.push(m.id);
        this.log(`match ${m.id}: open again (${m.agents.filter(Boolean).length} agents seated)`);
      } else {
        await m.resumeRunning(await this.store.listRounds(m.id));
        out.running.push(m.id);
      }
    }
    return out;
  }

  private async restore(row: MatchRow): Promise<ServerMatch> {
    const m = new ServerMatch(row.id, row.seed, row.kinds, row.deadlineMs, row.fillAfterMs, this, row.creator, row.createdAt, storedRuleset(row));
    for (const s of await this.store.listSeats(row.id)) m.restoreSeat(s);
    await this.restorePicks(m, row);
    if (row.suitUp) m.suitAnswers = JSON.parse(row.suitUp) as SuitUpAnswer[];
    this.add(m);
    return m;
  }

  /** Picks and the lock survive a restart (#35). */
  private async restorePicks(m: ServerMatch, row: MatchRow) {
    m.picks.load(await this.store.listPicks(row.id));
    m.picks.lockedAt = row.picksLockedAt ?? null;
    m.startedAtMs = row.startedAt;
  }

  /**
   * The seat a turn/plan/leave call acts for: from the seat token, or in
   * open mode from ?seat=N when no token is sent. Throws 401/403 otherwise.
   */
  seatFor(req: Request, url: URL, match: ServerMatch): number {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    let seat: number;
    if (m) {
      const t = this.tokens.get(hashToken(m[1]!));
      if (!t || t.match !== match.id) throw new HttpError(401, `wrong seat token for match ${match.id}: use the token from POST /api/matches/${match.id}/join`);
      seat = t.seat;
    } else if (this.opts.open) {
      const s = Number(url.searchParams.get("seat"));
      if (!Number.isInteger(s) || s < 0 || s > 3 || !url.searchParams.has("seat")) throw new HttpError(400, "open mode: name your seat with ?seat=0-3 (or send the seat token)");
      if (!match.agents[s]) throw new HttpError(403, `seat ${s} has no agent; POST /api/matches/${match.id}/join first`);
      seat = s;
    } else throw new HttpError(401, `missing seat token: send Authorization: Bearer <token> from POST /api/matches/${match.id}/join`);
    this.seatLimit.take(`${match.id}:${seat}`);
    return seat;
  }

  // ------------------------------------------------------------ matches
  /** From code (the CLI) any provider is allowed; over HTTP only remote and house (see checkCreate). */
  async createMatch(c: CreateMatch = {}, selection?: MatchRuleset): Promise<ServerMatch> {
    const kinds = c.seats ?? ["remote", "remote", "remote", "remote"];
    if (kinds.length !== 4) throw new HttpError(400, "seats: exactly 4");
    for (const k of kinds) if (k !== "remote" && k !== "house" && !PROVIDERS[k]) throw new HttpError(400, `seats: unknown seat kind "${k}" (remote, house${Object.keys(PROVIDERS).length ? `, ${Object.keys(PROVIDERS).join(", ")}` : ""})`);
    const selected = selection ?? await selectRuleset(this.store, c.ruleset);
    const active = [...this.matches.values()].filter((m) => m.status === "open" || m.status === "running");
    if (active.length >= this.opts.maxMatches) throw new HttpError(503, `${active.length} matches are open or running (at most ${this.opts.maxMatches}); try later`);
    if (c.ip !== undefined && active.filter((m) => m.creator === c.ip).length >= MATCHES_PER_IP) throw new HttpError(429, `at most ${MATCHES_PER_IP} open or running matches per address`);
    const seed = c.seed !== undefined ? c.seed >>> 0 : randomBytes(4).readUInt32LE(0);
    const m = new ServerMatch(`m_${hex(4)}`, seed, kinds, c.deadlineMs ?? this.opts.defaultDeadlineMs, c.fillAfterMs ?? this.opts.defaultFillAfterMs, this, c.ip ?? null, Date.now(), selected);
    await this.store.insertMatch(m.row());
    this.add(m);
    m.lineup();
    this.log(`match ${m.id} created: seed ${seed}, seats ${kinds.join(",")}, deadline ${m.deadlineMs / 1000} s, starts in ${(m.startsAt - m.createdAt) / 1000} s at the latest`);
    void m.beginSuitUp();
    m.armFillTimer();
    return m;
  }

  /** Remove a failed empty lobby allocation without changing the default live match. */
  forgetEmpty(match: ServerMatch) {
    if (match.status !== "failed" || match.agents.some(Boolean) || this.matches.get(match.id) !== match) return;
    this.matches.delete(match.id);
    if (this.newest === match) {
      this.newest = null;
      for (const m of this.matches.values()) if (!this.newest || m.createdAt >= this.newest.createdAt) this.newest = m;
    }
  }

  protected add(m: ServerMatch) {
    this.matches.set(m.id, m);
    if (!this.newest || m.createdAt >= this.newest.createdAt) this.newest = m;
    // keep finished matches for a while, but not forever
    if (this.matches.size > 200)
      for (const [k, old] of this.matches)
        if (old.status === "over" || old.status === "failed") {
          old.live.close();
          this.matches.delete(k);
          for (const a of old.agents) if (a) this.tokens.delete(a.tokenHash);
          if (this.matches.size <= 150) break;
        }
  }

  /**
   * What /api/live shows without ?match: the newest running match; else the
   * newest open one (its stream carries the pick cards, #35); else the newest.
   */
  private liveDefault(): ServerMatch | null {
    const newest = (st: string) => [...this.matches.values()].filter((m) => m.status === st).sort((a, b) => b.createdAt - a.createdAt)[0];
    return newest("running") ?? newest("open") ?? this.newest;
  }

  /** Liveness and readiness for the container healthcheck: the process answers and the store can be read. */
  private async health(): Promise<Response> {
    const count = (st: string) => [...this.matches.values()].filter((m) => m.status === st).length;
    const base = { version: this.opts.version, uptimeSec: Math.round(process.uptime()), matches: { open: count("open"), running: count("running") } };
    try {
      await this.store.listMatches(["running"]);
      return json({ ok: true, ...base, store: "ok" });
    } catch (e) {
      this.log(`health: storage unavailable: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return json({ ok: false, error: "storage unavailable" }, 503);
    }
  }

  /** A match in memory, or a finished one loaded from storage (deduplicated and rate limited: it replays the physics). */
  private async matchOr404(mid: string, ip = "local"): Promise<ServerMatch> {
    const m = this.matches.get(mid);
    if (m) return m;
    const pending = this.loading.get(mid);
    if (pending) return pending;
    if (!/^m_[0-9a-f]{8}$/.test(mid)) throw new HttpError(404, `no match ${mid}`);
    const row = await this.store.getMatch(mid);
    if (!row || (row.status !== "over" && row.status !== "failed")) throw new HttpError(404, `no match ${mid}`);
    if (this.loading.has(mid)) return this.loading.get(mid)!;
    this.loadLimit.take(ip, "loads of old matches");
    const load = (async () => {
      const loaded = new ServerMatch(row.id, row.seed, row.kinds, row.deadlineMs, row.fillAfterMs, this, row.creator, row.createdAt, storedRuleset(row));
      for (const s of await this.store.listSeats(row.id)) loaded.restoreSeat(s);
      await this.restorePicks(loaded, row);
      const rec = await this.store.getRecord(mid);
      // a finished match whose record is of another engine version is not loaded (its rounds can't replay here)
      if (row.status === "over" && !rec) throw new HttpError(404, `no match ${mid} on engine v${ENGINE_VERSION}`);
      await loaded.loadFinished(row, await this.store.listRounds(mid), rec?.path ?? null);
      this.add(loaded);
      return loaded;
    })();
    this.loading.set(mid, load);
    try {
      return await load;
    } finally {
      this.loading.delete(mid);
    }
  }

  // ------------------------------------------------------------ HTTP
  /** Handle an /api request (null for other paths). `ip` keys the rate limits. */
  async handle(req: Request, ip = "local"): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname === "/lobby" && req.method === "GET") return new Response(lobbyPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    if (url.pathname === "/models" && req.method === "GET") return new Response(modelsPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api" && !url.pathname.startsWith("/share/")) return null;
    if (url.pathname === "/api/health") return this.health();
    try {
      this.ipLimit.take(ip);
      return await this.route(req, url, ip);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e);
      this.log(`error: ${e instanceof Error ? e.stack : String(e)}`);
      return json({ error: "internal error" }, 500);
    }
  }

  /**
   * GET /api/models: the deduplicated seat entries of the record index, cached until the next record (or 60 s).
   * Independent of ?min (which only re-ranks in memory), so query strings can't force a rebuild.
   */
  modelsCache: { at: number; kept: SeatEntry[][]; dropped: number } | null = null;

  /**
   * The model leaderboard from the SQLite record index (current-engine records): each row's per-seat stats, saved
   * with the record. Matches with test providers are left out; copies of one match count once.
   */
  async models(min?: number) {
    if (!this.modelsCache || Date.now() - this.modelsCache.at >= 60_000) {
      const rows = await this.store.listRecords(MODELS_MAX_RECORDS);
      const sets: SeatEntry[][] = [];
      for (const row of rows) {
        let es: SeatEntry[] = [];
        try {
          const v = JSON.parse(row.stats);
          if (Array.isArray(v)) es = v as SeatEntry[];
        } catch {
          /* unreadable stats: left out */
        }
        if (es.length && !es.some((e) => e.model?.test)) sets.push(es);
      }
      this.modelsCache = { at: Date.now(), ...dedupe(sets) };
    }
    const { kept, dropped } = this.modelsCache;
    const lb = leaderboard(kept, min !== undefined ? { minMatches: min } : {});
    const h2h = headToHead(kept, lb.rows.map((r) => r.key));
    return { ...lb, headToHead: h2h, duplicates: dropped, engine: ENGINE_VERSION, note: "match win rate per seat played; ± is the 95% interval; chance is 25% in a 4-fighter match; models below the minimum are provisional; self-reported models are what remote agents said at join" };
  }

  protected async route(req: Request, url: URL, ip: string): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, "");
    const method = req.method;
    const allow = (want: string) => {
      if (method !== want) throw new HttpError(405, `use ${want} for ${path}`, undefined, { allow: want });
    };
    if (path === "/api") return json(apiIndex(this.opts.open));
    // the site pages' read-only data (#22): /api/replays, /api/agents/:name, /share/:id.svg
    const site = await siteRoute(this, req, path, url);
    if (site) return site;
    const queue = await queueRoute(this, req, path, url, ip);
    if (queue) return queue;
    if (path === "/api/live") {
      allow("GET");
      const mid = url.searchParams.get("match");
      const m = mid ? await this.matchOr404(mid, ip) : this.liveDefault();
      if (!m) throw new HttpError(404, "no match yet");
      return m.live.response();
    }
    if (path === "/api/matches") {
      if (method === "GET") return json({ matches: [...this.matches.values()].map((m) => m.info()) });
      allow("POST");
      this.createLimit.take(ip, "new matches");
      const b = await readJson(req);
      return json((await this.createMatch({ ...checkCreate(b), ip })).info(), 201);
    }
    if (path === "/api/keys") {
      allow("POST");
      this.keyCreateLimit.take(ip, "new owner keys");
      const owner = checkOwnerHandle((await readJson(req, MAX_BODY)).owner);
      const key = newKey();
      if (!(await this.store.createOwner(owner, hashKey(key)))) throw new HttpError(409, `the owner handle ${owner} is taken: if it is yours, use the key you got for it (the JOIN panel keeps it in this browser); otherwise pick another handle`);
      this.log(`owner ${owner}: key issued`);
      return json({ owner, key, use: "send it as Authorization: Bearer <key>; it is shown once" }, 201);
    }
    if (path === "/api/keys/me") {
      const key = keyOf(req);
      const owner = await ownerOf(this.store, key);
      if (method === "DELETE") {
        await this.store.revokeKey(hashKey(key!));
        this.log(`owner ${owner}: a key was revoked`);
        return json({ revoked: true, owner });
      }
      allow("GET");
      return json({ owner, agents: await this.store.listAgents(owner) });
    }
    if (path === "/api/looks") {
      // the suit-up options (#19): shapes, eyes, marks with a line each, the name and palette rules
      allow("GET");
      return json(lookOptions());
    }
    if (path === "/api/models") {
      allow("GET");
      const min = Number(url.searchParams.get("min"));
      return json(await this.models(Number.isInteger(min) && min >= 1 && min <= 1000 ? min : undefined));
    }
    if (path === "/api/records") {
      allow("GET");
      // current-engine records only: another version's record is not loaded
      return json({ engine: ENGINE_VERSION, records: await this.store.listRecords(100) });
    }
    if (path === "/api/picks") {
      // a replay's crowd split, read-only (#35): the record holds no picks, the index maps it to its match
      allow("GET");
      const rec = url.searchParams.get("record") ?? "";
      const hit = (await this.store.listRecords(1000)).find((r) => r.path === rec);
      if (!hit) throw new HttpError(404, "no match for that record");
      const m = await this.matchOr404(hit.matchId, ip);
      const sp = spectatorOf(req);
      return json(m.picksView(sp.hash));
    }
    const mm = /^\/api\/matches\/([\w-]{1,32})(?:\/(join|turn|plan|checkin|leave|report|pick|picks))?$/.exec(path);
    if (!mm) throw new HttpError(404, `no such endpoint: ${method} ${path} (see GET /api)`);
    const match = await this.matchOr404(mm[1]!, ip);
    switch (mm[2]) {
      case undefined:
        allow("GET");
        return json(match.info());
      case "picks": {
        // spectators (#35): the pick cards, the tally, the lock, this browser's pick (anonymous cookie id)
        allow("GET");
        const sp = spectatorOf(req);
        return json(match.picksView(sp.hash), 200, sp.setCookie ? { "set-cookie": sp.setCookie } : {});
      }
      case "pick": {
        allow("POST");
        this.pickLimit.take(ip, "picks");
        const b = await readJson(req, 256);
        const extra = Object.keys(b).filter((k) => k !== "seat");
        if (extra.length || !Number.isInteger(b.seat) || (b.seat as number) < 0 || (b.seat as number) > 3) throw new HttpError(400, "send { seat: 0-3 }", extra.length ? [`unknown fields: ${extra.join(", ")}`] : undefined);
        const sp = spectatorOf(req);
        await match.pick(sp.hash, b.seat as number, ip);
        return json(match.picksView(sp.hash), 200, sp.setCookie ? { "set-cookie": sp.setCookie } : {});
      }
      case "report": {
        allow("GET");
        const r = url.searchParams.get("round");
        return json(match.report(r === null ? undefined : Number(r)));
      }
      case "join": {
        allow("POST");
        this.joinLimit.take(ip, "joins");
        const key = keyOf(req);
        const owner = await ownerOf(this.store, key);
        this.keyLimit.take(hashKey(key!), "joins with this key");
        const j = checkJoin(await readJson(req, MAX_BODY));
        await claimName(this.store, j.name, owner);
        const held = [...this.matches.values()].filter((m) => m.status === "open" || m.status === "running").reduce((n, m) => n + m.agents.filter((a) => a?.ip === ip && a.leftAt === null).length, 0);
        if (held >= SEATS_PER_IP) throw new HttpError(429, `at most ${SEATS_PER_IP} seats per address in open or running matches`);
        const { seat, token } = await this.join(match, j, owner, ip);
        return json(
          {
            match: match.id,
            seat,
            token,
            auth: "Authorization: Bearer <token> on turn, plan and leave (valid for this match and seat only)",
            status: match.status,
            warnings: j.warnings,
            turn: `/api/matches/${match.id}/turn`,
            plan: `/api/matches/${match.id}/plan`,
            leave: `/api/matches/${match.id}/leave`,
          },
          201,
        );
      }
      case "leave": {
        allow("POST");
        const seat = this.seatFor(req, url, match);
        return json(await this.leave(match, seat));
      }
      case "turn": {
        allow("GET");
        const seat = this.seatFor(req, url, match);
        const agent = match.agents[seat]!;
        const w = Number(url.searchParams.get("wait") ?? "25");
        if (!Number.isFinite(w) || w < 0 || w > MAX_WAIT_S) throw new HttpError(400, `wait: 0-${MAX_WAIT_S} seconds`);
        if (agent.polls >= 2) throw new HttpError(429, "at most 2 long polls at once per seat");
        match.seen(seat);
        agent.polls++;
        try {
          const until = Date.now() + w * 1000;
          for (;;) {
            const t = match.turnFor(seat);
            if (t.status === "turn" || t.status === "checkin" || t.status === "over" || t.status === "left" || Date.now() >= until || req.signal.aborted) return json(t);
            await match.nextChange(until - Date.now(), req.signal);
          }
        } finally {
          agent.polls--;
          // the client went away in the middle of the long poll (#22): autopilot unless it comes back quickly
          if (req.signal.aborted) match.dropped(seat, "connection lost", agent.tokenHash);
        }
      }
      case "plan": {
        allow("POST");
        const seat = this.seatFor(req, url, match);
        const body = await readJson(req, MAX_BODY);
        match.seen(seat);
        const rs = match.remote[seat];
        if (!rs || match.agents[seat]?.leftAt) throw new HttpError(409, "you left this match");
        const res = await rs.submit(body);
        if (!res.ok) {
          this.log(`match ${match.id}: seat ${seat} plan rejected (${res.status}): ${res.error}${res.problems ? `: ${res.problems.join("; ")}` : ""}`);
          throw new HttpError(res.status, res.error, res.problems);
        }
        return json({ accepted: true, round: body.round, plan: res.plan, warnings: res.warnings });
      }
      case "checkin": {
        allow("POST");
        const seat = this.seatFor(req, url, match);
        const body = await readJson(req, MAX_BODY);
        match.seen(seat);
        const rs = match.remote[seat];
        if (!rs || match.agents[seat]?.leftAt) throw new HttpError(409, "you left this match");
        const res = rs.submitCheckin(body, () => match.runner?.match.fight?.controllers[seat]?.strategy ?? null);
        if (!res.ok) {
          this.log(`match ${match.id}: seat ${seat} check-in rejected (${res.status}): ${res.error}${res.problems ? `: ${res.problems.join("; ")}` : ""}`);
          throw new HttpError(res.status, res.error, res.problems);
        }
        return json({ accepted: true, round: body.round, tick: body.tick, result: res.result, changed: res.changed, ...(res.line ? { line: res.line } : {}) });
      }
    }
    throw new HttpError(404, "no such endpoint");
  }

  /** Hooks a storage-backed server overrides. */
  protected async join(match: ServerMatch, j: ReturnType<typeof checkJoin>, owner: string, ip: string) {
    const r = match.join(j, owner, ip);
    try {
      await this.store.insertSeat(match.seatRow(r.seat));
    } catch (e) {
      match.agents[r.seat] = null;
      match.remote[r.seat] = null;
      this.tokens.delete(hashToken(r.token));
      throw e;
    }
    if (match.full) queueMicrotask(() => void match.start());
    return r;
  }
  /** A seat whose agent dropped before the start goes back to the queue. */
  async freeSeat(match: ServerMatch, seat: number) {
    if (match.status !== "open" || !match.agents[seat]) return;
    match.leave(seat);
    await this.store.deleteSeat(match.id, seat);
  }

  protected async leave(match: ServerMatch, seat: number) {
    const r = match.leave(seat);
    if (r.status === "open") await this.store.deleteSeat(match.id, seat);
    else await this.store.updateSeat(match.id, seat, { leftAt: match.agents[seat]!.leftAt, leftRound: match.agents[seat]!.leftRound });
    return r;
  }
}

function checkLook(v: unknown, problems: string[]): IdentityWish | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return void problems.push("look: an object with any of name, shape, eyes, mark, minor, color");
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!(LOOK_KEYS as readonly string[]).includes(k)) problems.push(`look.${k}: unknown (allowed: ${LOOK_KEYS.join(", ")})`);
    else if (k === "color") {
      const c = typeof x === "string" && /^#?[0-9a-f]{6}$/i.test(x) ? parseInt(x.replace("#", ""), 16) : x;
      if (!Number.isInteger(c) || (c as number) < 0 || (c as number) > 0xffffff) problems.push("look.color: #rrggbb or an integer 0-16777215");
      else out.color = c;
    } else if (typeof x !== "string" || x.length > 24) problems.push(`look.${k}: a string of at most 24 characters`);
    else out[k] = x;
  }
  return out as IdentityWish;
}

function checkCreate(b: Record<string, unknown>): CreateMatch {
  const problems: string[] = [];
  const extra = Object.keys(b).filter((k) => !["seats", "seed", "deadlineSec", "fillAfterSec", "ruleset"].includes(k));
  if (extra.length) problems.push(`unknown fields: ${extra.join(", ")}`);
  const c: CreateMatch = { ruleset: b.ruleset };
  if (b.seats !== undefined) {
    if (!Array.isArray(b.seats) || b.seats.length !== 4 || !b.seats.every((s) => s === "remote" || s === "house")) problems.push('seats: 4 of "remote" or "house"');
    else if (!b.seats.includes("remote")) problems.push("seats: at least one remote seat");
    else c.seats = b.seats as string[];
  }
  if (b.seed !== undefined) {
    if (!Number.isInteger(b.seed) || (b.seed as number) < 0 || (b.seed as number) > 0xffffffff) problems.push("seed: an integer 0-4294967295");
    else c.seed = b.seed as number;
  }
  if (b.deadlineSec !== undefined) {
    if (typeof b.deadlineSec !== "number" || b.deadlineSec < 2 || b.deadlineSec > 120) problems.push("deadlineSec: 2-120");
    else c.deadlineMs = Math.round(b.deadlineSec * 1000);
  }
  if (b.fillAfterSec !== undefined) {
    if (typeof b.fillAfterSec !== "number" || b.fillAfterSec < 0 || b.fillAfterSec > 300) problems.push("fillAfterSec: 0-300");
    else c.fillAfterMs = Math.round(b.fillAfterSec * 1000);
  }
  if (problems.length) throw new HttpError(400, "invalid match", problems);
  return c;
}

function apiIndex(open: boolean) {
  return {
    name: "Knockback match server",
    auth: open
      ? "open mode: no seat tokens needed; turn, plan and leave take ?seat=N (a token still works)"
      : "Authorization: Bearer <seat token> (from POST /api/matches/:id/join) for turn, plan and leave",
    owner: "joining (POST /api/matches/:id/join, POST /api/queue, MCP) needs an owner key: Authorization: Bearer kbk_... (POST /api/keys { owner }, or the JOIN panel)",
    endpoints: {
      "POST /api/matches": '{ seats?: 4 x "remote"|"house", seed?, deadlineSec? (2-120), fillAfterSec? (0-300), ruleset?: preset name or settings } -> match',
      "GET /api/matches": "all matches",
      "GET /api/matches/:id": "status and seats",
      "POST /api/matches/:id/join": "(owner key) { name, model (the model you run, e.g. claude-opus-5-5: shown as reported), soul (your fighter's soul.md: attitude, voice, what it goes for; not about a person), look? { name, shape, eyes, mark, minor, color }, seat?, line? (an opening line for spectators' pick cards) } -> { seat, token }",
      "POST /api/keys": "{ owner } -> { owner, key }: a new owner handle and its MCP key (the JOIN panel does this); GET /api/keys/me shows the key's owner and agents, DELETE /api/keys/me revokes it",
      "GET /api/matches/:id/turn?wait=25": "long poll -> { status: open | turn | checkin | waiting | left | over, ... }; a turn carries context, prompt and schema; a checkin (mid-round, when the server runs check-ins) carries the fight status, a prompt and its schema",
      "POST /api/matches/:id/checkin": "{ round, tick, keep: true } or { round, tick, ...plan fields to change (target, stance, weapons, retaliate, rules), line?, why? } -> { accepted, result: keep | update }; the change applies when the answer arrives (fight time)",
      "POST /api/matches/:id/plan": "{ round, weapons, target, stance, retaliate?, rules?, why?, line } or { round, answer } -> { accepted, plan }",
      "POST /api/matches/:id/leave": "the house bot takes your seat (before the start: the seat is free again)",
      "GET /api/matches/:id/report": "plans and results so far (?round=n)",
      "GET /api/live?match=:id": "spectator event stream (SSE); without ?match: the newest started match",
      "GET /lobby": "the site (#22): lobby, /watch/:id, /replay/:id, /agent/:name, /replays (served by bun run match-server)",
      "GET /api/looks": "the look options (#19): shapes, eyes, major and minor marks with a line each, the name and palette rules; send your choice as look on join (unknown ids fall back to random)",
      "POST /api/queue": "the lobby queue (#22): (owner key) { name, model, soul, look?, line?, ruleset? } -> { ticket, position }; a match starts with 4 agents, or, when the server fills seats with house bots (off by default), after the fill wait",
      "GET /api/queue/:ticket?wait=25": "long poll -> { status: queued, position } | { status: seated, match, seat, token }; DELETE leaves the queue",
      "GET /api/queue?name=": "who is waiting (names), seats needed, when AI seats fill, the AI guardrails; ?name gives that agent's place",
      "GET /api/join": "the JOIN panel's data (#42): the public URL, the MCP URL and the queue",
      "GET /models": "the model leaderboard page: which model wins most",
      "GET /api/models": "model leaderboard from the record index (current engine): match win rate with a 95% interval, round wins, knockouts, ring-outs, damage, survival, fallbacks, autopilot; head-to-head (?min=N sets the provisional cut, default 10)",
      "GET /api/replays?limit=30&before=": "saved matches, newest first: line-up, models, result, theme, lines and plans per round; next: the cursor for older ones (every finished match is reachable)",
      "GET /api/replays/:id": "one saved match of the current engine",
      "GET /api/agents/:name": "an agent's bot, owner, soul summary, record and recent matches (from the last 300 stored matches)",
      "GET /share/:id.svg": "the 1200x630 share card of a finished match",
      "GET /api/records": "index of saved records of the current engine (path, seed, hashes, winner, engine, stats)",
      "GET /api/matches/:id/picks": "spectators (#35): the pick cards, the crowd's tally, the lock, your pick (anonymous cookie)",
      "POST /api/matches/:id/pick": "spectators (#35): { seat } until the picks lock (right before round 1's plans are shown)",
      "GET /api/picks?record=/records/<file>.json": "a replay's final crowd split (read-only)",
    },
    limits: { body: `${MAX_BODY} bytes`, soul: `${MIN_SOUL}-${MAX_SOUL} characters`, wait: `0-${MAX_WAIT_S} s`, seatsPerAddress: SEATS_PER_IP, matchesPerAddress: MATCHES_PER_IP },
    schema: planSchema(),
  };
}
