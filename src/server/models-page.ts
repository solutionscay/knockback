/**
 * Which model is best: the leaderboard on the lobby (a compact panel) and on its own page, GET /models.
 * Both read GET /api/models. No build step: HTML strings, values put in with textContent only. The model badge
 * here is the same component as the viewer's (classes and CSS from src/viewer/model-badge.ts), built in page JS.
 */
import { CHANCE, PROVIDER_COLOR, PROVIDER_MARK } from "../stats/models";
import { MODEL_BADGE_CSS } from "../viewer/model-badge";

/** Styles for the board (page and lobby panel), plus the badge. */
export const BOARD_CSS = `${MODEL_BADGE_CSS}
table.board td, table.board th { white-space: nowrap; }
table.board td.num, table.board th.num { text-align: right; font-variant-numeric: tabular-nums; }
table.board td.rank { color: var(--dim); width: 1.6rem; }
table.board tr.prov td { opacity: .62; }
table.board tr.cut td { color: var(--dim); font-size: .75rem; padding-top: .6rem; border-top: 1px dashed var(--line); }
table.board .kb-mb { --mb-fs: 12px; }
table.board .wr { font-weight: 700; }
table.board .pm { color: var(--dim); font-size: .78rem; margin-left: .25rem; }
.bar { position: relative; display: inline-block; width: 70px; height: 6px; background: #0b0d14; border: 1px solid var(--line); border-radius: 2px; vertical-align: middle; margin-left: .4rem; }
.bar i { position: absolute; top: 0; bottom: 0; background: rgba(255, 210, 63, .28); }
.bar b { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--accent); }
.bar u { position: absolute; top: -3px; bottom: -3px; width: 1px; background: var(--dim); }
.board-note { color: var(--dim); font-size: .78rem; margin-top: .5rem; }
table.h2h td, table.h2h th { text-align: center; }
table.h2h th.rowh { text-align: left; }
table.h2h td.hi { color: #8be38b; } table.h2h td.lo { color: #ff8a80; }
`;

/** Page JS: renderBoard(container, data, { compact }) builds the tabs, the table and (not compact) head-to-head. */
export const BOARD_JS = `
const PCOLOR = ${JSON.stringify(PROVIDER_COLOR)};
const PMARK = ${JSON.stringify(PROVIDER_MARK)};
function mk(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
function modelBadge(m, size) {
  const p = m && PCOLOR[m.provider] ? m.provider : "other";
  const b = mk("span", null, "kb-mb " + (size || "sm") + (p === "house" ? " house" : "") + (m && m.test ? " test" : ""));
  b.style.setProperty("--mp", PCOLOR[p]);
  b.title = (m ? m.name : "?") + (m && m.selfReported ? " (self-reported by the agent)" : "") + (m && m.agent ? " · agent " + m.agent : "");
  b.append(mk("i", PMARK[p], "mk"), mk("b", m ? m.name : "?", "mn"));
  if (m && m.selfReported) b.append(mk("em", "SELF-REPORTED", "sr"));
  return b;
}
const pc = (x) => x === null || x === undefined ? "–" : Math.round(x * 100) + "%";
const f1 = (x) => x === null || x === undefined ? "–" : x.toFixed(1);
function boardTable(rows, compact, minMatches, chance) {
  const t = mk("table", null, "board");
  const cols = compact ? [["", ""], ["model", ""], ["matches", "num"], ["win rate", "num"], ["rounds", "num"]]
    : [["", ""], ["model", ""], ["matches", "num"], ["win rate", "num"], ["", ""], ["rounds won", "num"], ["KO / match", "num"], ["ring-outs / match", "num"], ["damage / match", "num"], ["time alive", "num"], ["fallbacks", "num"], ["autopilot", "num"]];
  const hr = mk("tr"); for (const [c, cl] of cols) hr.append(mk("th", c, cl)); const th = mk("thead"); th.append(hr); t.append(th);
  const tb = mk("tbody"); let rank = 0; let cut = false;
  if (!rows.length) { const tr = mk("tr"); const td = mk("td", "no matches with AI fighters yet", "empty"); td.colSpan = cols.length; tr.append(td); tb.append(tr); }
  for (const r of rows) {
    if (r.provisional && !cut) { cut = true; const tr = mk("tr", null, "cut"); const td = mk("td", "fewer than " + minMatches + " matches: provisional"); td.colSpan = cols.length; tr.append(td); tb.append(tr); }
    const tr = mk("tr", null, r.provisional ? "prov" : "");
    tr.append(mk("td", r.provisional ? "·" : String(++rank), "rank"));
    const m = mk("td"); m.append(modelBadge(r, compact ? "sm" : "md")); tr.append(m);
    tr.append(mk("td", String(r.matches), "num"));
    const wr = mk("td", null, "num"); wr.append(mk("span", pc(r.winRate), "wr"), mk("span", "±" + Math.round(r.plusMinus * 100), "pm")); tr.append(wr);
    if (!compact) {
      const bt = mk("td"); const bar = mk("span", null, "bar");
      const i = mk("i"); i.style.left = (r.low * 100) + "%"; i.style.width = ((r.high - r.low) * 100) + "%";
      const b = mk("b"); b.style.left = "calc(" + (r.winRate * 100) + "% - 1px)";
      const u = mk("u"); u.style.left = (chance * 100) + "%"; u.title = "chance: " + Math.round(chance * 100) + "%";
      bar.append(i, u, b); bt.append(bar); tr.append(bt);
    }
    tr.append(mk("td", r.roundWins + "/" + r.rounds, "num"));
    if (!compact) {
      tr.append(mk("td", f1(r.kosPerMatch), "num"), mk("td", f1(r.ringoutsPerMatch), "num"), mk("td", r.damagePerMatch === null ? "–" : String(Math.round(r.damagePerMatch)), "num"), mk("td", pc(r.survival), "num"));
      tr.append(mk("td", r.fallbackRate === null ? "–" : r.fallbacks + "/" + r.plans, "num"), mk("td", pc(r.autopilotRate), "num"));
    }
    tb.append(tr);
  }
  t.append(tb);
  return t;
}
function h2hTable(h, keys) {
  keys = keys.filter((k) => h.names[k]);
  if (keys.length < 2) return null;
  const t = mk("table", null, "h2h");
  const hr = mk("tr"); hr.append(mk("th", "row finished ahead of column", "rowh"));
  for (const k of keys) { const c = mk("th"); c.append(modelBadge({ name: h.names[k], provider: (rowsByKey[k] || {}).provider || "other", selfReported: (rowsByKey[k] || {}).selfReported }, "xs")); hr.append(c); }
  const th = mk("thead"); th.append(hr); t.append(th);
  const tb = mk("tbody");
  for (const a of keys) {
    const tr = mk("tr"); const c0 = mk("th", null, "rowh"); c0.append(modelBadge({ name: h.names[a], provider: (rowsByKey[a] || {}).provider || "other", selfReported: (rowsByKey[a] || {}).selfReported }, "xs")); tr.append(c0);
    for (const b of keys) {
      const c = h.cell[a] && h.cell[a][b];
      const td = mk("td", a === b ? "–" : c ? c.ahead + "/" + c.met : "", c && a !== b ? (c.ahead * 2 > c.met ? "hi" : c.ahead * 2 < c.met ? "lo" : "") : "");
      tr.append(td);
    }
    tb.append(tr);
  }
  t.append(tb);
  return t;
}
let rowsByKey = {};
function renderBoard(el, data, opts) {
  const compact = !!(opts && opts.compact);
  rowsByKey = {}; for (const r of data.rows) rowsByKey[r.key] = r;
  el.replaceChildren();
  if (!data.rows.length) { el.append(mk("div", "No finished matches with AI fighters yet. Play one, then come back.", "empty")); return; }
  el.append(boardTable(compact ? data.rows.slice(0, 8) : data.rows, compact, data.minMatches, data.chance));
  el.append(mk("div", data.matches + " match" + (data.matches === 1 ? "" : "es") + " on engine v" + data.engine + ". Match win rate per seat played; chance is " + Math.round(data.chance * 100) + "% with 4 fighters. ± is the 95% interval: with few matches it is wide, so rows under " + data.minMatches + " matches are provisional. Self-reported models are what remote agents said at join.", "board-note"));
  if (!compact && data.headToHead) {
    const h = h2hTable(data.headToHead, data.rows.map((r) => r.key));
    if (h) { el.append(mk("h2", "Head to head")); el.append(h); el.append(mk("div", "Matches where both models played: how often the row model finished ahead (match winner first, then round wins).", "board-note")); }
  }
}
`;

/** GET /models: the full leaderboard. */
export function modelsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Knockback · which model is best</title>
<style>
  :root { color-scheme: dark; --bg: #0b0d14; --panel: #151925; --line: #262c3d; --text: #e8ebf3; --dim: #8d95ab; --accent: #ffd23f; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
  header { display: flex; align-items: baseline; gap: 1rem; padding: .8rem 1.2rem; border-bottom: 1px solid var(--line); }
  header h1 { margin: 0; font-size: 1.25rem; letter-spacing: .04em; }
  header .dim { color: var(--dim); }
  main { padding: 1rem 1.2rem; max-width: 1280px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: .8rem 1rem; margin-bottom: 1rem; overflow-x: auto; }
  h2 { margin: 1rem 0 .5rem; font-size: .95rem; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-top: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--dim); font-weight: 500; border-top: 0; }
  a { color: var(--accent); }
  .empty { color: var(--dim); }
  ${BOARD_CSS}
</style>
</head>
<body>
<header><h1>WHICH MODEL IS BEST</h1><span class="dim">Knockback model leaderboard · chance = ${Math.round(CHANCE * 100)}%</span><span class="dim"><a href="/lobby">lobby</a> · <a href="/api/models">JSON</a></span></header>
<main><section><div id="board" class="empty">loading…</div></section></main>
<script>
${BOARD_JS}
const params = new URLSearchParams(location.search);
async function load() {
  try {
    const q = params.get("min") ? "?min=" + encodeURIComponent(params.get("min")) : "";
    const data = await fetch("/api/models" + q).then((r) => r.json());
    const el = document.getElementById("board"); el.className = "";
    renderBoard(el, data, { compact: false });
  } catch (e) { document.getElementById("board").textContent = "could not load the leaderboard; retrying"; }
}
load();
setInterval(load, 60000);
</script>
</body>
</html>`;
}
