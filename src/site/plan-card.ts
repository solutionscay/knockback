/**
 * The plan card (#104): one small card with a fighter's plan, shown only when a spectator taps that fighter (its chip
 * in the viewer, or its seat under the fight) in a round with AI agents. Closed by default; tapping the same fighter
 * again, or ✕, closes it. It reads at the playback position: live on the Lobby, at the playhead on a replay.
 *
 *   → Pickle · keep distance             the headline: target · stance
 *   Health under 35% → go get health     the rules in plain words (ruleText); the one firing now is lit
 *   Anyone hits me → take cover
 *   0:22 → Pickle · “Pickle is burning”  the last change and its why
 *
 * It renders into the plan slot under the seat row (`#plan-slot`, the simplified pages' PLAN_SLOT).
 */
import { modelOf } from "../stats/models";
import { TICK_RATE } from "../sim/constants";
import type { Identity } from "../sim/identity";
import type { Strategy } from "../sim/sim-types";
import { ruleText, stanceText } from "../viewer/callouts";
import { colorVars } from "./bots";
import { clock } from "./data";
import { html, type Raw } from "./dom";
import { PlanBook, planAt, ruleStates, type PlanDiff, type PlanRound } from "./plans";
import type { Stage } from "./stage";

/** A seat played by an agent (not a house bot). */
export const isAgent = (label: string | undefined) => !!label && modelOf(label).provider !== "house";

const TARGET_WORD: Record<string, string> = { nearest: "the nearest", weakest: "the weakest", strongest: "the strongest", leader: "the leader" };
const targetOf = (s: Strategy, names: string[]) => (s.target === "grudge" && s.grudge !== undefined ? (names[s.grudge] ?? "?") : s.target);

/** "→ Pickle, rush in, new rules": what the last change set (pure). */
function changeText(d: PlanDiff[]): string {
  return d.map((x) => (x.field === "rules" ? "new rules" : x.field === "stance" ? stanceText(x.to) : x.field === "retaliate" ? `retaliate ${x.to}` : x.field === "target" ? (TARGET_WORD[x.to] ?? x.to) : x.to)).join(", ");
}

/** The card for fighter `seat` at `tick` (pure markup; empty when there is nothing to show). */
export function planCardHtml(r: PlanRound, seat: number, tick: number, names: string[], id: Identity | undefined): Raw {
  const now = planAt(r, seat, tick, names);
  if (!now) return html``;
  const s = now.strategy;
  const on = ruleStates(r, seat, tick, now);
  const tg = targetOf(s, names);
  const c = now.change;
  return html`<section class="plancard" style="${colorVars(id?.color)}">
    <div class="pc-hd"><b class="pc-n">${names[seat] ?? ""}</b><span class="pc-h">→ <em>${TARGET_WORD[tg] ?? tg}</em> · ${stanceText(s.stance)}</span><button type="button" class="pc-x" data-close aria-label="Close the plan">✕</button></div>
    ${s.rules?.length ? html`<ul class="pc-rules">${s.rules.map((rule, i) => html`<li class="${on[i]?.on ? "on" : ""}" title="${rule.label}">${ruleText(rule, names)}</li>`)}</ul>` : ""}
    ${c && c.diff.length ? html`<p class="pc-chg"><b>${clock(c.tick / TICK_RATE)}</b> → ${changeText(c.diff)}${c.why ? html` · <q>${c.why}</q>` : ""}</p>` : ""}
  </section>`;
}

/** The card on a page: who is open, kept in step with the viewer's camera (a chip tap follows that fighter). */
export class PlanCard {
  readonly book = new PlanBook();
  ids: Identity[] = [];
  private open = -1;
  /** the camera's fighter last seen (null: not seen yet, so a saved camera choice does not open the card) */
  private seenFollow: number | null = null;
  private last = "";
  /** after a tap here, the viewer's next position reports may still carry the old camera: they are ignored this long */
  private quietUntil = 0;

  constructor(
    private slot: HTMLElement,
    private stage: Stage,
    /** the seat row: tapping a seat (not its links) opens that fighter's card */
    seats: HTMLElement | null,
  ) {
    slot.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-close]")) this.toggle(this.open);
    });
    // pointerdown, not click: the seat row is redrawn while the fight plays, and a click needs the same element under
    // both ends of the tap
    seats?.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("a, button")) return;
      const seat = t.closest(".seat");
      if (seat?.parentElement) this.toggle([...seat.parentElement.children].indexOf(seat));
    });
  }

  /** Open fighter `seat`'s card, or close it if it is open; the camera follows the open fighter. */
  toggle(seat: number) {
    this.open = this.open === seat ? -1 : seat;
    this.seenFollow = this.open;
    this.quietUntil = performance.now() + 700;
    this.stage.followFighter(this.open);
    this.render();
  }

  render() {
    const pos = this.stage.pos;
    const follow = this.stage.follow;
    if (performance.now() < this.quietUntil) this.stage.follow = this.open;
    else if (pos && this.seenFollow !== follow) {
      // a chip tap in the viewer (follow on or off) opens or closes the card; the first report only sets the start
      if (this.seenFollow !== null) this.open = follow;
      this.seenFollow = follow;
    }
    const r = pos ? this.book.rounds.get(pos.round) : undefined;
    const show = !!pos && !!r && !pos.done && this.open >= 0 && isAgent(this.book.labels[this.open]);
    const h = show ? planCardHtml(r!, this.open, pos!.phase === "plan" ? 0 : pos!.tick, this.book.names, this.ids[this.open]).s : "";
    // html`` escapes every value (dom.ts): the agents' labels and reasons are text, never markup
    if (h !== this.last) this.slot.innerHTML = this.last = h;
  }
}
