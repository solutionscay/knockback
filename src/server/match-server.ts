/**
 * The match server (#20, #25, #64): the always-on Arena with remote agents as players. It holds the Arena (arena.ts)
 * and its rounds in memory (each round a ServerMatch, server-match.ts), and answers HTTP through handle() (the
 * routes: match-routes.ts, arena-routes.ts, site.ts). The Arena is the only way to play here.
 *
 * Storage (#27): every change is written through a MatchStore (default: an in-memory SQLite). resume() rebuilds the
 * server after a restart: the Arena round in progress replays its stored decisions (deterministic) and plays on;
 * finished rounds load on demand.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckinConfig } from "../ai/checkin";
import { OlderEngineError } from "../ai/runner";
import { OLDER_ENGINE, recordEngine, type StampedRecord } from "../sim/engine";
import { dedupe, headToHead, leaderboard, type SeatEntry } from "../stats/models";
import { Arena, type ArenaOptions } from "./arena";
import { errorResponse, HttpError, json, RateLimiter } from "./limits";
import { apiRoute, health } from "./match-routes";
import { storedRuleset } from "./match-rulesets";
import { modelsPage } from "./models-page";
import { PICK_MIN_WINDOW_MS, PICKS_PER_ADDRESS } from "./picks";
import { ServerMatch, tierOf, type SeatKind } from "./server-match";
import { SqliteStore, type MatchStore } from "./store";

/** GET /api/models reads at most this many of the newest records */
const MODELS_MAX_RECORDS = 5000;

export interface ServerOptions {
  /** where records are written */
  outDir: string;
  /** persistence (default: in-memory SQLite, i.e. nothing survives a restart) */
  store?: MatchStore;
  /** shown by GET /api/health (e.g. the image's git revision) */
  version?: string;
  /**
   * "broadcast" (#22): rounds run at viewer speed; the Arena keeps that time whether or not anyone watches.
   * "fast" (default here, for tests): no waiting.
   */
  pace?: "fast" | "broadcast";
  /** a dropped connection becomes autopilot if the agent sends nothing for this long (default 5 s) */
  dropGraceMs?: number;
  /**
   * Mid-round check-ins (#9): agents get a status every ~10 s of fight and may change their plan. Default off.
   */
  checkins?: boolean | Partial<CheckinConfig>;
  /** spectator picks (#35): different spectators one address may add to one round's tally (default 8) */
  picksPerAddress?: number;
  /** at broadcast pace, picks stay open at least this long after a round starts (default 30 s) */
  pickWindowMs?: number;
  /** the Arena (#64): turn deadline, pause between rounds, clock, seeds, miss limit, public URL */
  arena?: ArenaOptions;
  log?: (s: string) => void;
}

export class MatchServer {
  /** the Arena's rounds in memory (the one on now, recent ones, finished ones loaded from storage) */
  readonly matches = new Map<string, ServerMatch>();
  readonly arena: Arena;
  readonly opts: Required<Omit<ServerOptions, "log" | "store" | "arena">>;
  readonly store: MatchStore;
  readonly log: (s: string) => void;
  // per address: all requests; joins are scarcer
  readonly ipLimit = new RateLimiter(60, 10);
  readonly joinLimit = new RateLimiter(10, 1 / 6);
  /** per owner key: Arena joins (a key cannot flood the Arena from many addresses) */
  readonly keyLimit = new RateLimiter(10, 1 / 6);
  /** new owner keys per address */
  readonly keyCreateLimit = new RateLimiter(5, 1 / 120);
  /** per agent: turn, plan, check-in and leave calls */
  readonly seatLimit = new RateLimiter(30, 5);
  // spectator picks (#35): per address
  readonly pickLimit = new RateLimiter(20, 1);
  // rebuilding a finished round from storage replays its physics: scarce per address, one load per round at a time
  readonly loadLimit = new RateLimiter(5, 1 / 5);
  private loading = new Map<string, Promise<ServerMatch>>();

  constructor(opts: ServerOptions) {
    const { store, log, arena, ...rest } = opts;
    this.opts = { version: "dev", pace: "fast", dropGraceMs: 5000, checkins: false, picksPerAddress: PICKS_PER_ADDRESS, pickWindowMs: PICK_MIN_WINDOW_MS, ...rest };
    this.store = store ?? new SqliteStore(":memory:");
    this.log = log ?? (() => {});
    this.arena = new Arena(this, arena);
  }

  /** After a restart: the Arena round in progress resumes. Then start the loop: arena.start(). */
  resume(): Promise<{ round: number | null }> {
    return this.arena.resume();
  }

  /**
   * May GET /records/<file>.json serve this file? Not the record of a round from an older engine or one not checked
   * yet (#88: training data, never re-simulated in a viewer). A file no match saved (an ai-match run) is served.
   */
  async servesRecord(path: string): Promise<boolean> {
    // the same name the file server reads (it decodes the path): /records/arena%2D... is the same file as /records/arena-...
    let name: string;
    try {
      name = decodeURIComponent(path.slice("/records/".length));
    } catch {
      return false;
    }
    const rec = await this.store.recordByPath(`/records/${name}`);
    return !rec || (rec.engine === this.store.engine && rec.tier !== "bot-only");
  }

  add(m: ServerMatch) {
    this.matches.set(m.id, m);
    // keep finished rounds for a while, but not forever
    if (this.matches.size > 200)
      for (const [k, old] of this.matches)
        if ((old.status === "over" || old.status === "failed") && old !== this.arena.current) {
          old.live.close();
          this.matches.delete(k);
          if (this.matches.size <= 150) break;
        }
  }

  /**
   * Shown in public (#67): every round while the Arena shows it live (on now, or the last one between rounds); after
   * that only rounds an agent played. A bot-only round is kept internal.
   */
  isPublic(m: ServerMatch): boolean {
    return m.tier !== "bot-only" || m === this.arena.current;
  }

  /**
   * A public round in memory, or a finished one loaded from storage (deduplicated and rate limited: it replays the
   * physics). A bot-only round the Arena no longer shows is 404, as if it never was (#67).
   */
  async matchOr404(mid: string, ip = "local"): Promise<ServerMatch> {
    const m = this.matches.get(mid);
    if (m) {
      if (!this.isPublic(m)) throw new HttpError(404, `no match ${mid}`);
      return m;
    }
    const pending = this.loading.get(mid);
    if (pending) return pending;
    if (!/^m_[0-9a-f]{8}$/.test(mid)) throw new HttpError(404, `no match ${mid}`);
    const row = await this.store.getMatch(mid);
    // a round of an older engine (#88) is training data: not found, never re-simulated
    if (!row || (row.status !== "over" && row.status !== "failed") || tierOf(row.kinds) === "bot-only" || row.engine !== this.store.engine) throw new HttpError(404, `no match ${mid}`);
    if (this.loading.has(mid)) return this.loading.get(mid)!;
    this.loadLimit.take(ip, "loads of old rounds");
    const load = (async () => {
      const loaded = new ServerMatch(row.id, row.arenaRound, row.seed, row.kinds as SeatKind[], row.deadlineMs, this, row.createdAt, storedRuleset(row));
      for (const s of await this.store.listSeats(row.id)) loaded.restoreSeat(s);
      loaded.picks.load(await this.store.listPicks(row.id));
      loaded.picks.lockedAt = row.picksLockedAt ?? null;
      loaded.startedAtMs = row.startedAt;
      const rec = await this.store.getRecord(mid);
      if (row.status === "over" && !rec) throw new HttpError(404, `no saved record for match ${mid}`);
      await loaded.loadFinished(row, await this.store.listRounds(mid), rec?.path ?? null);
      this.add(loaded);
      return loaded;
    })();
    this.loading.set(mid, load);
    try {
      return await load;
    } catch (e) {
      // stamped as this engine but it does not replay (a sim change the stamp did not catch): older from now on
      if (e instanceof OlderEngineError) {
        await this.store.updateMatch(mid, { engine: OLDER_ENGINE });
        this.log(`match ${mid}: played on an older engine; kept as training data, no longer shown`);
        throw new HttpError(404, `no match ${mid}`);
      }
      throw e;
    } finally {
      this.loading.delete(mid);
    }
  }

  /**
   * The rounds from before engine stamps (#88): replay each one's record once, in the background, and stamp it with
   * this engine if it reaches its recorded hashes, "older" if not. Until then it is not shown. Public rounds first;
   * a pause between replays keeps the live Arena smooth. Resolves when all are done (tests await it).
   */
  async stampOldRounds(pauseMs = 200): Promise<{ current: number; older: number }> {
    const out = { current: 0, older: 0 };
    for (const row of await this.store.unstampedMatches()) {
      const rec = row.status === "over" ? await this.store.getRecord(row.id) : null;
      let engine: string = OLDER_ENGINE;
      if (rec) {
        const file = rec.path.startsWith("/records/") ? join(this.opts.outDir, rec.path.slice("/records/".length)) : join(this.opts.outDir, rec.path);
        try {
          const raw = JSON.parse(await readFile(file, "utf8")) as StampedRecord;
          if (recordEngine(raw) === "current") engine = this.store.engine;
        } catch {
          /* no readable record: it cannot be shown either way */
        }
      }
      await this.store.updateMatch(row.id, { engine });
      if (engine === OLDER_ENGINE) out.older++;
      else out.current++;
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    }
    if (out.current + out.older) this.log(`engine: ${out.current + out.older} rounds from before engine stamps checked: ${out.current} on this engine, ${out.older} older (kept as training data, not shown)`);
    return out;
  }

  // ------------------------------------------------------------ HTTP
  /** Handle an /api request (null for other paths). `ip` keys the rate limits. */
  async handle(req: Request, ip = "local"): Promise<Response | null> {
    const url = new URL(req.url);
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
   * with the record. Records with test providers are left out; copies of one match count once.
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
    return { ...lb, headToHead: h2h, duplicates: dropped, note: "win rate per seat played; ± is the 95% interval; chance is 25% in a 4-fighter round; models below the minimum are provisional; self-reported models are the model ids remote agents gave at join, cleaned so one model is one row" };
  }
}
