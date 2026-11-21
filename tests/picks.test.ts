/** #35: spectator picks. Humans pick a winner; picks never reach agents, prompts, tool results, the record or any hash. */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LobbyQueue } from "../src/server/lobby-queue";
import { MatchServer, type ServerMatch } from "../src/server/match-server";
import { McpGateway } from "../src/server/mcp";
import { soulOpeningLine } from "../src/server/picks";
import { picksView } from "../src/site/picks";
import { modelOf } from "../src/stats/models";
import { SqliteStore } from "../src/server/store";
import { initPhysics, replayMatch } from "../src/sim";

setDefaultTimeout(120_000);
beforeAll(async () => {
  await initPhysics();
});

const SOUL = readFileSync("souls/rat.md", "utf8");
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", line: "Coming through!" };
const tmp = () => mkdtempSync(join(tmpdir(), "kb-picks-"));

/** HTTP into the server; `cookie` is a spectator's browser cookie jar (one string). */
function http(s: MatchServer, ip = "1.2.3.4") {
  return async (method: string, path: string, body?: unknown, opts: { token?: string; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.cookie = opts.cookie;
    const res = (await s.handle(new Request(`http://kb.test${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), ip))!;
    const set = res.headers.get("set-cookie");
    return { status: res.status, data: (await res.json()) as any, cookie: set ? set.split(";")[0]! : undefined };
  };
}

/** A spectator: gets its cookie from GET /picks, then picks with it. */
async function spectator(call: ReturnType<typeof http>, mid: string) {
  const r = await call("GET", `/api/matches/${mid}/picks`);
  const cookie = r.cookie!;
  return { cookie, pick: (seat: number) => call("POST", `/api/matches/${mid}/pick`, { seat }, { cookie }), view: () => call("GET", `/api/matches/${mid}/picks`, undefined, { cookie }) };
}

async function playHttp(call: ReturnType<typeof http>, mid: string, token: string) {
  for (;;) {
    const t = (await call("GET", `/api/matches/${mid}/turn?wait=5`, undefined, { token })).data;
    if (t.status === "over") return t;
    if (t.status === "turn") await call("POST", `/api/matches/${mid}/plan`, { round: t.round, ...PLAN }, { token });
  }
}

/** Read a live stream's events as they come. */
function liveEvents(s: MatchServer, mid: string) {
  const events: any[] = [];
  let stop = false;
  void (async () => {
    const res = (await s.handle(new Request(`http://kb.test/api/live?match=${mid}`)))!;
    const reader = res.body!.getReader();
    let buf = "";
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
        buf = buf.slice(i + 2);
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
    reader.cancel();
  })();
  return { events, close: () => (stop = true) };
}

describe("opening lines", () => {
  test("join takes an optional opening line (validated like a plan line); house bots get a soul line; both show on the pick cards", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 5, fillAfterMs: 300_000 });
    expect((await call("POST", `/api/matches/${m.id}/join`, { name: "Bad", persona: SOUL, line: "" })).data.problems.join()).toContain("line");
    expect((await call("POST", `/api/matches/${m.id}/join`, { name: "Bad", persona: SOUL, line: 42 })).status).toBe(400);
    await call("POST", `/api/matches/${m.id}/join`, { name: "Talker", persona: SOUL, model: "claude-opus-5-5", line: '  "Hold still, snack."  ' });
    const v = (await call("GET", `/api/matches/${m.id}/picks`)).data;
    expect(v.fighters[0]).toMatchObject({ seat: 0, label: "agent · Talker", line: "Hold still, snack." });
    expect(v.fighters[1]).toMatchObject({ label: "open seat" });
    expect(v.fighters[2]!.label).toBe("house bot");
    expect(typeof v.fighters[2]!.line).toBe("string");
    expect(v.fighters[2]!.line.length).toBeGreaterThan(5);
    expect(v.fighters[0]!.svg).toStartWith("<svg");
    // the model badge's label: the agent's self-reported model, the house bot, nothing yet for an open seat
    expect(modelOf(v.fighters[0]!.model)).toMatchObject({ name: "CLAUDE OPUS 5.5", selfReported: true });
    expect(v.fighters[1]!.model).toBeNull();
    expect(modelOf(v.fighters[2]!.model).provider).toBe("house");
    // the site's lobby card reads the same answer (checked again on the page)
    const card = picksView({ ...v, now: 1000, locksAtEarliest: 31_000 }, 5000)!;
    expect(card.fighters.map((f) => f.model)).toEqual(v.fighters.map((f: { model: string | null }) => f.model));
    expect(card).toMatchObject({ match: m.id, locked: false, locksAt: 35_000, yours: null, winner: null });
    expect(picksView({ ...v, fighters: v.fighters.slice(0, 3) })).toBeNull();
    expect(soulOpeningLine([["intro", "*", "Hi, {me}!"], ["win", "*", "x"], ["intro", "*", "{killer} again"]], undefined, "Pip", 0)).toBe("Hi, Pip!");
    await m.start();
  });
});

describe("picks", () => {
  test("anonymous cookie id; one pick per spectator, changeable; per-address cap and limits; bad input", async () => {
    const s = new MatchServer({ outDir: tmp(), picksPerAddress: 3 });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], fillAfterMs: 300_000 });
    const a = await spectator(call, m.id);
    expect(a.cookie).toMatch(/^kb_spectator=[0-9a-f]{32}$/);
    expect((await a.pick(2)).data).toMatchObject({ counts: [0, 0, 1, 0], total: 1, yours: 2, locked: false });
    expect((await a.pick(1)).data).toMatchObject({ counts: [0, 1, 0, 0], total: 1, yours: 1 }); // changed, still one pick
    const b = await spectator(call, m.id);
    await b.pick(1);
    expect((await b.view()).data).toMatchObject({ counts: [0, 2, 0, 0], yours: 1 });
    expect((await call("GET", `/api/matches/${m.id}/picks`)).data.yours).toBeNull(); // no cookie: no pick
    const c = await spectator(call, m.id);
    await c.pick(0);
    const d = await spectator(call, m.id);
    expect((await d.pick(3)).status).toBe(429); // 4th spectator from the same address
    expect((await a.pick(3)).status).toBe(200); // an existing spectator may still change
    expect((await call("POST", `/api/matches/${m.id}/pick`, { seat: 7 }, { cookie: a.cookie })).status).toBe(400);
    expect((await call("POST", `/api/matches/${m.id}/pick`, { seat: 1, weight: 99 }, { cookie: a.cookie })).status).toBe(400);
    expect(s.matches.get(m.id)!.info()).not.toHaveProperty("picks"); // the match info (which agents read) has no picks
    await m.start();
  });

  test("the lock: picksLocked goes out before round 1's decisions, and a pick sent the moment the decisions arrive is refused", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 11, deadlineMs: 4000, fillAfterMs: 300_000 });
    const live = liveEvents(s, m.id);
    const fan = await spectator(call, m.id);
    await fan.pick(0);
    const late = await spectator(call, m.id);
    const ta = (await call("POST", `/api/matches/${m.id}/join`, { name: "A", persona: SOUL, line: "Ready." })).data.token;
    const tb = (await call("POST", `/api/matches/${m.id}/join`, { name: "B", persona: SOUL })).data.token;
    // B waits until its turn, then a spectator tries to pick the instant round 1's decisions are on the stream
    const tryLate = (async () => {
      for (;;) {
        await Bun.sleep(1);
        if (live.events.some((e) => e.type === "decisions")) return late.pick(2);
      }
    })();
    await Promise.all([playHttp(call, m.id, ta), playHttp(call, m.id, tb)]);
    const refused = await tryLate;
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain("locked");
    live.close();
    const types = live.events.map((e) => e.type);
    expect(types.indexOf("picksLocked")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("picksLocked")).toBeLessThan(types.indexOf("decisions"));
    expect(types.indexOf("lineup")).toBe(0); // the stream names the match before the start
    expect(live.events.find((e) => e.type === "match").matchId).toBe(m.id);
    expect(live.events.find((e) => e.type === "picksLocked")).toMatchObject({ counts: [1, 0, 0, 0], total: 1 });
    expect(m.picks.lockedAt).toBeLessThanOrEqual(m.runner!.playback!.startedAt); // (round 1's playback starts at its broadcast)
    // after the end: the report has the final split, the cards say who called it
    const rep = (await call("GET", `/api/matches/${m.id}/report`)).data;
    expect(rep.picks).toMatchObject({ counts: [1, 0, 0, 0], total: 1, winner: m.runner!.match.winner, calledIt: m.runner!.match.winner === 0 ? 1 : 0 });
    expect((await fan.view()).data).toMatchObject({ locked: true, yours: 0, winner: m.runner!.match.winner });
  });

  test("broadcast pace keeps the window open at least pickWindowMs after the start (round 1 is asked later)", async () => {
    const s = new MatchServer({ outDir: tmp(), pace: "broadcast", pickWindowMs: 400 });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "house", "house", "house"], seed: 3, deadlineMs: 3000, fillAfterMs: 300_000 });
    const live = liveEvents(s, m.id); // a spectator, so the window is kept
    const t = (await call("POST", `/api/matches/${m.id}/join`, { name: "Fast", persona: SOUL })).data.token;
    let firstTurn = 0;
    for (;;) {
      const r = (await call("GET", `/api/matches/${m.id}/turn?wait=5`, undefined, { token: t })).data;
      if (r.status === "turn") {
        firstTurn = Date.now();
        await call("POST", `/api/matches/${m.id}/plan`, { round: r.round, ...PLAN }, { token: t });
        break;
      }
    }
    expect(firstTurn - m.startedAtMs!).toBeGreaterThanOrEqual(390);
    await Bun.sleep(50);
    expect(m.picks.lockedAt! - m.startedAtMs!).toBeGreaterThanOrEqual(390);
    live.close();
    m.takeover(0, "test cleanup");
  });

  test("picks change nothing: the same match with and without picks has the same record, prompts and hashes", async () => {
    async function run(withPicks: boolean) {
      const s = new MatchServer({ outDir: tmp() });
      const call = http(s);
      const m = await s.createMatch({ seats: ["remote", "remote", "house", "house"], seed: 77, deadlineMs: 4000, fillAfterMs: 300_000 });
      if (withPicks) for (let i = 0; i < 6; i++) await (await spectator(http(s, `9.0.0.${i}`), m.id)).pick(i % 4);
      const ta = (await call("POST", `/api/matches/${m.id}/join`, { name: "A", persona: SOUL, line: "Ready when you are." })).data.token;
      const tb = (await call("POST", `/api/matches/${m.id}/join`, { name: "B", persona: SOUL, line: "Ready when you are." })).data.token;
      await Promise.all([playHttp(call, m.id, ta), playHttp(call, m.id, tb)]);
      return m;
    }
    const plain = await run(false);
    const picked = await run(true);
    expect(picked.picks.tally().total).toBe(6);
    const strip = (m: ServerMatch) => {
      const rec = JSON.parse(JSON.stringify(m.runner!.savedRecord()));
      delete rec.totalMs;
      for (const r of rec.rounds) for (const x of r.meta ?? []) delete x.ms;
      return rec;
    };
    expect(strip(picked)).toEqual(strip(plain));
    expect(JSON.stringify(picked.runner!.savedRecord())).not.toMatch(/"picks"|spectator|calledIt/);
    expect(picked.runner!.prompts).toEqual(plain.runner!.prompts);
    expect(replayMatch(picked.runner!.savedRecord()).record.rounds.map((r) => r.fight.finalHash)).toEqual(plain.runner!.match.record.rounds.map((r) => r.fight.finalHash));
  });

  test("MCP agents never see picks: no tool result mentions them, while spectators pick throughout", async () => {
    const api = new MatchServer({ outDir: tmp() });
    const gw = new McpGateway(api, { lobby: new LobbyQueue(api, { seats: ["remote", "house", "house", "house"], deadlineMs: 4000, fillAfterMs: 30_000 }) });
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://kb.test/mcp"), { fetch: (u, init) => gw.handle(new Request(u, init as RequestInit), "10.0.0.1") }));
    const texts: string[] = [];
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
      texts.push(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    const j = await call("join_lobby", { name: "Agent", persona: SOUL, line: "I see nothing." });
    for (let i = 0; i < 5; i++) await (await spectator(http(api, `8.0.0.${i}`), j.match)).pick(i % 4);
    for (;;) {
      const t = await call("wait_for_turn");
      if (t.status === "over") break;
      if (t.status === "turn") await call("submit_plan", { line: "Planning.", strategy: { weapons: ["bat"], target: "nearest", stance: "rush" } });
    }
    await call("get_round_report");
    const all = texts.join("\n");
    expect(all).not.toMatch(/"picks"|"counts"|calledIt|spectator|"yours"|picksLocked/);
    const m = api.matches.get(j.match)!;
    expect(m.picks.tally().total).toBe(5);
    // ("picks up" is game text in the rules paragraph; nothing about spectators may appear)
    expect(m.runner!.prompts.flatMap((p) => p.prompts).join("\n")).not.toMatch(/spectator|calledIt|"picks"|picksLocked|crowd split/i);
    gw.close();
  });

  test("a replay gets its split from the record index; picks and the lock survive a restart", async () => {
    const dir = tmp();
    const db = join(dir, "s.db");
    const s = new MatchServer({ outDir: dir, store: new SqliteStore(db) });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "house", "house", "house"], seed: 9, deadlineMs: 3000, fillAfterMs: 300_000 });
    const fan = await spectator(call, m.id);
    await fan.pick(1);
    const t = (await call("POST", `/api/matches/${m.id}/join`, { name: "Solo", persona: SOUL })).data.token;
    await playHttp(call, m.id, t);
    for (let i = 0; i < 100 && !m.runner!.recordFile; i++) await Bun.sleep(10);
    const rec = `/records/${m.runner!.recordFile}`;
    await s.store.close();
    const again = new MatchServer({ outDir: dir, store: new SqliteStore(db) });
    const c2 = http(again);
    const r = await c2("GET", `/api/picks?record=${encodeURIComponent(rec)}`, undefined, { cookie: fan.cookie });
    expect(r.data).toMatchObject({ match: m.id, locked: true, counts: [0, 1, 0, 0], total: 1, yours: 1, winner: m.runner!.match.winner });
    expect((await c2("POST", `/api/matches/${m.id}/pick`, { seat: 2 }, { cookie: fan.cookie })).status).toBe(409);
    await again.store.close();
  });
});
