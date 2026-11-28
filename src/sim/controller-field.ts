/**
 * How a fighter uses force fields (#40; the numbers are the ruleset's `tactics.forceField`). Every fighter, house bot or
 * AI seat, plays the same:
 *   deploy     carrying one, on the ground, where the zone will still be: with a rival's rocket or grenade coming;
 *              or with a ranged rival that has a clear line to me while I am under fire, hurt, in a cover, hold or
 *              overwatch stance, or ahead in the last two; never with a rival in fist reach (it walks in). An active
 *              "use force field" plan rule deploys at once.
 *   shelter    inside my own field with the fight outside: stand still in it, away from its edge (no jumps out).
 *   hold fire  no shot, throw or blast that a field's edge would stop (punches and swings still go).
 *   targets    a rival inside a field I am not in comes after the others, unless I fight up close (controller.ts).
 * Pure reads of the sim state and integer ticks: deterministic.
 */
import { length2D } from "./dmath";
import { fieldAround, fieldBetween, insideField } from "./sim-field";
import type { Sim } from "./sim";
import type { Fighter, Input, Stance, Weapon } from "./sim-types";
import { inOpen } from "./tactical";

/** Swings: a field's edge does not stop them (#40). The lightning sword's slash too, within its reach. */
const SWINGS: readonly Weapon[] = ["fist", "bat"];
/** Weapons that fight up close: a fighter carrying one walks into a rival's field instead of waiting it out. */
const CLOSE: readonly Weapon[] = ["fist", "bat", "hammer", "freezegun", "flamethrower", "lightning", "shotgun"];

/** Does this fighter carry a weapon that fights from range (its reach out to `tactics.forceField.rangedReach`)? */
export function rangedArmed(sim: Sim, f: Fighter): boolean {
  const w = f.weapons[1];
  return w !== "fist" && sim.ruleset.tactics.weapons.reach[w].max >= sim.ruleset.tactics.forceField.rangedReach;
}

/** Does `me` fight up close (fists only, or a close weapon in its slot)? */
export function fightsClose(me: Fighter): boolean {
  return CLOSE.includes(me.weapons[1]);
}

/** Is rival `o` inside a force field that `me` is not in? */
export function shieldedFrom(sim: Sim, me: Fighter, o: Fighter): boolean {
  if (!sim.fields.length) return false;
  const f = fieldAround(sim, o);
  return !!f && fieldAround(sim, me) !== f;
}

export class FieldTactics {
  /** damage taken lately: [tick, damage] */
  private taken: { tick: number; dmg: number }[] = [];
  /** why the last deploy was asked for (stats and tests) */
  reason = "";

  onHit(tick: number, damage: number) {
    this.taken.push({ tick, dmg: damage });
    if (this.taken.length > 32) this.taken.shift();
  }

  /** Change the final input: deploy, shelter, hold fire. `aimId`: the fighter being aimed at (or -1). */
  apply(sim: Sim, me: Fighter, input: Input, aimId: number, stance: Stance, rule: boolean) {
    if (!sim.ruleset.pickups.forceField.enabled) return;
    const mp = sim.pos(me);
    if (me.forceField > 0 && this.wantsDeploy(sim, me, mp, stance, rule)) input.field = true;
    if (!sim.fields.length) return;
    const aim = aimId >= 0 ? sim.fighters[aimId] : undefined;
    const ap = aim && aim.alive && !aim.removed ? sim.pos(aim) : null;
    // shelter: my own field, the one I am aiming at outside it
    const own = fieldAround(sim, me);
    if (own && own.owner === me.id && ap && !insideField(own, ap.x, ap.y)) {
      const T = sim.ruleset.tactics.forceField;
      const dx = mp.x - own.x;
      const room = own.r - T.shelterMargin;
      // stand still inside (a step back in past `room`): turning back at the edge each time the plan walked out was
      // pacing on one spot (#88's detector counted it)
      input.move = Math.abs(dx) > room ? -Math.sign(dx) * 0.6 : 0;
      input.jump = false;
      input.thrust = false;
      input.down = false;
    }
    // hold fire: a field's edge between me and the one I am aiming at
    if (input.fire && ap) {
      const w: Weapon = input.weapon === "fist" ? "fist" : (input.weapon ?? sim.weapon(me));
      const d = length2D(ap.x - mp.x, ap.y - mp.y);
      const slash = w === "lightning" && d <= sim.ruleset.tactics.weapons.reach.lightning.slash;
      if (!SWINGS.includes(w) && !slash) {
        const oy = mp.y + (sim.ruleset.tactics.weapons.enabled ? sim.ruleset.tactics.weapons.aimHeight : 0.25);
        if (fieldBetween(sim, mp.x, oy, ap.x, ap.y)) {
          input.fire = false;
          input.dig = false;
        }
      }
    }
  }

  private wantsDeploy(sim: Sim, me: Fighter, mp: { x: number; y: number }, stance: Stance, rule: boolean): boolean {
    // on the ground only: deployed in the air, the bubble stays up there and the fighter lands under it
    if (!me.grounded || fieldAround(sim, me)) return false;
    const T = sim.ruleset.tactics.forceField;
    // where the zone will still be while it is up: outside, the zone pushes the fighter out of its own field
    const [lo, hi] = sim.zoneAhead(sim.ruleset.pickups.forceField.ticks);
    if (mp.x < lo + 1 || mp.x > hi - 1) return false;
    const rivals = sim.fighters.filter((o) => o.alive && !o.removed && o.id !== me.id);
    if (!rivals.length) return false;
    if (rule) return this.why("rule");
    const dist = (o: Fighter) => {
      const q = sim.pos(o);
      return length2D(q.x - mp.x, q.y - mp.y);
    };
    if (rivals.some((o) => dist(o) < T.meleeRange)) return false;
    // a rival's rocket or grenade on its way
    for (const r of sim.rockets) {
      if (r.owner !== me.id && length2D(r.x - mp.x, r.y - mp.y) < T.incomingRange && (mp.x - r.x) * r.vx + (mp.y - r.y) * r.vy > 0) return this.why("rocket");
    }
    for (const e of sim.entities.values()) {
      if (e.kind !== "grenade" || e.dead || e.owner === me.id) continue;
      const t = e.body.translation();
      if (length2D(t.x - mp.x, t.y - mp.y) < T.incomingRange) return this.why("grenade");
    }
    // exposed to a ranged rival (a clear line, within threatRange) while under fire, hurt, in a defensive stance, or
    // ahead in the last two: hits from up close, fire or the zone alone are no reason (a field stops none of them)
    let recent = 0;
    for (const h of this.taken) if (sim.tick - h.tick <= T.underFireTicks) recent += h.dmg;
    const underFire = T.underFireTicks > 0 && recent >= T.underFireDamage;
    const hurt = me.hp < me.maxHp * T.hurtShare;
    const defensive = stance === "cover" || stance === "hold" || stance === "overwatch";
    const lead = rivals.length === 1 && me.hp - rivals[0]!.hp >= T.leadHp;
    if (!underFire && !hurt && !defensive && !lead) return false;
    return rivals.some((o) => rangedArmed(sim, o) && dist(o) <= T.threatRange && inOpen(sim, o, me)) && this.why(underFire ? "under fire" : hurt ? "hurt" : defensive ? "stance" : "lead");
  }

  private why(reason: string): true {
    this.reason = reason;
    return true;
  }
}
