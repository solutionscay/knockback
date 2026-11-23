/**
 * Fire and smoke (#33): flames rising from whatever burns this frame: static
 * cells (sim.fires), cells of loose pieces, props, and fighters on fire.
 * View only: reads the Sim, emits viewer particles (Math.random is fine here).
 */
import { CELL } from "../sim/grid";
import type { Sim } from "../sim/sim";
import type { Entity } from "../sim/sim-types";
import type { Fx } from "./fx";
import type { XformAt } from "./scene";

/** flames per second from one burning spot */
const RATE = 16;
/** at most this many flames a frame, however much burns (they are shared out) */
const MAX_PER_FRAME = 90;

export class FireView {
  private carry = 0;

  emit(sim: Sim, fx: Fx, dt: number, alpha: number, xform: XformAt) {
    if (dt <= 0) return;
    const spots: { x: number; y: number; spread: number; scale: number }[] = [];
    const g = sim.grid;
    for (const i of sim.fires.keys()) {
      const cx = i % g.cols;
      const cy = (i - cx) / g.cols;
      spots.push({ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL * 0.75, spread: CELL * 0.45, scale: 1 });
    }
    // #94: burning oil, a little wider and taller than a burning cell
    for (const i of sim.liquids.oilFires.keys()) {
      const cx = i % g.cols;
      const cy = (i - cx) / g.cols;
      spots.push({ x: g.wx(cx) + CELL / 2, y: g.wy(cy) + CELL * 0.9, spread: CELL * 0.55, scale: 1.2 });
    }
    for (const e of sim.entities.values()) {
      if (e.dead) continue;
      if (e.kind === "chunk") this.pieceSpots(e, alpha, xform, spots);
      else if (e.burn) {
        const p = xform(e, alpha);
        spots.push({ x: p.x, y: p.y + e.hh * 0.6, spread: e.hw * 0.8, scale: 1.1 });
      }
    }
    for (const f of sim.fighters) {
      if (f.burning <= 0 || !f.alive || f.removed) continue;
      const p = xform(f.entity, alpha);
      spots.push({ x: p.x, y: p.y - 0.2, spread: 0.32, scale: 1.25 });
      spots.push({ x: p.x, y: p.y + 0.35, spread: 0.25, scale: 1 });
    }
    if (!spots.length) {
      this.carry = 0;
      return;
    }
    // share the frame's flames out over the spots, round-robin from a random start
    this.carry += Math.min(MAX_PER_FRAME, spots.length * RATE * dt);
    const n = Math.floor(this.carry);
    this.carry -= n;
    const start = Math.floor(Math.random() * spots.length);
    for (let k = 0; k < n; k++) {
      const s = spots[(start + k) % spots.length]!;
      fx.flame(s.x, s.y, s.spread, s.scale);
    }
  }

  private pieceSpots(e: Entity, alpha: number, xform: XformAt, out: { x: number; y: number; spread: number; scale: number }[]) {
    let p: ReturnType<XformAt> | null = null;
    for (const c of e.cells!) {
      if (!c.burn) continue;
      p ??= xform(e, alpha);
      const lx = (c.lx + 0.5) * CELL;
      const ly = (c.ly + 0.75) * CELL;
      const co = Math.cos(p.a), si = Math.sin(p.a);
      out.push({ x: p.x + lx * co - ly * si, y: p.y + lx * si + ly * co, spread: CELL * 0.4, scale: 1 });
    }
  }
}
