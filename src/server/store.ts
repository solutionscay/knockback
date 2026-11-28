/**
 * Match server storage (#27). The server keeps its working state in memory
 * and writes every change through a MatchStore, so a restart can rebuild it:
 * the Arena's rounds (#64: each one a one-round match, numbered), their seats
 * (with hashed seat tokens), the decisions of every round played, plans
 * accepted for the round being asked, and an index of the saved records (the
 * records themselves stay JSON files). The Arena's seats and queue live in
 * memory: after a restart the round in progress resumes and agents join again.
 *
 * The interface is async and row-shaped (plain JSON-able values, no driver
 * types) so a Cloudflare backend (#26: D1, or a Durable Object's own SQLite)
 * can implement it; SqliteStore is the bun:sqlite one for local and LAN use.
 */
import { CLASSIC, CLOSE_QUARTERS, resolveRuleset, rulesetDiff, type Ruleset } from "../sim/ruleset";
import { Database } from "bun:sqlite";
import type { ControlEvent } from "../ai/runner";
import type { IdentityWish } from "../sim/identity";
import type { DecisionMeta } from "../sim/match";
import type { PlanUpdate } from "../sim/fight";
import type { Decision } from "../sim/voice";
import type { Crown, PlayedRound } from "./crown";
import { engineStamp } from "../sim/engine";
import { newOperatorId, type Operator } from "./profile";

/** The profile fields an owner sets (#113); undefined leaves a field as it is, null clears it. */
export interface ProfilePatch {
  nickname?: string | null;
  url?: string | null;
}

export type MatchStatus = "open" | "running" | "over" | "failed";

export interface RulesetPreset {
  name: string;
  ruleset: Ruleset | null;
  version: number;
  isDefault: boolean;
}

/**
 * The built-in presets (#161): their bodies come from the code. A fresh database gets them at version 1;
 * `syncBuiltinPresets` (bun run presets sync) brings a stored one to the code's body, with version + 1, when they differ.
 * `putRulesetPreset` refuses these names, so the code is their only source.
 */
export const BUILTIN_PRESETS: Readonly<Record<string, Ruleset>> = { Classic: CLASSIC, "Close Quarters": CLOSE_QUARTERS };
const isBuiltin = (name: string) => Object.keys(BUILTIN_PRESETS).some((b) => b.toLowerCase() === name.toLowerCase());

/** One built-in preset after a sync: `from` is the stored version (null: there was no row), `changes` the paths that differed. */
export interface BuiltinSync {
  name: string;
  from: number | null;
  to: number;
  changes: string[];
}

export interface MatchRow {
  ruleset: Ruleset;
  preset?: string;
  presetVersion?: number;
  id: string;
  /** the Arena round this match is (#64): 1, 2, 3, ... across the server's life */
  arenaRound: number;
  seed: number;
  /** per seat: "remote" (an agent) or "house" (a house bot) */
  kinds: string[];
  deadlineMs: number;
  status: MatchStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  /** winning seat once over */
  winner: number | null;
  /** when spectator picks locked (#35): right before round 1's decisions were broadcast */
  picksLockedAt?: number | null;
  /**
   * The engine the match was played on (#88: src/sim/engine.ts): the current stamp for a new match; "older" or an
   * older stamp once it no longer replays on this engine (kept as training data, never shown). A match without a stamp stays out of public results.
   */
  engine?: string | null;
}

export interface SeatRow {
  matchId: string;
  seat: number;
  name: string;
  /** the agent's soul.md (a fighter persona, personal data stripped) */
  soul: string;
  /** the owner whose key joined this agent */
  owner: string;
  look: IdentityWish | null;
  /** sha256 of the agent's Arena seat token (hex): the same in every round the agent plays */
  tokenHash: string;
  joinedAt: number;
  /** set when the agent left; the seat is played by the house bot from then on */
  leftAt: number | null;
  /** the first round the house bot plays for it (null: left before the start) */
  leftRound: number | null;
  /** the model the agent reported at join (shown as reported) */
  model: string;
  /** the client it joined with (#76): MCP clientInfo "name/version" or its User-Agent's first product; "" when none */
  client: string;
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
  /** the round's mid-round plan updates (#8/#9), set with the final hash; null before */
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

/**
 * Who played a round (#67): "bot-only" (house bots in every seat: kept for evaluation, never public), "warm-up" (one
 * agent and house bots) or "featured" (2 or more agents).
 */
export type RoundTier = "bot-only" | "warm-up" | "featured";

export interface RecordRow {
  matchId: string;
  /**
   * A public record: /records/<file>.json (served). A bot-only round's record: internal/<file>.json under the records
   * folder (never served).
   */
  path: string;
  tier: RoundTier;
  seed: number;
  hashes: string[];
  winner: number;
  createdAt: number;
  /** per-seat model stats for GET /api/models (src/stats/models.ts SeatEntry[] as JSON) */
  stats: string;
  /** the engine its match was played on (#88; read from the match, never written with the record row) */
  engine?: string | null;
}

/** The crown as stored (#65): the last Arena round applied to it, and the crown (null before any round was played). */
export interface CrownRow {
  round: number;
  crown: Crown | null;
}

/** An agent's longest ranked crown streak (#65: rounds with 2 or more agents) and the round it reached it. */
export interface StreakRow {
  name: string;
  owner: string;
  best: number;
  round: number;
}

/** An agent's played rounds of one tier (#65): agent seats only (house seats have no seat row). */
export interface AgentRoundsRow {
  name: string;
  owner: string;
  tier: "warm-up" | "featured";
  rounds: number;
  wins: number;
}

/** An agent's newest seat: what it last said it runs, and with which client. */
export interface LatestSeatRow {
  name: string;
  owner: string;
  model: string;
  client: string;
  /** the look it asked for at that seat (#96: its plush head on /models before it has played) */
  look: IdentityWish | null;
  lastRound: number;
}

export type MatchPatch = Partial<Pick<MatchRow, "status" | "startedAt" | "endedAt" | "error" | "winner" | "picksLockedAt" | "engine">>;
export type SeatPatch = Partial<Pick<SeatRow, "leftAt" | "leftRound">>;

export interface MatchStore {
  /**
   * The current engine's stamp (#88). Every public list and lookup (records, replays, the leaderboard's rounds and
   * streaks) keeps to matches played on it; matches from older engines stay stored for scripts and training.
   */
  readonly engine: string;
  getRulesetPreset(name: string): Promise<RulesetPreset | null>;
  defaultRulesetPreset(): Promise<RulesetPreset | null>;
  listRulesetPresets(): Promise<RulesetPreset[]>;
  putRulesetPreset(name: string, ruleset: unknown): Promise<RulesetPreset>;
  setDefaultRulesetPreset(name: string): Promise<void>;
  /** bring the built-in presets to the code's bodies (version + 1 where a body changed); `dryRun` reports only */
  syncBuiltinPresets(dryRun?: boolean): Promise<BuiltinSync[]>;
  insertMatch(m: MatchRow): Promise<void>;
  updateMatch(id: string, patch: MatchPatch): Promise<void>;
  getMatch(id: string): Promise<MatchRow | null>;
  /** newest first; `statuses` filters */
  listMatches(statuses?: MatchStatus[]): Promise<MatchRow[]>;
  /** the highest Arena round stored (0 for a fresh database) */
  lastArenaRound(): Promise<number>;
  /** the match of an Arena round, or null */
  getArenaRound(round: number): Promise<MatchRow | null>;
  insertSeat(s: SeatRow): Promise<void>;
  updateSeat(matchId: string, seat: number, patch: SeatPatch): Promise<void>;
  /** the owner of a key (sha256 hex) that is not revoked, or null */
  ownerOfKey(keyHash: string): Promise<string | null>;
  /** a new owner handle with its first key (and a new profile id, #113); false when the handle is taken */
  createOwner(handle: string, keyHash: string, profile?: ProfilePatch): Promise<boolean>;
  /** an owner's profile (#113): its stable id, nickname and URL; null when there is no such owner */
  profileOf(handle: string): Promise<{ id: string; handle: string; nickname: string | null; url: string | null } | null>;
  /** set or clear an owner's profile fields (undefined: leave as is) */
  setProfile(handle: string, patch: ProfilePatch): Promise<void>;
  /** the owners that set a nickname, with their agent names: their presence on the site */
  operators(): Promise<(Operator & { handle: string; agents: string[] })[]>;
  /** revoke one key (true when it was live) */
  revokeKey(keyHash: string): Promise<boolean>;
  /** revoke every live key of an owner; returns how many */
  revokeOwner(handle: string): Promise<number>;
  /** a new key for an existing owner (the operator's reissue after a revoke) */
  addKey(handle: string, keyHash: string): Promise<void>;
  /** owners with their live key count, newest first */
  listOwners(): Promise<{ handle: string; createdAt: number; liveKeys: number; agents: string[] }[]>;
  /** bind an agent name to an owner: the name's owner (this one, or the one it already belongs to) */
  claimAgent(name: string, owner: string): Promise<string>;
  /** the agent names bound to an owner */
  listAgents(owner: string): Promise<string[]>;
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
  /** any round's record row, bot-only ones too (the public routes refuse those) */
  getRecord(matchId: string): Promise<RecordRow | null>;
  /**
   * The public records (#67: never bot-only), newest first; `before` (ms) pages back through older ones; `tier` keeps
   * only warm-up or featured rounds.
   */
  listRecords(limit?: number, before?: number, tier?: Exclude<RoundTier, "bot-only">): Promise<RecordRow[]>;
  /** the record row of a public path (/records/<file>.json), any engine; null when no match saved it */
  recordByPath(path: string): Promise<RecordRow | null>;
  /**
   * Every record row, every tier and every engine, newest first, each with its match's engine (#88): for scripts and
   * training, never for a public page.
   */
  allRecords(): Promise<RecordRow[]>;
  /** the crown (#65) and the last Arena round applied to it */
  getCrown(): Promise<CrownRow>;
  /**
   * Save the crown after applying rounds up to `round`, and raise agents' best streaks (a lower one never replaces a
   * higher one), in one transaction.
   */
  saveCrown(c: CrownRow, streaks: StreakRow[]): Promise<void>;
  /** played Arena rounds (over, with a record) after `round`, oldest first: who won each */
  playedRounds(after: number): Promise<PlayedRound[]>;
  /** agents' best ranked crown streaks, longest first */
  listStreaks(): Promise<StreakRow[]>;
  /** per agent and tier: rounds played and won (agent seats only; bot-only rounds have none) */
  agentRounds(): Promise<AgentRoundsRow[]>;
  /** each agent's newest seat */
  latestSeats(): Promise<LatestSeatRow[]>;
  close(): Promise<void>;
}

/**
 * The schema version of SCHEMA. A database with any other version (or with tables from before the single schema) is
 * refused at startup: pre-alpha, there is no upgrade code. Bump it with any change to SCHEMA; reset with bun run db:reset.
 */
export const SCHEMA_VERSION = 9;

/** The one schema: the current model. Plain SQLite: D1 runs the same SQL. */
export const SCHEMA = `
  CREATE TABLE matches (
    id TEXT PRIMARY KEY,
    arena_round INTEGER NOT NULL UNIQUE, -- the Arena round this one-round match is (#64)
    seed INTEGER NOT NULL,
    kinds TEXT NOT NULL,              -- JSON array of 4 seat kinds: remote (an agent) or house
    deadline_ms INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','running','over','failed')),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    error TEXT,
    winner INTEGER,
    ruleset_body TEXT NOT NULL,       -- JSON Ruleset pinned at creation: later preset edits cannot affect the match
    ruleset_preset TEXT,
    ruleset_version INTEGER,
    picks_locked_at INTEGER,          -- spectator picks locked (#35)
    engine TEXT                       -- the engine stamp it was played on (#88); "older" or an older stamp: never shown
  );
  CREATE INDEX matches_status ON matches(status);
  CREATE TABLE owners (
    handle TEXT PRIMARY KEY COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    id TEXT NOT NULL DEFAULT '',      -- the operator profile's stable id (#113, op_...): a later login attaches here
    nickname TEXT,                    -- profile (#113): shown on the site, never in an agent's prompt
    url TEXT                          -- profile (#113): http(s) only
  );
  CREATE UNIQUE INDEX owners_id ON owners(id);
  CREATE TABLE owner_keys (
    key_hash TEXT PRIMARY KEY,         -- sha256 hex of the MCP key; the key itself is never stored
    owner TEXT NOT NULL COLLATE NOCASE REFERENCES owners(handle) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX owner_keys_owner ON owner_keys(owner);
  CREATE TABLE agents (
    name TEXT PRIMARY KEY COLLATE NOCASE, -- an agent name stays bound to its owner (same name, same stats)
    owner TEXT NOT NULL COLLATE NOCASE REFERENCES owners(handle) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE seats (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
    name TEXT NOT NULL,
    soul TEXT NOT NULL,               -- the agent's soul.md (personal data stripped)
    owner TEXT NOT NULL COLLATE NOCASE,
    look TEXT,                        -- JSON identity wish or NULL
    token_hash TEXT NOT NULL,         -- sha256 hex of the agent's Arena seat token (one per agent, every round); never the token
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    left_round INTEGER,
    model TEXT NOT NULL,              -- the model the agent reported at join (shown as reported)
    client TEXT NOT NULL,             -- the client it joined with (#76): MCP clientInfo name/version or User-Agent; '' if none
    opening_line TEXT,
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
    plan_updates TEXT,                -- JSON PlanUpdate[] of the played round (#8/#9), so a resume replays them
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
  CREATE TABLE control (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    event TEXT NOT NULL,              -- JSON ControlEvent (seat, mode, round, phase, tick, reason, line, fromRound)
    PRIMARY KEY (match_id, idx)
  );
  CREATE TABLE picks (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    spectator TEXT NOT NULL,          -- sha256 of the spectator cookie id; the id itself is never stored
    seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
    ip TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (match_id, spectator)
  );
  CREATE TABLE records (
    match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
    path TEXT NOT NULL,               -- /records/<file> (served) or internal/<file> (a bot-only round: never served)
    tier TEXT NOT NULL CHECK (tier IN ('bot-only','warm-up','featured')), -- who played (#67): bot-only is never public
    seed INTEGER NOT NULL,
    hashes TEXT NOT NULL,             -- JSON string[] (final hash per round)
    winner INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    stats TEXT NOT NULL               -- JSON SeatEntry[] (src/stats/models.ts) for GET /api/models
  );
  CREATE INDEX records_public ON records(tier, created_at);
  CREATE TABLE crown (                -- the Arena's crown (#65): one row
    id INTEGER PRIMARY KEY CHECK (id = 1),
    round INTEGER NOT NULL,           -- the last Arena round applied to it
    holder_kind TEXT CHECK (holder_kind IN ('agent','house')), -- NULL before any round was played
    holder_name TEXT,                 -- an agent holder
    holder_owner TEXT,
    holder_seat INTEGER,              -- a house holder: the house bot's seat
    streak INTEGER NOT NULL,          -- rounds won in a row
    ranked INTEGER NOT NULL,          -- of those, rounds with 2 or more agents
    won_round INTEGER NOT NULL
  );
  INSERT INTO crown (id, round, streak, ranked, won_round) VALUES (1, 0, 0, 0, 0);
  CREATE TABLE streaks (              -- agents' longest crown streaks, ranked rounds only (#65); house bots have none
    name TEXT PRIMARY KEY COLLATE NOCASE,
    owner TEXT NOT NULL COLLATE NOCASE,
    best INTEGER NOT NULL,
    round INTEGER NOT NULL            -- the Arena round it reached it
  );
  CREATE TABLE ruleset_presets (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    body TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    CHECK (is_default = 0 OR body IS NOT NULL)
  );
  CREATE UNIQUE INDEX one_default_ruleset ON ruleset_presets(is_default) WHERE is_default = 1;
  INSERT INTO ruleset_presets (name, body, is_default) VALUES ('Classic', '${JSON.stringify(BUILTIN_PRESETS.Classic).replaceAll("'", "''")}', 1);
  INSERT INTO ruleset_presets (name, body) VALUES ('Close Quarters', '${JSON.stringify(BUILTIN_PRESETS["Close Quarters"]).replaceAll("'", "''")}');
  INSERT INTO ruleset_presets (name) VALUES ('Sniper Alley'), ('Chaos');
`;

/** A database whose schema is not SCHEMA_VERSION: refused, never upgraded (pre-alpha). */
export class SchemaError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(`database ${path} has ${found === 0 ? "a schema from before the single schema" : `schema v${found}`}, not the current schema v${SCHEMA_VERSION}: reset the database (pre-alpha): bun run db:reset --db ${path}`);
  }
}

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(v: unknown): T => JSON.parse(v as string) as T;

const matchOf = (r: Row): MatchRow => ({
  id: r.id as string,
  arenaRound: r.arena_round as number,
  seed: r.seed as number,
  kinds: p(r.kinds),
  ruleset: resolveRuleset(p(r.ruleset_body)),
  ...(r.ruleset_preset ? { preset: r.ruleset_preset as string, presetVersion: r.ruleset_version as number } : {}),
  deadlineMs: r.deadline_ms as number,
  status: r.status as MatchStatus,
  createdAt: r.created_at as number,
  startedAt: (r.started_at as number | null) ?? null,
  endedAt: (r.ended_at as number | null) ?? null,
  error: (r.error as string | null) ?? null,
  winner: (r.winner as number | null) ?? null,
  picksLockedAt: (r.picks_locked_at as number | null) ?? null,
  engine: (r.engine as string | null) ?? null,
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
  soul: r.soul as string,
  owner: r.owner as string,
  look: r.look ? p(r.look) : null,
  tokenHash: r.token_hash as string,
  joinedAt: r.joined_at as number,
  leftAt: (r.left_at as number | null) ?? null,
  leftRound: (r.left_round as number | null) ?? null,
  model: r.model as string,
  client: r.client as string,
  openingLine: (r.opening_line as string | null) ?? null,
});

const COLS: Record<string, string> = { status: "status", startedAt: "started_at", endedAt: "ended_at", error: "error", winner: "winner", leftAt: "left_at", leftRound: "left_round", picksLockedAt: "picks_locked_at", engine: "engine" };

export class SqliteStore implements MatchStore {
  readonly db: Database;
  private engineAt: string | null;
  /** the current engine stamp, worked out on first use (the key and reset scripts never need it, nor physics) */
  get engine(): string {
    return (this.engineAt ??= engineStamp());
  }

  /**
   * `path`: a file, or ":memory:". An empty database gets SCHEMA; one with another schema throws SchemaError.
   * `engine`: the current engine stamp (default: worked out, src/sim/engine.ts).
   */
  constructor(path: string, engine?: string) {
    this.engineAt = engine ?? null;
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
      const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      const tables = (this.db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
      if (tables === 0) {
        this.db.transaction(() => {
          this.db.exec(SCHEMA);
          this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        })();
      } else if (version !== SCHEMA_VERSION) throw new SchemaError(path, version);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    } catch (e) {
      this.db.close();
      throw e;
    }
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
    if (isBuiltin(name)) throw new Error(`${name} is a built-in preset: it follows the code (bun run presets sync)`);
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
      if (!row?.body) throw new Error("the Arena's default ruleset must be a preset with settings");
      this.db.query("UPDATE ruleset_presets SET is_default = 0 WHERE is_default = 1").run();
      this.db.query("UPDATE ruleset_presets SET is_default = 1 WHERE name = ?").run(name);
    })();
  }

  async syncBuiltinPresets(dryRun = false) {
    return this.db.transaction(() => {
      const out: BuiltinSync[] = [];
      for (const [name, code] of Object.entries(BUILTIN_PRESETS)) {
        const row = this.db.query("SELECT body, version FROM ruleset_presets WHERE name = ?").get(name) as Row | null;
        const changes = row?.body ? rulesetDiff(resolveRuleset(p(row.body)), code) : ["(no settings)"];
        const from = row ? (row.version as number) : null;
        if (!changes.length) {
          out.push({ name, from, to: from!, changes });
          continue;
        }
        const to = from === null ? 1 : from + 1;
        if (!dryRun) {
          if (row) this.db.query("UPDATE ruleset_presets SET body = ?, version = ? WHERE name = ?").run(j(code), to, name);
          else this.db.query("INSERT INTO ruleset_presets (name, body) VALUES (?, ?)").run(name, j(code));
        }
        out.push({ name, from, to, changes });
      }
      return out;
    })();
  }

  async insertMatch(m: MatchRow) {
    this.db
      .query("INSERT INTO matches (id, arena_round, seed, kinds, deadline_ms, status, created_at, started_at, ended_at, error, winner, ruleset_body, ruleset_preset, ruleset_version, engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.arenaRound, m.seed, j(m.kinds), m.deadlineMs, m.status, m.createdAt, m.startedAt, m.endedAt, m.error, m.winner, j(m.ruleset), m.preset ?? null, m.presetVersion ?? null, m.engine === undefined ? this.engine : m.engine);
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
  async lastArenaRound() {
    return ((this.db.query("SELECT MAX(arena_round) AS n FROM matches").get() as { n: number | null }).n ?? 0);
  }
  async getArenaRound(round: number) {
    const r = this.db.query("SELECT * FROM matches WHERE arena_round = ?").get(round) as Row | null;
    return r ? matchOf(r) : null;
  }
  async ownerOfKey(keyHash: string) {
    const r = this.db.query("SELECT owner FROM owner_keys WHERE key_hash = ? AND revoked_at IS NULL").get(keyHash) as Row | null;
    return r ? (r.owner as string) : null;
  }
  async createOwner(handle: string, keyHash: string, profile: ProfilePatch = {}) {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM owners WHERE handle = ?").get(handle)) return false;
      const now = Date.now();
      this.db.query("INSERT INTO owners (handle, created_at, id, nickname, url) VALUES (?, ?, ?, ?, ?)").run(handle, now, newOperatorId(), profile.nickname ?? null, profile.url ?? null);
      this.db.query("INSERT INTO owner_keys (key_hash, owner, created_at) VALUES (?, ?, ?)").run(keyHash, handle, now);
      return true;
    })();
  }
  async revokeKey(keyHash: string) {
    return this.db.query("UPDATE owner_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL").run(Date.now(), keyHash).changes > 0;
  }
  async revokeOwner(handle: string) {
    return this.db.query("UPDATE owner_keys SET revoked_at = ? WHERE owner = ? AND revoked_at IS NULL").run(Date.now(), handle).changes;
  }
  async addKey(handle: string, keyHash: string) {
    const o = this.db.query("SELECT handle FROM owners WHERE handle = ?").get(handle) as Row | null;
    if (!o) throw new Error(`no owner ${handle}`);
    this.db.query("INSERT INTO owner_keys (key_hash, owner, created_at) VALUES (?, ?, ?)").run(keyHash, o.handle as string, Date.now());
  }
  async listOwners() {
    const rows = this.db.query("SELECT o.handle, o.created_at, (SELECT COUNT(*) FROM owner_keys k WHERE k.owner = o.handle AND k.revoked_at IS NULL) AS live FROM owners o ORDER BY o.created_at DESC").all() as Row[];
    return Promise.all(rows.map(async (r) => ({ handle: r.handle as string, createdAt: r.created_at as number, liveKeys: r.live as number, agents: await this.listAgents(r.handle as string) })));
  }
  async claimAgent(name: string, owner: string) {
    return this.db.transaction(() => {
      const r = this.db.query("SELECT owner FROM agents WHERE name = ?").get(name) as Row | null;
      if (r) return r.owner as string;
      const o = this.db.query("SELECT handle FROM owners WHERE handle = ?").get(owner) as Row | null;
      if (!o) throw new Error(`no owner ${owner}`);
      this.db.query("INSERT INTO agents (name, owner, created_at) VALUES (?, ?, ?)").run(name, o.handle as string, Date.now());
      return o.handle as string;
    })();
  }
  async profileOf(handle: string) {
    const r = this.db.query("SELECT handle, id, nickname, url FROM owners WHERE handle = ?").get(handle) as Row | null;
    return r ? { id: r.id as string, handle: r.handle as string, nickname: (r.nickname as string | null) ?? null, url: (r.url as string | null) ?? null } : null;
  }
  async setProfile(handle: string, patch: ProfilePatch) {
    if (patch.nickname !== undefined) this.db.query("UPDATE owners SET nickname = ? WHERE handle = ?").run(patch.nickname, handle);
    if (patch.url !== undefined) this.db.query("UPDATE owners SET url = ? WHERE handle = ?").run(patch.url, handle);
  }
  async operators() {
    const rows = this.db.query("SELECT o.handle, o.id, o.nickname, o.url, a.name FROM owners o LEFT JOIN agents a ON a.owner = o.handle WHERE o.nickname IS NOT NULL ORDER BY o.handle, a.created_at").all() as Row[];
    const by = new Map<string, Operator & { handle: string; agents: string[] }>();
    for (const r of rows) {
      const k = (r.handle as string).toLowerCase();
      const o = by.get(k) ?? { handle: r.handle as string, id: r.id as string, nickname: r.nickname as string, url: (r.url as string | null) ?? null, agents: [] };
      if (r.name) o.agents.push(r.name as string);
      by.set(k, o);
    }
    return [...by.values()];
  }
  async listAgents(owner: string) {
    return (this.db.query("SELECT name FROM agents WHERE owner = ? ORDER BY created_at").all(owner) as Row[]).map((r) => r.name as string);
  }
  async insertSeat(s: SeatRow) {
    this.db
      .query("INSERT INTO seats (match_id, seat, name, soul, owner, look, token_hash, joined_at, left_at, left_round, model, client, opening_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.matchId, s.seat, s.name, s.soul, s.owner, s.look ? j(s.look) : null, s.tokenHash, s.joinedAt, s.leftAt, s.leftRound, s.model, s.client, s.openingLine ?? null);
  }
  async updateSeat(matchId: string, seat: number, patch: SeatPatch) {
    this.patch("seats", "match_id = ? AND seat = ?", [matchId, seat], patch);
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
    this.db.query("INSERT OR REPLACE INTO records (match_id, path, tier, seed, hashes, winner, created_at, stats) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(r.matchId, r.path, r.tier, r.seed, j(r.hashes), r.winner, r.createdAt, r.stats);
  }
  async getRecord(matchId: string) {
    const r = this.db.query("SELECT r.*, m.engine FROM records r JOIN matches m ON m.id = r.match_id WHERE r.match_id = ?").get(matchId) as Row | null;
    return r ? recordOf(r) : null;
  }
  async listRecords(limit = 100, before?: number, tier?: Exclude<RoundTier, "bot-only">) {
    const tiers = tier ? [tier] : ["warm-up", "featured"];
    // only rounds played on this engine (#88): older ones are training data, never listed
    const where = `r.tier IN (${tiers.map(() => "?").join(",")}) AND m.engine = ?${before !== undefined ? " AND r.created_at < ?" : ""}`;
    const args = [...tiers, this.engine, ...(before !== undefined ? [before] : []), limit];
    return (this.db.query(`SELECT r.*, m.engine FROM records r JOIN matches m ON m.id = r.match_id WHERE ${where} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`).all(...(args as never[])) as Row[]).map(recordOf);
  }
  async recordByPath(path: string) {
    const r = this.db.query("SELECT r.*, m.engine FROM records r JOIN matches m ON m.id = r.match_id WHERE r.path = ?").get(path) as Row | null;
    return r ? recordOf(r) : null;
  }
  async allRecords() {
    return (this.db.query("SELECT r.*, m.engine FROM records r JOIN matches m ON m.id = r.match_id ORDER BY r.created_at DESC, r.rowid DESC").all() as Row[]).map(recordOf);
  }
  async getCrown() {
    const r = this.db.query("SELECT * FROM crown WHERE id = 1").get() as Row;
    const holder = r.holder_kind === "agent" ? { kind: "agent" as const, name: r.holder_name as string, owner: r.holder_owner as string } : r.holder_kind === "house" ? { kind: "house" as const, seat: r.holder_seat as number } : null;
    return { round: r.round as number, crown: holder ? { holder, streak: r.streak as number, ranked: r.ranked as number, wonRound: r.won_round as number } : null };
  }
  async saveCrown(c: CrownRow, streaks: StreakRow[]) {
    const h = c.crown?.holder;
    this.db.transaction(() => {
      this.db
        .query("UPDATE crown SET round = ?, holder_kind = ?, holder_name = ?, holder_owner = ?, holder_seat = ?, streak = ?, ranked = ?, won_round = ? WHERE id = 1")
        .run(c.round, h?.kind ?? null, h?.kind === "agent" ? h.name : null, h?.kind === "agent" ? h.owner : null, h?.kind === "house" ? h.seat : null, c.crown?.streak ?? 0, c.crown?.ranked ?? 0, c.crown?.wonRound ?? 0);
      for (const s of streaks)
        this.db.query("INSERT INTO streaks (name, owner, best, round) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, best = excluded.best, round = excluded.round WHERE excluded.best > streaks.best").run(s.name, s.owner, s.best, s.round);
    })();
  }
  async playedRounds(after: number) {
    const rows = this.db
      .query("SELECT m.arena_round, r.tier, r.winner, s.name, s.owner FROM matches m JOIN records r ON r.match_id = m.id LEFT JOIN seats s ON s.match_id = m.id AND s.seat = r.winner WHERE m.status = 'over' AND m.arena_round > ? ORDER BY m.arena_round")
      .all(after) as Row[];
    return rows.map((r) => ({ arenaRound: r.arena_round as number, tier: r.tier as RoundTier, winner: r.winner as number, winnerName: (r.name as string | null) ?? null, winnerOwner: (r.owner as string | null) ?? null }));
  }
  async listStreaks() {
    // a streak reached in a round of an older engine is not shown (#88); it stays stored
    return (this.db.query("SELECT s.* FROM streaks s JOIN matches m ON m.arena_round = s.round WHERE m.engine = ? ORDER BY s.best DESC, s.round").all(this.engine) as Row[]).map((r) => ({ name: r.name as string, owner: r.owner as string, best: r.best as number, round: r.round as number }));
  }
  async agentRounds() {
    const rows = this.db
      .query("SELECT MIN(s.name) AS name, MIN(s.owner) AS owner, r.tier, COUNT(*) AS rounds, SUM(r.winner = s.seat) AS wins FROM seats s JOIN records r ON r.match_id = s.match_id JOIN matches m ON m.id = s.match_id WHERE r.tier != 'bot-only' AND m.engine = ? GROUP BY s.name COLLATE NOCASE, r.tier")
      .all(this.engine) as Row[];
    return rows.map((r) => ({ name: r.name as string, owner: r.owner as string, tier: r.tier as "warm-up" | "featured", rounds: r.rounds as number, wins: r.wins as number }));
  }
  async latestSeats() {
    // SQLite: the bare columns come from the row with the MAX (each agent's newest seat)
    const rows = this.db.query("SELECT s.name, s.owner, s.model, s.client, s.look, MAX(m.arena_round) AS last FROM seats s JOIN matches m ON m.id = s.match_id GROUP BY s.name COLLATE NOCASE").all() as Row[];
    return rows.map((r) => ({ name: r.name as string, owner: r.owner as string, model: r.model as string, client: r.client as string, look: r.look ? p<IdentityWish>(r.look) : null, lastRound: r.last as number }));
  }
  async close() {
    this.db.close();
  }
}

const recordOf = (r: Row): RecordRow => ({
  matchId: r.match_id as string,
  path: r.path as string,
  tier: r.tier as RoundTier,
  seed: r.seed as number,
  hashes: p<string[]>(r.hashes),
  winner: r.winner as number,
  createdAt: r.created_at as number,
  stats: r.stats as string,
  engine: (r.engine as string | null) ?? null,
});
