/**
 * Contract 8: the match API over HTTP (#20, #25, #27). A match is created and validated, an agent joins with its
 * owner key and plays with its seat token (no token or another token: 401), wrong methods get 405 and unknown paths
 * 404. After a restart on the same store the seat token still works in an open match, and a finished match loads
 * from storage with the same result and the same round hashes.
 *
 * The server runs in-process (MatchServer.handle): no port, no network. The match runs at fast pace; deadlines and
 * fill timers are far away, so no result depends on time.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";

const outDir = mkdtempSync(join(tmpdir(), "kb-match-http-"));
const store = new SqliteStore(":memory:");
const api = new MatchServer({ outDir, store, pace: "fast" });
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
  return { status: res.status, headers: res.headers, data: (await res.json()) as any };
}
const ownerKey = async (owner: string) => (await call(api, "POST", "/api/keys", { body: { owner } })).data.key as string;
const joinBody = (name: string) => ({ name, model: "claude-opus-5-5", soul: SOUL });

describe("match API over HTTP", () => {
  let finished = "";

  test("create, join, play with the seat token, leave, report", async () => {
    expect((await call(api, "GET", "/api")).data.endpoints).toHaveProperty("POST /api/matches/:id/join");
    expect((await call(api, "GET", "/api/health")).data).toMatchObject({ ok: true, store: "ok" });
    expect((await call(api, "GET", "/api/nothing-here")).status).toBe(404);
    const wrong = await call(api, "PUT", "/api/matches");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");

    const bad = await call(api, "POST", "/api/matches", { body: { seats: ["house", "house", "house", "house"], bogus: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.data.problems).toEqual(["unknown fields: bogus", "seats: at least one remote seat"]);

    const created = await call(api, "POST", "/api/matches", { body: { seats: ["remote", "house", "house", "house"], seed: 4242, deadlineSec: 120, fillAfterSec: 300 } });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ status: "open", seed: 4242, deadlineSec: 120 });
    const id: string = created.data.id;

    expect((await call(api, "GET", `/api/matches/${id}/turn?wait=0`)).status).toBe(401);
    expect((await call(api, "GET", `/api/matches/${id}/turn?wait=0`, { auth: "st_not-a-token" })).status).toBe(401);
    expect((await call(api, "POST", `/api/matches/${id}/join`, { body: joinBody("Basher") })).status).toBe(401);

    const joined = await call(api, "POST", `/api/matches/${id}/join`, { auth: await ownerKey("Ada"), body: joinBody("Basher") });
    expect(joined.status).toBe(201);
    expect(joined.data).toMatchObject({ match: id, seat: 0 });
    const token: string = joined.data.token;
    expect(token).toMatch(/^st_[0-9a-f]{48}$/);

    // the only remote seat is taken: the match starts and asks for round 1
    let t = await call(api, "GET", `/api/matches/${id}/turn?wait=30`, { auth: token });
    while (t.data.status === "open" || t.data.status === "waiting") t = await call(api, "GET", `/api/matches/${id}/turn?wait=30`, { auth: token });
    expect(t.status).toBe(200);
    expect(t.data).toMatchObject({ status: "turn", round: 1, seat: 0 });

    const refused = await call(api, "POST", `/api/matches/${id}/plan`, { auth: token, body: { round: 1, weapons: ["bat", "bat"], target: "weakest", stance: "rush", line: "Wrong on purpose." } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const plan = await call(api, "POST", `/api/matches/${id}/plan`, { auth: token, body: { round: 1, weapons: ["rocket", "bat"], target: "weakest", stance: "rush", line: "Here I come." } });
    expect(plan.status).toBe(200);
    expect(plan.data).toMatchObject({ accepted: true, round: 1, plan: { stance: "rush", weapons: ["rocket", "bat"] } });

    const left = await call(api, "POST", `/api/matches/${id}/leave`, { auth: token });
    expect(left.data).toMatchObject({ seat: 0, status: "running" });
    expect((await call(api, "GET", `/api/matches/${id}/turn?wait=0`, { auth: token })).data.status).toBe("left");

    // the house bot plays the seat to the end
    const m = api.matches.get(id)!;
    while (m.status === "running") await m.nextChange(60_000);
    expect(m.status).toBe("over");
    const info = (await call(api, "GET", `/api/matches/${id}`)).data;
    expect(info.winner).toBeString();
    expect(info.seats[0]).toMatchObject({ agent: "Basher", houseFromRound: left.data.houseFromRound });
    const report = (await call(api, "GET", `/api/matches/${id}/report`)).data;
    expect(report.rounds.length).toBeGreaterThanOrEqual(2);
    expect(report.rounds[0].plans[0].line).toBe("Here I come.");
    expect((await call(api, "GET", `/api/matches/${id}/report?round=1`)).data.rounds.map((r: { round: number }) => r.round)).toEqual([1]);
    finished = id;
  });

  test("after a restart: an open match keeps its seat tokens, a finished one loads with the same hashes", async () => {
    const created = await api.createMatch({ seats: ["remote", "remote", "remote", "remote"], fillAfterMs: 3_600_000 });
    const joined = await call(api, "POST", `/api/matches/${created.id}/join`, { auth: await ownerKey("Bea"), body: joinBody("Waiter") });
    const token: string = joined.data.token;

    const restarted = new MatchServer({ outDir, store, pace: "fast" });
    const resumed = await restarted.resume();
    expect(resumed.open).toContain(created.id);
    const t = await call(restarted, "GET", `/api/matches/${created.id}/turn?wait=0`, { auth: token });
    expect(t.status).toBe(200);
    expect(t.data).toMatchObject({ match: created.id, seat: joined.data.seat, status: "open" });
    expect((await call(restarted, "GET", `/api/matches/${created.id}/turn?wait=0`, { auth: `st_${"0".repeat(48)}` })).status).toBe(401);
    expect((await call(restarted, "POST", `/api/matches/${created.id}/leave`, { auth: token })).data).toMatchObject({ status: "open" });

    expect(restarted.matches.has(finished)).toBe(false);
    const before = (await call(api, "GET", `/api/matches/${finished}/report`)).data;
    const after = (await call(restarted, "GET", `/api/matches/${finished}/report`)).data;
    expect(after.status).toBe("over");
    expect(after.winner).toBe(before.winner);
    expect(after.rounds.map((r: any) => r.result.finalHash)).toEqual(before.rounds.map((r: any) => r.result.finalHash));
    expect(after.record).toBe(before.record);
  });
});
