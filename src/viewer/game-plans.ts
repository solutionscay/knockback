import type { Fight } from "../sim/fight";
import type { Match } from "../sim/match";
import type { Fighter, SimEvent, Strategy } from "../sim/sim-types";
import type { Decision } from "../sim/voice";
import { CALLOUT, CalloutManager, planChangeText, ruleTagText, targetText, type KoEvent, type RuleFiring } from "./callouts";
import { esc } from "./game-hud";
import { hex, portraitSvg } from "./portrait";
import { modelBadgeHtml } from "./model-badge";
import { buildTagHtml } from "./build-view";

/** Short weapon names for the chip (the plan's spellings: hook, flamer, sword). */
const SHORT_NAME: Partial<Record<string, string>> = { grapple: "hook", flamethrower: "flamer", lightning: "sword" };

/** The carried weapon and its ammo on a HUD chip (#95): "rocket 5/8", red when low; "fists" bare-handed. */
export function ammoHtml(shown: Fight, f: Fighter): string {
  const w = f.weapons[1];
  if (w === "fist") return `<span class="ammo none">fists</span>`;
  const full = shown.sim.ruleset.weapons.table[w].ammo;
  const left = Math.max(0, f.ammo[w]);
  const low = left / Math.max(1, full) <= shown.sim.ruleset.tactics.pickup.lowAmmoShare;
  return `<span class="ammo${low ? " low" : ""}">${esc(SHORT_NAME[w] ?? w)} <b>${left}</b>/${full}</span>`;
}

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

  /** Mid-round plan updates (#8, #10): a thought and the chip, when the sim applies them (at their tick). */
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

  /** One line under each HUD chip: target, stance; ⚑ marks a rule override (#10, #11). The weapon and its ammo (#95) get a line of their own. */
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
    return `${tgt}<i>·</i>${stance}`;
  }

  renderChips(lineup: HTMLElement, match: Match, shown: Fight, decisions: Decision[]) {
    for (let i = 0; i < 4; i++) {
      const f = shown.sim.fighters[i]!;
      const ammo = f.alive ? ammoHtml(shown, f) : "";
      const html = this.planLine(i, match, shown, decisions);
      if (this.planKeys[i] === html + ammo) continue;
      this.planKeys[i] = html + ammo;
      const el = lineup.querySelector<HTMLElement>(`[data-id="${i}"] .plan`);
      if (el) el.innerHTML = html;
      const slot = lineup.querySelector<HTMLElement>(`[data-id="${i}"] .slot`);
      if (slot) slot.innerHTML = ammo;
    }
  }

  /** `labels`: who plays each seat, shown as a model badge on the chip; the tag next to it names the fighter's build (#81) */
  startLineup(lineup: HTMLElement, shown: Fight, decisions: Decision[], labels: (string | null)[] = []) {
    lineup.innerHTML = shown.sim.fighters
      .map((f) => `<div class="chip" data-id="${f.id}" data-follow="${f.id}" style="--c:${hex(f.color)}">${portraitSvg(f.look, "fight", "tiny")}<span class="nm"><span class="fn">${esc(f.name)}</span>${modelBadgeHtml(labels[f.id] ?? null, "sm")}${buildTagHtml(f.build)}<em class="plan"></em><em class="slot"></em></span></div>`)
      .join("");
    lineup.className = "show";
  }

  onEvent(e: SimEvent, match: Match, clock: number) {
    if (e.type === "rule" && e.on) {
      // the plan playing now: a mid-round update (#8) brings its own rules
      const rule = (match.fight?.controllers[e.fighter]?.strategy ?? match.decisions[e.fighter]?.strategy)?.rules?.[e.rule];
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
