import { Graphics } from "pixi.js";
import type { Sim } from "../sim/sim";
import type { Fx } from "./fx";
import type { XformAt } from "./scene";

export class ProjectileViews {
  readonly graphics = new Graphics();
  private rocketPrev = new Map<number, { x: number; y: number }>();
  ropes: { from: number; x0: number; y0: number; x1: number; y1: number; target: number; life: number; max: number }[] = [];
  zaps: { x0: number; y0: number; x1: number; y1: number; life: number }[] = [];
  swings: { x: number; y: number; dx: number; dy: number; life: number; color: number }[] = [];
  private tracers: { x0: number; y0: number; x1: number; y1: number; life: number }[] = [];
  tracer(x0: number, y0: number, x1: number, y1: number) {
    this.tracers.push({ x0, y0, x1, y1, life: 0.1 });
  }

  reset() {
    this.rocketPrev.clear();
    this.ropes = [];
    this.zaps = [];
    this.swings = [];
  }

  capturePrev(sim: Sim) {
    this.rocketPrev.clear();
    for (const r of sim.rockets) this.rocketPrev.set(r.id, { x: r.x, y: r.y });
  }

  render(sim: Sim, fx: Fx, dt: number, alpha: number, fxDt: number, xform: XformAt) {
    const pg = this.graphics;
    for (const r of sim.rockets) {
      const pr = this.rocketPrev.get(r.id) ?? r;
      const x = pr.x + (r.x - pr.x) * alpha;
      const y = pr.y + (r.y - pr.y) * alpha;
      const l = Math.hypot(r.vx, r.vy) || 1;
      const ux = r.vx / l;
      const uy = r.vy / l;
      const L = 0.55;
      const Wd = 0.13;
      // body
      pg.poly([x + ux * L, -(y + uy * L), x - ux * L + -uy * Wd, -(y - uy * L + ux * Wd), x - ux * L - -uy * Wd, -(y - uy * L - ux * Wd)]).fill(0xf2f2f2);
      pg.circle(x - ux * L, -(y - uy * L), 0.16 + Math.random() * 0.08).fill({ color: 0xffb03a, alpha: 0.95 });
      if (Math.random() < 0.9) {
        fx.add({ x: x - ux * L, y: y - uy * L, vx: -ux * 2 + (Math.random() - 0.5), vy: -uy * 2 + (Math.random() - 0.5), kind: "smoke", life: 0.7, size: 0.15, size1: 0.55, color: 0x9a97a2, alpha: 0.55, drag: 2, back: true });
        fx.add({ x: x - ux * L, y: y - uy * L, vx: -ux * 5, vy: -uy * 5, life: 0.12, size: 0.16, size1: 0.02, color: 0xffd36a });
      }
    }
    for (const t of this.tracers) {
      t.life -= fxDt;
      if (t.life <= 0) continue;
      pg.moveTo(t.x0, -t.y0).lineTo(t.x1, -t.y1).stroke({ width: 0.07, color: 0xfff1b8, alpha: Math.min(1, t.life * 12) });
    }
    this.tracers = this.tracers.filter((t) => t.life > 0);
    for (const r of this.ropes) {
      r.life -= fxDt;
      if (r.life <= 0) continue;
      const shooter = sim.fighters[r.from]!;
      const sp = shooter.removed ? { x: r.x0, y: r.y0 } : xform(shooter.entity, alpha);
      let ex = r.x1;
      let ey = r.y1;
      if (r.target >= 0) {
        const t = sim.fighters[r.target]!;
        if (!t.removed) {
          const tp = xform(t.entity, alpha);
          ex = tp.x;
          ey = tp.y;
        }
      }
      const a = Math.min(1, r.life / r.max + 0.3);
      pg.moveTo(sp.x, -(sp.y + 0.25)).lineTo(ex, -ey).stroke({ width: 0.07, color: 0xd8dce6, alpha: a });
      pg.circle(ex, -ey, 0.13).stroke({ width: 0.05, color: 0xd8dce6, alpha: a });
    }
    this.ropes = this.ropes.filter((r) => r.life > 0);
    for (const z of this.zaps) {
      z.life -= dt;
      if (z.life <= 0) continue;
      let px = z.x0;
      let py = z.y0;
      pg.moveTo(px, -py);
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        px = z.x0 + (z.x1 - z.x0) * t + (i < 6 ? (Math.random() - 0.5) * 0.8 : 0);
        py = z.y0 + (z.y1 - z.y0) * t + (i < 6 ? (Math.random() - 0.5) * 0.8 : 0);
        pg.lineTo(px, -py);
      }
      pg.stroke({ width: 0.12, color: 0xffb0bb, alpha: Math.min(1, z.life * 6) });
    }
    this.zaps = this.zaps.filter((z) => z.life > 0);
    for (const sw of this.swings) {
      sw.life -= fxDt;
      if (sw.life <= 0) continue;
      const base = Math.atan2(sw.dy, sw.dx);
      const pts: number[] = [];
      for (let i = 0; i <= 8; i++) {
        const ang = base + 1.1 - (2.2 * i) / 8;
        pts.push(sw.x - sw.dx * 0.5 + Math.cos(ang) * 1.3, -(sw.y - sw.dy * 0.5 + Math.sin(ang) * 1.3));
      }
      for (let i = 8; i >= 0; i--) {
        const ang = base + 1.1 - (2.2 * i) / 8;
        pts.push(sw.x - sw.dx * 0.5 + Math.cos(ang) * 0.8, -(sw.y - sw.dy * 0.5 + Math.sin(ang) * 0.8));
      }
      pg.poly(pts).fill({ color: sw.color, alpha: Math.min(0.6, sw.life * 5) });
    }
    this.swings = this.swings.filter((sw) => sw.life > 0);
  }
}
