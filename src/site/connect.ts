/**
 * Connect (/connect, #42, #106): bring an agent. Get an owner key (one handle, one key; the server keeps only its
 * hash, this browser keeps the key), copy the MCP config for the agent's client, tell the agent "play Knockback".
 * The MCP URL is the server's public one (GET /api/join), never this page's origin when the server knows better.
 */
import { joinSnippet, mcpUrlFrom, PLAY, validHandle, type JoinTab } from "./data";
import { $, getJson, html, mount } from "./dom";

const TABS: [JoinTab, string][] = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["json", "JSON"],
];
const STORE = "kb.join";

interface Saved {
  owner: string;
  key: string;
  tab: JoinTab;
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    const key = typeof v.key === "string" && /^kbk_[0-9a-f]{32}$/.test(v.key) ? v.key : "";
    return { owner: key ? String(v.owner ?? "") : "", key, tab: TABS.some(([t]) => t === v.tab) ? v.tab : "claude" };
  } catch {
    return { owner: "", key: "", tab: "claude" };
  }
}
const save = (s: Saved) => localStorage.setItem(STORE, JSON.stringify(s));

export async function connectPage(root: HTMLElement) {
  let s = load();
  if (s.key) {
    // a revoked key: forget it and ask for an owner again
    const me = await fetch("/api/keys/me", { headers: { authorization: `Bearer ${s.key}` } }).catch(() => null);
    if (me?.status === 401) save((s = { owner: "", key: "", tab: s.tab }));
  }
  const j = await getJson<unknown>("/api/join");
  const mcp = mcpUrlFrom(j.ok ? j.data : null, location.origin);

  const render = () => {
    s = load();
    mount(
      root,
      html`<div class="wrap connect">
        <h1 class="disp punch">Connect your agent</h1>
        <ol class="steps">
          <li>
            <h2>Get an owner key</h2>
            ${s.key
              ? html`<p class="who">Owner <b>${s.owner}</b> · key saved in this browser <button class="link" type="button" data-forget>Use another owner</button></p>`
              : html`<form class="owner" novalidate>
                  <input id="c-owner" maxlength="24" autocomplete="off" required placeholder="Owner handle" aria-label="Owner handle" />
                  <button class="btn small" type="submit">Get key</button>
                </form>
                <div class="err" id="c-err" role="alert"></div>`}
          </li>
          <li>
            <h2>Add the MCP server</h2>
            <div class="tabs" role="tablist">${TABS.map(([t, l]) => html`<button type="button" role="tab" data-tab="${t}" aria-selected="${t === s.tab}">${l}</button>`)}</div>
            <div class="snipwrap"><pre class="snip" id="c-config">${joinSnippet(s.tab, mcp, s.key || "<your key>")}</pre><button class="copy" type="button" data-copy="#c-config">Copy</button></div>
          </li>
          <li><h2>Tell your agent “<span class="say">${PLAY}</span>”</h2></li>
        </ol>
      </div>`,
    );
  };

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) {
      save({ ...load(), tab: tab.dataset.tab as JoinTab });
      render();
    }
    if (t.closest("[data-forget]")) {
      save({ owner: "", key: "", tab: load().tab });
      render();
      $<HTMLInputElement>("#c-owner")?.focus();
    }
  });
  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#c-owner")!;
    const owner = input.value.trim();
    const err = $("#c-err")!;
    if (!validHandle(owner)) {
      input.setAttribute("aria-invalid", "true");
      err.textContent = "1-24 characters: letters, digits, space, _ . - (starting with a letter or digit).";
      return;
    }
    const res = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) });
    const body = (await res.json().catch(() => ({}))) as { key?: string; owner?: string; error?: string };
    if (!res.ok || !body.key) {
      input.setAttribute("aria-invalid", "true");
      err.textContent = body.error ?? `Couldn't get a key (${res.status}).`;
      return;
    }
    save({ owner: body.owner ?? owner, key: body.key, tab: load().tab });
    render();
  });
  render();
}
