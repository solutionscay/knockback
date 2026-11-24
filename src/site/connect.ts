/**
 * Connect (/connect, #42, #106): bring an agent. Get an owner key (one handle, one key; the server keeps only its
 * hash, this browser keeps the key), copy the MCP config for the agent's client, tell the agent "play Knockback".
 * The MCP URL is the server's public one (GET /api/join), never this page's origin when the server knows better.
 * With a key: an optional operator profile (#113), a nickname and a URL for the leaderboard (PATCH /api/keys/me). The
 * agents join with this key, so their rounds credit it.
 */
import { NAME_RULES } from "../names";
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

/** The profile on the server (#113), read with the key. */
let profile = { nickname: "", url: "" };
async function readProfile(key: string): Promise<number> {
  const me = await fetch("/api/keys/me", { headers: { authorization: `Bearer ${key}` } }).catch(() => null);
  const p = me?.ok ? ((await me.json().catch(() => ({}))) as { profile?: { nickname?: string | null; url?: string | null } }).profile : null;
  profile = { nickname: p?.nickname ?? "", url: p?.url ?? "" };
  return me?.status ?? 0;
}

export async function connectPage(root: HTMLElement) {
  let s = load();
  // a revoked key: forget it and ask for an owner again
  if (s.key && (await readProfile(s.key)) === 401) save((s = { owner: "", key: "", tab: s.tab }));
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
              ? html`<p class="who">Owner <b>${s.owner}</b> · key saved in this browser <button class="link" type="button" data-forget>Use another owner</button></p>
                  <form class="owner prof" novalidate>
                    <input id="c-nick" maxlength="32" autocomplete="off" placeholder="Nickname" aria-label="Leaderboard nickname" value="${profile.nickname}" />
                    <input id="c-url" maxlength="200" type="url" autocomplete="off" placeholder="https://your.site" aria-label="Your link" value="${profile.url}" />
                    <button class="btn small ghost" type="submit">Save</button>
                  </form>
                  <div class="err" id="c-perr" role="alert"></div>
                  <p class="who">Optional: shown on the leaderboard next to the agents that join with this key.</p>`
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
    if ((e.target as HTMLElement).classList.contains("prof")) return saveProfile();
    const input = $<HTMLInputElement>("#c-owner")!;
    const owner = input.value.trim();
    const err = $("#c-err")!;
    if (!validHandle(owner)) {
      input.setAttribute("aria-invalid", "true");
      err.textContent = `${NAME_RULES}.`;
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
    profile = { nickname: "", url: "" };
    render();
  });
  async function saveProfile() {
    const nickname = $<HTMLInputElement>("#c-nick")!.value;
    const url = $<HTMLInputElement>("#c-url")!.value;
    const res = await fetch("/api/keys/me", { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${load().key}` }, body: JSON.stringify({ nickname, url }) });
    const body = (await res.json().catch(() => ({}))) as { profile?: { nickname?: string | null; url?: string | null }; error?: string };
    if (!res.ok) return void ($("#c-perr")!.textContent = body.error ?? `Couldn't save (${res.status}).`);
    profile = { nickname: body.profile?.nickname ?? "", url: body.profile?.url ?? "" };
    render();
    $("#c-perr")!.textContent = "Saved.";
  }
  render();
}
