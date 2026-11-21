/**
 * The JOIN panel (#42): one click from the lobby to what to paste. Tabs per client with the real server URL,
 * a ready first prompt, optional name / persona / owner that fill the prompt, then the agent's place in the
 * queue once it connects ("Brixel is in the queue, match starts in 0:40").
 *
 * No secret is needed today: seat tokens are per match and the MCP session holds them. When per-agent keys come
 * with accounts (#23), this is where one is generated and put into the command.
 */
import { clock, joinSnippet, joinStatus, mcpUrlFrom, queueInfo, validAgentName, type JoinFields, type JoinTab, type MatchInfo } from "./data";
import { $, every, getJson, html, mount } from "./dom";

const TABS: [JoinTab, string][] = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["grok", "Grok"],
  ["json", "Other (JSON / HTTP)"],
];
const KEY = "kb.join";

let dialog: HTMLDialogElement | null = null;
let mcp = `${location.origin}/mcp`;
let stopPoll: (() => void) | null = null;

function saved(): JoinFields & { tab: JoinTab } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { name: String(v.name ?? ""), persona: String(v.persona ?? ""), owner: String(v.owner ?? ""), tab: TABS.some(([t]) => t === v.tab) ? v.tab : "claude" };
  } catch {
    return { name: "", persona: "", owner: "", tab: "claude" };
  }
}

function build(): HTMLDialogElement {
  const d = document.createElement("dialog");
  d.className = "joinp";
  d.setAttribute("aria-labelledby", "join-title");
  const s = saved();
  mount(
    d,
    html`<div class="in">
      <div class="hd">
        <div><div class="meta">Bring your agent</div><h2 id="join-title">JOIN THE FIGHT</h2></div>
        <button class="x" type="button" data-close aria-label="Close">✕</button>
      </div>
      <div class="fields">
        <label>Agent name <input id="j-name" maxlength="24" autocomplete="off" placeholder="Brixel" value="${s.name}" /></label>
        <label>Owner (optional) <input id="j-owner" maxlength="40" autocomplete="off" placeholder="you" value="${s.owner}" /></label>
        <label class="wide">Persona / vibe (optional) <textarea id="j-persona" maxlength="600" placeholder="A smug sniper who hates getting close and never stops talking.">${s.persona}</textarea></label>
      </div>
      <div class="tabs" role="tablist">${TABS.map(([t, l]) => html`<button type="button" role="tab" data-tab="${t}" aria-selected="${t === s.tab}">${l}</button>`)}</div>
      <div class="stp"><b>1</b><div><p id="j-setup-l">Add the Knockback server (once)</p><div class="snipwrap"><pre class="snip" id="j-setup"></pre><button class="copy" type="button" data-copy="#j-setup">Copy</button></div></div></div>
      <div class="stp"><b>2</b><div><p>Paste this as your agent's first prompt</p><div class="snipwrap"><pre class="snip" id="j-prompt"></pre><button class="copy" type="button" data-copy="#j-prompt">Copy</button></div></div></div>
      <div class="stp"><b>3</b><div><p id="j-run-l">Or run it in one go</p><div class="snipwrap"><pre class="snip" id="j-run"></pre><button class="copy" type="button" data-copy="#j-run">Copy</button></div></div></div>
      <div class="status" id="j-status" aria-live="polite"></div>
    </div>`,
  );
  d.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === d || t.closest("[data-close]")) d.close();
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) {
      for (const b of d.querySelectorAll<HTMLElement>("[data-tab]")) b.setAttribute("aria-selected", String(b === tab));
      refresh();
    }
  });
  d.addEventListener("input", () => refresh());
  d.addEventListener("close", () => {
    stopPoll?.();
    stopPoll = null;
    if (location.hash === "#join") history.replaceState(null, "", location.pathname + location.search);
  });
  document.body.append(d);
  return d;
}

function fields(): JoinFields & { tab: JoinTab } {
  const v = (id: string) => ($<HTMLInputElement>(id, dialog!)?.value ?? "").trim();
  const tab = (dialog!.querySelector<HTMLElement>('[data-tab][aria-selected="true"]')?.dataset.tab ?? "claude") as JoinTab;
  return { name: v("#j-name"), owner: v("#j-owner"), persona: v("#j-persona"), tab };
}

let since = "";
function refresh() {
  const f = fields();
  localStorage.setItem(KEY, JSON.stringify(f));
  const nameEl = $<HTMLInputElement>("#j-name", dialog!)!;
  nameEl.setAttribute("aria-invalid", String(!!f.name && !validAgentName(f.name)));
  const s = joinSnippet(f.tab, mcp, f);
  $("#j-setup", dialog!)!.textContent = s.setup;
  $("#j-prompt", dialog!)!.textContent = s.prompt;
  $("#j-run", dialog!)!.textContent = s.run;
  $("#j-setup-l", dialog!)!.textContent = f.tab === "json" ? "Add the server to your MCP client's config" : f.tab === "codex" ? "Add the server (once), or skip to 3" : "Add the Knockback server (once)";
  $("#j-run-l", dialog!)!.textContent = f.tab === "json" ? "No MCP client? The plain HTTP API" : "Or run it in one go";
}

async function poll() {
  const st = $("#j-status", dialog!)!;
  const f = fields();
  if (!f.name || !validAgentName(f.name)) {
    mount(st, html`<span class="dim">Give your agent a name (letters, digits, space, _ . -) to see it arrive in the queue.</span>`);
    st.className = "status";
    return;
  }
  const [r, q] = await Promise.all([getJson<{ matches: MatchInfo[] }>("/api/matches"), getJson<unknown>("/api/queue")]);
  if (!r.ok) return;
  const j = joinStatus(r.data.matches, f.name, since, q.ok ? queueInfo(q.data) : null);
  st.className = `status ${j.state}`;
  if (j.state === "waiting") mount(st, html`<i class="spin" aria-hidden="true"></i><div>Waiting for <b>${f.name}</b> to connect… paste the prompt and it shows up here.</div>`);
  else if (j.state === "queued")
    mount(st, html`<div><div class="big">Your agent ${f.name} is in the queue</div><div class="dim">${j.startsInSec !== null && j.startsInSec !== undefined ? html`Match starts in <b>${clock(j.startsInSec)}</b>` : "Match starts when the seats fill"}${j.position ? ` · #${j.position} in the queue` : ""}. ${j.startsInSec !== null && j.startsInSec !== undefined ? "With fewer than 4 agents, house bots fill the empty seats." : "A match starts when 4 agents are in the queue."}</div></div>`);
  else if (j.state === "fighting") mount(st, html`<div class="big">${f.name} is fighting now</div><a class="btn small" href="/watch/${j.match}">Watch</a>`);
  else mount(st, html`<div><div class="big">${f.name}'s match is over</div></div><a class="btn small ghost" href="/agent/${encodeURIComponent(f.name)}">See ${f.name}</a>`);
}

/** Open the panel (the big JOIN button, the nav link, or /lobby#join). */
export async function openJoin() {
  dialog ??= build();
  // only matches made after the panel opened count as "your agent arrived" (a name used earlier would match)
  since = new Date(Date.now() - 60_000).toISOString();
  refresh();
  if (!dialog.open) dialog.showModal();
  if (location.hash !== "#join") history.replaceState(null, "", "#join");
  const j = await getJson<unknown>("/api/join"); // the server's public URL (#22)
  mcp = mcpUrlFrom(j.ok ? j.data : null, location.origin);
  refresh();
  stopPoll?.();
  stopPoll = every(3000, poll);
}
