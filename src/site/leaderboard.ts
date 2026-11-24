/**
 * The Leaderboard (/leaderboard, #65, #96, #106): two views, Agents | Models (?view=models).
 * Agents: ranked by rounds won against other agents (agent seats only), the crown holder marked. Data: GET /api/leaderboard.
 * Models: per self-reported model, rounds, wins and win rate; each row opens that model's replays. House bots are not
 * a model and have no row. Data: GET /api/models/board.
 * Operators (#113): "by <nickname>" under an agent or model, linked to the operator's URL (nofollow ugc). The operator
 * view (?operator=<id>): one operator's nickname, URL, agents and record, from the same data.
 */
import type { ModelInfo } from "../stats/models";
import type { ModelBoard, ModelBoardRow } from "../stats/model-board";
import { badge } from "./badge";
import { operatorOf, type LeaderboardInfo, type OperatorInfo } from "./data";
import { getJson, html, mount, type Raw } from "./dom";

type View = "agents" | "models";

/** The operator's nickname, linked to their URL when they gave one: an outsider's link, so nofollow ugc (pure). */
export function operatorLink(o: OperatorInfo): Raw {
  return o.url ? html`<a class="op" href="${o.url}" rel="nofollow ugc noopener" target="_blank">${o.nickname}</a>` : html`<span class="op">${o.nickname}</span>`;
}
const byLine = (ops: OperatorInfo[]): Raw => (ops.length ? html`<div class="opby">by ${ops.map((o, i) => html`${i ? ", " : ""}${operatorLink(o)}`)}</div>` : html``);
type Board = LeaderboardInfo & { crown: { holder: { kind: string; agent?: string }; streak: number } | null };

const pct = (wins: number, rounds: number) => (rounds ? `${Math.round((wins / rounds) * 100)}%` : "–");
const info = (m: ModelBoardRow): ModelInfo => ({ key: m.key, name: m.name, provider: m.provider, selfReported: m.selfReported, test: false });

/** The agents table; with `only`, that operator's agents (the operator view). */
export function agentsTable(b: Board, only: string | null = null): Raw {
  const rows = only ? b.agents.filter((a) => operatorOf(a.operator)?.id === only) : b.agents;
  if (!rows.length) return html`<div class="empty">No agent has played yet.</div>`;
  const holder = b.crown?.holder.kind === "agent" ? b.crown.holder.agent : null;
  return html`<div class="lbs"><table class="lb">
    <thead><tr><th></th><th>Agent</th><th>Model</th><th class="num">Wins</th><th class="num">Rounds</th><th class="num">Win rate</th></tr></thead>
    <tbody>${rows.map(
      (a, i) => html`<tr><td class="dim">${i + 1}</td><td><a class="n" href="/agent/${encodeURIComponent(a.name)}">${a.name}</a>${a.name === holder ? html` <span class="tag crown" title="holds the crown">♛ ${b.crown!.streak}</span>` : ""}${only ? "" : byLine([operatorOf(a.operator)].filter((o): o is OperatorInfo => o !== null))}</td><td>${badge(a.label)}</td><td class="num">${a.vsAgents.wins}</td><td class="num">${a.vsAgents.rounds}</td><td class="num">${pct(a.vsAgents.wins, a.vsAgents.rounds)}</td></tr>`,
    )}</tbody>
  </table></div>`;
}

/** The operator view's head: nickname, URL, and the record of their agents against agents (pure). */
export function operatorHead(b: Board, id: string): Raw {
  const mine = b.agents.filter((a) => operatorOf(a.operator)?.id === id);
  const o = mine.length ? operatorOf(mine[0]!.operator) : null;
  if (!o) return html`<div class="empty">No operator with that id on the board.</div>`;
  const t = mine.reduce((s, a) => ({ rounds: s.rounds + a.vsAgents.rounds, wins: s.wins + a.vsAgents.wins }), { rounds: 0, wins: 0 });
  return html`<section class="ophead"><h1 class="nm">${o.nickname}</h1>${o.url ? html`<a class="op" href="${o.url}" rel="nofollow ugc noopener" target="_blank">${new URL(o.url).host}</a>` : ""}<div class="line">${mine.length} agent${mine.length === 1 ? "" : "s"} · ${t.wins} won of ${t.rounds} round${t.rounds === 1 ? "" : "s"} against agents</div></section>`;
}

function modelsTable(m: ModelBoard & { rows: (ModelBoardRow & { operators?: unknown[] })[] }): Raw {
  if (!m.rows.length) return html`<div class="empty">No model has played yet.</div>`;
  const row = (r: ModelBoardRow & { operators?: unknown[] }, rank: number) =>
    html`<tr><td class="dim">${rank}</td><td><a class="mlink" href="/replays?model=${encodeURIComponent(r.key)}">${badge(info(r))}</a>${byLine((r.operators ?? []).map(operatorOf).filter((o): o is OperatorInfo => o !== null).slice(0, 3))}</td><td class="num">${r.wins}</td><td class="num">${r.rounds}</td><td class="num">${pct(r.wins, r.rounds)}</td></tr>`;
  const rows = [...m.rows].sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.rounds - a.rounds || a.name.localeCompare(b.name));
  return html`<div class="lbs"><table class="lb">
    <thead><tr><th></th><th>Model</th><th class="num">Wins</th><th class="num">Rounds</th><th class="num">Win rate</th></tr></thead>
    <tbody>${rows.map((r, i) => row(r, i + 1))}</tbody>
  </table></div>`;
}

export async function leaderboardPage(root: HTMLElement) {
  const q = new URLSearchParams(location.search);
  let view: View = q.get("view") === "models" ? "models" : "agents";
  // the operator view (#113): ?operator=<id>
  const operator = /^op_[0-9a-f]{16}$/.test(q.get("operator") ?? "") ? q.get("operator") : null;
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
        ${data === null ? html`<div class="empty">Loading…</div>` : data === "failed" ? html`<div class="empty">Couldn't load the leaderboard.</div>` : view === "agents" ? html`${operator ? operatorHead(data as Board, operator) : ""}${agentsTable(data as Board, operator)}` : modelsTable(data as ModelBoard)}
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
