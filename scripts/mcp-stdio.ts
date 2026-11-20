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
 * Logs go to stderr (stdout is the MCP channel).
 */
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

const upstream = new Client({ name: "knockback-stdio", version: "0.2.0" });
await upstream.connect(new StreamableHTTPClientTransport(url));
log(`connected to ${url} (session ${upstream.transport && "sessionId" in upstream.transport ? (upstream.transport as StreamableHTTPClientTransport).sessionId : "?"})`);

const server = new Server(
  { name: "knockback", version: "0.2.0" },
  { capabilities: { tools: {} }, ...(upstream.getInstructions() ? { instructions: upstream.getInstructions() } : {}) },
);
server.setRequestHandler(ListToolsRequestSchema, async (req) => upstream.listTools(req.params));
// the wait_* tools take up to ~25 s: allow well over that before giving up
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => upstream.callTool(req.params, undefined, { timeout: 120_000, signal: extra.signal }));

const stdio = new StdioServerTransport();
stdio.onclose = () => {
  void upstream.close().finally(() => process.exit(0));
};
await server.connect(stdio);
log("ready on stdio");
