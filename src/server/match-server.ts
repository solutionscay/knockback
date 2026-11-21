/**
 * The match server (#20, #25): Knockback matches with remote agents as players. It holds the matches in memory
 * (ServerMatch, server-match.ts), creates them, enforces the server-wide caps, and answers HTTP through handle()
 * (the routes: match-routes.ts).
 *
 * Storage (#27): every change is written through a MatchStore (default: an
 * in-memory SQLite). resume() rebuilds the server from it after a restart:
 * open matches wait again, running matches replay their stored rounds
 * (deterministic) and play on; finished ones load on demand.
 */
import { randomBytes } from "node:crypto";
import { DEFAULT_DEADLINE_MS } from "../ai/decide";
import type { CheckinConfig } from "../ai/checkin";
import { PROVIDERS } from "../ai/providers";
import type { SuitUpAnswer } from "../ai/suitup";
import { dedupe, headToHead, leaderboard, type SeatEntry } from "../stats/models";
import { errorResponse, HttpError, json, RateLimiter } from "./limits";
import { lobbyPage } from "./lobby";
import { MATCHES_PER_IP, type checkJoin } from "./match-input";
import { apiRoute, health } from "./match-routes";
import { selectRuleset, storedRuleset, type MatchRuleset } from "./match-rulesets";
import type { Matchmaker } from "./matchmaker";
import { modelsPage } from "./models-page";
import { PICK_MIN_WINDOW_MS, PICKS_PER_ADDRESS } from "./picks";
import { hashToken, hex } from "./seat-tokens";
import { ServerMatch, type SeatKind } from "./server-match";
import { SqliteStore, type MatchRow, type MatchStore } from "./store";

export { checkJoin, lookWarnings, MATCHES_PER_IP, MAX_WAIT_S, SEATS_PER_IP } from "./match-input";
export { hashToken } from "./seat-tokens";
export { ServerMatch, type SeatAgent, type SeatKind } from "./server-match";

/** GET /api/models reads at most this many of the newest records */
const MODELS_MAX_RECORDS = 5000;

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
  liveDefault(): ServerMatch | null {
    const newest = (st: string) => [...this.matches.values()].filter((m) => m.status === st).sort((a, b) => b.createdAt - a.createdAt)[0];
    return newest("running") ?? newest("open") ?? this.newest;
  }

  /** A match in memory, or a finished one loaded from storage (deduplicated and rate limited: it replays the physics). */
  async matchOr404(mid: string, ip = "local"): Promise<ServerMatch> {
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
      if (row.status === "over" && !rec) throw new HttpError(404, `no saved record for match ${mid}`);
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
    if (url.pathname === "/api/health") return health(this);
    try {
      this.ipLimit.take(ip);
      return await apiRoute(this, req, url, ip);
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
   * The model leaderboard from the SQLite record index: each row's per-seat stats, saved
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
    return { ...lb, headToHead: h2h, duplicates: dropped, note: "match win rate per seat played; ± is the 95% interval; chance is 25% in a 4-fighter match; models below the minimum are provisional; self-reported models are what remote agents said at join" };
  }

  /** Hooks a storage-backed server overrides. */
  async join(match: ServerMatch, j: ReturnType<typeof checkJoin>, owner: string, ip: string) {
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

  async leave(match: ServerMatch, seat: number) {
    const r = match.leave(seat);
    if (r.status === "open") await this.store.deleteSeat(match.id, seat);
    else await this.store.updateSeat(match.id, seat, { leftAt: match.agents[seat]!.leftAt, leftRound: match.agents[seat]!.leftRound });
    return r;
  }
}
