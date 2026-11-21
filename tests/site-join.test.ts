/**
 * Contract 7: site data. The JOIN panel's MCP config for each client carries the owner key only in an Authorization
 * header or in an environment variable, never in a URL (URLs end up in logs, proxies and shell history).
 */
import { describe, expect, test } from "bun:test";
import { arenaInfo, CODEX_KEY_ENV, joinSnippet, joinStatus, mcpUrlFrom, type JoinTab } from "../src/site/data";

const KEY = "kbk_0123456789abcdef0123456789abcdef";
const MCP = "https://kb.example.test/mcp";
/** Every tab of the JOIN panel: a new JoinTab fails the typecheck here until it is added. */
const TABS = Object.keys({ claude: 1, codex: 1, grok: 1, json: 1 } satisfies Record<JoinTab, 1>) as JoinTab[];

const urlsIn = (s: string) => s.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("JOIN snippets", () => {
  for (const tab of TABS)
    test(`${tab}: the key is in a header or an environment variable, never in a URL`, () => {
      const s = joinSnippet(tab, MCP, KEY);
      expect(s).toContain(KEY);
      expect(urlsIn(s)).toEqual([MCP]); // the MCP URL exactly as given: no ?key=, no key in the path
      // every occurrence of the key sits in a header value or an env assignment
      const allowed = [`Authorization: Bearer ${KEY}`, `"Authorization": "Bearer ${KEY}"`, `export ${CODEX_KEY_ENV}='${KEY}'`];
      const covered = allowed.reduce((n, a) => n + count(s, a), 0);
      expect(count(s, KEY)).toBe(covered);
    });

  test("json: a valid MCP config with the key in headers.Authorization", () => {
    const c = JSON.parse(joinSnippet("json", MCP, KEY));
    expect(c.mcpServers.knockback).toEqual({ type: "http", url: MCP, headers: { Authorization: `Bearer ${KEY}` } });
  });

  test("codex: the config reads the bearer token from the variable the snippet exports", () => {
    const s = joinSnippet("codex", MCP, KEY);
    expect(s).toContain(`export ${CODEX_KEY_ENV}='${KEY}'`);
    expect(s).toContain(`bearer_token_env_var = "${CODEX_KEY_ENV}"`);
    expect(count(s, KEY)).toBe(1); // not also pasted into config.toml
  });

  test("claude and grok: the header is one shell argument", () => {
    for (const tab of ["claude", "grok"] as const) expect(joinSnippet(tab, MCP, KEY)).toContain(`--header 'Authorization: Bearer ${KEY}'`);
  });

  test("the MCP URL the panel uses comes from the server, else this origin", () => {
    expect(mcpUrlFrom({ mcp: "https://kb.example.test/mcp" }, "http://localhost:5176")).toBe(MCP);
    expect(mcpUrlFrom({ publicUrl: "https://kb.example.test/" }, "http://localhost:5176")).toBe(MCP);
    expect(mcpUrlFrom(null, "http://localhost:5176")).toBe("http://localhost:5176/mcp");
  });
});

/**
 * The JOIN panel's status (#42, #64) read from the real server's GET /api/queue: where the owner's agent is in the
 * Arena (waiting for it, seated with the round it enters, queued with its place, fighting in the round on now).
 * In-process server, no port; the one round played waits for the agent's plan (no timer decides anything).
 */
describe("JOIN panel status from the Arena", () => {
  test("seated, queued, fighting, or not there yet", async () => {
    const { MatchServer } = await import("../src/server/match-server");
    const { initPhysics } = await import("../src/sim");
    await initPhysics();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const outDir = mkdtempSync(`${(await import("node:os")).tmpdir()}/kb-site-join-`);
    const api = new MatchServer({ outDir, pace: "fast", arena: { deadlineMs: 600_000 } });
    let ip = 0;
    const req = async (method: string, path: string, auth?: string, body?: unknown) =>
      (await (await api.handle(new Request(`http://kb.test${path}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), `10.7.0.${++ip}`))!.json()) as any;
    const tokens: string[] = [];
    for (const owner of ["Ann", "Ben", "Cat", "Dan", "Eli"]) {
      const { key } = await req("POST", "/api/keys", undefined, { owner });
      tokens.push((await req("POST", "/api/queue", key, { name: `${owner}Bot`, model: "claude-opus-5-5", soul: "A loud brawler who loves the bat and never backs down, ever." })).token);
    }
    const status = async (owner: string) => joinStatus(arenaInfo(await req("GET", "/api/queue")), owner);
    expect(await status("ann")).toMatchObject({ state: "seated", agent: "AnnBot", entersRound: 1 });
    expect(await status("Eli")).toMatchObject({ state: "queued", agent: "EliBot", position: 1 });
    expect(await status("Zed")).toEqual({ state: "waiting" });

    const round = api.arena.playRound();
    while ((await req("GET", "/api/arena/turn?wait=30", tokens[0])).status !== "turn");
    expect(await status("Ann")).toMatchObject({ state: "fighting", agent: "AnnBot", match: api.arena.current!.id });
    for (const t of tokens.slice(0, 4)) await req("POST", "/api/arena/leave", t);
    await round;
    rmSync(outDir, { recursive: true, force: true });
  });
});
