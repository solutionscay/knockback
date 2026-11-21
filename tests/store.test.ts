import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CLASSIC, CLOSE_QUARTERS } from "../src/sim/ruleset";
import { ENGINE_VERSION } from "../src/sim/engine-version";
import { SCHEMA_VERSION, SchemaError, SqliteStore, type MatchRow, type SeatRow } from "../src/server/store";
import { selectRuleset } from "../src/server/match-rulesets";

const file = () => join(mkdtempSync(join(tmpdir(), "kb-store-")), "server.db");
const match = (id: string, over: Partial<MatchRow> = {}): MatchRow => ({
  id, seed: 42, kinds: ["remote", "remote", "house", "house"], deadlineMs: 20_000, fillAfterMs: 60_000, status: "open",
  createdAt: 1000, startedAt: null, endedAt: null, creator: null, error: null, winner: null, ruleset: CLASSIC, ...over,
});
const seat = (matchId: string, n: number, over: Partial<SeatRow> = {}): SeatRow => ({
  matchId, seat: n, name: `A${n}`, persona: "soul text", look: n ? null : { color: 0xff8800 }, tokenHash: `h${matchId}${n}`, joinedAt: 2000, leftAt: null, leftRound: null, ...over,
});

describe("SqliteStore", () => {
  test("a fresh file gets the one schema and the built-in presets; a reopened file keeps its data", async () => {
    const f = file();
    const a = new SqliteStore(f);
    expect((a.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(await a.defaultRulesetPreset()).toMatchObject({ name: "Classic", version: 1, ruleset: CLASSIC });
    expect((await a.getRulesetPreset("Close Quarters"))!).toMatchObject({ version: 1, ruleset: CLOSE_QUARTERS });
    expect((await a.listRulesetPresets()).map((x) => x.name)).toEqual(["Classic", "Chaos", "Close Quarters", "Sniper Alley"]);
    await a.insertMatch(match("m1"));
    await a.close();
    const b = new SqliteStore(f);
    expect((await b.getMatch("m1"))!.kinds).toEqual(["remote", "remote", "house", "house"]);
    await b.close();
  });

  test("a database with an old or unknown schema is refused with the reset command; nothing is changed", async () => {
    const legacy = file();
    const db = new Database(legacy);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES (10, 1);");
    db.close();
    expect(() => new SqliteStore(legacy)).toThrow(SchemaError);
    expect(() => new SqliteStore(legacy)).toThrow(`reset the database (pre-alpha): bun run db:reset --db ${legacy}`);
    const after = new Database(legacy);
    expect((after.query("SELECT version FROM schema_migrations").get() as { version: number }).version).toBe(10);
    after.close();
    const future = file();
    new SqliteStore(future).db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => new SqliteStore(future)).toThrow(`schema v${SCHEMA_VERSION + 1}, not the current schema v${SCHEMA_VERSION}`);
  });

  test("without a stored default, a match gets Classic", async () => {
    const s = new SqliteStore(":memory:");
    s.db.exec("UPDATE ruleset_presets SET is_default = 0");
    expect(await selectRuleset(s)).toEqual({ ruleset: CLASSIC, preset: "Classic", presetVersion: 1 });
    await s.close();
  });

  test("matches, seats, rounds, plans and records round-trip", async () => {
    const s = new SqliteStore(":memory:");
    await s.insertMatch(match("m1"));
    await s.insertMatch(match("m2", { createdAt: 5000, status: "running", creator: "1.2.3.4" }));
    await s.updateMatch("m1", { status: "over", winner: 2, endedAt: 9000 });
    expect((await s.getMatch("m1"))!).toMatchObject({ status: "over", winner: 2, endedAt: 9000 });
    expect((await s.listMatches()).map((m) => m.id)).toEqual(["m2", "m1"]);
    expect((await s.listMatches(["running"])).map((m) => m.id)).toEqual(["m2"]);
    expect(await s.getMatch("nope")).toBeNull();

    await s.insertSeat(seat("m2", 0));
    await s.insertSeat(seat("m2", 1));
    await s.updateSeat("m2", 1, { leftAt: 7000, leftRound: 2 });
    const seats = await s.listSeats("m2");
    expect(seats[0]!.look).toEqual({ color: 0xff8800 });
    expect(seats[1]).toMatchObject({ leftAt: 7000, leftRound: 2 });
    await s.deleteSeat("m2", 0);
    expect((await s.listSeats("m2")).map((x) => x.seat)).toEqual([1]);

    const decisions = [0, 1, 2, 3].map((i) => ({ line: `l${i}`, strategy: { target: "nearest" as const, stance: "rush" as const, weapons: ["bat" as const], retaliate: "turn" as const, line: `l${i}` } }));
    const meta = [0, 1, 2, 3].map(() => ({ provider: "house", ms: 0, outcome: "house" as const }));
    await s.insertRound({ matchId: "m2", round: 1, decisions, meta, prompts: ["p", "p", "p", "p"], raw: [null, "{}", null, null], finalHash: null });
    await s.setRoundHash("m2", 1, "abcd1234");
    const rounds = await s.listRounds("m2");
    expect(rounds[0]).toMatchObject({ round: 1, finalHash: "abcd1234", raw: [null, "{}", null, null] });
    expect(rounds[0]!.decisions).toEqual(decisions);

    await s.insertPlan({ matchId: "m2", round: 2, seat: 1, raw: '{"a":1}', at: 1 });
    expect((await s.getPlan("m2", 2, 1))!.raw).toBe('{"a":1}');
    expect(await s.getPlan("m2", 2, 0)).toBeNull();

    await s.insertRecord({ matchId: "m1", path: "/records/x.json", seed: 42, hashes: ["a", "b"], winner: 2, createdAt: 9, engine: ENGINE_VERSION, stats: "[]" });
    expect((await s.listRecords())[0]).toMatchObject({ path: "/records/x.json", hashes: ["a", "b"], engine: ENGINE_VERSION, stats: "[]" });
    await s.close();
  });

  test("a token hash is unique, seats need their match, and a match's rows go with it", async () => {
    const s = new SqliteStore(":memory:");
    await s.insertMatch(match("m1"));
    await s.insertSeat(seat("m1", 0, { tokenHash: "same" }));
    expect(s.insertSeat(seat("m1", 1, { tokenHash: "same" }))).rejects.toThrow();
    expect(s.insertSeat(seat("ghost", 0))).rejects.toThrow();
    expect(s.insertMatch(match("m2", { status: "paused" as never }))).rejects.toThrow();
    s.db.query("DELETE FROM matches WHERE id = 'm1'").run();
    expect(await s.listSeats("m1")).toEqual([]);
    await s.close();
  });
});
