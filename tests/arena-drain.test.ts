/**
 * The drain before a deploy (#167): the round on now plays to its end, the next one is held, /api/health says idle
 * once it is held; undrain (or the drain's own limit) lets rounds go on; a new process (the new image) starts rounds
 * at once and resumes nothing. In-process at fast pace, as in arena.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArenaOptions } from "../src/server/arena";
import { MatchServer } from "../src/server/match-server";
import { SqliteStore } from "../src/server/store";
import { initPhysics } from "../src/sim";

const outDir = mkdtempSync(join(tmpdir(), "kb-drain-"));
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const server = (arena: ArenaOptions = {}, store?: SqliteStore) => new MatchServer({ outDir, pace: "fast", ...(store ? { store } : {}), arena: { deadlineMs: 600_000, seed: (r) => 9100 + r, ...arena } });
const health = async (api: MatchServer) => (await (await api.handle(new Request("http://kb.test/api/health")))!.json()) as any;
const SOUL = "A patient tactician who waits for the zone to close and then strikes. Speaks calmly, in full sentences.";
let ipN = 0;
/** one POST, each from its own address (per-address limits never decide a result) */
async function post(api: MatchServer, path: string, body: unknown, auth?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) };
  const res = (await api.handle(new Request(`http://kb.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), `10.7.0.${++ipN}`))!;
  return { status: res.status, data: (await res.json()) as any };
}
/** resolves when `ok()` holds (checked on every Arena change) */
async function until(api: MatchServer, ok: () => boolean) {
  while (!ok()) await api.arena.nextChange(1000);
}

describe("the drain", () => {
  test("the round on now ends, the next is held and health says idle; a new process plays the next round", async () => {
    const store = new SqliteStore(":memory:");
    const api = server({}, store);
    const key = (await post(api, "/api/keys", { owner: "dee" })).data.key as string;
    const joined = await post(api, "/api/queue", { name: "Drainer", model: "claude-opus-5-5", soul: SOUL, line: "Steady." }, key);
    expect(joined.status).toBe(201);
    const token = joined.data.token as string;
    expect(await health(api)).toMatchObject({ arena: { round: null, status: null, drain: null, idle: true } });

    const loop = api.arena.start();
    await until(api, () => api.arena.current?.status === "open"); // round 1 waits for Drainer's plan
    api.arena.drain(60_000);
    const during = await health(api);
    expect(during.arena).toMatchObject({ round: 1, status: "open", drain: { held: false }, idle: false });

    expect((await post(api, "/api/arena/plan", { round: 1, weapons: ["bat"], target: "weakest", stance: "rush", line: "Last one before the deploy." }, token)).status).toBe(200);
    await until(api, () => api.arena.state().idle);
    const held = await health(api);
    expect(held.arena).toMatchObject({ round: 1, status: "over", drain: { held: true }, idle: true });
    expect(held.matches).toEqual({ open: 0, running: 0 });
    expect(api.arena.round).toBe(1); // no round 2 was made

    // the deploy stops this process here; the new one (same store) has nothing to resume and plays round 2 at once
    const next = server({ sleep: async () => void next.arena.stop() }, store);
    expect(await next.resume()).toEqual({ round: null });
    expect(next.arena.state()).toMatchObject({ drain: null, idle: true });
    await next.arena.start();
    expect((await store.listMatches()).map((r) => [r.arenaRound, r.status])).toEqual([
      [2, "over"],
      [1, "over"],
    ]);

    // the old process: undrain lets its loop go on (here: straight to its stop)
    void api.arena.stop();
    await loop;
  }, 30_000);

  test("a drain before the loop holds even the first round; undrain, or the drain's own limit, lets rounds go on", async () => {
    const api = server({ sleep: async () => void (api.arena.round >= 2 && api.arena.stop()) });
    api.arena.drain(60_000);
    expect(api.arena.state()).toMatchObject({ round: null, idle: true });
    const loop = api.arena.start();
    await until(api, () => api.arena.state().drain?.held === true);
    expect(api.arena.round).toBe(0);
    api.arena.undrain();
    expect(api.arena.state().drain).toBeNull();
    await until(api, () => api.arena.round >= 1);
    // a drain of 50 ms ends by itself (set during round 1 or its win screen: round 2 waits for it, then plays)
    api.arena.drain(50);
    await loop;
    expect(api.arena.round).toBe(2);
    expect(api.arena.state().drain).toBeNull();
  }, 30_000);

  test("a drain while a resumed round plays holds the round after it", async () => {
    const store = new SqliteStore(":memory:");
    const before = server({}, store);
    const key = (await post(before, "/api/keys", { owner: "rex" })).data.key as string;
    await post(before, "/api/queue", { name: "Resumer", model: "claude-opus-5-5", soul: SOUL, line: "Again." }, key);
    void before.arena.playRound(); // this process "dies" with round 1 waiting for the plan
    await until(before, () => before.arena.current?.status === "open");

    const after = server({}, store);
    expect(await after.resume()).toEqual({ round: 1 });
    after.arena.drain(60_000); // the resumed round is on: it plays out, round 2 waits
    const loop = after.arena.start();
    await until(after, () => after.arena.state().idle);
    expect(after.arena.state()).toMatchObject({ round: 1, status: "over", drain: { held: true } });
    expect(after.arena.round).toBe(1);
    void after.arena.stop();
    await loop;
    await before.arena.leave(before.arena.seats[0]!); // let the dead process's round end too
  }, 30_000);
});
