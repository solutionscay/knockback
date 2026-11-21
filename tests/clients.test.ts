/**
 * Contract (#76): each agent's client is recorded next to the model it claims, and badges show both. An MCP agent's
 * client comes from its `initialize` request (clientInfo name and version); an HTTP agent's from its User-Agent. It is
 * stored with the seat and carried in the record's seat label; badges read "GPT-6 · via Codex", or the client alone
 * ("COPILOT CLI") when the agent named no model. The model board groups by the claimed model, lists the clients and
 * can be filtered by one.
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
import { badgeText, modelOf } from "../src/stats/models";
import { modelBadgeHtml } from "../src/viewer/model-badge";
import { arenaServer, call, enter, ownerKey, round, SOUL } from "./helpers/arena";

const outDir = mkdtempSync(join(tmpdir(), "kb-clients-"));
beforeAll(async () => {
  await initPhysics();
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("the agent's client (#76)", () => {
  test("an MCP agent's client comes from initialize: stored with the seat, in the record, on the badge", async () => {
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
      const joined = (await client.callTool({ name: "join_lobby", arguments: { name: "Luna", model: "GPT-6", soul: SOUL } })) as { isError?: boolean };
      expect(joined.isError).toBeFalsy();
      expect(api.arena.seats[0]).toMatchObject({ name: "Luna", model: "GPT-6", client: "codex-mcp-client/0.98.0" });

      // she plays a round over MCP: the seat row and the round's badge carry her client
      const r = api.arena.playRound();
      const tool = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);
      while ((await tool("wait_for_turn")).status !== "turn");
      expect((await tool("submit_plan", { line: "Luna, via Codex.", strategy: { weapons: ["rocket", "bat"], target: "weakest", stance: "rush" } })).accepted).toBe(true);
      const m = await r;
      expect((await api.store.listSeats(m.id))[0]).toMatchObject({ name: "Luna", client: "codex-mcp-client/0.98.0" });
      expect(badgeText((await call(api, "GET", `/api/matches/${m.id}`)).data.seats[0].model)).toBe("GPT-6 · via Codex");
      await client.close();
    } finally {
      gw.close();
    }
  });

  test("an HTTP agent's client is its User-Agent; seats, records and badges carry it; the board groups by the claimed model", async () => {
    const api = arenaServer(join(outDir, "http"));
    const zap = await enter(api, "Zap", "Ola", { model: "GPT-6", userAgent: "codex-mcp-client/0.98.0" });
    const kai = await enter(api, "Kai", "Kim", { model: "gpt-6", userAgent: "claude-code/2.1.0 (darwin)" });
    const cop = await enter(api, "Cop", "Ola", { model: "Copilot CLI (Auto)", userAgent: "github-copilot-cli/1.4.0" });
    const bare = await enter(api, "Bare", "Kim"); // no User-Agent sent
    const m = await round(api, [zap, kai, cop, bare]);

    // stored with each seat
    expect((await api.store.listSeats(m.id)).map((s) => [s.name, s.client])).toEqual([
      ["Zap", "codex-mcp-client/0.98.0"],
      ["Kai", "claude-code/2.1.0"],
      ["Cop", "github-copilot-cli/1.4.0"],
      ["Bare", ""],
    ]);
    // in the record: each agent seat's label names its model and client
    const rec = JSON.parse(readFileSync(join(outDir, "http", (await api.store.getRecord(m.id))!.path.replace(/^\/records\//, "")), "utf8"));
    expect(rec.labels).toEqual(["remote/Zap@GPT-6|codex-mcp-client/0.98.0", "remote/Kai@gpt-6|claude-code/2.1.0", "remote/Cop@Copilot CLI (Auto)|github-copilot-cli/1.4.0", "remote/Bare@claude-opus-5-5"]);
    // on the badges: the round's seats as the site and the viewer show them
    const seats = (await call(api, "GET", `/api/matches/${m.id}`)).data.seats as { model: Parameters<typeof badgeText>[0] }[];
    expect(seats.map((s) => badgeText(s.model))).toEqual(["GPT-6 · via Codex", "GPT-6 · via Claude Code", "COPILOT CLI", "CLAUDE OPUS 5.5"]);
    expect(modelBadgeHtml(rec.labels[0])).toContain(">GPT-6 · via Codex</b>");

    // the board: one GPT-6 row (the claim groups it) with both clients; Copilot by its client; a filter by client
    const board = (await call(api, "GET", "/api/models")).data;
    const gpt = board.rows.find((r: { key: string }) => r.key === "self:gpt-6");
    expect(gpt).toMatchObject({ matches: 2, clients: [{ name: "Claude Code", seats: 1 }, { name: "Codex", seats: 1 }] });
    expect(board.rows.map((r: { key: string }) => r.key).sort()).toEqual(["client:copilot-cli", "self:claude-opus-5-5", "self:gpt-6"]);
    expect(board.clients).toEqual(["Claude Code", "Codex", "Copilot CLI"]);
    const codex = (await call(api, "GET", "/api/models?client=codex")).data;
    expect(codex.rows.map((r: { key: string; matches: number }) => [r.key, r.matches])).toEqual([["self:gpt-6", 1]]);
  });

  test("badge text: the claimed model and the client; the client alone when no model was named", () => {
    const cases: [string, string][] = [
      ["remote/Zap@GPT-6|codex-mcp-client/0.98.0", "GPT-6 · via Codex"],
      ["remote/Kai@claude-opus-5-5|claude-code/2.1.0", "CLAUDE OPUS 5.5 · via Claude Code"],
      ["remote/Cop@Copilot CLI (Auto)|github-copilot-cli/1.4.0", "COPILOT CLI"],
      ["remote/Oc@auto|opencode/0.3.1", "OPENCODE"],
      ["remote/Raw@llama-4|my-harness/2", "LLAMA 4 · via my-harness"],
      ["remote/Bare@claude-opus-5-5", "CLAUDE OPUS 5.5"],
      ["remote/Bare@auto", "MODEL NOT REPORTED"],
      ["house", "HOUSE BOT"],
    ];
    expect(cases.map(([label]) => [label, badgeText(modelOf(label))])).toEqual(cases);
  });
});
