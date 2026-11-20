/**
 * stdio wrapper for the Knockback MCP server (#21): for MCP clients that only
 * start local stdio servers. It connects to a match server's /mcp over
 * Streamable HTTP and passes tools/list and tools/call through, so the agent
 * sees the same six tools (and the same session: one wrapper process = one
 * MCP session = one seat).
 *
 *   bun scripts/mcp-stdio.ts --server https://YOUR-SERVER/mcp
 *   bun scripts/mcp-stdio.ts                                   # KB_SERVER, else http://localhost:5176
 *
 * In a client's config: command "bun", args ["<repo>/scripts/mcp-stdio.ts", "--server", "<url>"].
 *
 * --session-file <path> keeps the MCP session id in that file: a wrapper (and
 * the agent behind it) that is restarted with the same file reattaches to the
 * same session, and so to the same seat; an agent that dropped mid-match gets
 * its fighter back from the house bot at the next round (#22).
 * Logs go to stderr (stdout is the MCP channel).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const argv = process.argv.slice(2);
const at = argv.indexOf("--server");
const base = (at >= 0 ? argv[at + 1] : process.env.KB_SERVER) ?? "http://localhost:5176";
const url = new URL(base.replace(/\/$/, "").replace(/\/mcp$/, "") + "/mcp");
const log = (s: string) => process.stderr.write(`[knockback-mcp] ${s}\n`);

const sf = argv.indexOf("--session-file");
const sessionFile = sf >= 0 ? argv[sf + 1] : undefined;
const saved: { url?: string; sessionId?: string; instructions?: string } = sessionFile && existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8")) : {};

let upstream = new Client({ name: "knockback-stdio", version: "0.2.0" });
let transport: StreamableHTTPClientTransport;
let instructions: string | undefined;
if (saved.sessionId && saved.url === url.href) {
  // reattach: the SDK client skips initialize when the transport already has a session id
  transport = new StreamableHTTPClientTransport(url, { sessionId: saved.sessionId });
  await upstream.connect(transport);
  try {
    await upstream.listTools();
    instructions = saved.instructions;
    log(`reattached to session ${saved.sessionId}`);
  } catch (e) {
    log(`session ${saved.sessionId} is gone (${e instanceof Error ? e.message : e}); starting a new one`);
    await upstream.close().catch(() => undefined);
    upstream = new Client({ name: "knockback-stdio", version: "0.2.0" });
    saved.sessionId = undefined;
  }
}
if (!instructions && !saved.sessionId) {
  transport = new StreamableHTTPClientTransport(url);
  await upstream.connect(transport);
  instructions = upstream.getInstructions();
}
if (sessionFile) writeFileSync(sessionFile, JSON.stringify({ url: url.href, sessionId: transport!.sessionId, instructions }, null, 2));
log(`connected to ${url} (session ${transport!.sessionId})`);

const server = new Server({ name: "knockback", version: "0.2.0" }, { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });
server.setRequestHandler(ListToolsRequestSchema, async (req) => upstream.listTools(req.params));
// the wait_* tools take up to ~25 s: allow well over that before giving up
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => upstream.callTool(req.params, undefined, { timeout: 120_000, signal: extra.signal }));

const stdio = new StdioServerTransport();
stdio.onclose = () => {
  void upstream.close().finally(() => process.exit(0));
};
await server.connect(stdio);
log("ready on stdio");
