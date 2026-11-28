import type { ReplaySummary } from "../src/api-types";
/**
 * Contract (#67): bot-only Arena rounds stay out of everything public. The Arena runs house-bot rounds without
 * stopping; those rounds are shown live and then never again: not in replays, the record index, the model stats,
 * share cards, the round routes or agent pages. Their records go to the internal folder, which is never served.
 * Rounds with one agent are warm-ups; rounds with 2 or more agents are featured, and lists show them first.
 *
 * In-process server at fast pace, temporary folder; agents plan over the HTTP API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPhysics } from "../src/sim";
import { featuredFirst } from "../src/site/data";
import { serveRecord } from "../scripts/viewer-server";
import { arenaServer, call, enter, round } from "./helpers/arena";

const outDir = mkdtempSync(join(tmpdir(), "kb-public-"));
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("bot-only rounds are not public (#67)", () => {
  test("only rounds an agent played are listed, served and counted; bot-only records are internal", async () => {
    const api = arenaServer(join(outDir, "a"));
    // a spectator on the Arena stream sees every round live, the bot-only one too
    const res = (await api.handle(new Request("http://kb.test/api/live"), "10.8.0.1"))!;
    const reader = res.body!.getReader();

    const bots = await round(api); // round 1: house bots only
    const ann = await enter(api, "Ann");
    const warm = await round(api, [ann]); // round 2: Ann and 3 house bots
    const ben = await enter(api, "Ben");
    const feat = await round(api, [ann, ben]); // round 3: Ann, Ben, 2 house bots
    const bots2 = await (async () => {
      await call(api, "POST", "/api/arena/leave", { auth: ann.token });
      await call(api, "POST", "/api/arena/leave", { auth: ben.token });
      return round(api); // round 4: house bots only again, and the round the Arena shows now
    })();
    expect([bots, warm, feat, bots2].map((m) => [m.kinds.filter((k) => k === "remote").length, m.tier])).toEqual([
      [0, "bot-only"],
      [1, "warm-up"],
      [2, "featured"],
      [0, "bot-only"],
    ]);

    // the live stream showed all 4 rounds; a bot-only round's end names no record
    const dec = new TextDecoder();
    let text = "";
    while (text.split('"type":"done"').length - 1 < 4) text += dec.decode((await reader.read()).value);
    await reader.cancel();
    const dones = [...text.matchAll(/"type":"done","record":(null|"[^"]*")/g)].map((m) => JSON.parse(m[1]!));
    expect(dones.map((d) => d === null)).toEqual([true, false, false, true]);

    // replays, the record index and the model stats: the warm-up and the featured round only
    const replays = (await call(api, "GET", "/api/replays")).data.replays as ReplaySummary[];
    expect(replays.map((r) => [r.match, r.tier]).sort()).toEqual(
      [
        [warm.id, "warm-up"],
        [feat.id, "featured"],
      ].sort(),
    );
    expect((await call(api, "GET", "/api/replays?tier=featured")).data.replays.map((r: ReplaySummary) => r.match)).toEqual([feat.id]);
    expect((await call(api, "GET", "/api/replays?tier=warm-up")).data.replays.map((r: ReplaySummary) => r.match)).toEqual([warm.id]);
    expect((await call(api, "GET", "/api/replays?tier=bot-only")).status).toBe(400);
    expect((await call(api, "GET", "/api/records")).data.records.map((r: { matchId: string }) => r.matchId).sort()).toEqual([warm.id, feat.id].sort());
    expect((await call(api, "GET", "/api/models")).data.matches).toBe(2);

    // a finished bot-only round the Arena no longer shows: 404 everywhere, from memory and from storage
    for (const path of [`/api/replays/${bots.id}`, `/share/${bots.id}.svg`, `/api/matches/${bots.id}`, `/api/matches/${bots.id}/report`, `/api/matches/${bots.id}/picks`, `/api/live?match=${bots.id}`]) expect([path, (await call(api, "GET", path)).status]).toEqual([path, 404]);
    expect(api.matches.has(bots.id)).toBe(true); // still in memory, and not listed
    expect((await call(api, "GET", "/api/matches")).data.matches.map((m: { id: string }) => m.id).sort()).toEqual([warm.id, feat.id, bots2.id].sort());
    api.matches.delete(bots.id);
    expect((await call(api, "GET", `/api/matches/${bots.id}/report`)).status).toBe(404);
    // ...while the round the Arena shows now (its win screen) stays reachable, bot-only or not
    expect((await call(api, "GET", `/api/matches/${bots2.id}`)).status).toBe(200);
    // the agent rounds are public
    expect((await call(api, "GET", `/api/replays/${feat.id}`)).status).toBe(200);
    expect((await call(api, "GET", `/share/${warm.id}.svg`)).status).toBe(200);
    // Ann's page has her 2 rounds and nothing else
    expect((await call(api, "GET", "/api/agents/Ann")).data.matches.map((m: { match: string }) => m.match).sort()).toEqual([warm.id, feat.id].sort());

    // records: bot-only ones in the internal folder, marked in the index; public ones at the top
    const dir = join(outDir, "a");
    const bot = (await api.store.getRecord(bots.id))!;
    expect(bot).toMatchObject({ tier: "bot-only" });
    expect(bot.path).toMatch(/^internal\/arena-[\w-]+\.json$/);
    expect(existsSync(join(dir, bot.path))).toBe(true);
    expect(readdirSync(join(dir, "internal")).filter((f) => f.endsWith(".json") && !f.includes(".prompts")).length).toBe(2);
    const file = bot.path.slice("internal/".length);
    expect(existsSync(join(dir, file))).toBe(false);
    // ...and never served: not by its folder path, not by its bare name
    expect((await serveRecord(`/records/${bot.path}`, dir))?.status).toBe(404);
    expect((await serveRecord(`/records/internal%2F${file}`, dir))?.status).toBe(404);
    expect((await serveRecord(`/records/${file}`, dir))?.status).toBe(404);
    const pub = (await api.store.getRecord(feat.id))!;
    expect(pub.path).toMatch(/^\/records\/arena-/);
    expect((await serveRecord(pub.path, dir))?.status).toBe(200);
  });

  test("lists show featured rounds first, then warm-ups, newest first within each", () => {
    const r = (match: string, tier: ReplaySummary["tier"]) => ({ match, tier }) as ReplaySummary;
    expect(featuredFirst([r("w3", "warm-up"), r("f2", "featured"), r("w1", "warm-up"), r("f0", "featured")]).map((x) => x.match)).toEqual(["f2", "f0", "w3", "w1"]);
  });
});
