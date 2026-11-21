import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerProvider } from "../src/ai/providers";
import { MatchServer } from "../src/server/match-server";
import { Matchmaker } from "../src/server/matchmaker";
import { McpGateway } from "../src/server/mcp";
import { SqliteStore } from "../src/server/store";
import { initPhysics, replayMatch } from "../src/sim";
import { generateIdentities, SHAPES } from "../src/sim/identity";

setDefaultTimeout(120_000);
const SOUL = readFileSync("souls/rat.md", "utf8");
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", line: "Coming through!" };
const tmp = () => mkdtempSync(join(tmpdir(), "kb-suit-"));
let suitCalls = 0;

beforeAll(async () => {
  await initPhysics();
  // a built-in seat that answers the suit-up with a look, and round prompts with a plan
  registerProvider("tailor", {
    label: "tailor/test",
    ask: async (prompt) => {
      if (prompt.startsWith("Knockback suit-up")) {
        suitCalls++;
        return '{"name":"Bramblor","shape":"cloud","eyes":"big","color":"#9bf06a","mark":"sprout","minor":"scarf","line":"I grew up in a junkyard.","why":"soft and green"}';
      }
      return '{"weapons":["bat"],"target":"nearest","stance":"rush","line":"Go."}';
    },
  });
});

function http(s: MatchServer, ip = "1.2.3.4") {
  return async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = (await s.handle(new Request(`http://kb.test${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), ip))!;
    return { status: res.status, data: (await res.json()) as any };
  };
}

async function playHttp(call: ReturnType<typeof http>, mid: string, token: string) {
  for (;;) {
    const t = (await call("GET", `/api/matches/${mid}/turn?wait=5`, undefined, token)).data;
    if (t.status === "over") return t;
    if (t.status === "turn") await call("POST", `/api/matches/${mid}/plan`, { round: t.round, ...PLAN }, token);
  }
}

describe("suit up on the match server (#19)", () => {
  test("an AI seat suits up when the match is made; an agent's join look too; the pick cards show both before the start; the record keeps them", async () => {
    const s = new MatchServer({ outDir: tmp() });
    const call = http(s);
    const m = await s.createMatch({ seats: ["remote", "tailor", "house", "house"], seed: 9, fillAfterMs: 300_000 });
    await m.beginSuitUp();
    const j = await call("POST", `/api/matches/${m.id}/join`, { name: "Agent", persona: SOUL, look: { name: "Brixel", shape: "tv", color: "#33ccff", mark: "jetpack" }, line: "Hi there." });
    expect(j.status).toBe(201);
    expect(j.data.warnings).toEqual([expect.stringContaining('look.mark: unknown "jetpack"')]);
    const cards = (await call("GET", `/api/matches/${m.id}/picks`)).data.fighters;
    expect(cards[0]).toMatchObject({ name: "Brixel", line: "Hi there." });
    expect(cards[1]).toMatchObject({ name: "Bramblor", line: "I grew up in a junkyard.", look: { shape: "cloud", mark: "sprout", color: 0x9bf06a } });
    // the answers are stored with the match
    expect(JSON.parse((await s.store.getMatch(m.id))!.suitUp!)).toEqual([expect.objectContaining({ seat: 1, by: "ai", outcome: "answered" })]);
    await playHttp(call, m.id, j.data.token);
    const rec = m.runner!.savedRecord();
    expect(rec.identities![1]).toMatchObject({ name: "Bramblor", shape: "cloud", eyes: "big", mark: "sprout", minor: "scarf", color: 0x9bf06a });
    expect(rec.identities![0]).toMatchObject({ name: "Brixel", shape: "tv", color: 0x33ccff });
    expect(rec.suitUp).toEqual([
      expect.objectContaining({ seat: 0, by: "agent", outcome: "partial", kept: ["name", "shape", "color"], dropped: [{ field: "mark", why: "invalid" }], line: "Hi there." }),
      expect.objectContaining({ seat: 1, by: "ai", outcome: "ok", line: "I grew up in a junkyard.", why: "soft and green" }),
    ]);
    // the replay needs no AI: the same identities and hashes from the record alone
    const again = replayMatch(JSON.parse(JSON.stringify(rec)));
    expect(again.identities).toEqual(rec.identities!);
    expect(again.record.rounds.map((r) => r.fight.finalHash)).toEqual(rec.rounds.map((r) => r.fight.finalHash));
  });

  test("GET /api/looks lists the options; with suitUp off (or no AI seat) the identities are the seeded ones", async () => {
    const s = new MatchServer({ outDir: tmp(), suitUp: false });
    const call = http(s);
    const looks = (await call("GET", "/api/looks")).data;
    expect(Object.keys(looks.shape)).toEqual([...SHAPES]);
    expect(looks.color).toContain("OKLab");
    const before = suitCalls;
    const m = await s.createMatch({ seats: ["tailor", "house", "house", "house"], seed: 12 });
    for (let i = 0; i < 400 && m.status !== "over"; i++) await Bun.sleep(25);
    expect(suitCalls).toBe(before);
    expect(m.runner!.match.identities).toEqual(generateIdentities(12));
    expect(m.runner!.match.record.suitUp).toBeUndefined();
  });

  test("a restart keeps the AI seats' looks (the answers are stored, not asked again)", async () => {
    const dir = tmp();
    const db = join(dir, "kb.db");
    const s1 = new MatchServer({ outDir: dir, store: new SqliteStore(db) });
    const m1 = await s1.createMatch({ seats: ["remote", "tailor", "house", "house"], seed: 21, fillAfterMs: 300_000 });
    await m1.beginSuitUp();
    const name = m1.settledLooks().identities[1]!.name;
    await s1.store.close();
    const calls = suitCalls;
    const s2 = new MatchServer({ outDir: dir, store: new SqliteStore(db) });
    await s2.resume();
    const m2 = s2.matches.get(m1.id)!;
    expect(m2.suitAnswers).toEqual(m1.suitAnswers);
    expect(m2.settledLooks().identities[1]!.name).toBe(name);
    await m2.beginSuitUp();
    expect(suitCalls).toBe(calls);
    await s2.store.close();
  });

  test("MCP: join_lobby's look lists the options; wait_for_match says which wishes were kept", async () => {
    const api = new MatchServer({ outDir: tmp() });
    const mm = new Matchmaker(api, { fillAfterMs: 0, tickMs: 50, deadlineMs: 4000 });
    const gw = new McpGateway(api, { lobby: mm, publicUrl: "http://kb.test" });
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://kb.test/mcp"), { fetch: (u, init) => gw.handle(new Request(u, init as RequestInit), "10.0.0.5") }));
    const tools = (await client.listTools()).tools;
    const look = (tools.find((t) => t.name === "join_lobby")!.inputSchema as any).properties.look;
    expect(look.properties.shape.description).toContain("barrel (a barrel: chunky");
    expect(look.properties.minor.description).toContain("scarf");
    const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);
    await call("join_lobby", { name: "Dresser", persona: SOUL, look: { name: "Bramblo", shape: "cloud", color: "#9bf06a", mark: "horns" } });
    let w: any;
    do w = await call("wait_for_match");
    while (w.status !== "started");
    // the agent's wishes are kept (house bots fill the other seats: AI-seat conflicts are covered over HTTP above)
    expect(w.you.look).toMatchObject({ name: "Bramblo", shape: "cloud", mark: "horns", color: "#9bf06a" });
    expect(w.you.lookChoice).toEqual({ kept: ["name", "shape", "mark", "color"], replaced: [] });
    mm.close();
    gw.close();
  });
});
