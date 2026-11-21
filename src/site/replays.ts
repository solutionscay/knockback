/**
 * /replays (#22): saved fights, newest first, one row each: the winner, the score, the line-up with models, the
 * arena and when. Only gallery matches (agents and house bots; data.ts isGalleryMatch): server-run model seats are
 * training data. "Older fights" pages back (GET /api/replays?before=), so every finished match is reachable.
 */
import { badge } from "./badge";
import { cleanIdentity, colorVars } from "./bots";
import { ago, cap, galleryReplays, type ReplayInfo, scoreline } from "./data";
import { getJson, html, mount, type Raw } from "./dom";

const row = (x: ReplayInfo): Raw => {
  const w = x.winner >= 0 ? x.winner : 0;
  const ids = x.identities.map((v, i) => cleanIdentity(v, i));
  return html`<a class="rrow" href="/replay/${x.match}" style="${colorVars(ids[w]!.color)}">
    <span class="rw"><b>${x.names[w]}</b> wins ${scoreline(x.wins)}</span>
    <span class="rl">${ids.map((v, i) => html`<span style="${colorVars(v.color)}"><i></i>${x.names[i]} ${badge(x.labels[i])}</span>`)}</span>
    <span class="dim">${cap(x.theme)} · ${ago(x.createdAt)}</span>
  </a>`;
};

export async function replaysPage(root: HTMLElement) {
  mount(root, html`<div class="wrap"><div class="wbar"><span class="meta">Replays</span></div><div class="empty">Loading…</div></div>`);
  const rs: ReplayInfo[] = [];
  let next: number | null = null;
  let failed = false;
  const more = async () => {
    const r = await getJson<{ replays: ReplayInfo[]; next?: number | null }>(`/api/replays?limit=60${next !== null ? `&before=${next}` : ""}`);
    if (!r.ok) failed = true;
    else {
      rs.push(...galleryReplays(r.data.replays));
      next = typeof r.data.next === "number" ? r.data.next : null;
    }
    render();
  };
  const render = () =>
    mount(
      root,
      html`<div class="wrap"><div class="wbar"><span class="meta">Replays · ${rs.length}${next !== null ? "+" : ""}</span></div>
        ${
          rs.length
            ? html`<div class="rlist">${rs.map(row)}</div>${next !== null ? html`<div style="text-align:center;margin-top:12px"><button class="btn small ghost" type="button" id="rp-more">Older fights</button></div>` : ""}`
            : html`<div class="card empty">${failed ? "Couldn't load the replays." : next !== null ? "No agent fights in this page." : "No finished matches yet."}</div>${!failed && next !== null ? html`<div style="text-align:center;margin-top:12px"><button class="btn small ghost" type="button" id="rp-more">Older fights</button></div>` : ""}`
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
