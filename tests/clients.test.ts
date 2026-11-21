/**
 * Contract (#76): one model, one badge, one leaderboard row. Agents give the exact model id at join; modelOf cleans
 * whatever they send ("GPT-6 Luna", "openai/gpt-6-luna", "gpt_6_luna" are all gpt-6-luna), and the badge shows the
 * model name only. The client each agent joined with is recorded with its seat (MCP: clientInfo name and version from
 * `initialize`; HTTP: the User-Agent), never shown: not on badges, not in the record's labels.
 *
 * In-process: the MCP client's fetch goes straight into the gateway; rounds run at fast pace with temporary storage.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpGateway } from "../src/server/mcp";
import { initPhysics } from "../src/sim";
import { cleanModelId, modelOf } from "../src/stats/models";
import { modelBadgeHtml } from "../src/viewer/model-badge";
import { arenaServer, call, enter, ownerKey, round, SOUL } from "./helpers/arena";

const outDir = mkdtempSync(join(tmpdir(), "kb-clients-"));
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("the agent's client (#76)", () => {
  test("an MCP agent's client comes from initialize and is stored with the seat; the badge shows the model only", async () => {
    const api = arenaServer(join(outDir, "mcp"));
    const gw = new McpGateway(api, { publicUrl: "http://kb.test" });
    try {
      const client = new Client({ name: "codex-mcp-client", version: "0.98.0" });
      const key = await ownerKey(api, "Lu");
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://kb.test/mcp"), {
          fetch: (url, init) => gw.handle(new Request(url, init as RequestInit), "10.3.0.1"),
          requestInit: { headers: { authorization: `Bearer ${key}` } },
        }),
      );
      // join_lobby asks for the exact model id
      const tools = (await client.listTools()).tools;
      expect((tools.find((t) => t.name === "join_lobby")!.inputSchema.properties as Record<string, { description?: string }>).model!.description).toContain("exact model id");
      const joined = (await client.callTool({ name: "join_lobby", arguments: { name: "Luna", model: "gpt-6-luna", soul: SOUL } })) as { isError?: boolean };
      expect(joined.isError).toBeFalsy();
      expect(api.arena.seats[0]).toMatchObject({ name: "Luna", model: "gpt-6-luna", client: "codex-mcp-client/0.98.0" });

      // she plays a round over MCP: the seat row and the round's badge carry her client
      const r = api.arena.playRound();
      const tool = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);
      while ((await tool("wait_for_turn")).status !== "turn");
      expect((await tool("submit_plan", { line: "Luna, via Codex.", strategy: { weapons: ["rocket", "bat"], target: "weakest", stance: "rush" } })).accepted).toBe(true);
      const m = await r;
      expect((await api.store.listSeats(m.id))[0]).toMatchObject({ name: "Luna", client: "codex-mcp-client/0.98.0" });
      const seat = (await call(api, "GET", `/api/matches/${m.id}`)).data.seats[0];
      expect(seat.model).toMatchObject({ key: "self:gpt-6-luna", name: "GPT-6 LUNA" });
      expect(seat.label).toBe("remote/Luna@gpt-6-luna"); // the client is not in the label
      await client.close();
    } finally {
      gw.close();
    }
  });

  test("an HTTP agent's client is its User-Agent, stored with the seat only; one model is one badge and one board row", async () => {
    const api = arenaServer(join(outDir, "http"));
    const zap = await enter(api, "Zap", "Ola", { model: "GPT-6 Luna", userAgent: "codex-mcp-client/0.98.0" });
    const kai = await enter(api, "Kai", "Kim", { model: "openai/gpt-6-luna", userAgent: "claude-code/2.1.0 (darwin)" });
    const cop = await enter(api, "Cop", "Ola", { model: "claude-haiku-5-5", userAgent: "github-copilot-cli/1.4.0" });
    const bare = await enter(api, "Bare", "Kim", { model: "auto" }); // no User-Agent; no model named
    const m = await round(api, [zap, kai, cop, bare]);

    // the client: stored with each seat
    expect((await api.store.listSeats(m.id)).map((s) => [s.name, s.client])).toEqual([
      ["Zap", "codex-mcp-client/0.98.0"],
      ["Kai", "claude-code/2.1.0"],
      ["Cop", "github-copilot-cli/1.4.0"],
      ["Bare", ""],
    ]);
    // ...and nowhere shown: the record's labels carry the model as reported, the badges the cleaned model name only
    const rec = JSON.parse(readFileSync(join(outDir, "http", (await api.store.getRecord(m.id))!.path.replace(/^\/records\//, "")), "utf8"));
    expect(rec.labels).toEqual(["remote/Zap@GPT-6 Luna", "remote/Kai@openai/gpt-6-luna", "remote/Cop@claude-haiku-5-5", "remote/Bare@auto"]);
    const seats = (await call(api, "GET", `/api/matches/${m.id}`)).data.seats as { model: { name: string } }[];
    expect(seats.map((s) => s.model.name)).toEqual(["GPT-6 LUNA", "GPT-6 LUNA", "CLAUDE HAIKU 5.5", "MODEL NOT REPORTED"]);
    expect(modelBadgeHtml(rec.labels[1])).toContain(">GPT-6 LUNA</b>");
    expect(JSON.stringify(seats)).not.toMatch(/codex-mcp|claude-code|copilot/i);

    // the board: Zap and Kai wrote one model two ways: one row, 2 seats
    const board = (await call(api, "GET", "/api/models")).data;
    expect(board.rows.map((r: { key: string; name: string; matches: number }) => [r.key, r.name, r.matches]).sort()).toEqual([
      ["remote:unreported", "MODEL NOT REPORTED", 1],
      ["self:claude-haiku-5-5", "CLAUDE HAIKU 5.5", 1],
      ["self:gpt-6-luna", "GPT-6 LUNA", 2],
    ]);
  });

  test("model ids are cleaned: one model, one id, however it is written", () => {
    const same: [string, string][] = [
      ["gpt-6-luna", "gpt-6-luna"],
      ["GPT-6 Luna", "gpt-6-luna"],
      ["openai/gpt-6-luna", "gpt-6-luna"],
      ["gpt_6_luna", "gpt-6-luna"],
      ["claude-opus-5-5", "claude-opus-5-5"],
      ["Claude Opus 5.5", "claude-opus-5-5"],
      ["anthropic/claude-opus-5.5", "claude-opus-5-5"],
      ["claude-opus-5-5-20261001", "claude-opus-5-5"],
      ["claude-haiku-5-5 (via Copilot)", "claude-haiku-5-5"],
      ["grok-4.6-latest", "grok-4-6"],
      ["Copilot CLI (Auto)", "copilot-cli"],
      ["auto", ""],
      ["Unknown", ""],
    ];
    expect(same.map(([raw]) => [raw, cleanModelId(raw)])).toEqual(same);
    // the badge: the model name only
    const badges: [string, string][] = [
      ["remote/Zap@GPT-6 Luna", "GPT-6 LUNA"],
      ["remote/Kai@claude-opus-5-5-20261001", "CLAUDE OPUS 5.5"],
      ["remote/Oc@grok-4.6", "GROK 4.6"],
      ["remote/Ll@llama-3.1-70b", "LLAMA 3.1 70B"],
      ["remote/Bare@auto", "MODEL NOT REPORTED"],
      ["house", "HOUSE BOT"],
    ];
    expect(badges.map(([label]) => [label, modelOf(label).name])).toEqual(badges);
  });
});
