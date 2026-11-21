/**
 * Contract 8: the Arena over HTTP (#20, #25, #27, #64). An agent joins with its owner key (POST /api/queue) and plays
 * with its seat token (no token or another token: 401); a bad join or plan gets 4xx with what is wrong; custom
 * matches are gone (POST /api/matches: 405); wrong methods get 405 and unknown paths 404. After a restart on the same
 * store a finished round loads from storage with the same result and the same hash.
 *
 * The server runs in-process (MatchServer.handle): no port, no network. Rounds run at fast pace, driven directly;
 * deadlines are far away, so no result depends on time.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";

const outDir = mkdtempSync(join(tmpdir(), "kb-arena-http-"));
const store = new SqliteStore(":memory:");
const api = new MatchServer({ outDir, store, pace: "fast", arena: { deadlineMs: 600_000 } });
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const SOUL = "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down.";
let ipN = 0;
/** One request; each from its own address so per-address limits never decide a result. */
async function call(server: MatchServer, method: string, path: string, opts: { auth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  const res = (await server.handle(new Request(`http://kb.test${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }), `10.3.0.${++ipN}`))!;
  return { status: res.status, headers: res.headers, data: (await res.json().catch(() => null)) as any };
}
const ownerKey = async (owner: string) => (await call(api, "POST", "/api/keys", { body: { owner } })).data.key as string;
const joinBody = (name: string) => ({ name, model: "claude-opus-5-5", soul: SOUL });

describe("the Arena over HTTP", () => {
  let finished = "";

  test("join with the owner key, play with the seat token, report", async () => {
    const index = (await call(api, "GET", "/api")).data;
    expect(Object.keys(index.endpoints)).toEqual(expect.arrayContaining(["POST /api/queue", "GET /api/arena/turn?wait=25", "POST /api/arena/plan", "POST /api/arena/leave"]));
    expect(Object.keys(index.endpoints).filter((k) => /\/api\/matches(\/:id)?\/(join|turn|plan|leave)|POST \/api\/matches$/.test(k))).toEqual([]);
    expect((await call(api, "GET", "/api/health")).data).toMatchObject({ ok: true, store: "ok" });
    expect((await call(api, "GET", "/api/nothing-here")).status).toBe(404);
    const custom = await call(api, "POST", "/api/matches", { body: { seats: ["remote", "house", "house", "house"] } });
    expect(custom.status).toBe(405); // the Arena is the only way to play
    expect(custom.headers.get("allow")).toBe("GET");
    expect((await call(api, "PUT", "/api/queue")).headers.get("allow")).toBe("POST");

    const key = await ownerKey("Ada");
    expect((await call(api, "POST", "/api/queue", { body: joinBody("Basher") })).status).toBe(401);
    const bad = await call(api, "POST", "/api/queue", { auth: key, body: { ...joinBody("Basher"), seat: 2, bogus: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.data.problems).toEqual(["unknown fields: seat, bogus (allowed: name, model, soul, look, line)"]);

    const joined = await call(api, "POST", "/api/queue", { auth: key, body: joinBody("Basher") });
    expect(joined.status).toBe(201);
    expect(joined.data).toMatchObject({ agent: "Basher", owner: "Ada", status: "seated", seat: 0, entersRound: 1 });
    const token: string = joined.data.token;
    expect(token).toMatch(/^st_[0-9a-f]{48}$/);
    expect((await call(api, "GET", "/api/queue?name=basher")).data.you).toMatchObject({ seat: 0, fromRound: 1 });

    expect((await call(api, "GET", "/api/arena/turn?wait=0")).status).toBe(401);
    expect((await call(api, "GET", "/api/arena/turn?wait=0", { auth: "st_not-a-token" })).status).toBe(401);
    expect((await call(api, "GET", "/api/arena/turn?wait=0", { auth: key })).status).toBe(401); // the owner key is not a seat token

    const round = api.arena.playRound();
    let t = await call(api, "GET", "/api/arena/turn?wait=30", { auth: token });
    while (t.data.status !== "turn") t = await call(api, "GET", "/api/arena/turn?wait=30", { auth: token });
    expect(t.data).toMatchObject({ status: "turn", round: 1, seat: 0 });
    expect(t.data.schema.weapons.values).toHaveProperty("bat");

    const refused = await call(api, "POST", "/api/arena/plan", { auth: token, body: { round: 1, weapons: ["bat", "bat"], target: "weakest", stance: "rush", line: "Wrong on purpose." } });
    expect(refused.status).toBe(422);
    expect(refused.data.problems.join(" ")).toContain("weapons");
    const plan = await call(api, "POST", "/api/arena/plan", { auth: token, body: { round: 1, weapons: ["rocket", "bat"], target: "weakest", stance: "rush", line: "Here I come." } });
    expect(plan.status).toBe(200);
    expect(plan.data).toMatchObject({ accepted: true, round: 1, plan: { stance: "rush", weapons: ["rocket", "bat"] } });
    expect((await call(api, "POST", "/api/arena/plan", { auth: token, body: { round: 1, weapons: ["bat"], target: "weakest", stance: "rush", line: "Again." } })).data.error).toContain("round 1 is already planned");

    const m = await round;
    expect(m.status).toBe("over");
    const info = (await call(api, "GET", `/api/matches/${m.id}`)).data;
    expect(info).toMatchObject({ arenaRound: 1, status: "over" });
    expect(info.winner).toBeString();
    expect(info.seats.map((s: { kind: string }) => s.kind)).toEqual(["remote", "house", "house", "house"]);
    const report = (await call(api, "GET", `/api/matches/${m.id}/report`)).data;
    expect(report.rounds).toHaveLength(1);
    expect(report.rounds[0].plans[0].line).toBe("Here I come.");
    expect((await call(api, "GET", "/api/matches")).data.matches.map((x: { id: string }) => x.id)).toContain(m.id);

    const left = await call(api, "POST", "/api/arena/leave", { auth: token });
    expect(left.data).toMatchObject({ left: true, agent: "Basher", seat: 0 });
    expect((await call(api, "POST", "/api/arena/leave", { auth: token })).status).toBe(410);
    finished = m.id;
  });

  test("after a restart a finished round loads from storage with the same hash", async () => {
    const restarted = new MatchServer({ outDir, store, pace: "fast" });
    expect(await restarted.resume()).toEqual({ round: null }); // nothing was in progress
    expect(restarted.matches.has(finished)).toBe(false);
    const before = (await call(api, "GET", `/api/matches/${finished}/report`)).data;
    const after = (await call(restarted, "GET", `/api/matches/${finished}/report`)).data;
    expect(after.status).toBe("over");
    expect(after.arenaRound).toBe(1);
    expect(after.winner).toBe(before.winner);
    expect(after.rounds.map((r: any) => r.result.finalHash)).toEqual(before.rounds.map((r: any) => r.result.finalHash));
    expect(after.record).toBe(before.record);
    // the next round number goes on from the stored ones
    expect((await restarted.arena.playRound()).arenaRound).toBe(2);
  });
});
