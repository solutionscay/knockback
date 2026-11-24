/**
 * Bare-handed and standing still: stretches where a fighter has no weapon, two or more fighters are alive, it is out
 * of a fight (no fighter damage dealt or taken for half a second, no rival within CLOSE m) and its body stays inside a
 * BOX m square for MIN_TICKS (2 s) or more. The demo complaint ("no weapon, just standing there") as a number.
 */
import type { Fight } from "../sim/fight";
import { isPickupWeapon, type SimEvent } from "../sim/sim-types";

export const IDLE_MIN_TICKS = 120;
const BOX = 1.0;
const CLOSE = 2.5;

export interface IdleSpell {
  fighter: number;
  plan: string;
  played: string;
  start: number;
  end: number;
  x: number;
  y: number;
  /** loose weapons on the floor at the start */
  loose: number;
  /** the fighter's goal was a pickup at the start */
  goalItem: boolean;
  target: number;
  targetDist: number;
}

interface Run { x0: number; x1: number; y0: number; y1: number; spell: IdleSpell }

/** Call `event()` on sim events and `tick()` after every step; `finish()` at the end. */
export class IdleBareTracker {
  readonly spells: IdleSpell[] = [];
  private readonly lastFight = [-1e9, -1e9, -1e9, -1e9];
  private readonly run: (Run | null)[] = [null, null, null, null];

  constructor(private readonly fight: Fight) {}

  event(e: SimEvent) {
    if (e.type === "hit" && e.source >= 0 && e.source !== e.target) this.lastFight[e.source] = this.lastFight[e.target] = e.tick;
  }

  private close(i: number) {
    const r = this.run[i];
    if (r && r.spell.end - r.spell.start >= IDLE_MIN_TICKS) this.spells.push(r.spell);
    this.run[i] = null;
  }

  tick() {
    const sim = this.fight.sim;
    const live = sim.alive().length >= 2 && !sim.roundOver;
    for (const f of sim.fighters) {
      const i = f.id;
      if (!f.alive || f.removed) {
        this.close(i);
        continue;
      }
      const p = sim.pos(f);
      const bare = f.weapons.every((w) => w === "fist");
      const near = sim.fighters.some((o) => o.id !== i && o.alive && !o.removed && Math.hypot(sim.pos(o).x - p.x, sim.pos(o).y - p.y) < CLOSE);
      const ok = live && bare && !near && sim.tick - this.lastFight[i]! > 30;
      const r = this.run[i];
      if (r && ok) {
        const x0 = Math.min(r.x0, p.x), x1 = Math.max(r.x1, p.x), y0 = Math.min(r.y0, p.y), y1 = Math.max(r.y1, p.y);
        if (x1 - x0 <= BOX && y1 - y0 <= BOX) {
          Object.assign(r, { x0, x1, y0, y1 });
          r.spell.end = sim.tick;
          continue;
        }
      }
      if (r) this.close(i);
      if (!ok) continue;
      const c = this.fight.controllers[i]!;
      const t = c.targetId >= 0 ? sim.fighters[c.targetId] : undefined;
      const tp = t && t.alive && !t.removed ? sim.pos(t) : null;
      this.run[i] = {
        x0: p.x, x1: p.x, y0: p.y, y1: p.y,
        spell: {
          fighter: i, plan: c.strategy.stance, played: c.stanceNow(sim), start: sim.tick, end: sim.tick, x: +p.x.toFixed(1), y: +p.y.toFixed(1),
          loose: sim.items().filter((e) => isPickupWeapon(e.itemType)).length,
          goalItem: c.goal?.item !== undefined, target: c.targetId, targetDist: tp ? +Math.hypot(tp.x - p.x, tp.y - p.y).toFixed(1) : -1,
        },
      };
    }
  }

  finish() {
    for (let i = 0; i < 4; i++) this.close(i);
  }
}
