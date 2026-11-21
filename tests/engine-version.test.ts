import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rescoreRecord } from "../src/ai/run";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { CLASSIC } from "../src/sim/ruleset";
import { ENGINE_VERSION, initPhysics, isCurrentEngine, Match, OtherEngineError, replayMatch, type MatchRecord } from "../src/sim";
import { sanitizeRecord } from "../src/viewer/sanitize";

beforeAll(async () => {
  await initPhysics();
});

const fresh = (seed: number): MatchRecord => {
  const m = new Match(seed);
  m.playToEnd();
  return JSON.parse(JSON.stringify(m.record));
};

describe("engine version", () => {
  test("new records carry this engine's version; the one check accepts only that exact number", () => {
    expect(ENGINE_VERSION).toBeGreaterThanOrEqual(1);
    expect(new Match(4).record.engine).toBe(ENGINE_VERSION);
    expect(isCurrentEngine({ engine: ENGINE_VERSION })).toBe(true);
    for (const x of [{}, { engine: String(ENGINE_VERSION) }, { engine: ENGINE_VERSION - 1 }, { engine: ENGINE_VERSION + 1 }, null, "x"]) expect(isCurrentEngine(x)).toBe(false);
  });

  test("a current record replays to its recorded hashes", () => {
    const rec = fresh(7);
    expect(replayMatch(rec).record.rounds.map((r) => r.fight.finalHash)).toEqual(rec.rounds.map((r) => r.fight.finalHash));
    expect(() => rescoreRecord(rec, ["house", "house", "house", "house"])).not.toThrow();
  });

  test("a record of another engine version is not loaded: refused before any simulation, everywhere", () => {
    const rec = fresh(9);
    for (const engine of [undefined, 0, ENGINE_VERSION - 1, ENGINE_VERSION + 1]) {
      const other = { ...rec, engine } as unknown as MatchRecord;
      const t0 = performance.now();
      expect(() => replayMatch(other)).toThrow(OtherEngineError);
      expect(() => new Match(other.seed, { recorded: other })).toThrow(OtherEngineError);
      expect(performance.now() - t0).toBeLessThan(1000); // refused up front (a full replay takes seconds)
      expect(() => rescoreRecord(other, ["house", "house", "house", "house"])).toThrow(OtherEngineError);
      expect(sanitizeRecord(other)).toBeNull();
    }
    expect(() => replayMatch({ ...rec, engine: 0 })).toThrow(`this is engine v${ENGINE_VERSION}: only records of the current engine are loaded`);
  });
});

describe("server: only current-engine records are listed", () => {
  test("GET /api/records leaves other engine versions out", async () => {
    const store = new SqliteStore(":memory:");
    const s = new MatchServer({ outDir: mkdtempSync(join(tmpdir(), "kb-engine-")), store });
    const row = { kinds: ["house", "house", "house", "house"], deadlineMs: 1000, fillAfterMs: 1000, status: "over" as const, createdAt: 1, startedAt: 1, endedAt: 2, creator: null, error: null, winner: 0, ruleset: CLASSIC };
    await store.insertMatch({ ...row, id: "m1", seed: 1 });
    await store.insertMatch({ ...row, id: "m2", seed: 2 });
    await store.insertRecord({ matchId: "m1", path: "/records/other.json", seed: 1, hashes: ["a"], winner: 0, createdAt: 1, engine: ENGINE_VERSION - 1, stats: "[]" });
    await store.insertRecord({ matchId: "m2", path: "/records/new.json", seed: 2, hashes: ["b"], winner: 0, createdAt: 2, engine: ENGINE_VERSION, stats: "[]" });
    const res = (await s.handle(new Request("http://kb.test/api/records"), "1.1.1.1"))!;
    const body = (await res.json()) as { engine: number; records: { path: string; engine: number }[] };
    expect(body.engine).toBe(ENGINE_VERSION);
    expect(body.records.map((r) => r.path)).toEqual(["/records/new.json"]);
    expect(await store.getRecord("m1")).toBeNull();
    expect((await s.handle(new Request("http://kb.test/api/replays/m_00000001"), "1.1.1.1"))!.status).toBe(404);
    await store.close();
  });
});
