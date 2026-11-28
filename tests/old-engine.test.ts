/**
 * Contract: rounds from an older engine (#88). A sim change leaves older records unreplayable; those rounds are kept
 * (the database rows and the record files: training data) but never shown and never re-simulated. They are left out
 * of every public list, their direct URLs are a clean 404, scripts still list them and tell them apart, and an
 * in-flight round that no longer replays at startup is set aside quietly for a fresh one.
 *
 * "Older" is made here the way it happens: a stored hash this engine does not reach (as after a sim change), or a
 * record without a stamp from before stamps. The server runs in-process; rounds run at fast pace, the agent's turns
 * time out at once (the house autopilot plays: the rounds are public warm-ups all the same).
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";
import { engineStamp, OLDER_ENGINE, recordEngine } from "../src/sim/engine";

const dir = mkdtempSync(join(tmpdir(), "kb-old-engine-"));
const outDir = join(dir, "records");
const dbPath = join(dir, "match-server.db");
let store: SqliteStore;
let api: MatchServer;
const logs: string[] = [];
beforeAll(async () => {
  await initPhysics();
  store = new SqliteStore(dbPath);
  api = new MatchServer({ outDir, store, pace: "fast", arena: { deadlineMs: 1, missLimit: 99 }, log: (s) => logs.push(s) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SOUL = "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down.";
let ipN = 0;
async function call(server: MatchServer, method: string, path: string, opts: { auth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  const res = (await server.handle(new Request(`http://kb.test${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }), `10.8.0.${++ipN}`))!;
  return { status: res.status, data: (await res.json().catch(() => null)) as any, text: res.status };
}

/** What the database holds for a match, read straight from SQLite (the shape scripts see). */
const raw = (sql: string, ...args: (string | number)[]) => store.db.query(sql).get(...args) as Record<string, unknown> | null;

/** Turn a played round into one from an older engine: its stored hash is one this engine never reaches. */
function makeOlder(matchId: string, opts: { unstamped?: boolean; stamp?: string } = {}) {
  const rec = raw("SELECT path FROM records WHERE match_id = ?", matchId)!;
  const file = join(outDir, (rec.path as string).slice("/records/".length));
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.rounds[0].fight.finalHash = "0ld0ld00";
  if (opts.unstamped) delete json.engine;
  if (opts.stamp) json.engine = opts.stamp;
  writeFileSync(file, JSON.stringify(json));
  store.db.query("UPDATE rounds SET final_hash = '0ld0ld00' WHERE match_id = ?").run(matchId);
  store.db.query("UPDATE records SET hashes = '[\"0ld0ld00\"]' WHERE match_id = ?").run(matchId);
  return file;
}

describe("rounds from an older engine (#88)", () => {
  const ids: Record<"old" | "unstampedOld" | "unstampedNew" | "keep" | "late", string> = { old: "", unstampedOld: "", unstampedNew: "", keep: "", late: "" };
  const paths: Record<string, string> = {};

  test("new rounds and their records carry this engine's stamp", async () => {
    const key = (await call(api, "POST", "/api/keys", { body: { owner: "Ada" } })).data.key as string;
    expect((await call(api, "POST", "/api/queue", { auth: key, body: { name: "Basher", model: "claude-opus-5-5", soul: SOUL } })).status).toBe(201);
    for (const k of ["old", "unstampedOld", "unstampedNew", "keep", "late"] as const) {
      const m = await api.arena.playRound();
      expect(m.status).toBe("over");
      expect(m.tier).toBe("warm-up");
      ids[k] = m.id;
      paths[k] = raw("SELECT path FROM records WHERE match_id = ?", m.id)!.path as string;
    }
    const stamp = engineStamp();
    expect(stamp).toMatch(/^e-[0-9a-f]{8}$/);
    expect(raw("SELECT engine FROM matches WHERE id = ?", ids.keep)!.engine).toBe(stamp);
    expect(JSON.parse(readFileSync(join(outDir, paths.keep!.slice("/records/".length)), "utf8")).engine).toBe(stamp);
  });

  test("the server excludes an unstamped database row even if its file still replays", async () => {
    makeOlder(ids.old, { stamp: "e-0ld0ld00" });
    store.db.query("UPDATE matches SET engine = ? WHERE id = ?").run("e-0ld0ld00", ids.old); // stamped by an older engine
    makeOlder(ids.unstampedOld, { unstamped: true });
    // a record from before stamps that still replays on this engine
    const f = join(outDir, paths.unstampedNew!.slice("/records/".length));
    const j = JSON.parse(readFileSync(f, "utf8"));
    delete j.engine;
    writeFileSync(f, JSON.stringify(j));
    store.db.query("UPDATE matches SET engine = NULL WHERE id IN (?, ?)").run(ids.unstampedOld, ids.unstampedNew);

    expect(await store.getRecord(ids.unstampedNew)).toMatchObject({ engine: null });
    expect((await call(new MatchServer({ outDir, store }), "GET", `/api/replays/${ids.unstampedNew}`)).status).toBe(404);
  });

  test("an older round is left out of every public list", async () => {
    // a restart: nothing in memory, every round comes from storage (as on the LAN after a deploy)
    const fresh = new MatchServer({ outDir, store, pace: "fast" });
    const hidden = [ids.old, ids.unstampedOld, ids.unstampedNew];
    const shown = [ids.keep, ids.late];

    const replays = (await call(fresh, "GET", "/api/replays?limit=100")).data.replays.map((r: { match: string }) => r.match);
    expect(replays).toEqual(expect.arrayContaining(shown));
    for (const id of hidden) expect(replays).not.toContain(id);
    const warm = (await call(fresh, "GET", "/api/replays?tier=warm-up")).data.replays.map((r: { match: string }) => r.match);
    for (const id of hidden) expect(warm).not.toContain(id);

    const records = (await call(fresh, "GET", "/api/records")).data.records.map((r: { matchId: string }) => r.matchId);
    expect(records).toEqual(expect.arrayContaining(shown));
    for (const id of hidden) expect(records).not.toContain(id);

    const agent = (await call(fresh, "GET", "/api/agents/Basher")).data;
    const agentMatches = agent.matches.map((m: { match: string }) => m.match);
    expect(agentMatches).toEqual(expect.arrayContaining(shown));
    for (const id of hidden) expect(agentMatches).not.toContain(id);

    const board = (await call(fresh, "GET", "/api/leaderboard")).data;
    expect(JSON.stringify(board)).toContain("Basher");
    const played = (board.agents as { name: string; vsHouse: { rounds: number } }[]).find((a) => a.name === "Basher")!;
    expect(played.vsHouse.rounds).toBe(shown.length); // its 2 stamped rounds on this engine, not all 5 it played

    // nothing in any answer gives the mark away
    for (const body of [replays, records, agent, board]) expect(JSON.stringify(body)).not.toMatch(/older|e-0ld|engine/);
  });

  test("an older round's direct URLs are a clean 404, never a re-simulation", async () => {
    const fresh = new MatchServer({ outDir, store, pace: "fast" });
    for (const id of [ids.old, ids.unstampedOld]) {
      for (const path of [`/api/matches/${id}`, `/api/matches/${id}/report`, `/api/matches/${id}/picks`, `/api/replays/${id}`, `/share/${id}.svg`]) {
        const r = await call(fresh, "GET", path);
        expect(r.status, path).toBe(404);
        expect(JSON.stringify(r.data ?? "")).not.toMatch(/replayed to|older|engine/);
      }
      const rec = raw("SELECT path FROM records WHERE match_id = ?", id)!.path as string;
      expect((await call(fresh, "GET", `/api/picks?record=${encodeURIComponent(rec)}`)).status).toBe(404);
      expect(await fresh.servesRecord(rec)).toBe(false); // GET /records/<file>.json: 404 (scripts/match-server.ts)
      expect(await fresh.servesRecord(rec.replace("arena-", "arena%2D"))).toBe(false); // an encoded name is the same file
      expect(await fresh.servesRecord("/records/%E0%A4%A.json")).toBe(false); // a bad encoding: refused
      expect(fresh.matches.has(id)).toBe(false); // it was never loaded (no replay ran)
    }
    expect(await fresh.servesRecord(paths.keep!)).toBe(true);
    expect((await call(fresh, "GET", `/api/matches/${ids.keep}/report`)).status).toBe(200);
    expect(await fresh.servesRecord("/records/an-ai-match-file.json")).toBe(true); // a file no round saved
  });

  test("a stamped round that no longer replays (a change the stamp missed) becomes older on first load: 404, not 500", async () => {
    makeOlder(ids.late);
    const fresh = new MatchServer({ outDir, store, pace: "fast", log: (s) => logs.push(s) });
    const r = await call(fresh, "GET", `/api/matches/${ids.late}`);
    expect(r.status).toBe(404);
    expect(raw("SELECT engine FROM matches WHERE id = ?", ids.late)!.engine).toBe(OLDER_ENGINE);
    expect((await call(fresh, "GET", `/api/replays/${ids.late}`)).status).toBe(404);
    expect(logs.some((l) => l.startsWith("error"))).toBe(false);
  });

  test("the data is kept, and scripts still list older rounds and tell them apart", async () => {
    // nothing deleted: the rows, the rounds and the record files are all there
    for (const id of Object.values(ids)) {
      expect(raw("SELECT status FROM matches WHERE id = ?", id)!.status).toBe("over");
      expect(raw("SELECT COUNT(*) AS n FROM rounds WHERE match_id = ?", id)!.n).toBe(1);
      expect(existsSync(join(outDir, (raw("SELECT path FROM records WHERE match_id = ?", id)!.path as string).slice("/records/".length)))).toBe(true);
    }
    const all = await store.allRecords();
    expect(all.length).toBe(5);
    const engineOf = (id: string) => all.find((r) => r.matchId === id)!.engine;
    expect(engineOf(ids.keep)).toBe(engineStamp());
    expect(engineOf(ids.unstampedOld)).toBeNull();

    // the record files on their own: a stamp, or a replay for one without
    const file = (k: keyof typeof ids) => JSON.parse(readFileSync(join(outDir, paths[k]!.slice("/records/".length)), "utf8"));
    expect(recordEngine(file("keep"))).toBe("current");
    expect(recordEngine(file("unstampedNew"))).toBe("current");
    expect(recordEngine(file("old"))).toBe("older");
    expect(recordEngine(file("unstampedOld"))).toBe("older");

    // the listing script, from the files and from the database
    const run = (...args: string[]) => {
      const p = Bun.spawnSync(["bun", "scripts/records-engine.ts", ...args, "--json"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
      expect(p.exitCode).toBe(0);
      return p.stdout.toString().trim().split("\n").map((l) => JSON.parse(l) as { path: string; engine: string; match?: string });
    };
    const fromFiles = run(outDir);
    expect(fromFiles.length).toBe(5);
    expect(fromFiles.filter((r) => r.engine === "older").length).toBe(3);
    const fromDb = run("--db", dbPath);
    expect(fromDb.length).toBe(5);
    expect(fromDb.filter((r) => r.engine === "older").map((r) => r.match).sort()).toEqual([ids.old, ids.late].sort());
  }, 30_000); // two script runs, each works out the stamp (its reference rounds on every map, about 3 s)

  test("an in-flight round that does not replay at startup is set aside quietly; a fresh round starts", async () => {
    // the round in progress when the server stopped, from an older engine (as round 1810 at the #88 switch)
    const live = ids.old;
    store.db.query("UPDATE matches SET status = 'running', ended_at = NULL, engine = NULL WHERE id = ?").run(live);
    const quiet: string[] = [];
    const restarted = new MatchServer({ outDir, store, pace: "fast", arena: { deadlineMs: 1, missLimit: 99 }, log: (s) => quiet.push(s) });
    expect(await restarted.resume()).toEqual({ round: null });
    const row = raw("SELECT status, engine, error FROM matches WHERE id = ?", live)!;
    expect(row).toEqual({ status: "failed", engine: OLDER_ENGINE, error: "played on an older engine" });
    expect(quiet.some((l) => /failed:|replayed to|error/i.test(l))).toBe(false);
    expect(quiet.some((l) => l.includes("older engine"))).toBe(true);
    const next = await restarted.arena.playRound();
    expect(next.status).toBe("over");
    expect(next.arenaRound).toBe(6);
    expect(raw("SELECT engine FROM matches WHERE id = ?", next.id)!.engine).toBe(engineStamp());
    expect((await call(restarted, "GET", `/api/matches/${live}`)).status).toBe(404);
  });

  test("the store file is plain SQLite: scripts can read every round with its engine", () => {
    const db = new Database(dbPath);
    const n = db.query("SELECT COUNT(*) AS n FROM matches WHERE engine = ?").get(OLDER_ENGINE) as { n: number };
    db.close();
    expect(n.n).toBe(2);
  });
});
