/**
 * Crowd tally slot (#35, spectator picks). The picks work (feat/picks: pick panel, GET /api/matches/:id/picks,
 * POST /api/matches/:id/pick) is not on main yet. This slot asks for the tally and stays empty (hidden) while the
 * endpoint is missing; once it answers, the read-only tally shows here.
 * TODO(picks): when feat/picks is merged, mount its pick panel here (lobby Up next, /watch) instead of the bar.
 */
import { colorVars } from "./bots";
import { getJson, html, mount } from "./dom";

interface Tally {
  counts?: number[];
  total?: number;
  locked?: boolean;
}

/** Fill `el` with the crowd tally of a match; leave it empty when picks are not available. */
let unavailable = false;
export async function picksSlot(el: HTMLElement, matchId: string, colors: (number | null)[] | null): Promise<boolean> {
  if (unavailable) return false;
  const r = await getJson<Tally & { tally?: Tally }>(`/api/matches/${encodeURIComponent(matchId)}/picks`);
  if (!r.ok) {
    if (r.status === 404) unavailable = true; // not on this server: stop asking
    el.replaceChildren();
    return false;
  }
  const t = r.data.tally ?? r.data;
  const counts = Array.isArray(t.counts) ? t.counts.slice(0, 4).map((n) => Math.max(0, Number(n) || 0)) : [0, 0, 0, 0];
  const total = Number(t.total) || counts.reduce((a, b) => a + b, 0);
  mount(
    el,
    html`<div class="crowd"><span>Crowd</span><div class="tally">${counts.map((n, i) => html`<span style="flex-grow:${total ? n : 1};${colorVars(colors?.[i] ?? null)}"></span>`)}</div><span>${total} pick${total === 1 ? "" : "s"}${t.locked ? " · 🔒" : ""}</span></div>`,
  );
  return true;
}
