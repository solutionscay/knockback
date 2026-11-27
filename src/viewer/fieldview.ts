/**
 * Force fields (#40), view only: a shimmering bubble where the sim has one (sim.fields), a ripple where it stops
 * something (fieldHit), a flash when it goes up and a burst when it goes down. It flickers as it runs low on time or on
 * damage it can take, and fades out over its last second. World meters, y down (the world container's frame).
 */
import { Graphics } from "pixi.js";
import type { Sim } from "../sim/sim";
import type { SimEvent } from "../sim/sim-types";
import type { Fx } from "./fx";
import { POWER_COLOR } from "./palette";

const COLOR = POWER_COLOR.forcefield!;
const RIM = 0xe6ecff;
/** the last ticks of a field's life: it fades out (60 ticks = 1 s) */
const FADE_TICKS = 60;
const RIPPLE_LIFE = 0.45;

interface Ripple {
  field: number;
  x: number;
  y: number;
  /** seconds left */
  life: number;
  size: number;
}

export class FieldView {
  readonly graphics = new Graphics();
  private ripples: Ripple[] = [];
  /** seconds since each field went up (for the opening flash), by id */
  private age = new Map<number, number>();

  reset() {
    this.ripples = [];
    this.age.clear();
    this.graphics.clear();
  }

  onEvent(e: SimEvent, fx: Fx, float: (text: string, x: number, y: number, color: number, scale: number) => void) {
    switch (e.type) {
      case "fieldUp":
        this.age.set(e.field, 0);
        fx.add({ x: e.x, y: e.y, kind: "ring", life: 0.5, size: 0.3, size1: e.r * 1.15, color: COLOR, alpha: 1, aux: 0.2 });
        fx.add({ x: e.x, y: e.y, kind: "flash", life: 0.18, size: e.r * 0.9, color: RIM, alpha: 0.6 });
        float("FORCE FIELD", e.x, e.y + e.r + 0.4, COLOR, 0.85);
        break;
      case "fieldHit":
        this.ripples.push({ field: e.field, x: e.x, y: e.y, life: RIPPLE_LIFE, size: Math.min(1.6, 0.6 + e.damage / 12) });
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * Math.PI * 2;
          fx.add({ x: e.x, y: e.y, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3, life: 0.25, size: 0.07, color: RIM, kind: "spark", drag: 3 });
        }
        break;
      case "fieldDown": {
        this.age.delete(e.field);
        const n = e.reason === "broken" ? 26 : 14;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          fx.add({ x: e.x + Math.cos(a) * 2.2, y: e.y + Math.sin(a) * 2.2, vx: Math.cos(a) * (e.reason === "broken" ? 5 : 1.5), vy: Math.sin(a) * (e.reason === "broken" ? 5 : 1.5), life: 0.5, size: 0.09, color: COLOR, kind: "square", gravity: 4, vr: 8 });
        }
        if (e.reason === "broken") float("FIELD BROKEN", e.x, e.y + 2.6, COLOR, 0.8);
        break;
      }
    }
  }

  render(sim: Sim, time: number, dt: number) {
    const g = this.graphics;
    g.clear();
    const spec = sim.ruleset.pickups.forceField;
    for (const f of sim.fields) {
      const age = (this.age.get(f.id) ?? 1) + dt;
      this.age.set(f.id, age);
      // grows in over 0.2 s; fades over the last second; flickers when low on time or on damage it can take
      const grow = Math.min(1, age / 0.2);
      const r = f.r * (0.6 + 0.4 * grow);
      const fade = Math.min(1, f.ticks / FADE_TICKS);
      const low = f.hp < spec.absorb * 0.3 || f.ticks < FADE_TICKS * 1.5;
      const flicker = low ? 0.65 + 0.35 * Math.sin(time * 38) : 1;
      const a = fade * flicker;
      const x = f.x, y = -f.y;
      // the body: a faint fill with a brighter inner band near the edge
      g.circle(x, y, r).fill({ color: COLOR, alpha: 0.09 * a });
      g.circle(x, y, r * 0.93).stroke({ width: r * 0.14, color: COLOR, alpha: 0.12 * a });
      // the shimmer: arcs sliding round the bubble at different speeds
      for (let k = 0; k < 3; k++) {
        const start = time * (1.3 + k * 0.7) * (k % 2 ? -1 : 1) + k * 2.1;
        g.arc(x, y, r * (0.8 - k * 0.12), start, start + 0.9 + 0.3 * Math.sin(time * 2 + k)).stroke({ width: 0.05, color: RIM, alpha: (0.22 + 0.1 * Math.sin(time * 5 + k)) * a });
      }
      // a soft hex-ish sheen: three chords that wobble
      for (let k = 0; k < 3; k++) {
        const ang = time * 0.6 + (k * Math.PI) / 3;
        const cx = Math.cos(ang) * r * 0.85, cy = Math.sin(ang) * r * 0.85;
        g.moveTo(x - cx, y - cy).lineTo(x + cx, y + cy).stroke({ width: 0.03, color: RIM, alpha: 0.07 * a });
      }
      // the edge
      g.circle(x, y, r).stroke({ width: 0.09, color: RIM, alpha: (0.55 + 0.2 * Math.sin(time * 6)) * a });
      g.circle(x, y, r + 0.08).stroke({ width: 0.05, color: COLOR, alpha: 0.35 * a });
      // the damage it can still take, as a thin arc along the top
      const share = Math.max(0, f.hp / spec.absorb);
      if (share < 1) g.arc(x, y, r + 0.22, -Math.PI / 2 - share * Math.PI * 0.45, -Math.PI / 2 + share * Math.PI * 0.45).stroke({ width: 0.07, color: COLOR, alpha: 0.6 * a });
    }
    for (const id of [...this.age.keys()]) if (!sim.fields.some((f) => f.id === id)) this.age.delete(id);
    // ripples: a bright ring growing from where it was hit, and that part of the edge lit
    for (const rp of this.ripples) {
      rp.life -= dt;
      const f = sim.fields.find((x) => x.id === rp.field);
      const t = 1 - Math.max(0, rp.life) / RIPPLE_LIFE;
      const alpha = (1 - t) * 0.9;
      g.circle(rp.x, -rp.y, 0.2 + t * rp.size).stroke({ width: 0.08 * (1 - t) + 0.02, color: RIM, alpha });
      if (f) {
        const ang = Math.atan2(-(rp.y - f.y), rp.x - f.x);
        g.arc(f.x, -f.y, f.r, ang - 0.5 - t * 0.6, ang + 0.5 + t * 0.6).stroke({ width: 0.16 * (1 - t) + 0.04, color: RIM, alpha: alpha * 0.8 });
      }
    }
    this.ripples = this.ripples.filter((r) => r.life > 0);
  }
}
