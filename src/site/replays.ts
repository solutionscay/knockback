/**
 * /replays (#22, #67): saved rounds, newest first, one row each: the winner, the line-up with models, the arena and
 * when. Featured rounds (2 or more agents) come first; warm-ups (one agent against house bots) follow in their own
 * list. Bot-only rounds are never listed (the server keeps them internal). Only gallery matches (agents and house
 * bots; data.ts isGalleryMatch): server-run model seats are training data. "Older" pages back each list
 * (GET /api/replays?tier=&before=), so every public round is reachable.
 */
import { badge } from "./badge";
import { cleanIdentity, colorVars, head } from "./bots";
import { ago, cap, galleryReplays, type ReplayInfo, scoreline } from "./data";
import { getJson, html, mount, type Raw } from "./dom";

const row = (x: ReplayInfo): Raw => {
  const w = x.winner >= 0 ? x.winner : 0;
  const ids = x.identities.map((v, i) => cleanIdentity(v, i));
  return html`<a class="rrow" href="/replay/${x.match}" style="${colorVars(ids[w]!.color)}">
    <span class="rw">${head(ids[w]!, "win")}<b>${x.names[w]}</b> wins ${scoreline(x.wins)}</span>
    <span class="rl">${ids.map((v, i) => html`<span style="${colorVars(v.color)}">${head(v, i === w ? "win" : "ko")}${x.names[i]} ${badge(x.labels[i])}</span>`)}</span>
    <span class="dim">${cap(x.theme)} · ${ago(x.createdAt)}</span>
  </a>`;
};

/** One tier's list: its rows and the cursor for its next (older) page. */
interface List {
  tier: "featured" | "warm-up";
  title: string;
  none: string;
  rows: ReplayInfo[];
  next: number | null;
  failed: boolean;
}

export async function replaysPage(root: HTMLElement) {
  mount(root, html`<div class="wrap"><div class="wbar"><span class="meta">Replays</span></div><div class="empty">Loading…</div></div>`);
  const lists: List[] = [
    { tier: "featured", title: "Featured · agents against agents", none: "No round with 2 or more agents yet.", rows: [], next: null, failed: false },
    { tier: "warm-up", title: "Warm-ups · one agent against the house bots", none: "No warm-up rounds yet.", rows: [], next: null, failed: false },
  ];
  const more = async (l: List) => {
    const r = await getJson<{ replays: ReplayInfo[]; next?: number | null }>(`/api/replays?tier=${l.tier}&limit=60${l.next !== null ? `&before=${l.next}` : ""}`);
    if (!r.ok) l.failed = true;
    else {
      l.rows.push(...galleryReplays(r.data.replays));
      l.next = typeof r.data.next === "number" ? r.data.next : null;
    }
    render();
  };
  const section = (l: List): Raw =>
    html`<div class="wbar"><span class="meta">${l.title} · ${l.rows.length}${l.next !== null ? "+" : ""}</span></div>
      ${l.rows.length ? html`<div class="rlist">${l.rows.map(row)}</div>` : html`<div class="card empty">${l.failed ? "Couldn't load these replays." : l.next !== null ? "No agent rounds in this page." : l.none}</div>`}
      ${!l.failed && l.next !== null ? html`<div style="text-align:center;margin:12px 0 20px"><button class="btn small ghost" type="button" data-more="${l.tier}">Older rounds</button></div>` : html`<div style="height:20px"></div>`}`;
  const render = () => mount(root, html`<div class="wrap">${lists.map(section)}</div>`);
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-more]");
    const l = b && lists.find((x) => x.tier === b.dataset.more);
    if (!b || !l) return;
    b.disabled = true;
    void more(l);
  });
  await Promise.all(lists.map(more));
}
