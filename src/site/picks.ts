/**
 * Spectator picks on the site (#35).
 *  - picksSlot: the read-only crowd tally (/watch).
 *  - PicksCard: the lobby's "Pick the winner" card: the 4 fighters (bot, name, model badge, opening line, share),
 *    a PICK button each until the server locks the picks (right before round 1's plans are shown), the crowd's
 *    bar and the earliest lock; after the match, the crowd's pick and whether this browser called it.
 * The server owns the lock and the anonymous spectator cookie; this only shows and sends picks. Values from the
 * server go through html`` (escaped); the bots are drawn here from the checked identity.
 */
import { badge } from "./badge";
import { bot, cleanIdentity, colorVars } from "./bots";
import { clock } from "./data";
import { getJson, html, mount, raw, toast } from "./dom";
import type { Identity } from "../sim/identity";

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

interface PickFighter {
  seat: number;
  name: string;
  id: Identity;
  label: string;
  model: string | null;
  line: string | null;
}
export interface PicksView {
  match: string;
  status: string;
  locked: boolean;
  /** local clock ms of the earliest lock, or null */
  locksAt: number | null;
  counts: number[];
  total: number;
  yours: number | null;
  fighters: PickFighter[];
  winner: number | null;
}

const seatOf = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3 ? (v as number) : null);
const pct = (n: number, total: number) => (total ? Math.round((100 * n) / total) : 0);

/** The server's GET /picks answer, checked (pure: tested). */
export function picksView(raw: unknown, now = Date.now()): PicksView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.match !== "string" || !Array.isArray(o.fighters) || o.fighters.length !== 4) return null;
  const counts = Array.isArray(o.counts) && o.counts.length === 4 ? o.counts.map((n) => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 0)) : [0, 0, 0, 0];
  const fighters = o.fighters.map((f, i) => {
    const x = (f ?? {}) as Record<string, unknown>;
    const id = cleanIdentity(x.look, i);
    return { seat: i, name: String(x.name ?? id.name).slice(0, 24), id, label: String(x.label ?? "").slice(0, 40), model: typeof x.model === "string" ? x.model.slice(0, 120) : null, line: typeof x.line === "string" ? x.line.slice(0, 140) : null };
  });
  return {
    match: o.match.slice(0, 32),
    status: String(o.status ?? ""),
    locked: o.locked === true,
    locksAt: Number.isFinite(o.locksAtEarliest) ? (o.locksAtEarliest as number) - (Number(o.now) || now) + now : null,
    counts,
    total: counts.reduce((a, b) => a + b, 0),
    yours: seatOf(o.yours),
    fighters,
    winner: seatOf(o.winner),
  };
}

/** The lobby's pick card. `show(matchId)` on each poll; null hides it. */
export class PicksCard {
  private view: PicksView | null = null;
  private busy = false;

  constructor(private card: HTMLElement) {
    card.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-pick]");
      if (b) void this.pick(Number(b.dataset.pick));
    });
    setInterval(() => this.tick(), 1000);
  }

  async show(matchId: string | null) {
    if (!matchId) {
      this.view = null;
      this.card.hidden = true;
      return;
    }
    const r = await getJson<unknown>(`/api/matches/${encodeURIComponent(matchId)}/picks`);
    const v = r.ok ? picksView(r.data) : null;
    if (!v) {
      if (!r.ok && r.status === 404 && this.view?.match === matchId) this.view = null;
      this.card.hidden = !this.view;
      return;
    }
    this.view = v;
    this.render();
  }

  private async pick(seat: number) {
    const v = this.view;
    if (!v || v.locked || this.busy) return;
    this.busy = true;
    try {
      const r = await fetch(`/api/matches/${encodeURIComponent(v.match)}/pick`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ seat }) });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.ok) this.view = picksView(data) ?? v;
      else {
        if (r.status === 409) v.locked = true;
        toast(data.error ?? `pick failed (${r.status})`);
      }
      this.render();
    } finally {
      this.busy = false;
    }
  }

  private tick() {
    const el = this.card.querySelector<HTMLElement>("[data-locks]");
    const v = this.view;
    if (!el || !v) return;
    const left = v.locksAt === null ? 0 : Math.ceil((v.locksAt - Date.now()) / 1000);
    el.textContent = left > 0 ? `locks in ${clock(left)}` : "locks soon";
  }

  private render() {
    const v = this.view;
    if (!v) return;
    this.card.hidden = false;
    const over = v.winner !== null;
    const open = !v.locked && !over;
    const lead = Math.max(...v.counts);
    const rows = v.fighters.map((f) => {
      const mine = v.yours === f.seat;
      const won = v.winner === f.seat;
      const crowd = (v.locked || over) && v.total > 0 && v.counts[f.seat] === lead;
      return html`<div class="pk${mine ? " mine" : ""}${won ? " won" : ""}" style="${colorVars(f.id.color)}">
        ${bot(f.id, "fist", won ? "win" : "fight", true)}
        <div class="pi"><div class="pn">${f.name}${crowd ? raw(' <span class="star" title="the crowd\'s pick">★</span>') : ""}</div>
          <div class="pb">${f.model !== null ? badge(f.model) : ""}${f.label.startsWith("agent") || f.label === "open seat" ? html`<span class="pa">${f.label}</span>` : ""}</div>
          ${f.line ? html`<p>“${f.line}”</p>` : ""}</div>
        <div class="pr"><b>${pct(v.counts[f.seat]!, v.total)}%</b>${open ? html`<button class="btn small${mine ? "" : " ghost"}" type="button" data-pick="${f.seat}" aria-pressed="${mine}">${mine ? "Picked" : "Pick"}</button>` : mine ? html`<span class="tag">YOURS</span>` : ""}</div>
      </div>`;
    });
    const you =
      over && v.yours !== null
        ? v.yours === v.winner
          ? html`<div class="pyou yes"><b>You called it!</b> ${v.fighters[v.winner!]!.name} won.</div>`
          : html`<div class="pyou"><b>You picked ${v.fighters[v.yours]!.name}.</b> ${v.fighters[v.winner!]!.name} won.</div>`
        : "";
    const sub = over ? `${pct(v.counts[v.winner!]!, v.total)}% called it` : v.locked ? "🔒 locked" : raw(`<span data-locks></span>`);
    mount(
      this.card,
      html`<h2>${over ? "The crowd’s pick" : "Pick the winner"} <small>${sub}</small></h2>
        ${rows}
        <div class="pfoot"><div class="tally">${v.fighters.map((f) => html`<span style="flex-grow:${v.total ? v.counts[f.seat] : 1};${colorVars(f.id.color)}"></span>`)}</div><span>${v.total} pick${v.total === 1 ? "" : "s"}</span></div>
        ${you}
        ${open ? html`<div class="pnote">One pick per browser, changeable until round 1. The bots never see it.</div>` : ""}`,
    );
    this.tick();
  }
}
