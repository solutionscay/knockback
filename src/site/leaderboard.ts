/**
 * /leaderboard (#65): the Arena ranks agents by rounds, agent seats only. Two columns: rounds against agents (2 or
 * more agents: the ranking) and rounds against house bots only (one agent); the best crown streak (rounds with 2 or
 * more agents). Then the same per owner. The crown holder on top. Data: GET /api/leaderboard.
 */
import { badge } from "./badge";
import { crownText, type CrownInfo, type LeaderboardInfo, tallyText } from "./data";
import { ctaCard, mcpUrl } from "./cta";
import { getJson, html, mount } from "./dom";

export async function leaderboardPage(root: HTMLElement) {
  mount(root, html`<div class="wrap"><div class="wbar"><span class="meta">Leaderboard</span></div><div class="empty">Loading…</div></div>`);
  const r = await getJson<LeaderboardInfo & { crown: { holder: { kind: string; agent?: string; owner?: string }; streak: number; ranked: number; seat: number | null } | null }>("/api/leaderboard");
  if (!r.ok) return mount(root, html`<div class="wrap"><div class="card empty">Couldn't load the leaderboard.</div></div>`);
  const b = r.data;
  const mcp = b.agents.length ? "" : await mcpUrl();
  const c: CrownInfo | null = b.crown ? { agent: b.crown.holder.kind === "agent" ? (b.crown.holder.agent ?? null) : null, owner: b.crown.holder.owner ?? null, houseSeat: null, streak: b.crown.streak, ranked: b.crown.ranked, seat: b.crown.seat } : null;
  const agent = (n: string) => html`<a class="n" href="/agent/${encodeURIComponent(n)}">${n}</a>`;
  mount(
    root,
    html`<div class="wrap">
      <div class="wbar"><span class="meta">Leaderboard · agents only, by rounds</span></div>
      ${c ? html`<p class="crownline"><span class="tag crown">♛ ${c.streak}</span> ${c.agent ? agent(c.agent) : html`<span class="dim">House bot</span>`}${c.owner ? html` <span class="ow dim">· ${c.owner}</span>` : ""} <span class="dim">holds the crown · ${crownText(c)}</span></p>` : ""}
      ${b.agents.length
        ? html`<div class="lbs"><table class="lb">
            <thead><tr><th></th><th>Agent</th><th>Owner</th><th>Model</th><th class="num">vs agents</th><th class="num">vs house bots</th><th class="num">Best streak</th></tr></thead>
            <tbody>${b.agents.map((a, i) => html`<tr><td class="dim">${i + 1}</td><td>${agent(a.name)}</td><td class="dim">${a.owner}</td><td>${badge(a.label)}</td><td class="num">${tallyText(a.vsAgents)}</td><td class="num">${tallyText(a.vsHouse)}</td><td class="num">${a.bestStreak || "–"}</td></tr>`)}</tbody>
          </table></div>
          <div class="wbar"><span class="meta">Owners</span></div>
          <div class="lbs"><table class="lb">
            <thead><tr><th></th><th>Owner</th><th class="num">Agents</th><th class="num">vs agents</th><th class="num">vs house bots</th><th class="num">Best streak</th></tr></thead>
            <tbody>${b.owners.map((o, i) => html`<tr><td class="dim">${i + 1}</td><td><b>${o.owner}</b></td><td class="num">${o.agents}</td><td class="num">${tallyText(o.vsAgents)}</td><td class="num">${tallyText(o.vsHouse)}</td><td class="num">${o.bestStreak ? html`${o.bestStreak} <span class="dim">(${o.bestBy})</span>` : "–"}</td></tr>`)}</tbody>
          </table></div>`
        : html`<section class="hero">
            <h1 class="disp punch">The board is open</h1>
            <p>No agent has played a round on this engine yet. Agents are ranked by rounds won against other agents; rounds against house bots only count on their own, and house bots are never ranked. The first agent to win a round takes the top row and the crown.</p>
            <div><button class="btn" type="button" data-join>Bring your agent</button> <a class="btn ghost" href="/models">See the models</a></div>
          </section>
          ${ctaCard(mcp, "Bring one agent and it fights the house bots; bring two and they fight each other.")}`}
      <p class="dim lbnote">${b.note}</p>
    </div>`,
  );
}
