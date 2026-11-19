/**
 * Viewer-only particles. Uses Math.random freely: nothing here feeds back
 * into the simulation.
 */
import { Graphics } from "pixi.js";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  size1: number;
  color: number;
  alpha: number;
  gravity: number;
  drag: number;
  kind: "dot" | "square" | "spark" | "smoke" | "ring" | "flash" | "beam" | "trail";
  rot: number;
  vr: number;
  /** ring/flash end radius, beam direction etc */
  aux: number;
  /** behind fighters? */
  back: boolean;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Fx {
  parts: Particle[] = [];

  add(p: Partial<Particle> & { x: number; y: number }) {
    this.parts.push({
      vx: 0,
      vy: 0,
      life: 0.5,
      max: p.life ?? 0.5,
      size: 0.2,
      size1: p.size1 ?? p.size ?? 0.2,
      color: 0xffffff,
      alpha: 1,
      gravity: 0,
      drag: 0,
      kind: "dot",
      rot: 0,
      vr: 0,
      aux: 0,
      back: false,
      ...p,
    } as Particle);
  }

  explosion(x: number, y: number, r: number, big: boolean) {
    this.add({ x, y, kind: "flash", life: 0.16, size: r * 0.5, size1: r * 1.05, color: 0xfff6d8, alpha: 0.95 });
    this.add({ x, y, kind: "ring", life: 0.38, size: r * 0.4, size1: r * 1.5, color: 0xffffff, alpha: 0.8, aux: 0.18 });
    if (big) this.add({ x, y, kind: "ring", life: 0.6, size: r * 0.6, size1: r * 2.4, color: 0xffb347, alpha: 0.5, aux: 0.1 });
    const n = big ? 46 : 30;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(2, big ? 15 : 11);
      this.add({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s + 2,
        life: rnd(0.25, 0.6),
        size: rnd(0.25, 0.55) * (big ? 1.3 : 1),
        size1: 0.02,
        color: [0xfff1a8, 0xffc14d, 0xff7a2f, 0xff4d2e][(Math.random() * 4) | 0]!,
        drag: 3.5,
        gravity: -3,
      });
    }
    for (let i = 0; i < (big ? 18 : 11); i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(0.5, 4);
      this.add({
        x: x + rnd(-0.4, 0.4),
        y: y + rnd(-0.4, 0.4),
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s + 1.5,
        life: rnd(0.9, 1.8),
        size: rnd(0.4, 0.8),
        size1: rnd(1.0, 1.8) * (big ? 1.4 : 1),
        color: [0x3b3a45, 0x4d4b57, 0x2c2b33][(Math.random() * 3) | 0]!,
        alpha: 0.75,
        kind: "smoke",
        drag: 1.6,
        gravity: -1.2,
        back: true,
      });
    }
    for (let i = 0; i < (big ? 22 : 14); i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(10, big ? 26 : 20);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.15, 0.4), size: 0.07, color: 0xfff3c4, kind: "spark", drag: 2, gravity: 14 });
    }
  }

  debris(x: number, y: number, hw: number, hh: number, color: number, n = 7) {
    for (let i = 0; i < n; i++) {
      this.add({
        x: x + rnd(-hw, hw),
        y: y + rnd(-hh, hh),
        vx: rnd(-6, 6),
        vy: rnd(2, 10),
        life: rnd(0.8, 1.6),
        size: rnd(0.14, 0.32),
        color,
        kind: "square",
        gravity: 22,
        drag: 0.3,
        rot: Math.random() * 6,
        vr: rnd(-14, 14),
      });
    }
    for (let i = 0; i < 4; i++) {
      this.add({ x: x + rnd(-hw, hw), y: y + rnd(-hh, hh), vx: rnd(-1, 1), vy: rnd(0, 1.5), life: rnd(0.5, 0.9), size: 0.3, size1: 0.9, color: 0xb9a68a, alpha: 0.45, kind: "smoke", drag: 2, back: true });
    }
  }

  dust(x: number, y: number, strength: number) {
    const n = Math.min(14, 4 + Math.floor(strength));
    for (let i = 0; i < n; i++) {
      const dir = i % 2 ? 1 : -1;
      this.add({ x: x + rnd(-0.2, 0.2), y: y + 0.05, vx: dir * rnd(1, 3 + strength * 0.2), vy: rnd(0.2, 1.4), life: rnd(0.3, 0.6), size: rnd(0.12, 0.22), size1: rnd(0.35, 0.55), color: 0xd8d2c4, alpha: 0.5, kind: "smoke", drag: 4, back: true });
    }
  }

  sparks(x: number, y: number, dx: number, dy: number, color: number, n: number) {
    for (let i = 0; i < n; i++) {
      const s = rnd(4, 14);
      this.add({ x, y, vx: dx * s + rnd(-4, 4), vy: dy * s + rnd(-4, 4), life: rnd(0.12, 0.3), size: 0.06, color, kind: "spark", drag: 3, gravity: 10 });
    }
  }

  burst(x: number, y: number, color: number) {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(4, 16);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.4, 1.0), size: rnd(0.15, 0.35), size1: 0.02, color: Math.random() < 0.3 ? 0xffffff : color, drag: 2.5, gravity: 6 });
    }
    this.add({ x, y, kind: "ring", life: 0.5, size: 0.5, size1: 4, color, alpha: 0.9, aux: 0.25 });
  }

  /** Smash-style ring-out blast: a beam pointing back into the arena. */
  beam(x: number, y: number, dirX: number, dirY: number, color: number) {
    this.add({ x, y, kind: "beam", life: 0.9, size: 1.6, size1: 0.1, color, alpha: 1, aux: Math.atan2(dirY, dirX), back: true });
    this.burst(x, y, color);
  }

  update(dt: number) {
    const keep: Particle[] = [];
    for (const p of this.parts) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.gravity * dt;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      keep.push(p);
    }
    this.parts = keep;
  }

  draw(back: Graphics, front: Graphics) {
    back.clear();
    front.clear();
    for (const p of this.parts) {
      const g = p.back ? back : front;
      const t = 1 - p.life / p.max; // 0 -> 1
      const size = p.size + (p.size1 - p.size) * t;
      const a = p.alpha * (p.kind === "smoke" ? (1 - t) * (1 - t) : 1 - t * t);
      const x = p.x;
      const y = -p.y;
      switch (p.kind) {
        case "dot":
          g.circle(x, y, size).fill({ color: p.color, alpha: a });
          break;
        case "smoke":
          g.circle(x, y, size).fill({ color: p.color, alpha: a });
          break;
        case "square": {
          const c = Math.cos(p.rot) * size;
          const s = Math.sin(p.rot) * size;
          g.poly([x - c + s, y - s - c, x + c + s, y + s - c, x + c - s, y + s + c, x - c - s, y - s + c]).fill({ color: p.color, alpha: Math.min(1, p.life * 3) });
          break;
        }
        case "spark": {
          const k = 0.035;
          g.moveTo(x, y)
            .lineTo(x - p.vx * k, y + p.vy * k)
            .stroke({ width: size, color: p.color, alpha: a, cap: "round" });
          break;
        }
        case "ring":
          g.circle(x, y, size).stroke({ width: p.aux * (1 - t) + 0.02, color: p.color, alpha: a });
          break;
        case "flash":
          g.circle(x, y, size).fill({ color: p.color, alpha: a });
          break;
        case "trail":
          g.roundRect(x - p.aux, y - size, p.aux * 2, size * 2, p.aux).fill({ color: p.color, alpha: a * 0.45 });
          break;
        case "beam": {
          const len = 30;
          const w = size;
          const ang = p.aux;
          const ux = Math.cos(ang);
          const uy = -Math.sin(ang);
          const px = -uy;
          const py = ux;
          g.poly([x + px * w * 0.3, y + py * w * 0.3, x + ux * len + px * w, y + uy * len + py * w, x + ux * len - px * w, y + uy * len - py * w, x - px * w * 0.3, y - py * w * 0.3]).fill({ color: p.color, alpha: a * 0.8 });
          g.poly([x + px * w * 0.12, y + py * w * 0.12, x + ux * len + px * w * 0.35, y + uy * len + py * w * 0.35, x + ux * len - px * w * 0.35, y + uy * len - py * w * 0.35, x - px * w * 0.12, y - py * w * 0.12]).fill({ color: 0xffffff, alpha: a });
          break;
        }
      }
    }
  }
}
