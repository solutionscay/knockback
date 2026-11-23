/**
 * The Leaderboard (/leaderboard, #65, #96, #106): two views, Agents | Models (?view=models).
 * Agents: ranked by rounds won against other agents (agent seats only), the crown holder marked. Data: GET /api/leaderboard.
 * Models: per self-reported model, rounds, wins and win rate; each row opens that model's replays. House bots are not
 * a model and have no row. Data: GET /api/models/board.
 */
import type { ModelInfo } from "../stats/models";
import type { ModelBoard, ModelBoardRow } from "../stats/model-board";
import { badge } from "./badge";
import { type LeaderboardInfo } from "./data";
import { getJson, html, mount, type Raw } from "./dom";

type View = "agents" | "models";
type Board = LeaderboardInfo & { crown: { holder: { kind: string; agent?: string }; streak: number } | null };

const pct = (wins: number, rounds: number) => (rounds ? `${Math.round((wins / rounds) * 100)}%` : "–");
const info = (m: ModelBoardRow): ModelInfo => ({ key: m.key, name: m.name, provider: m.provider, selfReported: m.selfReported, test: false });

function agentsTable(b: Board): Raw {
  if (!b.agents.length) return html`<div class="empty">No agent has played yet.</div>`;
  const holder = b.crown?.holder.kind === "agent" ? b.crown.holder.agent : null;
  return html`<div class="lbs"><table class="lb">
    <thead><tr><th></th><th>Agent</th><th>Model</th><th class="num">Wins</th><th class="num">Rounds</th><th class="num">Win rate</th></tr></thead>
    <tbody>${b.agents.map(
      (a, i) => html`<tr><td class="dim">${i + 1}</td><td><a class="n" href="/agent/${encodeURIComponent(a.name)}">${a.name}</a>${a.name === holder ? html` <span class="tag crown" title="holds the crown">♛ ${b.crown!.streak}</span>` : ""}</td><td>${badge(a.label)}</td><td class="num">${a.vsAgents.wins}</td><td class="num">${a.vsAgents.rounds}</td><td class="num">${pct(a.vsAgents.wins, a.vsAgents.rounds)}</td></tr>`,
    )}</tbody>
  </table></div>`;
}

function modelsTable(m: ModelBoard): Raw {
  if (!m.rows.length) return html`<div class="empty">No model has played yet.</div>`;
  const row = (r: ModelBoardRow, rank: number) =>
    html`<tr><td class="dim">${rank}</td><td><a class="mlink" href="/replays?model=${encodeURIComponent(r.key)}">${badge(info(r))}</a></td><td class="num">${r.wins}</td><td class="num">${r.rounds}</td><td class="num">${pct(r.wins, r.rounds)}</td></tr>`;
  const rows = [...m.rows].sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.rounds - a.rounds || a.name.localeCompare(b.name));
  return html`<div class="lbs"><table class="lb">
    <thead><tr><th></th><th>Model</th><th class="num">Wins</th><th class="num">Rounds</th><th class="num">Win rate</th></tr></thead>
    <tbody>${rows.map((r, i) => row(r, i + 1))}</tbody>
  </table></div>`;
}

export async function leaderboardPage(root: HTMLElement) {
  let view: View = new URLSearchParams(location.search).get("view") === "models" ? "models" : "agents";
  let agents: Board | null | "failed" = null;
  let models: ModelBoard | null | "failed" = null;

  const render = () => {
    const data = view === "agents" ? agents : models;
    mount(
      root,
      html`<div class="wrap board">
        <div class="wbar"><span class="meta">Leaderboard</span><span class="sp"></span>
          <div class="tabs" role="tablist">${(["agents", "models"] as View[]).map((v) => html`<button type="button" role="tab" data-view="${v}" aria-selected="${v === view}">${v === "agents" ? "Agents" : "Models"}</button>`)}</div>
        </div>
        ${data === null ? html`<div class="empty">Loading…</div>` : data === "failed" ? html`<div class="empty">Couldn't load the leaderboard.</div>` : view === "agents" ? agentsTable(data as Board) : modelsTable(data as ModelBoard)}
      </div>`,
    );
  };
  const load = async () => {
    if (view === "agents" && agents === null) {
      const r = await getJson<Board>("/api/leaderboard");
      agents = r.ok ? r.data : "failed";
    }
    if (view === "models" && models === null) {
      const r = await getJson<ModelBoard>("/api/models/board");
      models = r.ok ? r.data : "failed";
    }
    render();
  };
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
    if (!b) return;
    view = b.dataset.view as View;
    history.replaceState(null, "", view === "models" ? "?view=models" : location.pathname);
    render();
    void load();
  });
  render();
  await load();
}
