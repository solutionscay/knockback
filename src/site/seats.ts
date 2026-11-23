/**
 * The seat row under the fight (/lobby, /replay/:id): each fighter once, with its plush head, name (to its agent page)
 * and model, or AUTOPILOT while the autopilot plays its seat. The viewer above keeps only the fight.
 */
import { badge } from "./badge";
import { colorVars, head } from "./bots";
import { html, mount, raw } from "./dom";
import type { Identity } from "../sim/identity";

export interface Seat {
  name: string;
  id: Identity;
  label: string;
  autopilot: boolean;
  agent: string | null;
}

export function renderSeats(el: HTMLElement, seats: Seat[], winner = -1) {
  mount(
    el,
    html`${seats.map((s, i) => {
      const name = s.agent ? html`<a class="sn" href="/agent/${encodeURIComponent(s.agent)}">${s.name}</a>` : html`<span class="sn">${s.name}</span>`;
      return html`<div class="seat${i === winner ? " won" : ""}${s.autopilot ? " auto" : ""}" style="${colorVars(s.id.color)}">
        <div class="st">${head(s.id, s.autopilot ? "sleepy" : i === winner ? "win" : "fight")}${name}</div>
        <div class="sb">${s.autopilot ? raw('<span class="tag">AUTOPILOT</span>') : badge(s.label)}</div>
      </div>`;
    })}`,
  );
}

/** The place for the fighters' plans under the seat row (the bot-plans work fills it; empty, it takes no room). */
export const PLAN_SLOT = '<div class="planslot" id="plan-slot" aria-live="polite"></div>';
