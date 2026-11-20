import type { Fight } from "../sim/fight";
import type { Match } from "../sim/match";
import type { SimEvent, Strategy } from "../sim/sim";
import type { Decision } from "../sim/voice";
import { CALLOUT, CalloutManager, planChangeText, ruleTagText, targetText, type KoEvent, type RuleFiring } from "./callouts";
import { esc } from "./game-hud";
import { hex, portraitSvg } from "./portrait";

export class GamePlans {
  /** plan thoughts and rule tags over the fight (#10, #11); ?thoughts=off hides them */
  callouts = new CalloutManager(typeof location === "undefined" || new URLSearchParams(location.search).get("thoughts") !== "off");
  /** round-start plan-change thoughts, shown one by one */
  private pendingThoughts: { at: number; fighter: number; text: string }[] = [];
  roundFirings: RuleFiring[] = [];
  private ruleTagAt = new Map<number, number>();
  private lastRuleTag = -1e9;
  roundKos: KoEvent[] = [];
  /** each fighter's base plan now (the round's decision, then any plan updates) */
  private planNow: (Strategy | null)[] = [null, null, null, null];
  private nextUpdate = 0;
  private planKeys: string[] = [];
  /** fighters on autopilot (#22): the chip says so instead of the plan */
  autopilot: boolean[] = [];

  startRound(match: Match, decisions: Decision[], clock: number) {
    this.planKeys = [];
    this.callouts.clear();
    this.roundFirings = [];
    this.roundKos = [];
    this.ruleTagAt.clear();
    this.nextUpdate = 0;
    this.planNow = decisions.map((d) => d.strategy);
    // plan changes since last round: one thought per fighter, staggered
    this.pendingThoughts = [];
    const prev = match.record.rounds[match.round - 2]?.strategies;
    if (prev) {
      let k = 0;
      decisions.forEach((d, i) => {
        const t = planChangeText(prev[i]!, d.strategy, match.names);
        if (t) this.pendingThoughts.push({ at: clock + 0.9 + 1.4 * k++, fighter: i, text: t });
      });
    }
  }

  /** Mid-round plan updates in the record (#10; stub until #8/#9): a thought and the chip, at their tick. */
  applyUpdates(match: Match, shown: Fight, decisions: Decision[], clock: number) {
    const ups = match.record.rounds[match.round - 1]?.planUpdates;
    if (!ups) return;
    const tick = shown.sim.tick;
    while (this.nextUpdate < ups.length && ups[this.nextUpdate]!.tick <= tick) {
      const u = ups[this.nextUpdate++]!;
      const prev = this.planNow[u.fighter] ?? decisions[u.fighter]!.strategy;
      // a callout for every update that changes something, or that comes with a line
      const text = planChangeText(prev, u.strategy, match.names) ?? (u.line ? "→ keeps the plan" : null);
      if (text) this.callouts.add({ kind: "thought", fighter: u.fighter, text, ...(u.line ? { line: u.line } : {}), at: clock });
      this.planNow[u.fighter] = u.strategy;
    }
  }

  /** One line under each HUD chip: target, stance, first weapon; ⚑ marks a rule override (#10, #11). */
  private planLine(i: number, match: Match, shown: Fight, decisions: Decision[]): string {
    const f = shown.sim.fighters[i]!;
    if (!f.alive) return `<span class="out">OUT</span>`;
    if (this.autopilot[i]) return `<span class="autopilot">AUTOPILOT</span>`;
    const base = this.planNow[i] ?? decisions[i]!.strategy;
    const ctl = shown.controllers[i]!;
    const tr = ctl.rules.targetRule();
    const rs = ctl.rules.stance();
    const names = match.names;
    const tgt = tr ? `<b class="rule">⚑ ${tr.kind === "avoid" ? "avoid " : "→ "}${esc(names[tr.subject] ?? "?")}</b>` : `<b>→ ${esc(targetText(base, names))}</b>`;
    const stance = rs ? `<span class="rule">⚑ ${esc(rs)}</span>` : esc(base.stance);
    const w = base.weapons[0] === "grapple" ? "hook" : (base.weapons[0] ?? "fists");
    return `${tgt}<i>·</i>${stance}<i>·</i>${esc(w)}`;
  }

  renderChips(lineup: HTMLElement, match: Match, shown: Fight, decisions: Decision[]) {
    for (let i = 0; i < 4; i++) {
      const html = this.planLine(i, match, shown, decisions);
      if (this.planKeys[i] === html) continue;
      this.planKeys[i] = html;
      const el = lineup.querySelector<HTMLElement>(`[data-id="${i}"] .plan`);
      if (el) el.innerHTML = html;
    }
  }

  startLineup(lineup: HTMLElement, shown: Fight, decisions: Decision[]) {
    lineup.innerHTML = shown.sim.fighters
      .map((f) => `<div class="chip" data-id="${f.id}" data-follow="${f.id}" style="--c:${hex(f.color)}">${portraitSvg(f.look, decisions[f.id]!.strategy.weapons[0] ?? "fist", "fight", "tiny")}<span class="nm">${esc(f.name)}<em class="plan"></em></span></div>`)
      .join("");
    lineup.className = "show";
  }

  onEvent(e: SimEvent, match: Match, clock: number) {
    if (e.type === "rule" && e.on) {
      const rule = match.decisions[e.fighter]?.strategy.rules?.[e.rule];
      // few callouts: the same rule of the same fighter tags again only after CALLOUT.ruleRepeatSeconds
      const key = e.fighter * 8 + e.rule;
      if (clock - (this.ruleTagAt.get(key) ?? -1e9) >= CALLOUT.ruleRepeatSeconds && clock - this.lastRuleTag >= CALLOUT.ruleGapSeconds) {
        this.ruleTagAt.set(key, clock);
        this.lastRuleTag = clock;
        this.callouts.add({ kind: "rule", fighter: e.fighter, text: ruleTagText(rule), subject: e.subject, at: clock });
      }
      this.roundFirings.push({ tick: e.tick, fighter: e.fighter, rule: e.rule, subject: e.subject, ...(rule ? { action: rule.do } : {}) });
    }
    if (e.type === "ko") this.roundKos.push({ tick: e.tick, by: e.by, victim: e.fighter });
  }

  update(clock: number, hidden: boolean) {
    // callouts over the fight: nothing during knockout slow motion or outside the fight beat
    while (this.pendingThoughts.length && this.pendingThoughts[0]!.at <= clock) {
      const t = this.pendingThoughts.shift()!;
      this.callouts.add({ kind: "thought", fighter: t.fighter, text: t.text, at: clock });
    }
    return this.callouts.update(clock, hidden);
  }
}
