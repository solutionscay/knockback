/**
 * Plan rule evaluation (#6): deterministic, from sim state and integer
 * ticks only. Each Controller owns one RuleEngine. evaluate() runs every
 * RULE_EVAL.everyTicks and right after a pickup, hit or knockout; it
 * starts and stops rules (with hysteresis) and pushes a "rule" sim event
 * each time. The controller reads the effective overrides; the base
 * strategy is never changed, so it comes back when a rule stops.
 */
import type { Controller } from "./controller";
import { isPickupWeapon } from "./sim-types";
import { hasLongGun, inCover, inOpen } from "./tactical";
import type { Sim } from "./sim";
import type { Fighter, ItemType, Retaliate, Rule, Stance, Weapon } from "./sim-types";

/**
 *   everyTicks   regular evaluation interval (events also trigger one)
 *   minOnTicks   a rule stays active at least this long after it starts
 *   minOffTicks  and can start again only this long after it stops
 *   ledgeM, barrelM, chaseTicks, hitTicks, itemCost   trigger thresholds
 */
import { CLASSIC, type Ruleset } from "./ruleset";


export interface RuleState {
  active: boolean;
  since: number;
  offAt: number;
  /** fighter that made the trigger true (closest by path cost), -1 if none */
  subject: number;
}

export class RuleEngine {
  readonly state: RuleState[];
  private nextEval = 0;
  /** set by Fight when a pickup, hit or knockout happened */
  dirty = false;
  /** starts per rule this fight (tests, debug) */
  readonly starts: number[];

  constructor(readonly rules: readonly Rule[], private readonly tuning: Ruleset["tactics"]["ruleEval"] = CLASSIC.tactics.ruleEval) {
    this.state = rules.map(() => ({ active: false, since: -1, offAt: -this.tuning.minOffTicks, subject: -1 }));
    this.starts = rules.map(() => 0);
  }

  get any(): boolean {
    return this.rules.length > 0;
  }

  /** Who `who` means for this fighter now (seat order). */
  private candidates(sim: Sim, me: Fighter, who: Rule["who"], targetId: number): Fighter[] {
    const alive = sim.fighters.filter((f) => f.alive && !f.removed);
    if (who === "enemy") return alive.filter((f) => f.id !== me.id);
    if (who === "target") return alive.filter((f) => f.id === targetId && f.id !== me.id);
    if (typeof who === "number") return alive.filter((f) => f.id === who);
    return alive; // anyone
  }

  /** Is the trigger true, and for which fighters. */
  private trigger(sim: Sim, ctl: Controller, me: Fighter, r: Rule): { on: boolean; who: Fighter[] } {
    const cand = () => this.candidates(sim, me, r.who, ctl.targetId);
    const pos = (f: Fighter) => sim.pos(f);
    switch (r.when) {
      case "holds":
        return this.some(cand().filter((f) => r.item === "jetpack" ? f.power.jetpack > 0 : f.weapons.includes(r.item as Weapon)));
      case "my_health_below":
        return { on: me.hp < r.value! * (me.maxHp / 100), who: [] };
      case "health_below":
        return this.some(cand().filter((f) => f.hp < r.value! * (f.maxHp / 100)));
      case "near_ledge":
        return this.some(cand().filter((f) => nearLedge(sim, f)));
      case "near_barrel": {
        const barrels: { x: number; y: number }[] = [];
        for (const e of sim.entities.values()) if (!e.dead && (e.kind === "barrel" || e.kind === "tnt")) barrels.push(e.body.translation());
        return this.some(cand().filter((f) => barrels.some((b) => Math.hypot(b.x - pos(f).x, b.y - pos(f).y) < this.tuning.barrelM)));
      }
      case "on_streak":
        return this.some(cand().filter((f) => f.kos >= r.value!));
      case "chasing_me":
        return this.some(cand().filter((f) => f.id !== me.id && ctl.peers[f.id]!.targetId === me.id && sim.tick - ctl.peers[f.id]!.targetSince >= this.tuning.chaseTicks));
      case "hit_me":
        return this.some(cand().filter((f) => ctl.hitBy(f.id, sim.tick - this.tuning.hitTicks)));
      case "item_near": {
        if (me.surface < 0) return { on: false, who: [] };
        const nav = sim.nav;
        const plan = nav.fighterPlan(sim.grid, me.surface, pos(me).x);
        for (const it of sim.items()) {
          if (it.itemType !== r.item) continue;
          const t = it.body.translation();
          const s = nav.surfaceAt(t.x, t.y + 0.3, 0.2);
          if (s && plan.cost[s.id]! + Math.abs(plan.arriveX[s.id]! - t.x) <= this.tuning.itemCost) return { on: true, who: [] };
        }
        return { on: false, who: [] };
      }
      case "alone_with": {
        const others = sim.fighters.filter((f) => f.alive && !f.removed && f.id !== me.id);
        return { on: others.length === 1, who: others };
      }
      case "in_open":
        return this.some(cand().filter((f) => inOpen(sim, me, f)));
      case "has_long_gun":
        return this.some(cand().filter((f) => hasLongGun(sim, f)));
      case "in_cover":
        return { on: inCover(sim, me), who: [] };
    }
  }

  private some(who: Fighter[]) {
    return { on: who.length > 0, who };
  }

  /** The closest fighter (other than me) by path cost; ties go to the lower seat. */
  private closest(sim: Sim, me: Fighter, who: Fighter[]): number {
    const others = who.filter((f) => f.id !== me.id);
    if (!others.length) return -1;
    const mp = sim.pos(me);
    const plan = me.surface >= 0 ? sim.nav.fighterPlan(sim.grid, me.surface, mp.x) : null;
    let best = -1;
    let bc = Infinity;
    for (const f of others) {
      const p = sim.pos(f);
      let c = plan && f.surface >= 0 ? plan.cost[f.surface]! + Math.abs(plan.arriveX[f.surface]! - p.x) : Infinity;
      if (!Number.isFinite(c)) c = 1000 + Math.abs(p.x - mp.x) + Math.abs(p.y - mp.y);
      if (c < bc) {
        bc = c;
        best = f.id;
      }
    }
    return best;
  }

  /** Start and stop rules; push a "rule" event for each change. */
  evaluate(sim: Sim, ctl: Controller, me: Fighter) {
    if (!this.any || !me.alive) return;
    if (sim.tick < this.nextEval && !this.dirty) return;
    this.nextEval = sim.tick + this.tuning.everyTicks;
    this.dirty = false;
    const t = sim.tick;
    this.rules.forEach((r, i) => {
      const st = this.state[i]!;
      const tr = this.trigger(sim, ctl, me, r);
      const subj = tr.on ? this.closest(sim, me, tr.who) : -1;
      if (st.active) {
        if (tr.on) st.subject = subj;
        else if (t - st.since >= this.tuning.minOnTicks) {
          st.active = false;
          st.offAt = t;
          sim.events.push({ type: "rule", tick: t, fighter: me.id, rule: i, on: false, subject: st.subject });
        } else if (st.subject >= 0 && !sim.fighters[st.subject]!.alive) st.subject = -1;
      } else if (tr.on && t - st.offAt >= this.tuning.minOffTicks) {
        st.active = true;
        st.since = t;
        st.subject = subj;
        this.starts[i]!++;
        sim.events.push({ type: "rule", tick: t, fighter: me.id, rule: i, on: true, subject: subj });
      }
    });
  }

  private first(kinds: Rule["do"][]): { rule: Rule; state: RuleState } | null {
    for (let i = 0; i < this.rules.length; i++) if (this.state[i]!.active && kinds.includes(this.rules[i]!.do)) return { rule: this.rules[i]!, state: this.state[i]! };
    return null;
  }

  /** The highest active target/avoid rule: whom to target, or whom to keep away from. */
  targetRule(): { kind: "target" | "avoid"; subject: number } | null {
    const f = this.first(["target", "avoid"]);
    return f && f.state.subject >= 0 ? { kind: f.rule.do as "target" | "avoid", subject: f.state.subject } : null;
  }

  /** Every fighter an active avoid rule keeps away from (never targeted). */
  avoided(): number[] {
    const out: number[] = [];
    this.rules.forEach((r, i) => {
      const s = this.state[i]!;
      if (s.active && r.do === "avoid" && s.subject >= 0 && !out.includes(s.subject)) out.push(s.subject);
    });
    return out;
  }

  stance(): Stance | null {
    return this.first(["stance"])?.rule.stance ?? null;
  }

  use(): Weapon | "jetpack" | null {
    const item = this.first(["use"])?.rule.doItem;
    return item === "jetpack" || isPickupWeapon(item) ? item : null;
  }

  retaliate(): Retaliate | null {
    return this.first(["retaliate"])?.rule.retaliate ?? null;
  }

  /** Items active seek rules go for, highest priority first. */
  seeking(): ItemType[] {
    const out: ItemType[] = [];
    this.rules.forEach((r, i) => {
      if (this.state[i]!.active && r.do === "seek" && r.doItem && !out.includes(r.doItem)) out.push(r.doItem);
    });
    return out;
  }
}

/** Standing within sim.ruleset.tactics.ruleEval.ledgeM of a pit edge or the level edge. */
export function nearLedge(sim: Sim, f: Fighter): boolean {
  const p = sim.pos(f);
  if (p.x - sim.level.minX < sim.ruleset.tactics.ruleEval.ledgeM || sim.level.maxX - p.x < sim.ruleset.tactics.ruleEval.ledgeM) return true;
  const s = f.surface >= 0 ? sim.nav.surfaces[f.surface] : undefined;
  if (!s || !f.grounded) return false;
  return (s.dropLeft && p.x - s.x0 < sim.ruleset.tactics.ruleEval.ledgeM) || (s.dropRight && s.x1 - p.x < sim.ruleset.tactics.ruleEval.ledgeM);
}
