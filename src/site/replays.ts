/**
 * Replays (/replays, #22, #67, #106): the library of saved rounds, newest first, one row each: the winner, the four
 * fighters with their models, the map and the date. One filter (a model or an agent: ?model=<key>, ?agent=<name>)
 * and "Older" pages (GET /api/replays?before=). Bot-only rounds are never listed (the server keeps them internal);
 * only gallery matches (agents and house bots; data.ts isGalleryMatch).
 */
import { modelOf } from "../stats/models";
import { badge } from "./badge";
import { cleanIdentity, colorVars, head } from "./bots";
import { cap, galleryReplays, type ReplayInfo } from "./data";
import { getJson, html, mount, type Raw } from "./dom";

/** "23 Nov · 22:29" */
export const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

const row = (x: ReplayInfo): Raw => {
  const w = x.winner >= 0 ? x.winner : 0;
  const ids = x.identities.map((v, i) => cleanIdentity(v, i));
  return html`<a class="rrow" href="/replay/${x.match}" style="${colorVars(ids[w]!.color)}">
    <span class="rw">${head(ids[w]!, "win")}<b>${x.names[w]}</b> wins</span>
    <span class="rl">${ids.map((v, i) => html`<span>${head(v, i === w ? "win" : "ko")}${x.names[i]} ${badge(x.labels[i])}</span>`)}</span>
    <span class="dim">${cap(x.theme)} · ${when(x.createdAt)}</span>
  </a>`;
};

export interface Filter {
  model: string;
  agent: string;
}

/** Keep the rounds a model (its key from modelOf) or an agent played; every round with no filter (pure: tested). */
export const withFilter = (rs: ReplayInfo[], f: Filter) =>
  rs.filter((r) => r.labels.some((l) => {
    const m = modelOf(l);
    return (!f.model || m.key === f.model) && (!f.agent || m.agent?.toLowerCase() === f.agent.toLowerCase());
  }));
/** Keep the rounds a model played (#96; pure: tested). */
export const withModel = (rs: ReplayInfo[], key: string) => withFilter(rs, { model: key, agent: "" });

/** The filter's choices from the rounds loaded: models and agents, A to Z (pure). */
export function filterChoices(rs: ReplayInfo[]): { models: [string, string][]; agents: string[] } {
  const models = new Map<string, string>();
  const agents = new Set<string>();
  for (const r of rs)
    for (const l of r.labels) {
      const m = modelOf(l);
      if (m.key === "house") continue;
      models.set(m.key, m.name);
      if (m.agent) agents.add(m.agent);
    }
  return { models: [...models].sort((a, b) => a[1].localeCompare(b[1])), agents: [...agents].sort((a, b) => a.localeCompare(b)) };
}

const PAGE = 40;

export async function replaysPage(root: HTMLElement) {
  const q = new URLSearchParams(location.search);
  const filter: Filter = { model: q.get("model")?.slice(0, 80) ?? "", agent: q.get("agent")?.slice(0, 24) ?? "" };
  const all: ReplayInfo[] = [];
  let next: number | null = null;
  let failed = false;
  let loading = true;

  const page = async () => {
    const r = await getJson<{ replays: ReplayInfo[]; next?: number | null }>(`/api/replays?limit=${PAGE}${next !== null ? `&before=${next}` : ""}`);
    if (!r.ok) return void (failed = true);
    all.push(...galleryReplays(r.data.replays));
    next = typeof r.data.next === "number" ? r.data.next : null;
  };
  /** one page; with a filter, pages until enough rounds match (or none are left) */
  const more = async () => {
    loading = true;
    render();
    const had = withFilter(all, filter).length;
    let n = 0;
    do await page();
    while (!failed && next !== null && (filter.model || filter.agent) && withFilter(all, filter).length - had < 20 && ++n < 10);
    loading = false;
    render();
  };

  const select = (): Raw => {
    const c = filterChoices(all);
    const cur = filter.model ? `model:${filter.model}` : filter.agent ? `agent:${filter.agent}` : "";
    if (filter.model && !c.models.some(([k]) => k === filter.model)) c.models.unshift([filter.model, filter.model]);
    if (filter.agent && !c.agents.includes(filter.agent)) c.agents.unshift(filter.agent);
    const opt = (v: string, l: string) => html`<option value="${v}"${v === cur ? html` selected` : ""}>${l}</option>`;
    return html`<select id="rp-filter" aria-label="Filter">${opt("", "All rounds")}${c.models.length ? html`<optgroup label="Model">${c.models.map(([k, n]) => opt(`model:${k}`, n))}</optgroup>` : ""}${c.agents.length ? html`<optgroup label="Agent">${c.agents.map((a) => opt(`agent:${a}`, a))}</optgroup>` : ""}</select>`;
  };

  const render = () => {
    const rows = withFilter(all, filter);
    mount(
      root,
      html`<div class="wrap">
        <div class="wbar"><span class="meta">Replays</span><span class="sp"></span>${all.length || filter.model || filter.agent ? select() : ""}</div>
        ${rows.length
          ? html`<div class="rlist">${rows.map(row)}</div>`
          : html`<div class="empty">${loading ? "Loading…" : failed ? "Couldn't load replays." : filter.model || filter.agent ? "No rounds with this filter yet." : "No rounds yet."}</div>`}
        ${!failed && next !== null && !loading ? html`<div class="more"><button class="btn small ghost" type="button" data-more>Older</button></div>` : ""}
      </div>`,
    );
  };

  root.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-more]")) void more();
  });
  root.addEventListener("change", (e) => {
    const s = e.target as HTMLSelectElement;
    if (s.id !== "rp-filter") return;
    const [k, ...v] = s.value.split(":");
    filter.model = k === "model" ? v.join(":") : "";
    filter.agent = k === "agent" ? v.join(":") : "";
    const u = new URL(location.href);
    u.search = filter.model ? `?model=${encodeURIComponent(filter.model)}` : filter.agent ? `?agent=${encodeURIComponent(filter.agent)}` : "";
    history.replaceState(null, "", u);
    if (withFilter(all, filter).length < 20 && next !== null) void more();
    else render();
  });
  await more();
}
