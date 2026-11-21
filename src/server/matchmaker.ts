/**
 * The matchmaker (#22): the lobby waits for agents. It replaces LobbyQueue.seat(), which opened a match for the
 * first agent and let house bots fill it.
 *
 * - Outside agents (MCP join_lobby, or HTTP POST /api/queue) wait in a queue, oldest first.
 * - A match opens when 4 agents are waiting (distinct names: never the same agent twice in a match). When at least
 *   one agent has waited `fillAfterMs` (default 60 s), the empty seats get built-in AI seats from the roster
 *   (claude / codex / grok, the providers ai-match uses), so the model leaderboard keeps getting data. A house bot
 *   takes a seat only when that provider is not available here or the daily AI-seat cap is spent (a provider that
 *   fails mid-match falls back to the house plan per round, as in every match).
 * - Nobody queued: nothing runs. There is no loop and no automatic match.
 * - Cost guardrails: at most `maxConcurrent` matchmaker matches at once (default 1; the queue waits), at most
 *   `aiSeatsPerDay` built-in AI seats per UTC day (default 30), and every provider call is logged (latency, sizes,
 *   estimated tokens) to the server log, `<out>/ai-usage.jsonl` and the queue's summary.
 * - Ratings (#23): `order` picks who plays with the oldest waiting agent (default: oldest first).
 *
 * Seating goes through POST /api/matches/:id/join in-process, so agents get the same validation, rate limits and
 * seat tokens as any HTTP agent. The queue lives in memory: after a restart agents join again (MCP sessions do not
 * survive a restart either).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PROVIDERS, type Provider } from "../ai/providers";
import { HttpError } from "./limits";
import { selectRuleset, type MatchRuleset } from "./match-rulesets";
import { checkJoin, type MatchServer, type ServerMatch } from "./match-server";

export interface MatchmakerOptions {
  /** an agent that waited this long gets AI seats around it (default 60 s) */
  fillAfterMs?: number;
  /** agents a match needs before AI seats fill the rest (default 1) */
  minAgents?: number;
  /** built-in seats for the empty places, in turn across matches (default claude, codex, grok); "house" allowed */
  roster?: string[];
  /** turn deadline of matchmaker matches (default 75 s: agents that think with a full model need it) */
  deadlineMs?: number;
  /** matchmaker matches open or running at once (default 1) */
  maxConcurrent?: number;
  /** built-in AI seats per UTC day (default 30); past it the empty seats get house bots */
  aiSeatsPerDay?: number;
  /** a queued agent that has not asked about its place for this long leaves the queue (default 180 s) */
  idleMs?: number;
  /** is this built-in seat usable here? (default: the provider exists and its CLI is on PATH) */
  available?: (kind: string) => boolean;
  /** who plays with the oldest waiting agent: the candidates in the order to take them (#23 ratings; default oldest first) */
  order?: (oldest: QueueEntry, candidates: QueueEntry[]) => QueueEntry[];
  /** public base URL (KB_PUBLIC_URL) for GET /api/join; default: from the request */
  publicUrl?: string;
  /** provider call log (default <out>/ai-usage.jsonl); null: no file */
  usageFile?: string | null;
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

export interface UsageLine {
  at: string;
  kind: string;
  label: string;
  ms: number;
  ok: boolean;
  promptChars: number;
  answerChars: number;
  /** characters / 4: the CLIs do not report tokens */
  estTokens: number;
  error?: string;
}

/** CLI behind each built-in provider: a seat is only given to a provider whose CLI is installed. */
const BIN: Record<string, string> = { claude: "claude", codex: "codex", grok: "grok" };
const defaultAvailable = (kind: string) => kind === "house" || (!!PROVIDERS[kind] && (!BIN[kind] || !!Bun.which(BIN[kind]!)));
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/** Open matchmakers: a provider is wrapped once, and each call is reported to the matchmakers whose roster has it. */
const meters = new Set<Matchmaker>();

/** Wrap a built-in provider: every call is timed and reported (the CLIs do not report tokens: chars / 4). */
function metered(kind: string, p: Provider): Provider {
  if ((p as Provider & { metered?: boolean }).metered) return p;
  const ask: Provider["ask"] = async (prompt, signal) => {
    const t0 = performance.now();
    let text = "";
    let error: string | undefined;
    try {
      text = await p.ask(prompt, signal);
      return text;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const line: UsageLine = { at: new Date().toISOString(), kind, label: p.label, ms: Math.round(performance.now() - t0), ok: !error, promptChars: prompt.length, answerChars: text.length, estTokens: Math.ceil((prompt.length + text.length) / 4), ...(error ? { error: error.slice(0, 200) } : {}) };
      for (const mm of meters) if (mm.roster.includes(kind)) mm.record(line);
    }
  };
  return Object.assign({ ...p, ask }, { metered: true });
}

export class Matchmaker {
  readonly fillAfterMs: number;
  readonly minAgents: number;
  readonly roster: string[];
  readonly deadlineMs: number;
  readonly maxConcurrent: number;
  readonly aiSeatsPerDay: number;
  readonly idleMs: number;
  /** waiting agents, oldest first; seated entries stay until their agent picks up the seat */
  private queue: QueueEntry[] = [];
  /** matches this matchmaker made */
  private made: string[] = [];
  private rosterAt = 0;
  private day = utcDay();
  private aiSeats = 0;
  private usage = { calls: 0, errors: 0, ms: 0, estTokens: 0 };
  private waiters = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private available: (kind: string) => boolean;
  private order: NonNullable<MatchmakerOptions["order"]>;
  private usageFile: string | null;

  constructor(
    readonly api: MatchServer,
    readonly opts: MatchmakerOptions = {},
  ) {
    this.fillAfterMs = opts.fillAfterMs ?? 60_000;
    this.minAgents = Math.max(1, Math.min(4, opts.minAgents ?? 1));
    this.roster = (opts.roster ?? ["claude", "codex", "grok"]).filter(Boolean);
    this.deadlineMs = opts.deadlineMs ?? 75_000;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 1);
    this.aiSeatsPerDay = Math.max(0, opts.aiSeatsPerDay ?? 30);
    this.idleMs = opts.idleMs ?? 180_000;
    this.available = opts.available ?? defaultAvailable;
    this.order = opts.order ?? ((_o, c) => c);
    this.usageFile = opts.usageFile === undefined ? join(api.opts.outDir, "ai-usage.jsonl") : opts.usageFile;
    for (const k of this.roster) if (k !== "house" && !PROVIDERS[k]) throw new Error(`matchmaker roster: unknown seat kind "${k}" (house, ${Object.keys(PROVIDERS).join(", ")})`);
    for (const k of new Set(this.roster)) if (k !== "house") PROVIDERS[k] = metered(k, PROVIDERS[k]!);
    meters.add(this);
    api.matchmaker = this;
    this.timer = setInterval(() => void this.tick(), opts.tickMs ?? 1000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    meters.delete(this);
  }

  /** Count today's built-in AI seats from storage (a restart keeps the daily cap). */
  async init() {
    const since = Date.parse(`${utcDay()}T00:00:00Z`);
    this.aiSeats = (await this.api.store.listMatches())
      .filter((m) => m.createdAt >= since)
      .reduce((n, m) => n + m.kinds.filter((k) => k !== "remote" && k !== "house").length, 0);
    return this;
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

  /** When the oldest waiting agent gets AI seats (ms since epoch), or null. */
  fillsAt(): number | null {
    const o = this.waiting()[0];
    return o ? o.joinedAt + this.fillAfterMs : null;
  }

  /** The public view (GET /api/queue, the lobby page). Names only: tickets and bodies stay here. */
  summary(now = Date.now()) {
    if (utcDay(now) !== this.day) this.rollDay(now);
    const w = this.waiting();
    const live = this.live();
    const fillsAt = this.fillsAt();
    return {
      waiting: w.map((e, i) => ({ position: i + 1, agent: e.name, waitingSec: Math.floor((now - e.joinedAt) / 1000), ruleset: e.selection.preset })),
      /** agents still needed for a full match of outside agents */
      needed: Math.max(0, 4 - w.length),
      /** seconds until the oldest agent's match starts with AI seats (null: nobody waiting) */
      fillsInSec: fillsAt === null ? null : Math.max(0, Math.ceil((fillsAt - now) / 1000)),
      /** the queue waits for a running match to end (max concurrent) */
      blocked: live.length >= this.maxConcurrent,
      live: live.map((m) => ({ match: m.id, status: m.status })),
      fillAfterSec: this.fillAfterMs / 1000,
      minAgents: this.minAgents,
      roster: this.roster,
      maxConcurrent: this.maxConcurrent,
      ai: { seatsToday: this.aiSeats, seatsPerDay: this.aiSeatsPerDay, callsToday: this.usage.calls, errorsToday: this.usage.errors, estTokensToday: this.usage.estTokens, avgMs: this.usage.calls ? Math.round(this.usage.ms / this.usage.calls) : null },
    };
  }

  // ---------------------------------------------------------------- matching

  /** Check the queue (timer, every join, every leave). */
  tick(): Promise<void> {
    return this.serial(() => this.matchNow());
  }

  private async matchNow(now = Date.now()) {
    if (utcDay(now) !== this.day) this.rollDay(now);
    // agents that stopped asking leave the queue; seated entries nobody picked up free their seat by the deadline
    for (const e of [...this.queue]) if (now - e.lastSeen > this.idleMs) {
      this.queue.splice(this.queue.indexOf(e), 1);
      this.api.log(`queue: ${e.name} dropped (no word for ${Math.round(this.idleMs / 1000)} s)`);
      this.changed();
    }
    for (;;) {
      if (this.live().length >= this.maxConcurrent) return;
      const w = this.waiting();
      const oldest = w[0];
      if (!oldest) return;
      const key = JSON.stringify(oldest.selection);
      const names = new Set([oldest.name.toLowerCase()]);
      const group = [oldest];
      for (const e of this.order(oldest, w.slice(1).filter((x) => JSON.stringify(x.selection) === key))) {
        if (group.length === 4) break;
        if (names.has(e.name.toLowerCase())) continue;
        names.add(e.name.toLowerCase());
        group.push(e);
      }
      const ready = group.length === 4 || (group.length >= this.minAgents && now - oldest.joinedAt >= this.fillAfterMs);
      if (!ready) return;
      await this.open(group);
    }
  }

  /** The built-in seats for `n` empty places: the roster in turn (distinct when it can), house bots when needed. */
  private builtIns(n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      let kind = "house";
      for (let tries = 0; tries < this.roster.length; tries++) {
        const k = this.roster[(this.rosterAt + tries) % this.roster.length]!;
        if (out.includes(k) && tries < this.roster.length - 1) continue;
        this.rosterAt = (this.rosterAt + tries + 1) % this.roster.length;
        kind = k;
        break;
      }
      if (kind !== "house" && !this.available(kind)) {
        this.api.log(`matchmaker: ${kind} is not available here; a house bot takes the seat`);
        kind = "house";
      }
      if (kind !== "house" && this.aiSeats >= this.aiSeatsPerDay) {
        this.api.log(`matchmaker: the daily cap of ${this.aiSeatsPerDay} AI seats is spent; a house bot takes the seat`);
        kind = "house";
      }
      if (kind !== "house") this.aiSeats++;
      out.push(kind);
    }
    return out;
  }

  private async open(group: QueueEntry[]) {
    const kinds = [...group.map(() => "remote"), ...this.builtIns(4 - group.length)];
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
        this.queue.splice(this.queue.indexOf(e), 1);
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

  // ---------------------------------------------------------------- guardrails

  private rollDay(now: number) {
    this.day = utcDay(now);
    this.aiSeats = 0;
    this.usage = { calls: 0, errors: 0, ms: 0, estTokens: 0 };
  }

  /** One provider call (from the metered wrapper). */
  record(line: UsageLine) {
    if (utcDay() !== this.day) this.rollDay(Date.now());
    this.usage.calls++;
    this.usage.ms += line.ms;
    this.usage.estTokens += line.estTokens;
    if (!line.ok) this.usage.errors++;
    this.api.log(`ai usage: ${line.label} ${line.ok ? "ok" : "ERROR"} ${line.ms} ms, ~${line.estTokens} tokens (${line.promptChars}+${line.answerChars} chars)${line.error ? ` ${line.error}` : ""}`);
    if (this.usageFile) {
      try {
        appendFileSync(this.usageFile, JSON.stringify(line) + "\n");
      } catch {
        /* the log file is a convenience; the server log has the line */
      }
    }
  }
}
