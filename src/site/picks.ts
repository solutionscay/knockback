/**
 * Spectator picks on the site (#35): the state behind the seat row's PICK buttons and crowd shares (seats.ts).
 * The server owns the lock (right before round 1's plans are shown) and the anonymous spectator cookie; this only
 * reads and sends picks.
 */
import { cleanIdentity } from "./bots";
import { clock } from "./data";
import { getJson, toast } from "./dom";
import type { Identity } from "../sim/identity";

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
export const pct = (n: number, total: number) => (total ? Math.round((100 * n) / total) : 0);

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

/** One match's picks: load on each poll, send a pick, say when they lock. `onChange` re-renders the seat row. */
export class Picks {
  view: PicksView | null = null;
  private busy = false;
  private missing = false;

  constructor(private onChange: () => void) {}

  async load(matchId: string | null) {
    if (!matchId || this.missing) {
      if (this.view && this.view.match !== matchId) (this.view = null), this.onChange();
      return;
    }
    const r = await getJson<unknown>(`/api/matches/${encodeURIComponent(matchId)}/picks`);
    if (!r.ok && r.status === 404 && !this.view) this.missing = true; // no picks on this server: stop asking
    const v = r.ok ? picksView(r.data) : null;
    if (v || this.view?.match !== matchId) this.view = v;
    this.onChange();
  }

  /** picks are open: show the PICK buttons */
  get open() {
    return !!this.view && !this.view.locked && this.view.winner === null;
  }

  /** "picks lock in 0:21", "you called it", or "" */
  status(): string {
    const v = this.view;
    if (!v) return "";
    if (v.winner !== null) return v.yours === null ? "" : v.yours === v.winner ? "You called it" : `You picked ${v.fighters[v.yours]!.name}`;
    if (!v.locked) {
      const left = v.locksAt === null ? 0 : Math.ceil((v.locksAt - Date.now()) / 1000);
      return left > 0 ? `Pick a winner · locks in ${clock(left)}` : "Pick a winner · locks soon";
    }
    return "";
  }

  async pick(seat: number) {
    const v = this.view;
    if (!v || !this.open || this.busy) return;
    this.busy = true;
    try {
      const r = await fetch(`/api/matches/${encodeURIComponent(v.match)}/pick`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ seat }) });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.ok) this.view = picksView(data) ?? v;
      else {
        if (r.status === 409) v.locked = true;
        toast(data.error ?? `pick failed (${r.status})`);
      }
      this.onChange();
    } finally {
      this.busy = false;
    }
  }
}
