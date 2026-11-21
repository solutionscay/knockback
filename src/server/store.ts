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
import { CLASSIC, CLOSE_QUARTERS, resolveRuleset, type Ruleset } from "../sim/ruleset";
import { Database } from "bun:sqlite";
import type { ControlEvent } from "../ai/runner";
import type { IdentityWish } from "../sim/identity";
import type { DecisionMeta, PlanUpdate } from "../sim/match";
import type { Decision } from "../sim/voice";

export type MatchStatus = "open" | "running" | "over" | "failed";

export interface RulesetPreset {
  name: string;
  ruleset: Ruleset | null;
  version: number;
  isDefault: boolean;
}

export interface MatchRow {
  ruleset?: Ruleset;
  preset?: string;
  presetVersion?: number;
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
  /** when spectator picks locked (#35): right before round 1's decisions were broadcast */
  picksLockedAt?: number | null;
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
  /** the model the agent reported at join (unverified), or null */
  model?: string | null;
  /** the agent's opening line, shown on spectators' pick cards (#35) */
  openingLine?: string | null;
}

/** A spectator's pick (#35): kept apart from the match; never in the record, prompts or tool results. */
export interface PickRow {
  matchId: string;
  /** sha256 of the spectator's cookie id */
  spectator: string;
  seat: number;
  /** the picking address, for the per-address cap */
  ip: string;
  createdAt: number;
  updatedAt: number;
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
  /** the round's mid-round plan updates (#8/#9), set with the final hash; null before, or for rounds stored before the column */
  planUpdates?: PlanUpdate[] | null;
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
  /** engine version that made the record (src/sim/engine-version.ts); rows from before the column are 0 */
  engine: number;
  /** per-seat model stats for GET /api/models (src/stats/models.ts SeatEntry[] as JSON); null on rows from before it */
  stats?: string | null;
}

export type MatchPatch = Partial<Pick<MatchRow, "status" | "startedAt" | "endedAt" | "error" | "winner" | "picksLockedAt">>;
export type SeatPatch = Partial<Pick<SeatRow, "leftAt" | "leftRound">>;

export interface MatchStore {
  getRulesetPreset(name: string): Promise<RulesetPreset | null>;
  defaultRulesetPreset(): Promise<RulesetPreset | null>;
  listRulesetPresets(): Promise<RulesetPreset[]>;
  putRulesetPreset(name: string, ruleset: unknown): Promise<RulesetPreset>;
  setDefaultRulesetPreset(name: string): Promise<void>;
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
  /** the round was played: its final hash and its mid-round plan updates (a resume replays them) */
  setRoundHash(matchId: string, round: number, finalHash: string, planUpdates?: PlanUpdate[]): Promise<void>;
  listRounds(matchId: string): Promise<RoundRow[]>;
  insertPlan(p: PlanRow): Promise<void>;
  getPlan(matchId: string, round: number, seat: number): Promise<PlanRow | null>;
  /** a change of control (autopilot / agent back, #22), in order */
  insertControl(matchId: string, idx: number, e: ControlEvent): Promise<void>;
  listControl(matchId: string): Promise<ControlEvent[]>;
  /** spectator picks (#35): one per spectator per match, changeable until the lock */
  upsertPick(p: PickRow): Promise<void>;
  listPicks(matchId: string): Promise<PickRow[]>;
  insertRecord(r: RecordRow): Promise<void>;
  getRecord(matchId: string): Promise<RecordRow | null>;
  /** newest first; `before` (ms) pages back through older ones */
  listRecords(limit?: number, before?: number): Promise<RecordRow[]>;
  /** fill in a record's model stats (rows saved before the column) */
  setRecordStats(matchId: string, stats: string): Promise<void>;
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
  // 2 (#22): who controls each fighter, as it changes (autopilot / agent back)
  `CREATE TABLE control (
     match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL,
     event TEXT NOT NULL,              -- JSON ControlEvent (seat, mode, round, phase, tick, reason, line, fromRound)
     PRIMARY KEY (match_id, idx)
   );`,
  // 3: the engine version that made each record; older rows count as 0
  `ALTER TABLE records ADD COLUMN engine INTEGER NOT NULL DEFAULT 0;`,
  // 4 (#8/#9): the mid-round plan updates of each played round (JSON PlanUpdate[]), so a resume replays them
  `ALTER TABLE rounds ADD COLUMN plan_updates TEXT;`,
  // 5 (model spotlight): the model a remote agent reported at join; per-seat model stats of each record
  `ALTER TABLE seats ADD COLUMN model TEXT;
   ALTER TABLE records ADD COLUMN stats TEXT;`,
  // 6 (#36): ruleset presets and the settings pinned to each match
  `CREATE TABLE ruleset_presets (
     name TEXT PRIMARY KEY COLLATE NOCASE,
     body TEXT,
     version INTEGER NOT NULL DEFAULT 1,
     is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
     CHECK (is_default = 0 OR body IS NOT NULL)
   );
   CREATE UNIQUE INDEX one_default_ruleset ON ruleset_presets(is_default) WHERE is_default = 1;
   INSERT INTO ruleset_presets (name, body, is_default) VALUES ('Classic', '${JSON.stringify(CLOSE_QUARTERS).replaceAll("'", "''")}', 1);
   INSERT INTO ruleset_presets (name) VALUES ('Sniper Alley'), ('Close Quarters'), ('Chaos');
   ALTER TABLE matches ADD COLUMN ruleset_body TEXT;
   ALTER TABLE matches ADD COLUMN ruleset_preset TEXT;
   ALTER TABLE matches ADD COLUMN ruleset_version INTEGER;`,
  // 7 (#37): fill the new layout keys in existing snapshots before changing the built-in Classic.
  `UPDATE matches SET ruleset_body = json_set(ruleset_body,
       '$.arena.spawns.spread', json('${JSON.stringify(CLOSE_QUARTERS.arena.spawns.spread)}'),
       '$.pickups.armory.spread', json('${JSON.stringify(CLOSE_QUARTERS.pickups.armory.spread)}'),
       '$.pickups.supply.avoidDistance', 0,
       '$.zone.suddenDeath.graceTicks', 0,
       '$.tactics.weapons', json('{"enabled":false}'))
     WHERE ruleset_body IS NOT NULL AND json_type(ruleset_body, '$.arena.spawns.spread') IS NULL;
   UPDATE ruleset_presets SET body = json_set(body,
       '$.arena.spawns.spread', json('${JSON.stringify(CLOSE_QUARTERS.arena.spawns.spread)}'),
       '$.pickups.armory.spread', json('${JSON.stringify(CLOSE_QUARTERS.pickups.armory.spread)}'),
       '$.pickups.supply.avoidDistance', 0,
       '$.zone.suddenDeath.graceTicks', 0,
       '$.tactics.weapons', json('{"enabled":false}'))
     WHERE body IS NOT NULL AND json_type(body, '$.arena.spawns.spread') IS NULL;
   UPDATE ruleset_presets SET body = '${JSON.stringify(CLASSIC).replaceAll("'", "''")}', version = version + 1 WHERE name = 'Classic';
   UPDATE ruleset_presets SET body = '${JSON.stringify(CLOSE_QUARTERS).replaceAll("'", "''")}' WHERE name = 'Close Quarters' AND body IS NULL;`,
  // 8 (#35): spectator picks, the pick lock, agents' opening lines
  `CREATE TABLE picks (
     match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
     spectator TEXT NOT NULL,          -- sha256 of the spectator cookie id; the id itself is never stored
     seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
     ip TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (match_id, spectator)
   );
   ALTER TABLE matches ADD COLUMN picks_locked_at INTEGER;
   ALTER TABLE seats ADD COLUMN opening_line TEXT;`,
];

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(v: unknown): T => JSON.parse(v as string) as T;

const matchOf = (r: Row): MatchRow => ({
  id: r.id as string,
  seed: r.seed as number,
  kinds: p(r.kinds),
  ...(r.ruleset_body ? { ruleset: resolveRuleset(p(r.ruleset_body)) } : {}),
  ...(r.ruleset_preset ? { preset: r.ruleset_preset as string, presetVersion: r.ruleset_version as number } : {}),
  deadlineMs: r.deadline_ms as number,
  fillAfterMs: r.fill_after_ms as number,
  status: r.status as MatchStatus,
  createdAt: r.created_at as number,
  startedAt: (r.started_at as number | null) ?? null,
  endedAt: (r.ended_at as number | null) ?? null,
  creator: (r.creator as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  winner: (r.winner as number | null) ?? null,
  picksLockedAt: (r.picks_locked_at as number | null) ?? null,
});

const presetOf = (r: Row): RulesetPreset => ({
  name: r.name as string,
  ruleset: r.body === null ? null : resolveRuleset(p(r.body)),
  version: r.version as number,
  isDefault: r.is_default === 1,
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
  model: (r.model as string | null) ?? null,
  openingLine: (r.opening_line as string | null) ?? null,
});

const COLS: Record<string, string> = { status: "status", startedAt: "started_at", endedAt: "ended_at", error: "error", winner: "winner", leftAt: "left_at", leftRound: "left_round", picksLockedAt: "picks_locked_at" };

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

  async getRulesetPreset(name: string) {
    const row = this.db.query("SELECT * FROM ruleset_presets WHERE name = ?").get(name) as Row | null;
    return row ? presetOf(row) : null;
  }
  async defaultRulesetPreset() {
    const row = this.db.query("SELECT * FROM ruleset_presets WHERE is_default = 1").get() as Row | null;
    return row ? presetOf(row) : null;
  }
  async listRulesetPresets() {
    return (this.db.query("SELECT * FROM ruleset_presets ORDER BY is_default DESC, name").all() as Row[]).map(presetOf);
  }
  async putRulesetPreset(name: string, input: unknown) {
    name = name.trim();
    if (!name || name.length > 64 || /[\x00-\x1f]/.test(name)) throw new Error("ruleset preset name must be 1–64 printable characters");
    if (name.toLowerCase() === "classic") throw new Error("Classic is the built-in ruleset");
    if (input === undefined) throw new Error("ruleset preset needs settings");
    const ruleset = resolveRuleset(input);
    const row = this.db.query(
      "INSERT INTO ruleset_presets (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, version = version + 1 RETURNING *",
    ).get(name, j(ruleset)) as Row;
    return presetOf(row);
  }
  async setDefaultRulesetPreset(name: string) {
    this.db.transaction(() => {
      const row = this.db.query("SELECT body FROM ruleset_presets WHERE name = ?").get(name) as Row | null;
      if (!row?.body) throw new Error("lobby default must be a preset with settings");
      this.db.query("UPDATE ruleset_presets SET is_default = 0 WHERE is_default = 1").run();
      this.db.query("UPDATE ruleset_presets SET is_default = 1 WHERE name = ?").run(name);
    })();
  }

  async insertMatch(m: MatchRow) {
    this.db
      .query("INSERT INTO matches (id, seed, kinds, deadline_ms, fill_after_ms, status, created_at, started_at, ended_at, creator, error, winner, ruleset_body, ruleset_preset, ruleset_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.seed, j(m.kinds), m.deadlineMs, m.fillAfterMs, m.status, m.createdAt, m.startedAt, m.endedAt, m.creator, m.error, m.winner, m.ruleset ? j(m.ruleset) : null, m.preset ?? null, m.presetVersion ?? null);
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
      .query("INSERT INTO seats (match_id, seat, name, persona, look, token_hash, joined_at, left_at, left_round, model, opening_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.matchId, s.seat, s.name, s.persona, s.look ? j(s.look) : null, s.tokenHash, s.joinedAt, s.leftAt, s.leftRound, s.model ?? null, s.openingLine ?? null);
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
  async setRoundHash(matchId: string, round: number, finalHash: string, planUpdates: PlanUpdate[] = []) {
    this.db.query("UPDATE rounds SET final_hash = ?, plan_updates = ? WHERE match_id = ? AND round = ?").run(finalHash, planUpdates.length ? j(planUpdates) : null, matchId, round);
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
      planUpdates: r.plan_updates ? p<PlanUpdate[]>(r.plan_updates) : null,
    }));
  }
  async insertPlan(pl: PlanRow) {
    this.db.query("INSERT OR REPLACE INTO plans (match_id, round, seat, raw, at) VALUES (?, ?, ?, ?, ?)").run(pl.matchId, pl.round, pl.seat, pl.raw, pl.at);
  }
  async getPlan(matchId: string, round: number, seat: number) {
    const r = this.db.query("SELECT * FROM plans WHERE match_id = ? AND round = ? AND seat = ?").get(matchId, round, seat) as Row | null;
    return r ? { matchId, round, seat, raw: r.raw as string, at: r.at as number } : null;
  }
  async insertControl(matchId: string, idx: number, e: ControlEvent) {
    this.db.query("INSERT OR REPLACE INTO control (match_id, idx, event) VALUES (?, ?, ?)").run(matchId, idx, j(e));
  }
  async listControl(matchId: string) {
    return (this.db.query("SELECT event FROM control WHERE match_id = ? ORDER BY idx").all(matchId) as Row[]).map((r) => p<ControlEvent>(r.event));
  }
  async upsertPick(pk: PickRow) {
    this.db
      .query("INSERT INTO picks (match_id, spectator, seat, ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (match_id, spectator) DO UPDATE SET seat = excluded.seat, updated_at = excluded.updated_at")
      .run(pk.matchId, pk.spectator, pk.seat, pk.ip, pk.createdAt, pk.updatedAt);
  }
  async listPicks(matchId: string) {
    return (this.db.query("SELECT * FROM picks WHERE match_id = ? ORDER BY created_at").all(matchId) as Row[]).map((r) => ({
      matchId,
      spectator: r.spectator as string,
      seat: r.seat as number,
      ip: r.ip as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    }));
  }
  async insertRecord(r: RecordRow) {
    this.db.query("INSERT OR REPLACE INTO records (match_id, path, seed, hashes, winner, created_at, engine, stats) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(r.matchId, r.path, r.seed, j(r.hashes), r.winner, r.createdAt, r.engine, r.stats ?? null);
  }
  async getRecord(matchId: string) {
    const r = this.db.query("SELECT * FROM records WHERE match_id = ?").get(matchId) as Row | null;
    return r ? recordOf(r) : null;
  }
  async setRecordStats(matchId: string, stats: string) {
    this.db.query("UPDATE records SET stats = ? WHERE match_id = ?").run(stats, matchId);
  }
  async listRecords(limit = 100, before?: number) {
    if (before !== undefined) return (this.db.query("SELECT * FROM records WHERE created_at < ? ORDER BY created_at DESC LIMIT ?").all(before, limit) as Row[]).map(recordOf);
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
  engine: (r.engine as number | null) ?? 0,
  stats: (r.stats as string | null) ?? null,
});
