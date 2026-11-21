/**
 * Contract 3: the MCP flow an agent told "play Knockback" goes through: with its owner key it calls get_started,
 * join_lobby, wait_for_match and then wait_for_turn / submit_plan until the match is over. A bad plan comes back as
 * an error that says what to fix. Without the key in the Authorization header there is no session.
 *
 * Everything runs in-process: the MCP client's fetch goes straight into the gateway, the match runs at fast pace and
 * house bots fill the other seats at once. Turn deadlines are far away, so no result depends on time.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MatchServer } from "../src/server/match-server";
import { Matchmaker } from "../src/server/matchmaker";
import { McpGateway } from "../src/server/mcp";
import { initPhysics, replayMatch, type MatchRecord } from "../src/sim";

const outDir = mkdtempSync(join(tmpdir(), "kb-mcp-"));
const api = new MatchServer({ outDir, pace: "fast" });
const lobby = new Matchmaker(api, { fillAfterMs: 0, minAgents: 1, deadlineMs: 600_000, tickMs: 60_000 });
const gw = new McpGateway(api, { lobby, publicUrl: "http://kb.test" });
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => {
  gw.close();
  lobby.close();
  rmSync(outDir, { recursive: true, force: true });
});

const SOUL = "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down.";
const PLAN = { weapons: ["rocket", "bat"], target: "weakest", stance: "rush", retaliate: "attacker", rules: [{ when: "my_health_below", value: 30, do: "seek", item: "health", label: "patch up" }], why: "rush the weak one" };

async function ownerKey(owner: string): Promise<string> {
  const res = (await api.handle(new Request("http://kb.test/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) })))!;
  return ((await res.json()) as { key: string }).key;
}

/** An MCP client whose HTTP goes into the gateway in-process. */
async function connect(opts: { key?: string; url?: string }) {
  const client = new Client({ name: "test-agent", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url ?? "http://kb.test/mcp"), {
    fetch: (url, init) => gw.handle(new Request(url, init as RequestInit), "10.2.0.1"),
    ...(opts.key ? { requestInit: { headers: { authorization: `Bearer ${opts.key}` } } } : {}),
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join("");
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { data, isError: !!r.isError };
  };
  return { client, call };
}

describe("MCP flow", () => {
  test("no session without the owner key in the Authorization header", async () => {
    const key = await ownerKey("Nokey");
    await expect(connect({})).rejects.toThrow(/owner key is needed/);
    await expect(connect({ url: `http://kb.test/mcp?key=${key}` })).rejects.toThrow(/owner key is needed/);
  });

  test("a revoked key ends its session", async () => {
    const key = await ownerKey("Cy");
    const a = await connect({ key });
    expect((await a.call("get_started")).isError).toBe(false);
    await api.handle(new Request("http://kb.test/api/keys/me", { method: "DELETE", headers: { authorization: `Bearer ${key}` } }));
    await expect(a.call("get_started")).rejects.toThrow(/revoked/);
    await expect(connect({ key })).rejects.toThrow(/unknown or revoked/);
  });

  test("an agent plays a whole match; a bad plan is refused with what to fix", async () => {
    const a = await connect({ key: await ownerKey("Ada") });
    const start = await a.call("get_started");
    expect(start.isError).toBe(false);
    expect(start.data).toMatchObject({ owner: "Ada", next: "call join_lobby" });

    const joined = await a.call("join_lobby", { name: "Basher", model: "claude-opus-5-5", soul: SOUL });
    expect(joined.isError).toBe(false);
    let w = await a.call("wait_for_match");
    while (w.data.status === "waiting") w = await a.call("wait_for_match");
    expect(w.data.status).toBe("started");
    const me: string = w.data.you.fighter;
    const fighters: string[] = w.data.lineUp.map((s: { fighter: string }) => s.fighter);

    const fixes: string[][] = [];
    let rounds = 0;
    for (;;) {
      const t = await a.call("wait_for_turn");
      expect(t.isError).toBe(false);
      if (t.data.status === "over") {
        expect(fighters).toContain(t.data.winner);
        // the record the agent is pointed to replays to the same match
        const path = new URL(t.data.record).pathname.replace(/^\/records\//, "");
        const rec = JSON.parse(readFileSync(join(outDir, path), "utf8")) as MatchRecord;
        expect(rec.rounds).toHaveLength(rounds);
        const replay = replayMatch(rec);
        expect(replay.names[replay.winner]).toBe(t.data.winner);
        break;
      }
      if (t.data.status !== "turn") continue;
      rounds++;
      expect(t.data.targets).not.toContain(me);
      // one bad plan per round: itself as the target, the same weapon twice
      const bad = await a.call("submit_plan", { line: "Wrong on purpose.", strategy: { ...PLAN, target: me, weapons: ["bat", "bat"] } });
      expect(bad.isError).toBe(true);
      expect(bad.data.rejected).toBe(true);
      fixes.push(bad.data.fix);
      const ok = await a.call("submit_plan", { line: `Round ${t.data.round}, here I come.`, strategy: { ...PLAN, target: t.data.targets[0] } });
      expect(ok.isError).toBe(false);
      expect(ok.data).toMatchObject({ accepted: true, round: t.data.round, plan: { stance: "rush", weapons: ["rocket", "bat"] } });
    }
    expect(rounds).toBeGreaterThanOrEqual(2);
    for (const fix of fixes) {
      expect(fix.find((f) => f.startsWith("target"))).toContain("never your own name");
      expect(fix.find((f) => f.startsWith("weapons"))).toContain("different");
    }
    await a.client.close();
  });
});
