import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SqliteStore, type MatchRow, type SeatRow } from "../src/server/store";

const file = () => join(mkdtempSync(join(tmpdir(), "kb-store-")), "server.db");
const match = (id: string, over: Partial<MatchRow> = {}): MatchRow => ({
  id, seed: 42, kinds: ["remote", "remote", "house", "house"], deadlineMs: 20_000, fillAfterMs: 60_000, status: "open",
  createdAt: 1000, startedAt: null, endedAt: null, creator: null, error: null, winner: null, ...over,
});
const seat = (matchId: string, n: number, over: Partial<SeatRow> = {}): SeatRow => ({
  matchId, seat: n, name: `A${n}`, persona: "soul text", look: n ? null : { color: 0xff8800 }, tokenHash: `h${matchId}${n}`, joinedAt: 2000, leftAt: null, leftRound: null, ...over,
});

describe("SqliteStore", () => {
  test("migrations run once; a reopened file keeps its data and version", async () => {
    const f = file();
    const a = new SqliteStore(f);
    await a.insertMatch(match("m1"));
    await a.close();
    const b = new SqliteStore(f);
    expect(b.migrate()).toBe(MIGRATIONS.length);
    expect((b.db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(MIGRATIONS.length);
    expect((await b.getMatch("m1"))!.kinds).toEqual(["remote", "remote", "house", "house"]);
    await b.close();
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

    await s.insertRecord({ matchId: "m1", path: "/records/x.json", seed: 42, hashes: ["a", "b"], winner: 2, createdAt: 9, engine: 1 });
    expect((await s.listRecords())[0]).toMatchObject({ path: "/records/x.json", hashes: ["a", "b"], engine: 1 });
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
