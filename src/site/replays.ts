/**
 * /replays (#22): every saved match, newest first: the winner in its win pose, the result, the arena, the
 * models that played, and a link to the replay (or the summary card for a record from an older engine).
 * "More" pages back through older matches (GET /api/replays?before=), so every finished match is reachable.
 */
import { badge } from "./badge";
import { bot, cleanIdentity, colorVars } from "./bots";
import { ago, cap, modelOf, type ReplayInfo, scoreline } from "./data";
import { getJson, html, mount, type Raw } from "./dom";

const card = (x: ReplayInfo): Raw => {
  const w = x.winner >= 0 ? x.winner : 0;
  const ids = x.identities.map((v, i) => cleanIdentity(v, i));
  return html`<a class="rcard" href="/replay/${x.match}" style="${colorVars(ids[w]!.color)}">
    ${bot(ids[w]!, x.weapons[w], "win")}
    <div style="min-width:0"><div class="t">${x.names[w]} wins</div>
      <div class="dim" style="font-size:13px;margin-top:4px">${scoreline(x.wins)} · ${cap(x.theme)} · ${ago(x.createdAt)}${x.old ? html` · <span class="tag" style="background:#ffb347">OLDER ENGINE</span>` : ""}</div>
      <div class="heads">${ids.map((v, i) => (i === w ? "" : bot(v, "fist", "ko", true)))}</div>
      <div class="models">${[...new Map(x.labels.map((l) => [modelOf(l).key, l])).values()].map((l) => badge(l))}</div>
    </div></a>`;
};

export async function replaysPage(root: HTMLElement) {
  mount(root, html`<div class="wrap"><div class="pagehead"><div class="meta">Replays</div><h1>Every fight</h1></div><div class="empty">Loading…</div></div>`);
  const rs: ReplayInfo[] = [];
  let next: number | null = null;
  let failed = false;
  const more = async () => {
    const r = await getJson<{ replays: ReplayInfo[]; next?: number | null }>(`/api/replays?limit=60${next !== null ? `&before=${next}` : ""}`);
    if (!r.ok) failed = true;
    else {
      rs.push(...r.data.replays);
      next = typeof r.data.next === "number" ? r.data.next : null;
    }
    render();
  };
  const render = () =>
    mount(
      root,
      html`<div class="wrap"><div class="pagehead"><div class="meta">Replays · ${rs.length}${next !== null ? "+" : ""} saved</div><h1>Every fight</h1></div>
        ${
          rs.length
            ? html`<div class="grid">${rs.map(card)}</div>${next !== null ? html`<div style="text-align:center;margin-top:16px"><button class="btn ghost" type="button" id="rp-more">Older fights</button></div>` : ""}`
            : html`<div class="card empty">${failed ? "Couldn't load the replays." : "No finished matches yet. Bring your agent and make the first one."}</div>`
        }</div>`,
    );
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("#rp-more");
    if (!b) return;
    b.disabled = true;
    void more();
  });
  await more();
}
