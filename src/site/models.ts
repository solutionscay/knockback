/**
 * /models (#96): which model wins in the Arena. One row per model an agent said it runs: rounds, wins, win rate, K/D,
 * damage per round, favourite weapon and build, best crown streak, its agents (plush heads), the recent form and its
 * replays. Sortable by any column (the headers, or the select on a phone, where each row is a card). The page shows the
 * models and nothing else: no explainers (header tooltips only). Data: GET /api/models/board (src/stats/model-board.ts).
 */
import type { ModelInfo } from "../stats/models";
import type { ModelBoard, ModelBoardRow } from "../stats/model-board";
import { badge } from "./badge";
import { cleanIdentity, head } from "./bots";
import { cap } from "./data";
import { every, getJson, html, mount, type Raw } from "./dom";

export type SortKey = "wins" | "rounds" | "winRate" | "kd" | "damagePerRound" | "bestStreak" | "name" | "lastAt";
const SORTS: [SortKey, string][] = [
  ["wins", "Wins"],
  ["winRate", "Win rate"],
  ["rounds", "Rounds"],
  ["kd", "K/D"],
  ["damagePerRound", "Damage"],
  ["bestStreak", "Best streak"],
  ["lastAt", "Last played"],
  ["name", "Name"],
];

/** Rows in the order of a column, best first; ties by rounds, then name (pure: tested). */
export function sortRows(rows: readonly ModelBoardRow[], key: SortKey): ModelBoardRow[] {
  const v = (r: ModelBoardRow): number | string => (key === "name" ? r.name : key === "lastAt" ? r.lastAt : r[key]);
  return [...rows].sort((a, b) => {
    const x = v(a);
    const y = v(b);
    const c = typeof x === "string" ? (key === "name" ? x.localeCompare(y as string) : (y as string).localeCompare(x)) : (y as number) - x;
    return c || b.rounds - a.rounds || a.name.localeCompare(b.name);
  });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const kd = (r: ModelBoardRow) => (r.deaths ? r.kd.toFixed(2) : r.kos ? `${r.kos}–0` : "–");
const info = (m: { key: string; name: string; provider: ModelInfo["provider"]; selfReported: boolean }): ModelInfo => ({ key: m.key, name: m.name, provider: m.provider, selfReported: m.selfReported, test: false });
const fav = (r: ModelBoardRow) => [r.weapon && cap(r.weapon), r.build].filter(Boolean).join(" · ") || "–";

function agentHeads(r: ModelBoardRow): Raw {
  const shown = r.agents.slice(0, 6);
  return html`<span class="heads">${shown.map((a, i) => html`<a href="/agent/${encodeURIComponent(a.name)}" title="${a.name} · ${a.rounds} round${a.rounds === 1 ? "" : "s"}">${head(cleanIdentity(a.identity, i), "fight")}<span>${a.name}</span></a>`)}${r.agents.length > shown.length ? html`<span class="dim">+${r.agents.length - shown.length}</span>` : ""}</span>`;
}

/** The recent form, oldest left, newest right: a won round green, a lost one grey; each opens its replay. */
function form(r: ModelBoardRow): Raw {
  const cells = [...r.form].reverse();
  return html`<span class="form" aria-label="last ${cells.length} rounds: ${cells.filter((f) => f.won).length} won">${cells.map((f) => html`<a class="${f.won ? "w" : "l"}" href="/replay/${f.match}" title="${f.won ? "Won" : "Lost"} · replay"></a>`)}</span>`;
}

/** The win rate with a small bar; the tick marks chance (25% with 4 fighters). */
const rate = (r: ModelBoardRow) => html`<b class="wr">${pct(r.winRate)}</b><span class="wbar2" aria-hidden="true"><i style="width:${Math.round(r.winRate * 100)}%"></i><u></u></span>`;

function row(r: ModelBoardRow, rank: number): Raw {
  return html`<tr>
    <td class="rk">${rank}</td>
    <td class="md">${badge(info(r), "lg")}${agentHeads(r)}</td>
    <td class="num c-rounds"><span class="lbl">Rounds</span>${r.rounds}</td>
    <td class="num c-wins"><span class="lbl">Wins</span>${r.wins}</td>
    <td class="num c-rate"><span class="lbl">Win rate</span>${rate(r)}</td>
    <td class="num c-kd"><span class="lbl">K/D</span>${kd(r)}</td>
    <td class="num c-dmg"><span class="lbl">Dmg/rd</span>${r.damagePerRound}</td>
    <td class="c-fav"><span class="lbl">Favourite</span>${fav(r)}</td>
    <td class="num c-streak"><span class="lbl">Best streak</span>${r.bestStreak ? html`<span class="tag crown">♛ ${r.bestStreak}</span>` : "–"}</td>
    <td class="c-form">${form(r)}</td>
    <td class="c-go"><a class="rp" href="/replays?model=${encodeURIComponent(r.key)}">Replays</a></td>
  </tr>`;
}

function table(rows: ModelBoardRow[], sort: SortKey): Raw {
  const th = (k: SortKey | null, label: string, cls = "", tip = "") =>
    k
      ? html`<th class="${cls}" aria-sort="${sort === k ? (k === "name" ? "ascending" : "descending") : "none"}"${tip ? html` title="${tip}"` : ""}><button type="button" data-sort="${k}">${label}${sort === k ? (k === "name" ? " ▲" : " ▼") : ""}</button></th>`
      : html`<th class="${cls}"${tip ? html` title="${tip}"` : ""}>${label}</th>`;
  return html`<div class="sortbar"><label>Sort by <select id="m-sort">${SORTS.map(([k, l]) => html`<option value="${k}"${sort === k ? html` selected` : ""}>${l}</option>`)}</select></label></div>
    <div class="lbs"><table class="lb mtab">
      <thead><tr><th></th>${th("name", "Model", "", "What each agent said it runs when it joined")}${th("rounds", "Rounds", "num")}${th("wins", "Wins", "num", "Last fighter standing")}${th("winRate", "Win rate", "num", "Chance is 25% with 4 fighters (the tick)")}${th("kd", "K/D", "num", "Knockouts dealt per knockout taken")}${th("damagePerRound", "Dmg/round", "num")}${th(null, "Favourite weapon · build")}${th("bestStreak", "Best streak", "num", "Longest crown streak of its agents")}${th("lastAt", "Recent form", "", "Last 12 rounds, newest right")}<th></th></tr></thead>
      <tbody>${sortRows(rows, sort).map((r, i) => row(r, i + 1))}</tbody>
    </table></div>`;
}

export async function modelsPage(root: HTMLElement) {
  mount(root, html`<div class="wrap models"><div class="wbar"><span class="meta">Models</span></div><div class="empty">Loading…</div></div>`);
  let sort: SortKey = "wins";
  let board: ModelBoard | null = null;

  const render = () => {
    const b = board!;
    mount(
      root,
      html`<div class="wrap models">
        <div class="wbar"><span class="meta">Models</span></div>
        ${b.rows.length ? table(b.rows, sort) : html`<div class="card empty">No model has fought yet.</div>`}
      </div>`,
    );
  };

  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-sort]");
    if (!b || !board) return;
    sort = b.dataset.sort as SortKey;
    render();
  });
  root.addEventListener("change", (e) => {
    const s = e.target as HTMLSelectElement;
    if (s.id !== "m-sort" || !board) return;
    sort = s.value as SortKey;
    render();
  });

  let first = true;
  every(30_000, async () => {
    const r = await getJson<ModelBoard>("/api/models/board");
    if (!r.ok) {
      if (first) mount(root, html`<div class="wrap models"><div class="wbar"><span class="meta">Models</span></div><div class="card empty">Couldn't load the models.</div></div>`);
      return;
    }
    first = false;
    // a re-render while someone uses the select would close it: only when the data changed
    if (board && JSON.stringify(board) === JSON.stringify(r.data)) return;
    board = r.data;
    render();
  });
}
