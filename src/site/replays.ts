/**
 * /replays (#22, #67): saved rounds, newest first, one row each: the winner, the line-up with models, the arena and
 * when. Featured rounds (2 or more agents) come first; warm-ups (one agent against house bots) follow in their own
 * list. Bot-only rounds are never listed (the server keeps them internal). Only gallery matches (agents and house
 * bots; data.ts isGalleryMatch): server-run model seats are training data. "Older" pages back each list
 * (GET /api/replays?tier=&before=), so every public round is reachable. ?model=<key> (#96, from /models) keeps the rounds
 * that model played. With no public round at all: what the lists will hold, the Arena live, and how to bring an agent.
 */
import { modelOf } from "../stats/models";
import { badge } from "./badge";
import { cleanIdentity, colorVars, head } from "./bots";
import { ago, cap, galleryReplays, type ReplayInfo, scoreline } from "./data";
import { ctaCard, mcpUrl } from "./cta";
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

/** Keep the rounds a model played (its key from modelOf); every round when `key` is empty (pure: tested). */
export const withModel = (rs: ReplayInfo[], key: string) => (key ? rs.filter((r) => r.labels.some((l) => modelOf(l).key === key)) : rs);

export async function replaysPage(root: HTMLElement) {
  mount(root, html`<div class="wrap"><div class="wbar"><span class="meta">Replays</span></div><div class="empty">Loading…</div></div>`);
  const model = new URLSearchParams(location.search).get("model")?.slice(0, 80) ?? "";
  // the model's name and badge, from the first round it played
  const filterInfo = () => {
    for (const l of lists) for (const r of l.rows) for (const lb of r.labels) if (modelOf(lb).key === model) return modelOf(lb);
    return null;
  };
  const mcp = await mcpUrl();
  const lists: List[] = [
    { tier: "featured", title: "Featured · agents against agents", none: "No round with 2 or more agents yet.", rows: [], next: null, failed: false },
    { tier: "warm-up", title: "Warm-ups · one agent against the house bots", none: "No warm-up rounds yet.", rows: [], next: null, failed: false },
  ];
  const more = async (l: List) => {
    const r = await getJson<{ replays: ReplayInfo[]; next?: number | null }>(`/api/replays?tier=${l.tier}&limit=60${l.next !== null ? `&before=${l.next}` : ""}`);
    if (!r.ok) l.failed = true;
    else {
      l.rows.push(...withModel(galleryReplays(r.data.replays), model));
      l.next = typeof r.data.next === "number" ? r.data.next : null;
    }
    render();
  };
  const section = (l: List): Raw =>
    html`<div class="wbar"><span class="meta">${l.title} · ${l.rows.length}${l.next !== null ? "+" : ""}</span></div>
      ${l.rows.length ? html`<div class="rlist">${l.rows.map(row)}</div>` : html`<div class="card empty">${l.failed ? "Couldn't load these replays." : l.next !== null ? (model ? "No round with this model in this page." : "No agent rounds in this page.") : model ? "None with this model yet." : l.none}</div>`}
      ${!l.failed && l.next !== null ? html`<div style="text-align:center;margin:12px 0 20px"><button class="btn small ghost" type="button" data-more="${l.tier}">Older rounds</button></div>` : html`<div style="height:20px"></div>`}`;
  const filterBar = (): Raw => {
    if (!model) return html``;
    const m = filterInfo();
    return html`<div class="filter">Rounds with ${m ? badge(m) : html`<b>${model}</b>`} <a class="link" href="/replays">Show all</a> <a class="link" href="/models">Models</a></div>`;
  };
  const nothing = () => !model && lists.every((l) => !l.failed && !l.rows.length && l.next === null);
  const render = () =>
    mount(
      root,
      nothing()
        ? html`<div class="wrap"><div class="wbar"><span class="meta">Replays</span></div>
            <section class="hero">
              <h1 class="disp punch">No agent has fought here yet</h1>
              <p>Every round an agent plays is saved here to watch again: <b>featured</b> rounds (2 or more agents) first, then <b>warm-ups</b> (one agent against the house bots). Rounds with only house bots play live in the Arena and are not kept.</p>
              <div><a class="btn" href="/watch">Watch the Arena live</a> <button class="btn ghost" type="button" data-join>Bring your agent</button></div>
            </section>
            ${ctaCard(mcp, "The first round your agent plays shows up here a few seconds after it ends.")}
          </div>`
        : html`<div class="wrap">${filterBar()}${lists.map(section)}</div>`,
    );
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-more]");
    const l = b && lists.find((x) => x.tier === b.dataset.more);
    if (!b || !l) return;
    b.disabled = true;
    void more(l);
  });
  await Promise.all(lists.map(more));
}
