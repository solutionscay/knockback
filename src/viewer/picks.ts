/**
 * Spectator picks in the viewer (#35): before the match, a pick panel with
 * the 4 fighters (portrait, name, who plays it, opening line, live share) and
 * the lock countdown; during the fight a thin crowd tally under the clock;
 * on the win screen the crowd's split ("38% called it", "You called it!").
 * Replays show the stored split, read-only. The server owns the lock; this
 * only shows it. Picks never touch the match: this module only reads the
 * server's /picks answers and the stream's picks events.
 */
import type { Beat } from "../flow/beats";

interface Fighter {
  seat: number;
  name: string;
  color: number;
  label: string;
  line: string | null;
  svg: string;
}

interface View {
  match: string;
  locked: boolean;
  locksAtEarliest: number | null;
  counts: number[];
  total: number;
  yours: number | null;
  fighters: Fighter[];
  winner?: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hex = (c: number) => `#${(c >>> 0 & 0xffffff).toString(16).padStart(6, "0")}`;
const pct = (n: number, total: number) => (total ? Math.round((100 * n) / total) : 0);

/** The server's answer, checked: numbers are numbers, strings are short strings, the portrait is the server's own SVG. */
export function sanitizeView(raw: unknown): View | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.match !== "string" || !Array.isArray(o.fighters) || o.fighters.length !== 4) return null;
  const counts = Array.isArray(o.counts) && o.counts.length === 4 ? o.counts.map((n) => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 0)) : [0, 0, 0, 0];
  const seat = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3 ? (v as number) : null);
  const fighters = o.fighters.map((f, i) => {
    const x = (f ?? {}) as Record<string, unknown>;
    const svg = typeof x.svg === "string" && x.svg.startsWith("<svg") && !/<script|on\w+=/i.test(x.svg) ? x.svg : "";
    return { seat: i, name: String(x.name ?? `Fighter ${i + 1}`).slice(0, 24), color: Number(x.color) || 0x9aa4bd, label: String(x.label ?? "").slice(0, 40), line: typeof x.line === "string" ? x.line.slice(0, 140) : null, svg };
  });
  const w = seat(o.winner);
  return {
    match: o.match.slice(0, 32),
    locked: o.locked === true,
    locksAtEarliest: Number.isFinite(o.locksAtEarliest) ? (o.locksAtEarliest as number) - (Number(o.now) || Date.now()) + Date.now() : null,
    counts,
    total: counts.reduce((a, b) => a + b, 0),
    yours: seat(o.yours),
    fighters,
    ...(w !== null ? { winner: w } : {}),
  };
}

export class PickPanel {
  private view: View | null = null;
  private readOnly = false;
  private panel: HTMLElement;
  private tally: HTMLElement;
  private flash: HTMLElement;
  private timer: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private root: HTMLElement = document.getElementById("hud") ?? document.body) {
    this.panel = this.el("picks-panel");
    this.tally = this.el("crowd-tally");
    this.flash = this.el("picks-flash");
    this.panel.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-pick]");
      if (b) void this.pick(Number(b.dataset.pick));
    });
    this.timer = setInterval(() => this.renderCountdown(), 500);
  }

  private el(id: string): HTMLElement {
    let e = document.getElementById(id);
    if (!e) {
      e = document.createElement("div");
      e.id = id;
      this.root.appendChild(e);
    }
    return e;
  }

  /** A live (or open) match: fetch its cards and this browser's pick. */
  async setMatch(id: string) {
    if (this.view?.match === id) return;
    this.readOnly = false;
    await this.load(`/api/matches/${encodeURIComponent(id)}/picks`);
  }

  /** A replay: the stored split, read-only. */
  async setRecord(path: string) {
    this.readOnly = true;
    await this.load(`/api/picks?record=${encodeURIComponent(path)}`);
  }

  private async load(url: string) {
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) return;
      this.view = sanitizeView(await r.json());
      this.render();
    } catch {
      /* no picks for this match (an old server, a record from elsewhere): nothing to show */
    }
  }

  private async pick(seat: number) {
    const v = this.view;
    if (!v || v.locked || this.readOnly || this.busy) return;
    this.busy = true;
    try {
      const r = await fetch(`/api/matches/${encodeURIComponent(v.match)}/pick`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ seat }) });
      const data = await r.json();
      if (r.ok) this.view = sanitizeView(data) ?? v;
      else if (r.status === 409) v.locked = true;
      this.render();
    } finally {
      this.busy = false;
    }
  }

  /** Stream: the tally changed. */
  onPicks(e: { matchId?: unknown; counts?: unknown }) {
    const v = this.view;
    if (!v || e.matchId !== v.match || !Array.isArray(e.counts) || e.counts.length !== 4) return;
    v.counts = e.counts.map((n) => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 0));
    v.total = v.counts.reduce((a, b) => a + b, 0);
    this.render();
  }

  /** Stream: the window closed (right before round 1's plans). */
  onLocked(e: { matchId?: unknown; counts?: unknown }) {
    const v = this.view;
    if (!v || e.matchId !== v.match) return;
    this.onPicks(e);
    v.locked = true;
    this.render();
    if (v.total) {
      this.flash.innerHTML = `<b>PICKS LOCKED</b> ${v.total} pick${v.total === 1 ? "" : "s"}`;
      this.flash.className = "show";
      setTimeout(() => (this.flash.className = ""), 2600);
    }
  }

  /** Each frame: the crowd tally shows during the fight only. */
  update(beat: Beat["kind"]) {
    const on = !!this.view && this.view.locked && this.view.total > 0 && (beat === "go" || beat === "fight");
    if (this.tally.classList.contains("show") !== on) this.tally.classList.toggle("show", on);
  }

  /** The win screen: append the crowd's split. */
  celebrate(el: HTMLElement, winner: number) {
    const v = this.view;
    if (!v || !v.total) return;
    const share = pct(v.counts[winner]!, v.total);
    const rows = [...v.fighters]
      .sort((a, b) => v.counts[b.seat]! - v.counts[a.seat]!)
      .map((f) => `<div class="crow${f.seat === winner ? " won" : ""}" style="--c:${hex(f.color)};--w:${pct(v.counts[f.seat]!, v.total)}%"><span class="cn">${esc(f.name)}</span><span class="cb"><span></span>${f.seat === winner ? "<em>WINNER</em>" : ""}</span><span class="cp">${pct(v.counts[f.seat]!, v.total)}%</span></div>`)
      .join("");
    const mine = v.yours;
    const you =
      mine === null
        ? ""
        : mine === winner
          ? `<div class="you yes"><b>You called it!</b><span>${v.counts[winner]! > 1 ? `You and ${v.counts[winner]! - 1} other${v.counts[winner]! > 2 ? "s" : ""} picked` : "You picked"} ${esc(v.fighters[winner]!.name)}.</span></div>`
          : `<div class="you no"><b>You picked ${esc(v.fighters[mine]!.name)}</b><span>${esc(v.fighters[winner]!.name)} won it.</span></div>`;
    const block = document.createElement("div");
    block.className = "crowd";
    block.innerHTML = `<div class="ch">THE CROWD <span>${v.total} pick${v.total === 1 ? "" : "s"}</span></div><div class="called"><b>${share}%</b> called it</div>${rows}${you}`;
    el.appendChild(block);
  }

  private render() {
    const v = this.view;
    if (!v) return;
    const showPanel = !v.locked && !this.readOnly;
    this.panel.className = showPanel ? "show" : "";
    if (showPanel) {
      const cards = v.fighters
        .map((f) => {
          const mine = v.yours === f.seat;
          return `<div class="pcard${mine ? " mine" : ""}" style="--c:${hex(f.color)}">${mine ? `<span class="badge">YOUR PICK</span>` : ""}<div class="pp">${f.svg}</div><div class="pn">${esc(f.name)}</div><div class="pl">${esc(f.label)}</div><div class="pq">${f.line ? `“${esc(f.line)}”` : ""}</div><button type="button" data-pick="${f.seat}">${mine ? "✓ PICKED" : `PICK ${esc(f.name.toUpperCase())}`}</button><div class="ppct">${pct(v.counts[f.seat]!, v.total)}%</div></div>`;
        })
        .join("");
      this.panel.innerHTML = `<div class="ptitle">Who wins? Tap a bot.</div><div class="pcards">${cards}</div><div class="pbar">${this.barHtml()}<div class="pcount"><b data-count></b><span>UNTIL PICKS LOCK</span></div></div><div class="pnote">The bots never see your pick.</div>`;
      this.renderCountdown();
    }
    const lead = v.fighters.reduce((a, f) => (v.counts[f.seat]! > v.counts[a.seat]! ? f : a), v.fighters[0]!);
    this.tally.innerHTML = `<div class="tl">Crowd: <b>${esc(lead.name)} ${pct(v.counts[lead.seat]!, v.total)}%</b>${v.yours !== null ? ` · you: <b style="color:${hex(v.fighters[v.yours]!.color)}">${esc(v.fighters[v.yours]!.name)}</b>` : ""}<span>🔒 ${v.total}</span></div><div class="seg">${v.fighters.map((f) => `<i style="--c:${hex(f.color)};flex:${v.counts[f.seat]! || 0.0001}"></i>`).join("")}</div>`;
  }

  private barHtml(): string {
    const v = this.view!;
    const seg = v.fighters.map((f) => `<i style="--c:${hex(f.color)};flex:${v.counts[f.seat]! || 0.0001}"></i>`).join("");
    const legend = v.fighters.map((f) => `<span class="${v.yours === f.seat ? "me" : ""}" style="--c:${hex(f.color)}"><i></i>${esc(f.name)} ${pct(v.counts[f.seat]!, v.total)}%</span>`).join("");
    return `<div class="pbars"><div class="pseg">${v.total ? seg : `<i class="empty"></i>`}</div><div class="plegend">${legend}<em>${v.total} pick${v.total === 1 ? "" : "s"}</em></div></div>`;
  }

  private renderCountdown() {
    const b = this.panel.querySelector<HTMLElement>("[data-count]");
    const v = this.view;
    if (!b || !v) return;
    const left = v.locksAtEarliest === null ? 0 : Math.ceil((v.locksAtEarliest - Date.now()) / 1000);
    b.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "SOON";
  }

  dispose() {
    clearInterval(this.timer);
  }
}
