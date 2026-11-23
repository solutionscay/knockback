/**
 * The /models page (#96): the board built from rounds (pure), its sort, its route, and GET /api/models/board on an
 * in-process Arena: empty (house bots only: no rows, the agents that joined), then with
 * agent rounds; rounds of an older engine never count (#88).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPhysics } from "../src/sim";
import { modelBoard, type BoardRound, type BoardSeat, type ModelBoard } from "../src/stats/model-board";
import { filterChoices, withFilter, withModel } from "../src/site/replays";
import { REDIRECTS, route, SITE_PATHS } from "../src/site/route";
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
  const b = modelBoard(rounds, [{ name: "ann", best: 3 }], [
    { name: "Ann", model: "claude-opus-5-5", look: null, live: true },
    { name: "Dee", model: "gemini-3-pro", look: null, live: false },
    { name: "Eve", model: "gemini 3 pro", look: null, live: true },
  ]);

  test("one row per model however it was spelled; test providers left out", () => {
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

  test("house bots are not a model: no row, no baseline (#106)", () => {
    expect(b.rows.some((r) => r.key === "house")).toBe(false);
    expect(b).not.toHaveProperty("house");
    expect(b).not.toHaveProperty("houseFrom");
  });

  test("connected: models that joined without a round here, their agents grouped", () => {
    expect(b.connected.map((c) => [c.key, c.agents.map((a) => [a.name, a.live])])).toEqual([
      [
        "self:gemini-3-pro",
        [
          ["Dee", false],
          ["Eve", true],
        ],
      ],
    ]);
  });

  test("no agent round: no rows, only the models that joined; house-bot rounds never count", () => {
    const houseOnly = [rd("h1", 1, 2, [seat("house"), seat("house"), seat("house", { kos: 3, died: false }), seat("house")], "bot-only")];
    const e = modelBoard(houseOnly, [], [{ name: "Ann", model: "claude-opus-5-5", look: null, live: false }]);
    expect(e.rows).toEqual([]);
    expect(e.rounds).toBe(0);
    expect(e.connected.map((c) => c.key)).toEqual(["self:claude-opus-5-5"]);
    expect(modelBoard([], [], [])).toEqual({ rounds: 0, rows: [], connected: [] });
  });
});

describe("the site: four pages (#106)", () => {
  test("routes, and the old paths redirect", () => {
    expect(route("/models")).toEqual({ page: "redirect", nav: "", to: "/leaderboard?view=models" });
    expect(route("/models/")).toEqual({ page: "redirect", nav: "", to: "/leaderboard?view=models" });
    expect(route("/watch")).toEqual({ page: "redirect", nav: "", to: "/lobby" });
    expect(route("/lobby", "#join")).toEqual({ page: "redirect", nav: "", to: "/connect" });
    expect(route("/watch/m_0123abcd")).toEqual({ page: "lobby", nav: "lobby", id: "m_0123abcd" });
    expect(route("/")).toEqual({ page: "lobby", nav: "lobby", id: null });
    expect(route("/connect")).toEqual({ page: "connect", nav: "connect" });
    expect(route("/agent/Brixel")).toEqual({ page: "agent", nav: "leaderboard", name: "Brixel" });
    expect(SITE_PATHS).not.toContain("/models");
    expect(SITE_PATHS).toContain("/connect");
    for (const p of Object.keys(REDIRECTS)) expect(SITE_PATHS as readonly string[]).not.toContain(p);
  });
  test("replays of one model", () => {
    const r = (match: string, labels: string[]) => ({ match, labels }) as ReplayInfo;
    const rs = [r("a", ["remote/Ann@claude-opus-5-5", "house", "house", "house"]), r("b", ["remote/Ben@gpt-6-luna", "house", "house", "house"])];
    expect(withModel(rs, "self:claude-opus-5-5").map((x) => x.match)).toEqual(["a"]);
    expect(withModel(rs, "").length).toBe(2);
  });
  test("replays of one agent; the filter's choices", () => {
    const r = (match: string, labels: string[]) => ({ match, labels }) as ReplayInfo;
    const rs = [r("a", ["remote/Ann@claude-opus-5-5", "house", "house", "house"]), r("b", ["remote/Ben@gpt-6-luna", "remote/Ann@claude-opus-5-5", "house", "house"])];
    expect(withFilter(rs, { model: "", agent: "ann" }).map((x) => x.match)).toEqual(["a", "b"]);
    expect(withFilter(rs, { model: "", agent: "Ben" }).map((x) => x.match)).toEqual(["b"]);
    const c = filterChoices(rs);
    expect(c.agents).toEqual(["Ann", "Ben"]);
    expect(c.models.map(([, n]) => n)).toEqual(["CLAUDE OPUS 5.5", "GPT-6 LUNA"]);
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
    expect(b.rounds).toBe(0);
    expect(b.rows).toEqual([]);
    expect(b.connected.map((c) => [c.key, c.agents.map((a) => [a.name, a.live])])).toEqual([["self:claude-opus-5-5", [["Ann", true]]]]);

    const warm = await round(api, [ann]);
    b = await board();
    expect(b.rounds).toBe(1);
    expect(b.rows.map((r) => [r.key, r.rounds, r.agents.map((a) => a.name), r.form[0]!.match])).toEqual([["self:claude-opus-5-5", 1, ["Ann"], warm.id]]);
    expect(b.rows[0]!.weapon).toBe("rocket");
    expect(b.connected).toEqual([]);

    // that round is now from an older engine: not counted
    (api.store as SqliteStore).db.query("UPDATE matches SET engine = ? WHERE id = ?").run("e-0ld0ld00", warm.id);
    b = await board();
    expect([b.rounds, b.rows.length]).toEqual([0, 0]);
    expect(b.connected.map((c) => c.key)).toEqual(["self:claude-opus-5-5"]);
  });
});
