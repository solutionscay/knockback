/**
 * The matchmaker (#22): the lobby waits for agents. It replaces LobbyQueue.seat(), which opened a match for the
 * first agent and let house bots fill it.
 *
 * - Outside agents (MCP join_lobby, or HTTP POST /api/queue) wait in a queue, oldest first.
 * - A match opens when 4 agents are waiting (distinct names: never the same agent twice in a match). Agents only by
 *   default. With `fillAfterMs` set (match-server --fill-bots, for tests and demos), house bots take the empty seats
 *   once an agent has waited that long. The server runs no models: real models only play as agents (MCP or HTTP).
 * - Nobody queued: nothing runs. There is no loop and no automatic match.
 * - At most `maxConcurrent` matchmaker matches at once (default 1; the queue waits).
 * - Ratings (#23): `order` picks who plays with the oldest waiting agent (default: oldest first).
 *
 * Seating goes through POST /api/matches/:id/join in-process, so agents get the same validation, rate limits and
 * seat tokens as any HTTP agent. The queue lives in memory: after a restart agents join again (MCP sessions do not
 * survive a restart either).
 */
import { randomBytes } from "node:crypto";
import { HttpError } from "./limits";
import { selectRuleset, type MatchRuleset } from "./match-rulesets";
import { checkJoin, type MatchServer, type ServerMatch } from "./match-server";

export interface MatchmakerOptions {
  /** an agent that waited this long gets house bots around it; null (default): agents only, no fill */
  fillAfterMs?: number | null;
  /** with fillAfterMs: agents a match needs before house bots fill the rest (default 1) */
  minAgents?: number;
  /** turn deadline of matchmaker matches (default 75 s: agents that think with a full model need it) */
  deadlineMs?: number;
  /** matchmaker matches open or running at once (default 1) */
  maxConcurrent?: number;
  /** a queued agent that has not asked about its place for this long leaves the queue (default 180 s) */
  idleMs?: number;
  /** who plays with the oldest waiting agent: the candidates in the order to take them (#23 ratings; default oldest first) */
  order?: (oldest: QueueEntry, candidates: QueueEntry[]) => QueueEntry[];
  /** public base URL (KB_PUBLIC_URL) for GET /api/join; default: from the request */
  publicUrl?: string;
  /** ms between checks of the queue (default 1000) */
  tickMs?: number;
}

export interface QueueEntry {
  ticket: string;
  name: string;
  body: Record<string, unknown>;
  ip: string;
  selection: MatchRuleset;
  joinedAt: number;
  lastSeen: number;
  /** set when the entry got a seat */
  seated: { match: string; seat: number; token: string } | null;
}

export class Matchmaker {
  readonly fillAfterMs: number | null;
  readonly minAgents: number;
  readonly deadlineMs: number;
  readonly maxConcurrent: number;
  readonly idleMs: number;
  /** waiting agents, oldest first; seated entries stay until their agent picks up the seat */
  private queue: QueueEntry[] = [];
  /** matches this matchmaker made */
  private made: string[] = [];
  private waiters = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private order: NonNullable<MatchmakerOptions["order"]>;

  constructor(
    readonly api: MatchServer,
    readonly opts: MatchmakerOptions = {},
  ) {
    this.fillAfterMs = opts.fillAfterMs ?? null;
    this.minAgents = Math.max(1, Math.min(4, opts.minAgents ?? 1));
    this.deadlineMs = opts.deadlineMs ?? 75_000;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 1);
    this.idleMs = opts.idleMs ?? 180_000;
    this.order = opts.order ?? ((_o, c) => c);
    api.matchmaker = this;
    this.timer = setInterval(() => void this.tick(), opts.tickMs ?? 1000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- the queue

  /**
   * Put an agent in the queue (body: name, persona, look?, model?, line?). Rejects bad input and a name that is
   * already waiting. A match may form at once (the 4th agent, or no fill wait): `seated` says so.
   */
  enqueue(body: Record<string, unknown>, ip: string, ruleset?: string): Promise<QueueEntry> {
    return this.serial(async () => {
      const j = checkJoin(body);
      const key = j.name.toLowerCase();
      if (this.queue.some((e) => !e.seated && e.name.toLowerCase() === key)) throw new HttpError(409, `${j.name} is already in the queue`);
      this.api.joinLimit.take(ip, "queue joins");
      const now = Date.now();
      const e: QueueEntry = { ticket: `qt_${randomBytes(12).toString("hex")}`, name: j.name, body, ip, selection: await selectRuleset(this.api.store, ruleset), joinedAt: now, lastSeen: now, seated: null };
      this.queue.push(e);
      this.api.log(`queue: ${e.name} joined (${this.waiting().length} waiting)`);
      await this.matchNow();
      this.changed();
      return e;
    });
  }

  /** Remove an entry if it is still there (it may have left meanwhile: never splice at -1). */
  private drop(e: QueueEntry): boolean {
    const i = this.queue.indexOf(e);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  /** The agent leaves the queue (or gives up the seat it was given before it picked it up). */
  leave(ticket: string): boolean {
    const i = this.queue.findIndex((e) => e.ticket === ticket);
    if (i < 0) return false;
    const [e] = this.queue.splice(i, 1);
    this.api.log(`queue: ${e!.name} left`);
    this.changed();
    return true;
  }

  entry(ticket: string): QueueEntry | null {
    const e = this.queue.find((x) => x.ticket === ticket) ?? null;
    if (e) e.lastSeen = Date.now();
    return e;
  }

  /** The agent took its seat (MCP or HTTP got the token): it is no longer in the queue. */
  pickedUp(ticket: string) {
    this.queue = this.queue.filter((e) => e.ticket !== ticket);
  }

  /** Waiting agents, oldest first. */
  waiting(): QueueEntry[] {
    return this.queue.filter((e) => !e.seated);
  }

  /** 1-based place of a waiting agent by name (case-insensitive), or null. */
  position(name: string): number | null {
    const i = this.waiting().findIndex((e) => e.name.toLowerCase() === name.trim().toLowerCase());
    return i < 0 ? null : i + 1;
  }

  /** Wait (up to `ms`) for the next queue change. */
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

  private changed() {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Matchmaker matches that are open or running. */
  live(): ServerMatch[] {
    this.made = this.made.filter((id) => {
      const s = this.api.matches.get(id)?.status;
      return s === "open" || s === "running";
    });
    return this.made.map((id) => this.api.matches.get(id)!);
  }

  /** When the oldest waiting agent gets house bots (ms since epoch), or null (nobody waiting, or agents only). */
  fillsAt(): number | null {
    const o = this.waiting()[0];
    return o && this.fillAfterMs !== null ? o.joinedAt + this.fillAfterMs : null;
  }

  /** The public view (GET /api/queue, the lobby page). Names only: tickets and bodies stay here. */
  summary(now = Date.now()) {
    const w = this.waiting();
    const live = this.live();
    const fillsAt = this.fillsAt();
    return {
      waiting: w.map((e, i) => ({ position: i + 1, agent: e.name, waitingSec: Math.floor((now - e.joinedAt) / 1000), ruleset: e.selection.preset })),
      /** agents still needed for a full match of outside agents */
      needed: Math.max(0, 4 - w.length),
      /** seconds until the oldest agent's match starts with house bots (null: nobody waiting, or agents only) */
      fillsInSec: fillsAt === null ? null : Math.max(0, Math.ceil((fillsAt - now) / 1000)),
      /** the queue waits for a running match to end (max concurrent) */
      blocked: live.length >= this.maxConcurrent,
      live: live.map((m) => ({ match: m.id, status: m.status })),
      /** null: agents only (no house-bot fill) */
      fillAfterSec: this.fillAfterMs === null ? null : this.fillAfterMs / 1000,
      minAgents: this.minAgents,
      maxConcurrent: this.maxConcurrent,
    };
  }

  // ---------------------------------------------------------------- matching

  /** Check the queue (timer, every join, every leave). */
  tick(): Promise<void> {
    return this.serial(() => this.matchNow());
  }

  private async matchNow(now = Date.now()) {
    // agents that stopped asking leave the queue; seated entries nobody picked up free their seat by the deadline
    for (const e of [...this.queue]) if (now - e.lastSeen > this.idleMs && this.drop(e)) {
      this.api.log(`queue: ${e.name} dropped (no word for ${Math.round(this.idleMs / 1000)} s)`);
      this.changed();
    }
    for (;;) {
      if (this.live().length >= this.maxConcurrent) return;
      const group = this.readyGroup(now);
      if (!group) return;
      await this.open(group);
    }
  }

  /**
   * The first ready group, oldest head first. Every waiting agent is tried as a head, so an agent whose group
   * cannot fill (a ruleset nobody else picked) does not block the agents behind it.
   */
  private readyGroup(now: number): QueueEntry[] | null {
    const w = this.waiting();
    for (const [i, head] of w.entries()) {
      const key = JSON.stringify(head.selection);
      const names = new Set([head.name.toLowerCase()]);
      const group = [head];
      for (const e of this.order(head, w.slice(i + 1).filter((x) => JSON.stringify(x.selection) === key))) {
        if (group.length === 4) break;
        if (names.has(e.name.toLowerCase())) continue;
        names.add(e.name.toLowerCase());
        group.push(e);
      }
      if (group.length === 4 || (this.fillAfterMs !== null && group.length >= this.minAgents && now - head.joinedAt >= this.fillAfterMs)) return group;
    }
    return null;
  }

  private async open(group: QueueEntry[]) {
    const kinds = [...group.map(() => "remote"), ...Array.from({ length: 4 - group.length }, () => "house")];
    // the agents are seated right after the match is made; the fill timer only guards against a seat that fails
    const m = await this.api.createMatch({ seats: kinds, deadlineMs: this.deadlineMs, fillAfterMs: 30_000 }, group[0]!.selection);
    this.made.push(m.id);
    this.api.log(`matchmaker: match ${m.id} for ${group.map((e) => e.name).join(", ")}${group.length < 4 ? ` + ${kinds.slice(group.length).join(", ")}` : ""}`);
    for (const [seat, e] of group.entries()) {
      try {
        const token = await this.join(m, e, seat);
        e.seated = { match: m.id, seat, token };
      } catch (err) {
        // a seat that cannot be taken (the agent's address hit a limit): it leaves the queue; its seat gets the house bot
        this.api.log(`matchmaker: ${e.name} could not take seat ${seat} in ${m.id}: ${err instanceof Error ? err.message : String(err)}`);
        this.drop(e);
      }
    }
    if (!m.agents.some(Boolean)) await m.cancelEmpty();
    else if (!m.full) void m.start();
    this.changed();
  }

  /** POST /api/matches/:id/join in-process, at the seat the matchmaker chose. */
  private async join(m: ServerMatch, e: QueueEntry, seat: number): Promise<string> {
    const res = (await this.api.handle(new Request(`http://matchmaker.internal/api/matches/${m.id}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...e.body, seat }) }), e.ip))!;
    const data = (await res.json()) as { token?: string; error?: string; problems?: string[] };
    if (res.status === 201 && data.token) return data.token;
    throw new HttpError(res.status, data.error ?? "join failed", data.problems);
  }
}
