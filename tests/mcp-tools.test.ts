/**
 * Contract 3b: the MCP tool surface an agent reads before it plays. The server lists the eight tools by name, and
 * the plan schemas come from the constants the plan parser checks, so an agent that follows the schema sends a plan
 * the server accepts. The schemas follow the ruleset of the Arena's rounds (#64): with another default preset,
 * join_lobby narrows the weapons, and leaving goes back to Classic.
 *
 * Everything runs in-process. No round is played (joining only claims a seat), so no match or timer runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MatchServer } from "../src/server/match-server";
import { McpGateway } from "../src/server/mcp";
import { CLASSIC } from "../src/sim/ruleset";
import { RULE_STANCES } from "../src/sim/rules";
import { MAX_RULES, RULE_DO, RULE_WHEN } from "../src/sim/sim-types";

const outDir = mkdtempSync(join(tmpdir(), "kb-mcp-tools-"));
const api = new MatchServer({ outDir, pace: "fast" });
const gw = new McpGateway(api, { publicUrl: "http://kb.test" });
afterAll(() => {
  gw.close();
  rmSync(outDir, { recursive: true, force: true });
});

const SOUL = "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down.";

async function connect(owner: string) {
  const res = (await api.handle(new Request("http://kb.test/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) })))!;
  const { key } = (await res.json()) as { key: string };
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://kb.test/mcp"), {
      fetch: (url, init) => gw.handle(new Request(url, init as RequestInit), "10.3.0.1"),
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

/** The input schemas the server lists now, by tool name. */
async function tools(client: Client): Promise<Record<string, any>> {
  return Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
}

const planShape = (t: Record<string, any>) => {
  const s = t.submit_plan.inputSchema.properties;
  return { weapons: s.strategy.properties.weapons.items.enum, checkinWeapons: t.submit_checkin.inputSchema.properties.weapons.items.enum };
};

describe("MCP tools", () => {
  test("the tools an agent sees, and plan schemas built from the parser's constants", async () => {
    const client = await connect("Tess");
    expect(client.getInstructions()).toContain("call get_started");
    const t = await tools(client);
    expect(Object.keys(t).sort()).toEqual(["get_round_report", "get_started", "join_lobby", "leave", "submit_checkin", "submit_plan", "wait_for_match", "wait_for_turn"]);
    expect(t.join_lobby.inputSchema.required.sort()).toEqual(["model", "name", "soul"]);
    const strategy = t.submit_plan.inputSchema.properties.strategy;
    expect(t.submit_plan.inputSchema.required.sort()).toEqual(["line", "strategy"]);
    expect(strategy.properties.stance.enum).toEqual([...RULE_STANCES]);
    expect(strategy.properties.rules.maxItems).toBe(MAX_RULES);
    expect(strategy.properties.rules.items.properties.when.enum).toEqual([...RULE_WHEN]);
    expect(strategy.properties.rules.items.properties.do.enum).toEqual([...RULE_DO]);
    expect(planShape(t)).toEqual({ weapons: [...CLASSIC.weapons.enabled], checkinWeapons: [...CLASSIC.weapons.enabled] });
    // `round` names an Arena round: any round number, not one of a match's rounds
    expect(t.submit_plan.inputSchema.properties.round.maximum ?? Infinity).toBeGreaterThan(1e6);
    await client.close();
  });

  test("the schemas follow the Arena's ruleset, and go back to Classic on leave", async () => {
    await api.store.putRulesetPreset("Bats", { weapons: { enabled: ["bat", "rocket"] }, round: { maxRounds: 5 } });
    await api.store.setDefaultRulesetPreset("Bats");
    const client = await connect("Bo");
    const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);
    expect(await call("join_lobby", { name: "Basher", model: "claude-opus-5-5", soul: SOUL })).toMatchObject({ joined: true, status: "seated" });
    const narrowed = planShape(await tools(client));
    expect(narrowed).toEqual({ weapons: ["rocket", "bat"], checkinWeapons: ["rocket", "bat"] });
    expect((await tools(client)).submit_plan.description).not.toContain("grapple");
    expect(await call("leave")).toMatchObject({ left: true, agent: "Basher" });
    expect(planShape(await tools(client))).toEqual({ weapons: [...CLASSIC.weapons.enabled], checkinWeapons: [...CLASSIC.weapons.enabled] });
    await client.close();
  });
});
