/**
 * The seat row under the fight (/watch, /lobby): each fighter once, with its color, name (to its agent page),
 * model, round wins and, while picks are open, a PICK button; after the lock, the crowd's share. The viewer above
 * keeps only the fight and its plan chips, so this is the one place the line-up shows.
 */
import { badge } from "./badge";
import { colorVars } from "./bots";
import { html, mount, raw } from "./dom";
import { type Picks, pct } from "./picks";
import type { Identity } from "../sim/identity";

export interface Seat {
  name: string;
  id: Identity;
  label: string;
  wins: number;
  autopilot: boolean;
  agent: string | null;
  /** the crown holder's streak coming into this round (#65); null: not the holder */
  crown?: number | null;
}

export function renderSeats(el: HTMLElement, seats: Seat[], picks: Picks, winner = -1) {
  const v = picks.view;
  const open = picks.open;
  mount(
    el,
    html`${seats.map((s, i) => {
      const mine = v?.yours === i;
      const share = v && !open && v.total > 0 ? html`<span class="pct" title="the crowd's picks">${pct(v.counts[i]!, v.total)}%</span>` : "";
      const name = s.agent ? html`<a class="sn" href="/agent/${encodeURIComponent(s.agent)}">${s.name}</a>` : html`<span class="sn">${s.name}</span>`;
      return html`<div class="seat${i === winner ? " won" : ""}${mine ? " mine" : ""}${s.autopilot ? " auto" : ""}" style="${colorVars(s.id.color)}">
        <div class="st">${s.crown ? html`<span class="tag crown" title="crown holder · ${s.crown} round${s.crown === 1 ? "" : "s"} won in a row">♛ ${s.crown}</span>` : ""}${name}<span class="wins" title="${s.wins} round${s.wins === 1 ? "" : "s"} won"><i class="${s.wins >= 1 ? "w" : ""}"></i><i class="${s.wins >= 2 ? "w" : ""}"></i></span></div>
        <div class="sb">${s.autopilot ? raw('<span class="tag">AUTOPILOT</span>') : badge(s.label)}${open ? html`<button class="pick" type="button" data-pick="${i}" aria-pressed="${mine}">${mine ? "Picked" : "Pick"}</button>` : share}</div>
      </div>`;
    })}`,
  );
}

/** One click listener for the row's PICK buttons. */
export function wirePicks(el: HTMLElement, picks: Picks) {
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-pick]");
    if (b) void picks.pick(Number(b.dataset.pick));
  });
}
