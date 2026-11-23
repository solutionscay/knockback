/**
 * The /models page (#96): the board built from rounds (pure), its sort, its route, and GET /api/models/board on an
 * in-process Arena: empty (house bots only), then with agent rounds; rounds of an older engine never count (#88, #91).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPhysics } from "../src/sim";
import { modelBoard, type BoardRound, type BoardSeat, type ModelBoard } from "../src/stats/model-board";
import { sortRows } from "../src/site/models";
import { withModel } from "../src/site/replays";
import { route, SITE_PATHS } from "../src/site/route";
import type { ReplayInfo } from "../src/site/data";
import type { SqliteStore } from "../src/server/store";
import { arenaServer, call, enter, round } from "./helpers/arena";

const seat = (label: string, o: Partial<BoardSeat> = {}): BoardSeat => ({ label, fighter: "F", identity: null, weapon: "bat", build: "", kos: 0, damage: 0, died: true, ...o });
const rd = (match: string, at: number, winner: number, seats: BoardSeat[], tier: BoardRound["tier"] = "warm-up"): BoardRound => ({ match, createdAt: new Date(Date.UTC(2026, 10, 1, 0, at)).toISOString(), tier, winner, seats });

describe("the models board (pure)", () => {
  // newest first, as the server reads them
  const rounds = [
    rd("m3", 3, 0, [seat("remote/Ann@claude-opus-5-5", { kos: 2, damage: 90, died: false, weapon: "rocket", build: "heavy" }), seat("remote/Ben@gpt-6-luna", { kos: 1, damage: 40 }), seat("house", { damage: 10 }), seat("house")], "featured"),
    rd("m2", 2, 2, [seat("remote/Ann@Claude Opus 5.5", { damage: 30, weapon: "rocket", build: "heavy" }), seat("house"), seat("house", { kos: 1, damage: 50, died: false, weapon: "gun" }), seat("house")]),
    rd("m1", 1, 1, [seat("remote/Cy@claude-opus-5-5", { kos: 1, damage: 20, weapon: "bat" }), seat("house", { kos: 1, died: false }), seat("house"), seat("stub/x")]),
  ];
  const b = modelBoard(rounds, [{ name: "ann", best: 3 }]);

  test("one row per model however it was spelled; house bots and test providers left out", () => {
    expect(b.rounds).toBe(3);
    expect(b.rows.map((r) => [r.key, r.rounds, r.wins])).toEqual([
      ["self:claude-opus-5-5", 3, 1],
      ["self:gpt-6-luna", 1, 0],
    ]);
  });

  test("stats: K/D, damage per round, favourites, streak, agents and form", () => {
    const c = b.rows[0]!;
    expect([c.kos, c.deaths, c.kd, c.damagePerRound]).toEqual([3, 2, 1.5, 47]);
    expect([c.weapon, c.build]).toEqual(["rocket", "heavy"]);
    expect(c.bestStreak).toBe(3);
    expect(c.agents.map((a) => [a.name, a.rounds])).toEqual([
      ["Ann", 2],
      ["Cy", 1],
    ]);
    expect(c.form).toEqual([
      { match: "m3", won: true },
      { match: "m2", won: false },
      { match: "m1", won: false },
    ]);
    expect(c.lastAt).toBe(rounds[0]!.createdAt);
  });

  test("no agent round: no rows", () => {
    const houseOnly = [rd("h1", 1, 2, [seat("house"), seat("house"), seat("house", { kos: 3, died: false }), seat("house")], "bot-only")];
    expect(modelBoard(houseOnly, [])).toEqual({ rounds: 0, rows: [] });
    expect(modelBoard([], [])).toEqual({ rounds: 0, rows: [] });
  });

  test("sorting: numbers best first, names A to Z, ties by rounds", () => {
    const [a, g] = b.rows;
    expect(sortRows(b.rows, "damagePerRound").map((r) => r.key)).toEqual([a!.key, g!.key]);
    expect(sortRows(b.rows, "name").map((r) => r.name)).toEqual(["CLAUDE OPUS 5.5", "GPT-6 LUNA"]);
    expect(sortRows(b.rows, "kd").map((r) => r.key)).toEqual([a!.key, g!.key]);
  });
});

describe("the site serves /models (#96)", () => {
  test("route and paths", () => {
    expect(route("/models")).toEqual({ page: "models", nav: "models" });
    expect(route("/models/")).toEqual({ page: "models", nav: "models" });
    expect(SITE_PATHS).toContain("/models");
  });
  test("replays of one model", () => {
    const r = (match: string, labels: string[]) => ({ match, labels }) as ReplayInfo;
    const rs = [r("a", ["remote/Ann@claude-opus-5-5", "house", "house", "house"]), r("b", ["remote/Ben@gpt-6-luna", "house", "house", "house"])];
    expect(withModel(rs, "self:claude-opus-5-5").map((x) => x.match)).toEqual(["a"]);
    expect(withModel(rs, "").length).toBe(2);
  });
});

const outDir = mkdtempSync(join(tmpdir(), "kb-models-"));
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("GET /api/models/board", () => {
  test("empty, then with agent rounds; older-engine rounds never count", async () => {
    const api = arenaServer(join(outDir, "a"));
    const board = async () => {
      const { modelsBoardOf } = await import("../src/server/site");
      return (await modelsBoardOf(api, true)) as ModelBoard;
    };
    expect((await call(api, "GET", "/api/models/board")).status).toBe(200);
    expect(await api.handle(new Request("http://kb.test/models"))).toBeNull(); // not the API's page any more: the site serves it

    await round(api); // house bots only
    const ann = await enter(api, "Ann", "ann-owner", { model: "claude-opus-5-5" });
    let b = await board();
    expect(b).toEqual({ rounds: 0, rows: [] });

    const warm = await round(api, [ann]);
    b = await board();
    expect(b.rounds).toBe(1);
    expect(b.rows.map((r) => [r.key, r.rounds, r.agents.map((a) => a.name), r.form[0]!.match])).toEqual([["self:claude-opus-5-5", 1, ["Ann"], warm.id]]);
    expect(b.rows[0]!.weapon).toBe("rocket");
    expect(Object.keys(b).sort()).toEqual(["rounds", "rows"]);

    // that round is now from an older engine: not counted
    (api.store as SqliteStore).db.query("UPDATE matches SET engine = ? WHERE id = ?").run("e-0ld0ld00", warm.id);
    b = await board();
    expect(b).toEqual({ rounds: 0, rows: [] });
  });
});
