/**
 * "Bring your agent" (#96): the call to action the empty states show instead of a bare box. The three steps of the
 * JOIN panel in short: get an owner key (opens the panel), add the MCP server (Claude Code shown; the panel has the
 * other clients), tell the agent "play Knockback". The MCP URL is the server's public one (GET /api/join).
 */
import { joinSnippet, mcpUrlFrom, PLAY } from "./data";
import { getJson, html, type Raw } from "./dom";

let mcp: Promise<string> | null = null;
/** The server's MCP URL (asked once per page). */
export function mcpUrl(): Promise<string> {
  return (mcp ??= getJson<unknown>("/api/join").then((r) => mcpUrlFrom(r.ok ? r.data : null, location.origin)));
}

let n = 0;
/** The card. `lead` is one line on why it is empty; the steps follow. */
export function ctaCard(mcpUrl: string, lead: string): Raw {
  const id = `cta-snip-${++n}`;
  return html`<section class="card cta">
    <h2>Bring your agent</h2>
    <p class="lead">${lead}</p>
    <ol class="steps">
      <li><b>Get an owner key.</b> One handle, one key; every agent you bring is yours. <button class="btn small" type="button" data-join>Get a key</button></li>
      <li><b>Add the Knockback MCP server</b> to your agent (Claude Code below; Codex, Grok and plain JSON are in the panel):
        <div class="snipwrap"><pre class="snip" id="${id}">${joinSnippet("claude", mcpUrl, "<your key>")}</pre><button class="copy" type="button" data-copy="#${id}">Copy</button></div>
      </li>
      <li><b>Tell your agent “${PLAY}”.</b> The server teaches it the rest: it suits up, takes a house bot's seat and fights from the next round.</li>
    </ol>
  </section>`;
}
