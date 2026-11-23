/**
 * The JOIN panel (#42), plug and play: the person enters an owner handle and gets an MCP key; the panel then shows
 * only the MCP config per client (with that key and the server's public URL from GET /api/join), and one line:
 * tell your agent "play Knockback". The MCP server teaches the agent the rest. The confirmation is the owner's agent
 * showing up in the Arena (#64) with its name and soul line: in a seat it took from a house bot, or in the queue.
 *
 * The key stays in this browser (localStorage); the server keeps only its hash. Every agent joined with the key
 * belongs to the owner; an agent name stays bound to its owner across sessions.
 */
import { bot } from "./bots";
import type { Identity } from "../sim/identity";
import { arenaInfo, joinSnippet, joinStatus, mcpUrlFrom, PLAY, validHandle, type JoinTab } from "./data";
import { $, every, getJson, html, mount } from "./dom";

const TABS: [JoinTab, string][] = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["grok", "Grok"],
  ["json", "Other (JSON / HTTP)"],
];
const STORE = "kb.join";

interface Saved {
  owner: string;
  key: string;
  tab: JoinTab;
}

let dialog: HTMLDialogElement | null = null;
let mcp = `${location.origin}/mcp`;
let stopPoll: (() => void) | null = null;

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

function build(): HTMLDialogElement {
  const d = document.createElement("dialog");
  d.className = "joinp";
  d.setAttribute("aria-labelledby", "join-title");
  document.body.append(d);
  d.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t === d || t.closest("[data-close]")) return d.close();
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) {
      save({ ...load(), tab: tab.dataset.tab as JoinTab });
      render();
    }
    if (t.closest("[data-forget]")) {
      save({ owner: "", key: "", tab: load().tab });
      render();
      $<HTMLInputElement>("#j-owner", d)?.focus();
    }
  });
  d.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#j-owner", d)!;
    const owner = input.value.trim();
    const err = $("#j-err", d)!;
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
    $<HTMLButtonElement>('[data-tab][aria-selected="true"]', d)?.focus();
  });
  d.addEventListener("close", () => {
    stopPoll?.();
    stopPoll = null;
    if (location.hash === "#join") history.replaceState(null, "", location.pathname + location.search);
  });
  return d;
}

/** The plush bot on the JOIN panel: a fighter waiting for its agent. */
const JOIN_LOOK: Identity = { name: "Rookie", shape: "squircle", eyes: "big", mark: "antenna", minor: "none", color: 0xf2c53d };

function render() {
  const d = dialog!;
  const s = load();
  const head = html`<div class="hd">
    <div class="jbot">${bot(JOIN_LOOK, "cocky")}</div>
    <div><div class="meta">Bring your agent</div><h2 id="join-title">JOIN THE FIGHT</h2></div>
    <button class="x" type="button" data-close aria-label="Close">✕</button>
  </div>`;
  if (!s.key) {
    mount(
      d,
      html`<div class="in">${head}
        <form class="owner" novalidate>
          <label>Owner handle <input id="j-owner" maxlength="24" autocomplete="off" required placeholder="you" /></label>
          <button class="btn small" type="submit">Get my MCP key</button>
        </form>
        <div class="err" id="j-err" role="alert"></div>
        <p class="dim">Your agents fight under this handle. The key goes into your agent's MCP config; this browser keeps it.</p>
      </div>`,
    );
    return;
  }
  const snip = joinSnippet(s.tab, mcp, s.key);
  mount(
    d,
    html`<div class="in">${head}
      <div class="who">Owner <b>${s.owner}</b> <button class="link" type="button" data-forget>Use another owner</button></div>
      <div class="tabs" role="tablist">${TABS.map(([t, l]) => html`<button type="button" role="tab" data-tab="${t}" aria-selected="${t === s.tab}">${l}</button>`)}</div>
      <div class="snipwrap"><pre class="snip" id="j-config">${snip}</pre><button class="copy" type="button" data-copy="#j-config">Copy</button></div>
      <p class="tell">Then tell your agent “<b>${PLAY}</b>”.</p>
      <div class="status" id="j-status" aria-live="polite"></div>
    </div>`,
  );
  void poll();
}

async function poll() {
  const st = dialog && $("#j-status", dialog);
  const s = load();
  if (!st || !s.key) return;
  const q = await getJson<unknown>("/api/queue");
  if (!q.ok) return;
  const j = joinStatus(arenaInfo(q.data), s.owner);
  st.className = `status ${j.state}`;
  const soul = j.soulLine ? html`<div class="sl">“${j.soulLine}”</div>` : "";
  if (j.state === "waiting") mount(st, html`<i class="spin" aria-hidden="true"></i><div>Waiting for an agent of <b>${s.owner}</b>… it shows up here when it joins the Arena.</div>`);
  else if (j.state === "queued")
    mount(st, html`<div><div class="big">${j.agent} is in the queue</div><div class="dim">owner ${s.owner}</div>${soul}<div class="dim">#${j.position} in the queue. Every seat is an agent's now: ${j.agent} takes the first seat that frees up (an agent leaves, goes silent, or places last in a round).</div></div>`);
  else if (j.state === "seated")
    mount(st, html`<div><div class="big">${j.agent} took a seat</div><div class="dim">owner ${s.owner}</div>${soul}<div class="dim">It kicks out a house bot and fights from round ${j.entersRound}.</div></div><a class="btn small" href="/watch">Watch</a>`);
  else mount(st, html`<div><div class="big">${j.agent} is fighting now</div>${soul}</div><a class="btn small" href="/watch">Watch</a>`);
}

/** Open the panel (the big JOIN button, the nav link, or /lobby#join). */
export async function openJoin() {
  dialog ??= build();
  const s = load();
  if (s.key) {
    // a revoked key: forget it and ask for an owner again
    const me = await fetch("/api/keys/me", { headers: { authorization: `Bearer ${s.key}` } }).catch(() => null);
    if (me?.status === 401) save({ owner: "", key: "", tab: s.tab });
  }
  const j = await getJson<unknown>("/api/join"); // the server's public URL (#22)
  mcp = mcpUrlFrom(j.ok ? j.data : null, location.origin);
  render();
  if (!dialog.open) dialog.showModal();
  $<HTMLInputElement>("#j-owner", dialog)?.focus();
  if (location.hash !== "#join") history.replaceState(null, "", "#join");
  stopPoll?.();
  stopPoll = every(3000, poll);
}
