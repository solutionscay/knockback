/**
 * Match server storage (#27). The server keeps its working state in memory
 * and writes every change through a MatchStore, so a restart can rebuild it:
 * matches, seats (with hashed seat tokens), the decisions of every round
 * played, plans accepted for the round being asked, and an index of the
 * saved records (the records themselves stay JSON files).
 *
 * The interface is async and row-shaped (plain JSON-able values, no driver
 * types) so a Cloudflare backend (#26: D1, or a Durable Object's own SQLite)
 * can implement it; SqliteStore is the bun:sqlite one for local and LAN use.
 */
import { Database } from "bun:sqlite";
import type { IdentityWish } from "../sim/identity";
import type { DecisionMeta } from "../sim/match";
import type { Decision } from "../sim/voice";

export type MatchStatus = "open" | "running" | "over" | "failed";

export interface MatchRow {
  id: string;
  seed: number;
  /** per seat: "remote", "house" or a local provider name */
  kinds: string[];
  deadlineMs: number;
  fillAfterMs: number;
  status: MatchStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** address that created it over HTTP (null for CLI matches) */
  creator: string | null;
  error: string | null;
  /** winning seat once over */
  winner: number | null;
}

export interface SeatRow {
  matchId: string;
  seat: number;
  name: string;
  persona: string;
  look: IdentityWish | null;
  /** sha256 of the seat token (hex) */
  tokenHash: string;
  joinedAt: number;
  /** set when the agent left; the seat is played by the house bot from then on */
  leftAt: number | null;
  /** the first round the house bot plays for it (null: left before the start) */
  leftRound: number | null;
}

export interface RoundRow {
  matchId: string;
  round: number;
  decisions: Decision[];
  meta: DecisionMeta[];
  prompts: string[];
  raw: (string | null)[];
  /** set once the round has been played */
  finalHash: string | null;
}

export interface PlanRow {
  matchId: string;
  round: number;
  seat: number;
  /** the plan text as accepted (parsed again by decideRound) */
  raw: string;
  at: number;
}

export interface RecordRow {
  matchId: string;
  /** e.g. /records/remote-42-....json (local file) or an object key when hosted */
  path: string;
  seed: number;
  hashes: string[];
  winner: number;
  createdAt: number;
}

export type MatchPatch = Partial<Pick<MatchRow, "status" | "startedAt" | "endedAt" | "error" | "winner">>;
export type SeatPatch = Partial<Pick<SeatRow, "leftAt" | "leftRound">>;

export interface MatchStore {
  insertMatch(m: MatchRow): Promise<void>;
  updateMatch(id: string, patch: MatchPatch): Promise<void>;
  getMatch(id: string): Promise<MatchRow | null>;
  /** newest first; `statuses` filters */
  listMatches(statuses?: MatchStatus[]): Promise<MatchRow[]>;
  insertSeat(s: SeatRow): Promise<void>;
  updateSeat(matchId: string, seat: number, patch: SeatPatch): Promise<void>;
  /** a seat freed before the start */
  deleteSeat(matchId: string, seat: number): Promise<void>;
  listSeats(matchId: string): Promise<SeatRow[]>;
  insertRound(r: RoundRow): Promise<void>;
  setRoundHash(matchId: string, round: number, finalHash: string): Promise<void>;
  listRounds(matchId: string): Promise<RoundRow[]>;
  insertPlan(p: PlanRow): Promise<void>;
  getPlan(matchId: string, round: number, seat: number): Promise<PlanRow | null>;
  insertRecord(r: RecordRow): Promise<void>;
  getRecord(matchId: string): Promise<RecordRow | null>;
  listRecords(limit?: number): Promise<RecordRow[]>;
  close(): Promise<void>;
}

/** Schema versions, applied in order, each once (table schema_migrations). Plain SQLite: D1 runs the same SQL. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE matches (
     id TEXT PRIMARY KEY,
     seed INTEGER NOT NULL,
     kinds TEXT NOT NULL,              -- JSON array of 4 seat kinds
     deadline_ms INTEGER NOT NULL,
     fill_after_ms INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open','running','over','failed')),
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     ended_at INTEGER,
     creator TEXT,
     error TEXT,
     winner INTEGER
   );
   CREATE INDEX matches_status ON matches(status);
   CREATE TABLE seats (
     match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
     seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
     name TEXT NOT NULL,
     persona TEXT NOT NULL,
     look TEXT,                        -- JSON identity wish or NULL
     token_hash TEXT NOT NULL UNIQUE,  -- sha256 hex of the seat token; the token itself is never stored
     joined_at INTEGER NOT NULL,
     left_at INTEGER,
     left_round INTEGER,
     PRIMARY KEY (match_id, seat)
   );
   CREATE TABLE rounds (
     match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
     round INTEGER NOT NULL,
     decisions TEXT NOT NULL,          -- JSON Decision[4] as played
     meta TEXT NOT NULL,               -- JSON DecisionMeta[4]
     prompts TEXT NOT NULL,            -- JSON string[4]
     raw TEXT NOT NULL,                -- JSON (string|null)[4]
     final_hash TEXT,
     PRIMARY KEY (match_id, round)
   );
   CREATE TABLE plans (
     match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
     round INTEGER NOT NULL,
     seat INTEGER NOT NULL,
     raw TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (match_id, round, seat)
   );
   CREATE TABLE records (
     match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     seed INTEGER NOT NULL,
     hashes TEXT NOT NULL,             -- JSON string[] (final hash per round)
     winner INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );`,
];

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(v: unknown): T => JSON.parse(v as string) as T;

const matchOf = (r: Row): MatchRow => ({
  id: r.id as string,
  seed: r.seed as number,
  kinds: p(r.kinds),
  deadlineMs: r.deadline_ms as number,
  fillAfterMs: r.fill_after_ms as number,
  status: r.status as MatchStatus,
  createdAt: r.created_at as number,
  startedAt: (r.started_at as number | null) ?? null,
  endedAt: (r.ended_at as number | null) ?? null,
  creator: (r.creator as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  winner: (r.winner as number | null) ?? null,
});

const seatOf = (r: Row): SeatRow => ({
  matchId: r.match_id as string,
  seat: r.seat as number,
  name: r.name as string,
  persona: r.persona as string,
  look: r.look ? p(r.look) : null,
  tokenHash: r.token_hash as string,
  joinedAt: r.joined_at as number,
  leftAt: (r.left_at as number | null) ?? null,
  leftRound: (r.left_round as number | null) ?? null,
});

const COLS: Record<string, string> = { status: "status", startedAt: "started_at", endedAt: "ended_at", error: "error", winner: "winner", leftAt: "left_at", leftRound: "left_round" };

export class SqliteStore implements MatchStore {
  readonly db: Database;

  /** `path`: a file, or ":memory:" */
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
    this.migrate();
  }

  /** Apply the migrations this file has not seen yet. Returns the schema version. */
  migrate(): number {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const have = (this.db.query("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null }).v ?? 0;
    for (let v = have + 1; v <= MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v - 1]!);
        this.db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, Date.now());
      })();
    }
    return MIGRATIONS.length;
  }

  private patch(table: string, where: string, args: unknown[], patch: Record<string, unknown>) {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    const set = keys.map((k) => `${COLS[k]!} = ?`).join(", ");
    this.db.query(`UPDATE ${table} SET ${set} WHERE ${where}`).run(...(keys.map((k) => patch[k]) as never[]), ...(args as never[]));
  }

  async insertMatch(m: MatchRow) {
    this.db
      .query("INSERT INTO matches (id, seed, kinds, deadline_ms, fill_after_ms, status, created_at, started_at, ended_at, creator, error, winner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.seed, j(m.kinds), m.deadlineMs, m.fillAfterMs, m.status, m.createdAt, m.startedAt, m.endedAt, m.creator, m.error, m.winner);
  }
  async updateMatch(id: string, patch: MatchPatch) {
    this.patch("matches", "id = ?", [id], patch);
  }
  async getMatch(id: string) {
    const r = this.db.query("SELECT * FROM matches WHERE id = ?").get(id) as Row | null;
    return r ? matchOf(r) : null;
  }
  async listMatches(statuses?: MatchStatus[]) {
    const rows = statuses?.length
      ? (this.db.query(`SELECT * FROM matches WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at DESC, rowid DESC`).all(...statuses) as Row[])
      : (this.db.query("SELECT * FROM matches ORDER BY created_at DESC, rowid DESC").all() as Row[]);
    return rows.map(matchOf);
  }
  async insertSeat(s: SeatRow) {
    this.db
      .query("INSERT INTO seats (match_id, seat, name, persona, look, token_hash, joined_at, left_at, left_round) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.matchId, s.seat, s.name, s.persona, s.look ? j(s.look) : null, s.tokenHash, s.joinedAt, s.leftAt, s.leftRound);
  }
  async updateSeat(matchId: string, seat: number, patch: SeatPatch) {
    this.patch("seats", "match_id = ? AND seat = ?", [matchId, seat], patch);
  }
  async deleteSeat(matchId: string, seat: number) {
    this.db.query("DELETE FROM seats WHERE match_id = ? AND seat = ?").run(matchId, seat);
  }
  async listSeats(matchId: string) {
    return (this.db.query("SELECT * FROM seats WHERE match_id = ? ORDER BY seat").all(matchId) as Row[]).map(seatOf);
  }
  async insertRound(r: RoundRow) {
    this.db
      .query("INSERT OR REPLACE INTO rounds (match_id, round, decisions, meta, prompts, raw, final_hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.matchId, r.round, j(r.decisions), j(r.meta), j(r.prompts), j(r.raw), r.finalHash);
  }
  async setRoundHash(matchId: string, round: number, finalHash: string) {
    this.db.query("UPDATE rounds SET final_hash = ? WHERE match_id = ? AND round = ?").run(finalHash, matchId, round);
  }
  async listRounds(matchId: string) {
    return (this.db.query("SELECT * FROM rounds WHERE match_id = ? ORDER BY round").all(matchId) as Row[]).map((r) => ({
      matchId: r.match_id as string,
      round: r.round as number,
      decisions: p<Decision[]>(r.decisions),
      meta: p<DecisionMeta[]>(r.meta),
      prompts: p<string[]>(r.prompts),
      raw: p<(string | null)[]>(r.raw),
      finalHash: (r.final_hash as string | null) ?? null,
    }));
  }
  async insertPlan(pl: PlanRow) {
    this.db.query("INSERT OR REPLACE INTO plans (match_id, round, seat, raw, at) VALUES (?, ?, ?, ?, ?)").run(pl.matchId, pl.round, pl.seat, pl.raw, pl.at);
  }
  async getPlan(matchId: string, round: number, seat: number) {
    const r = this.db.query("SELECT * FROM plans WHERE match_id = ? AND round = ? AND seat = ?").get(matchId, round, seat) as Row | null;
    return r ? { matchId, round, seat, raw: r.raw as string, at: r.at as number } : null;
  }
  async insertRecord(r: RecordRow) {
    this.db.query("INSERT OR REPLACE INTO records (match_id, path, seed, hashes, winner, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(r.matchId, r.path, r.seed, j(r.hashes), r.winner, r.createdAt);
  }
  async getRecord(matchId: string) {
    const r = this.db.query("SELECT * FROM records WHERE match_id = ?").get(matchId) as Row | null;
    return r ? recordOf(r) : null;
  }
  async listRecords(limit = 100) {
    return (this.db.query("SELECT * FROM records ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(recordOf);
  }
  async close() {
    this.db.close();
  }
}

const recordOf = (r: Row): RecordRow => ({
  matchId: r.match_id as string,
  path: r.path as string,
  seed: r.seed as number,
  hashes: p<string[]>(r.hashes),
  winner: r.winner as number,
  createdAt: r.created_at as number,
});
