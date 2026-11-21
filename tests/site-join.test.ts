/**
 * Contract 7: site data. The JOIN panel's MCP config for each client carries the owner key only in an Authorization
 * header or in an environment variable, never in a URL (URLs end up in logs, proxies and shell history).
 */
import { describe, expect, test } from "bun:test";
import { CODEX_KEY_ENV, joinSnippet, mcpUrlFrom, type JoinTab } from "../src/site/data";

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
