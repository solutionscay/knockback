/**
 * The match server (#20): Knockback matches with remote agents as players,
 * over a plain JSON HTTP API. Empty or silent seats get the house bot.
 *
 *   POST /api/agents                  register: { name, persona, look? } -> { id, key }
 *   POST /api/matches                 create: { seats?, seed?, deadlineSec?, fillAfterSec? }
 *   GET  /api/matches                 list
 *   GET  /api/matches/:id             status and seats
 *   POST /api/matches/:id/join        (agent key) take a remote seat: { seat? }
 *   GET  /api/matches/:id/turn        (agent key) long poll: ?wait=0-30 s -> open | turn | waiting | over
 *   POST /api/matches/:id/plan        (agent key) { round, weapons, target, stance, retaliate?, rules?, why?, line } or { round, answer }
 *   GET  /api/matches/:id/report      plans and results so far (?round=n for one round)
 *   GET  /api/live?match=:id          spectator stream (SSE); without ?match: the newest match
 *
 * Agent keys go in `Authorization: Bearer <key>`. Every body is JSON, at
 * most MAX_BODY bytes; requests are rate limited per address and per agent.
 * The match itself runs in MatchRunner, exactly like a local AI match.
 */
import { randomBytes } from "node:crypto";
import { DEFAULT_DEADLINE_MS, type Seat } from "../ai/decide";
import { MatchRunner, type RunnerEvent } from "../ai/runner";
import { PROVIDERS } from "../ai/providers";
import type { IdentityWish } from "../sim/identity";
import { parseSoul, type Soul } from "../sim/soul";
import { exampleSouls } from "../sim/souls";
import { errorResponse, HttpError, json, MAX_BODY, RateLimiter, readJson } from "./limits";
import { LiveStream } from "./live";
import { planSchema, RemoteSeat } from "./remote";

export const MAX_PERSONA = 8_000;
export const MIN_PERSONA = 40;
export const MAX_WAIT_S = 30;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
const LOOK_KEYS = ["name", "shape", "eyes", "mark", "minor", "color"] as const;

export interface Agent {
  id: string;
  key: string;
  name: string;
  persona: string;
  soulId: string;
  look?: IdentityWish;
  createdAt: number;
  /** long polls in flight */
  polls: number;
}

/** "remote" (an agent's seat), "house" (the house bot), or a local provider name (CLI only). */
export type SeatKind = string;

export interface CreateMatch {
  seats?: SeatKind[];
  seed?: number;
  deadlineMs?: number;
  fillAfterMs?: number;
}

export interface ServerOptions {
  /** where records are written */
  outDir: string;
  maxAgents?: number;
  /** open or running matches at once */
  maxMatches?: number;
  defaultDeadlineMs?: number;
  /** an open match starts after this long, house bots in the empty seats */
  defaultFillAfterMs?: number;
  log?: (s: string) => void;
}

const id = (bytes: number) => randomBytes(bytes).toString("hex");

export class ServerMatch {
  status: "open" | "running" | "over" | "failed" = "open";
  readonly remote: (RemoteSeat | null)[];
  readonly agents: (Agent | null)[] = [null, null, null, null];
  readonly live = new LiveStream();
  readonly createdAt = Date.now();
  startsAt: number;
  runner: MatchRunner | null = null;
  error: string | null = null;
  private version = 0;
  private waiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    readonly seed: number,
    readonly kinds: SeatKind[],
    readonly deadlineMs: number,
    fillAfterMs: number,
    private server: MatchServer,
  ) {
    this.remote = kinds.map(() => null);
    this.startsAt = this.createdAt + fillAfterMs;
    if (!kinds.includes("remote")) queueMicrotask(() => this.start());
    else this.timer = setTimeout(() => this.start(), fillAfterMs);
  }

  /** Wake every long poll on this match. */
  changed() {
    this.version++;
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

  seatOf(agent: Agent): number {
    return this.agents.findIndex((a) => a?.id === agent.id);
  }

  join(agent: Agent, want?: number): number {
    if (this.status !== "open") throw new HttpError(409, `match ${this.id} is ${this.status}; join an open match`);
    if (this.seatOf(agent) >= 0) throw new HttpError(409, `you already sit in seat ${this.seatOf(agent)}`);
    const free = this.kinds.map((k, i) => (k === "remote" && !this.agents[i] ? i : -1)).filter((i) => i >= 0);
    if (want !== undefined && !free.includes(want)) throw new HttpError(409, `seat ${want} is not a free remote seat (free: ${free.join(", ") || "none"})`);
    const seat = want ?? free[0];
    if (seat === undefined) throw new HttpError(409, "no free remote seat");
    this.agents[seat] = agent;
    const rs = new RemoteSeat(agent.name, this.deadlineMs);
    rs.onChange = () => this.changed();
    this.remote[seat] = rs;
    this.server.log(`match ${this.id}: ${agent.name} joined seat ${seat}`);
    this.changed();
    if (this.kinds.every((k, i) => k !== "remote" || this.agents[i])) queueMicrotask(() => this.start());
    return seat;
  }

  /** Build the seats (souls, providers) and play the match in the background. */
  start() {
    if (this.status !== "open") return;
    clearTimeout(this.timer);
    this.status = "running";
    const souls = this.souls();
    const seats: Seat[] = this.kinds.map((k, i) => {
      const rs = this.remote[i];
      if (rs) return { providerName: "remote", provider: rs.provider, soul: souls[i]! };
      if (k === "remote" || k === "house") return { providerName: "house", provider: null, soul: souls[i]! };
      return { providerName: k, provider: PROVIDERS[k]!, soul: souls[i]! };
    });
    const wishes = this.agents.map((a) => a?.look);
    try {
      this.runner = new MatchRunner({
        seed: this.seed,
        seats,
        ...(wishes.some(Boolean) ? { identityWishes: wishes } : {}),
        onEvent: (e) => this.onEvent(e),
      });
    } catch (e) {
      this.fail(e);
      return;
    }
    this.remote.forEach((rs, i) => rs?.bind(this.runner!.match, i));
    this.server.log(`match ${this.id}: started, seed ${this.seed}, seats ${this.runner.labels.join(", ")}`);
    this.runner.start();
    this.changed();
    this.runner
      .run()
      .then(() => {
        this.runner!.save(this.server.opts.outDir, "remote");
        this.status = "over";
        this.server.log(`match ${this.id}: ${this.runner!.names[this.runner!.match.winner]} wins ${this.runner!.match.wins.join("-")}; record ${this.runner!.recordFile}`);
        this.changed();
      })
      .catch((e) => this.fail(e));
  }

  private fail(e: unknown) {
    this.status = "failed";
    this.error = e instanceof Error ? e.message : String(e);
    this.server.log(`match ${this.id}: failed: ${this.error}`);
    this.live.broadcast({ type: "error", error: this.error });
    this.changed();
  }

  private onEvent(e: RunnerEvent) {
    this.live.broadcast(e);
    if (e.type === "round") this.changed();
  }

  /** One soul per seat: the agent's persona, or the example soul of that seat; ids made unique. */
  private souls(): Soul[] {
    const base = exampleSouls();
    const used = new Set<string>();
    return this.kinds.map((_, i) => {
      const a = this.agents[i];
      let soul = a ? parseSoul(a.persona, i, a.soulId).soul : base[i]!;
      let sid = soul.id;
      for (let n = 2; used.has(sid); n++) sid = `${soul.id}-${n}`;
      used.add(sid);
      if (sid !== soul.id) soul = { ...soul, id: sid };
      return soul;
    });
  }

  /** What `agent` should do now. */
  turnFor(agent: Agent) {
    const seat = this.seatOf(agent);
    const base = { match: this.id, seat, status: this.status as string };
    if (this.status === "open") return { ...base, status: "open", startsInSec: Math.max(0, Math.ceil((this.startsAt - Date.now()) / 1000)), message: "waiting for players; empty seats get the house bot when the match starts" };
    if (this.status === "failed") return { ...base, status: "over", error: this.error };
    const m = this.runner!.match;
    if (this.status === "over") return { ...base, status: "over", winner: m.names[m.winner], wins: m.wins.slice(), youWon: m.winner === seat, record: this.runner!.recordFile ? `/records/${this.runner!.recordFile}` : null, report: `/api/matches/${this.id}/report` };
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
        schema: planSchema(),
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
      deadlineSec: this.deadlineMs / 1000,
      createdAt: new Date(this.createdAt).toISOString(),
      ...(this.status === "open" ? { startsInSec: Math.max(0, Math.ceil((this.startsAt - Date.now()) / 1000)) } : {}),
      seats: this.kinds.map((k, i) => ({
        seat: i,
        kind: k === "remote" && !this.agents[i] && this.status !== "open" ? "house" : k,
        agent: this.agents[i]?.name ?? null,
        fighter: r?.names[i] ?? null,
        label: r?.labels[i] ?? null,
      })),
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
                knockouts: f.stats.kos.map((k) => ({ victim: names[k.victim], by: k.by >= 0 && k.by !== k.victim ? names[k.by] : null, weapon: k.weapon, cause: k.cause })),
                summary: Object.fromEntries(names.map((n, s) => [n, f.stats.summary[s]])),
                finalHash: rec.fight.finalHash,
              }
            : null,
        };
      })
      .filter((x) => round === undefined || x.round === round);
    return { ...this.info(), rounds };
  }
}

export class MatchServer {
  readonly agents = new Map<string, Agent>();
  private byKey = new Map<string, Agent>();
  readonly matches = new Map<string, ServerMatch>();
  private newest: ServerMatch | null = null;
  readonly opts: Required<Omit<ServerOptions, "log">>;
  readonly log: (s: string) => void;
  // per address: all requests; registrations and match creation are scarcer
  readonly ipLimit = new RateLimiter(60, 10);
  readonly registerLimit = new RateLimiter(10, 1 / 6);
  readonly createLimit = new RateLimiter(5, 1 / 12);
  readonly agentLimit = new RateLimiter(30, 5);

  constructor(opts: ServerOptions) {
    this.opts = { maxAgents: 500, maxMatches: 16, defaultDeadlineMs: DEFAULT_DEADLINE_MS, defaultFillAfterMs: 60_000, ...opts } as MatchServer["opts"];
    this.log = opts.log ?? (() => {});
  }

  // ------------------------------------------------------------ agents
  register(body: Record<string, unknown>): { agent: Agent; warnings: string[] } {
    const problems: string[] = [];
    const extra = Object.keys(body).filter((k) => !["name", "persona", "look"].includes(k));
    if (extra.length) problems.push(`unknown fields: ${extra.join(", ")} (allowed: name, persona, look)`);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!NAME_RE.test(name)) problems.push("name: 1-24 characters: letters, digits, space, _ . - (starting with a letter or digit)");
    const persona = body.persona;
    if (typeof persona !== "string" || persona.length < MIN_PERSONA || persona.length > MAX_PERSONA) problems.push(`persona: a soul text of ${MIN_PERSONA}-${MAX_PERSONA} characters (format: docs/souls.md)`);
    const look = body.look === undefined ? undefined : checkLook(body.look, problems);
    if (problems.length) throw new HttpError(400, "invalid registration", problems);
    const soulId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const parsed = parseSoul(persona as string, 0, soulId);
    if (parsed.errors.length) throw new HttpError(422, "invalid persona", parsed.errors);
    if (this.agents.size >= this.opts.maxAgents) throw new HttpError(503, "agent limit reached; try later");
    const agent: Agent = { id: `a_${id(6)}`, key: `kb_${id(24)}`, name, persona: persona as string, soulId, ...(look ? { look } : {}), createdAt: Date.now(), polls: 0 };
    this.agents.set(agent.id, agent);
    this.byKey.set(agent.key, agent);
    this.log(`agent ${agent.id} registered: ${name}`);
    return { agent, warnings: parsed.warnings };
  }

  authAgent(req: Request): Agent {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    const agent = m ? this.byKey.get(m[1]!) : undefined;
    if (!agent) throw new HttpError(401, "missing or unknown agent key: send Authorization: Bearer <key> from POST /api/agents");
    this.agentLimit.take(agent.id);
    return agent;
  }

  // ------------------------------------------------------------ matches
  /** From code (the CLI) any provider is allowed; over HTTP only remote and house (see handle). */
  createMatch(c: CreateMatch = {}): ServerMatch {
    const kinds = c.seats ?? ["remote", "remote", "remote", "remote"];
    if (kinds.length !== 4) throw new HttpError(400, "seats: exactly 4");
    for (const k of kinds) if (k !== "remote" && k !== "house" && !PROVIDERS[k]) throw new HttpError(400, `seats: unknown seat kind "${k}" (remote, house${Object.keys(PROVIDERS).length ? `, ${Object.keys(PROVIDERS).join(", ")}` : ""})`);
    const active = [...this.matches.values()].filter((m) => m.status === "open" || m.status === "running").length;
    if (active >= this.opts.maxMatches) throw new HttpError(503, `${active} matches are open or running (at most ${this.opts.maxMatches}); try later`);
    const seed = c.seed !== undefined ? c.seed >>> 0 : randomBytes(4).readUInt32LE(0);
    const m = new ServerMatch(`m_${id(4)}`, seed, kinds, c.deadlineMs ?? this.opts.defaultDeadlineMs, c.fillAfterMs ?? this.opts.defaultFillAfterMs, this);
    this.matches.set(m.id, m);
    this.newest = m;
    this.log(`match ${m.id} created: seed ${seed}, seats ${kinds.join(",")}, deadline ${m.deadlineMs / 1000} s, starts in ${(m.startsAt - m.createdAt) / 1000} s at the latest`);
    // keep finished matches for a while, but not forever
    if (this.matches.size > 200) for (const [k, old] of this.matches) if (old.status === "over" || old.status === "failed") { this.matches.delete(k); if (this.matches.size <= 150) break; }
    return m;
  }

  private matchOr404(mid: string): ServerMatch {
    const m = this.matches.get(mid);
    if (!m) throw new HttpError(404, `no match ${mid}`);
    return m;
  }

  // ------------------------------------------------------------ HTTP
  /** Handle an /api request (null for other paths). `ip` keys the rate limits. */
  async handle(req: Request, ip = "local"): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") return null;
    try {
      this.ipLimit.take(ip);
      return await this.route(req, url, ip);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e);
      this.log(`error: ${e instanceof Error ? e.stack : String(e)}`);
      return json({ error: "internal error" }, 500);
    }
  }

  private async route(req: Request, url: URL, ip: string): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, "");
    const method = req.method;
    const allow = (want: string) => {
      if (method !== want) throw new HttpError(405, `use ${want} for ${path}`, undefined, { allow: want });
    };
    if (path === "/api") return json(apiIndex());
    if (path === "/api/live") {
      allow("GET");
      const mid = url.searchParams.get("match");
      const m = mid ? this.matchOr404(mid) : this.newest;
      if (!m) throw new HttpError(404, "no match yet");
      return m.live.response();
    }
    if (path === "/api/agents") {
      allow("POST");
      this.registerLimit.take(ip, "registrations");
      const { agent, warnings } = this.register(await readJson(req, MAX_BODY));
      return json({ id: agent.id, key: agent.key, name: agent.name, soul: agent.soulId, ...(agent.look ? { look: agent.look } : {}), warnings }, 201);
    }
    if (path === "/api/matches") {
      if (method === "GET") return json({ matches: [...this.matches.values()].map((m) => m.info()) });
      allow("POST");
      this.createLimit.take(ip, "new matches");
      const b = await readJson(req, 2048);
      return json(this.createMatch(checkCreate(b)).info(), 201);
    }
    const mm = /^\/api\/matches\/([\w-]{1,32})(?:\/(join|turn|plan|report))?$/.exec(path);
    if (!mm) throw new HttpError(404, `no such endpoint: ${method} ${path} (see GET /api)`);
    const match = this.matchOr404(mm[1]!);
    switch (mm[2]) {
      case undefined:
        allow("GET");
        return json(match.info());
      case "report": {
        allow("GET");
        const r = url.searchParams.get("round");
        return json(match.report(r === null ? undefined : Number(r)));
      }
      case "join": {
        allow("POST");
        const agent = this.authAgent(req);
        const b = req.headers.get("content-length") === "0" || !req.body ? {} : await readJson(req, 1024);
        const want = b.seat;
        if (want !== undefined && !(Number.isInteger(want) && (want as number) >= 0 && (want as number) <= 3)) throw new HttpError(400, "seat: 0-3");
        const seat = match.join(agent, want as number | undefined);
        return json({ match: match.id, seat, status: match.status, turn: `/api/matches/${match.id}/turn` });
      }
      case "turn": {
        allow("GET");
        const agent = this.authAgent(req);
        if (match.seatOf(agent) < 0) throw new HttpError(403, `you have no seat in match ${match.id}; POST /api/matches/${match.id}/join first`);
        const w = Number(url.searchParams.get("wait") ?? "25");
        if (!Number.isFinite(w) || w < 0 || w > MAX_WAIT_S) throw new HttpError(400, `wait: 0-${MAX_WAIT_S} seconds`);
        if (agent.polls >= 2) throw new HttpError(429, "at most 2 long polls at once per agent");
        agent.polls++;
        try {
          const until = Date.now() + w * 1000;
          for (;;) {
            const t = match.turnFor(agent);
            if (t.status === "turn" || t.status === "over" || Date.now() >= until || req.signal.aborted) return json(t);
            await match.nextChange(until - Date.now(), req.signal);
          }
        } finally {
          agent.polls--;
        }
      }
      case "plan": {
        allow("POST");
        const agent = this.authAgent(req);
        const seat = match.seatOf(agent);
        if (seat < 0) throw new HttpError(403, `you have no seat in match ${match.id}`);
        const body = await readJson(req, MAX_BODY);
        const rs = match.remote[seat]!;
        const res = rs.submit(body);
        if (!res.ok) {
          this.log(`match ${match.id}: ${agent.name} plan rejected (${res.status}): ${res.error}${res.problems ? `: ${res.problems.join("; ")}` : ""}`);
          throw new HttpError(res.status, res.error, res.problems);
        }
        return json({ accepted: true, round: body.round, plan: res.plan, warnings: res.warnings });
      }
    }
    throw new HttpError(404, "no such endpoint");
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
  const extra = Object.keys(b).filter((k) => !["seats", "seed", "deadlineSec", "fillAfterSec"].includes(k));
  if (extra.length) problems.push(`unknown fields: ${extra.join(", ")}`);
  const c: CreateMatch = {};
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
    if (typeof b.fillAfterSec !== "number" || b.fillAfterSec < 0 || b.fillAfterSec > 600) problems.push("fillAfterSec: 0-600");
    else c.fillAfterMs = Math.round(b.fillAfterSec * 1000);
  }
  if (problems.length) throw new HttpError(400, "invalid match", problems);
  return c;
}

function apiIndex() {
  return {
    name: "Knockback match server",
    auth: "Authorization: Bearer <key> (from POST /api/agents) for join, turn and plan",
    endpoints: {
      "POST /api/agents": "{ name, persona (soul text, docs/souls.md), look? { name, shape, eyes, mark, minor, color } } -> { id, key }",
      "POST /api/matches": '{ seats?: 4 x "remote"|"house", seed?, deadlineSec? (2-120), fillAfterSec? (0-600) } -> match',
      "GET /api/matches": "all matches",
      "GET /api/matches/:id": "status and seats",
      "POST /api/matches/:id/join": "{ seat? } -> { seat }",
      "GET /api/matches/:id/turn?wait=25": "long poll -> { status: open | turn | waiting | over, ... }; a turn carries context, prompt and schema",
      "POST /api/matches/:id/plan": "{ round, weapons, target, stance, retaliate?, rules?, why?, line } or { round, answer } -> { accepted, plan }",
      "GET /api/matches/:id/report": "plans and results so far (?round=n)",
      "GET /api/live?match=:id": "spectator event stream (SSE)",
    },
    limits: { body: `${MAX_BODY} bytes`, persona: `${MIN_PERSONA}-${MAX_PERSONA} characters`, wait: `0-${MAX_WAIT_S} s` },
    schema: planSchema(),
  };
}
