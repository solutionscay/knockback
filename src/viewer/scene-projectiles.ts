import { Container, Graphics, Sprite } from "pixi.js";
import { WEAPON_ACCENT } from "./palette";
import type { Sim } from "../sim/sim";
import type { Fx } from "./fx";
import type { XformAt } from "./scene";
import { setWorldFrame } from "./world-art";

/** A crossbow bolt's drawn flight (#92): its speed and its longest time (the shot itself is instant in the sim). */
const BOLT_SPEED = 120;
const BOLT_FLIGHT = 0.12;

export class ProjectileViews {
  readonly graphics = new Graphics();
  /** the plush sprites (#87): rockets, mines, the grapple hook, crossbow bolts; over the code trails and glows */
  readonly sprites = new Container();
  private used = 0;
  rails: { x0: number; y0: number; x1: number; y1: number; life: number }[] = [];
  waves: { paths: { x: number; y: number }[][]; life: number }[] = [];
  private minePrev = new Map<number, { x: number; y: number }>();
  private rocketPrev = new Map<number, { x: number; y: number }>();
  /** where a fighter's drawn muzzle is (the plush bot), or null */
  muzzleOf: ((fighter: number) => { x: number; y: number } | null) | null = null;
  /** a new rocket is drawn from the drawn muzzle, easing onto its sim path (view only) */
  private rocketOff = new Map<number, { x: number; y: number }>();
  /** a new mine likewise starts at the drawn hand */
  private mineOff = new Map<number, { x: number; y: number }>();
  ropes: { from: number; x0: number; y0: number; x1: number; y1: number; target: number; life: number; max: number }[] = [];
  zaps: { x0: number; y0: number; x1: number; y1: number; life: number }[] = [];
  swings: { x: number; y: number; dx: number; dy: number; life: number; color: number }[] = [];
  private tracers: { x0: number; y0: number; x1: number; y1: number; life: number }[] = [];
  /** precision shots (#38): rifle tracer, sniper round, crossbow bolt (and bolts left stuck in walls) */
  shots: { x0: number; y0: number; x1: number; y1: number; life: number; weapon: "rifle" | "sniper" | "crossbow" }[] = [];
  bolts: { x: number; y: number; dx: number; dy: number; life: number }[] = [];
  /** crossbow bolts in flight (#92): the plush bolt along the shot's line, at most BOLT_FLIGHT s; view only */
  private flights: { x0: number; y0: number; x1: number; y1: number; t: number; dur: number; stick: boolean }[] = [];
  /** lightning bolts (#72): a jagged line, redrawn every frame so it crackles */
  lightning: { x0: number; y0: number; x1: number; y1: number; life: number }[] = [];
  /**
   * A crossbow bolt flies from (x0, y0) to (x1, y1). The sim's shot is instant (it hits, pins and damages on the
   * tick it is fired), so the flight is kept short: BOLT_SPEED m/s, at most BOLT_FLIGHT s. `stick`: it stays in the
   * wall where it lands.
   */
  flyBolt(x0: number, y0: number, x1: number, y1: number, stick: boolean) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    this.flights.push({ x0, y0, x1, y1, t: 0, dur: Math.min(BOLT_FLIGHT, len / BOLT_SPEED), stick });
  }

  tracer(x0: number, y0: number, x1: number, y1: number) {
    this.tracers.push({ x0, y0, x1, y1, life: 0.1 });
  }

  reset() {
    this.rocketPrev.clear();
    this.rocketOff.clear();
    this.mineOff.clear();
    this.ropes = [];
    this.zaps = [];
    this.swings = [];
    this.rails = [];
    this.waves = [];
    this.shots = [];
    this.bolts = [];
    this.flights = [];
    this.lightning = [];
    this.minePrev.clear();
  }

  capturePrev(sim: Sim) {
    this.rocketPrev.clear();
    for (const r of sim.rockets) this.rocketPrev.set(r.id, { x: r.x, y: r.y });
    this.minePrev.clear();
    for (const m of sim.mines) this.minePrev.set(m.id, { x: m.x, y: m.y });
  }

  /**
   * A world sprite this frame (pooled): frame `name` centered at x, y (game meters, y up), turned to point along
   * (dx, dy); pointing left it is mirrored, so its top stays up and the light stays put.
   */
  private sprite(name: string, x: number, y: number, dx = 1, dy = 0, alpha = 1) {
    let s = this.sprites.children[this.used] as Sprite | undefined;
    if (!s) s = this.sprites.addChild(new Sprite());
    this.used++;
    if (!setWorldFrame(s, name)) return;
    s.position.set(x, -y);
    const left = dx < 0;
    s.rotation = left ? -Math.atan2(-dy, -dx) : -Math.atan2(dy, dx);
    if (left) s.scale.x *= -1;
    s.alpha = alpha;
  }

  render(sim: Sim, fx: Fx, dt: number, alpha: number, fxDt: number, xform: XformAt) {
    const pg = this.graphics;
    this.used = 0;
    try {
      this.draw(sim, fx, dt, alpha, fxDt, xform, pg);
    } finally {
      const kids = this.sprites.children;
      for (let i = 0; i < kids.length; i++) kids[i]!.visible = i < this.used && kids[i]!.visible;
    }
  }

  private draw(sim: Sim, fx: Fx, dt: number, alpha: number, fxDt: number, xform: XformAt, pg: Graphics) {
    for (const id of this.rocketOff.keys()) if (!sim.rockets.some((r) => r.id === id)) this.rocketOff.delete(id);
    for (const id of this.mineOff.keys()) if (!sim.mines.some((m) => m.id === id)) this.mineOff.delete(id);
    for (const m of sim.mines) {
      const p = this.minePrev.get(m.id) ?? m;
      let off = this.mineOff.get(m.id);
      if (!off) {
        const h = !this.minePrev.has(m.id) ? this.muzzleOf?.(m.owner) : null;
        off = h ? { x: h.x - m.x, y: h.y - m.y } : { x: 0, y: 0 };
        this.mineOff.set(m.id, off);
      }
      off.x *= Math.exp(-fxDt * 14);
      off.y *= Math.exp(-fxDt * 14);
      const x = p.x + (m.x - p.x) * alpha + off.x;
      const y = -(p.y + (m.y - p.y) * alpha + off.y);
      const armed = m.armedAt >= 0 && sim.tick > m.armedAt;
      const glow = armed && sim.tick % 12 < 8;
      if (glow) pg.circle(x, y, 0.49).fill({ color: WEAPON_ACCENT.mine, alpha: 0.4 });
      this.sprite("mine", x, -y);
    }
    for (const r of this.rails) {
      r.life -= fxDt;
      if (r.life <= 0) continue;
      const a = Math.min(1, r.life * 10);
      pg.moveTo(r.x0, -r.y0).lineTo(r.x1, -r.y1).stroke({ width: 0.34, color: WEAPON_ACCENT.railgun, alpha: 0.55 * a });
      pg.moveTo(r.x0, -r.y0).lineTo(r.x1, -r.y1).stroke({ width: 0.10, color: 0xf0fdff, alpha: a });
    }
    this.rails = this.rails.filter(r => r.life > 0);
    for (const wave of this.waves) {
      wave.life -= fxDt;
      if (wave.life <= 0) continue;
      const progress = Math.min(1, (0.36 - wave.life) / 0.23 + 0.12);
      for (const path of wave.paths) {
        const i = Math.floor((path.length - 1) * progress);
        const start = path[Math.max(0, i - 6)]!;
        const end = path[i]!;
        pg.moveTo(start.x, -start.y - 0.08);
        for (let j = Math.max(0, i - 6) + 1; j <= i; j++) pg.lineTo(path[j]!.x, -path[j]!.y - 0.08);
        pg.stroke({ width: 0.18, color: WEAPON_ACCENT.hammer, alpha: Math.min(1, wave.life * 6) });
        pg.circle(end.x, -end.y - 0.12, 0.24).fill({ color: 0xffe0a8, alpha: Math.min(1, wave.life * 6) });
      }
    }
    this.waves = this.waves.filter(wave => wave.life > 0);
    for (const r of sim.rockets) {
      const pr = this.rocketPrev.get(r.id) ?? r;
      let off = this.rocketOff.get(r.id);
      if (!off) {
        const m = this.muzzleOf?.(r.owner);
        off = m && r.age < 3 ? { x: m.x - r.x, y: m.y - r.y } : { x: 0, y: 0 };
        this.rocketOff.set(r.id, off);
      }
      off.x *= Math.exp(-fxDt * 16);
      off.y *= Math.exp(-fxDt * 16);
      const x = pr.x + (r.x - pr.x) * alpha + off.x;
      const y = pr.y + (r.y - pr.y) * alpha + off.y;
      const l = Math.hypot(r.vx, r.vy) || 1;
      const ux = r.vx / l;
      const uy = r.vy / l;
      const L = 0.55;
      pg.circle(x - ux * L, -(y - uy * L), 0.16 + Math.random() * 0.08).fill({ color: 0xffb03a, alpha: 0.95 });
      this.sprite("rocket", x + ux * 0.05, y + uy * 0.05, ux, uy);
      if (Math.random() < 0.9) {
        fx.add({ x: x - ux * L, y: y - uy * L, vx: -ux * 2 + (Math.random() - 0.5), vy: -uy * 2 + (Math.random() - 0.5), kind: "smoke", life: 0.7, size: 0.15, size1: 0.55, color: 0x9a97a2, alpha: 0.55, drag: 2, back: true });
        fx.add({ x: x - ux * L, y: y - uy * L, vx: -ux * 5, vy: -uy * 5, life: 0.12, size: 0.16, size1: 0.02, color: 0xffd36a });
      }
    }
    // the sniper's laser sight (#38): on while it aims, brighter as the shot gets close; it ends where the round would
    const aimH = sim.ruleset.tactics.weapons.enabled ? sim.ruleset.tactics.weapons.aimHeight : 0.25;
    for (const f of sim.fighters) {
      if (!f.alive || f.removed || f.scope <= 0) continue;
      const p = xform(f.entity, alpha);
      const ox = p.x, oy = p.y + aimH;
      const range = sim.ruleset.weapons.table.sniper.range;
      const hit = sim.raycast(ox, oy, f.aimX, f.aimY, range, f.entity.collider);
      const d = hit ? hit.dist : range;
      const k = Math.min(1, f.scope / sim.ruleset.weapons.table.sniper.aimTicks);
      const ex = ox + f.aimX * d, ey = oy + f.aimY * d;
      const lm = this.muzzleOf?.(f.id); // the laser starts at the plush scope's muzzle
      const lx = lm ? lm.x : ox + f.aimX * 0.9, ly = lm ? lm.y : oy + f.aimY * 0.9;
      pg.moveTo(lx, -ly).lineTo(ex, -ey).stroke({ width: 0.16, color: WEAPON_ACCENT.sniper, alpha: 0.12 + 0.18 * k });
      pg.moveTo(lx, -ly).lineTo(ex, -ey).stroke({ width: 0.045, color: WEAPON_ACCENT.sniper, alpha: 0.55 + 0.45 * k });
      pg.circle(ex, -ey, 0.13 + 0.06 * k).fill({ color: WEAPON_ACCENT.sniper, alpha: 0.9 });
      pg.circle(ex, -ey, 0.05).fill({ color: 0xffffff, alpha: 0.9 });
    }
    for (const sh of this.shots) {
      sh.life -= fxDt;
      if (sh.life <= 0) continue;
      const a = Math.min(1, sh.life * (sh.weapon === "sniper" ? 5 : 12));
      if (sh.weapon === "sniper") {
        pg.moveTo(sh.x0, -sh.y0).lineTo(sh.x1, -sh.y1).stroke({ width: 0.24, color: WEAPON_ACCENT.sniper, alpha: 0.45 * a });
        pg.moveTo(sh.x0, -sh.y0).lineTo(sh.x1, -sh.y1).stroke({ width: 0.07, color: 0xfff4f4, alpha: a });
      } else if (sh.weapon === "rifle") {
        // a short tracer streak toward the end of the shot
        const tx = sh.x1 - (sh.x1 - sh.x0) * 0.35, ty = sh.y1 - (sh.y1 - sh.y0) * 0.35;
        pg.moveTo(tx, -ty).lineTo(sh.x1, -sh.y1).stroke({ width: 0.08, color: WEAPON_ACCENT.rifle, alpha: a });
      } else {
        pg.moveTo(sh.x0, -sh.y0).lineTo(sh.x1, -sh.y1).stroke({ width: 0.05, color: 0xdfe6d8, alpha: 0.5 * a });
      }
    }
    this.shots = this.shots.filter((sh) => sh.life > 0);
    for (const f of this.flights) {
      f.t += fxDt;
      const len = Math.hypot(f.x1 - f.x0, f.y1 - f.y0) || 1;
      const dx = (f.x1 - f.x0) / len, dy = (f.y1 - f.y0) / len;
      if (f.t >= f.dur) {
        if (f.stick) this.bolts.push({ x: f.x1, y: f.y1, dx, dy, life: 2.5 });
        continue;
      }
      const k = f.t / f.dur;
      // its middle, a bolt's half length behind the point it has reached
      const x = f.x0 + (f.x1 - f.x0) * k - dx * 0.25, y = f.y0 + (f.y1 - f.y0) * k - dy * 0.25;
      this.sprite("bolt", x, y, dx, dy);
    }
    this.flights = this.flights.filter((f) => f.t < f.dur);
    for (const b of this.bolts) {
      b.life -= fxDt;
      if (b.life <= 0) continue;
      const a = Math.min(1, b.life * 2);
      // the bolt's tip in the wall: its middle 0.25 m back along its flight
      this.sprite("bolt", b.x - b.dx * 0.25, b.y - b.dy * 0.25, b.dx, b.dy, a);
    }
    this.bolts = this.bolts.filter((b) => b.life > 0);
    for (const b of this.lightning) {
      b.life -= fxDt;
      if (b.life <= 0) continue;
      const a = Math.min(1, b.life * 6);
      const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) || 1;
      const nx = -(b.y1 - b.y0) / len, ny = (b.x1 - b.x0) / len;
      const n = Math.max(4, Math.round(len / 0.7));
      const pts: number[] = [b.x0, -b.y0];
      for (let i = 1; i < n; i++) {
        const t = i / n, j = (Math.random() - 0.5) * 0.7;
        pts.push(b.x0 + (b.x1 - b.x0) * t + nx * j, -(b.y0 + (b.y1 - b.y0) * t + ny * j));
      }
      pts.push(b.x1, -b.y1);
      for (const [w, c, k] of [[0.42, WEAPON_ACCENT.lightning, 0.35], [0.16, WEAPON_ACCENT.lightning, 0.9], [0.06, 0xffffff, 1]] as const) {
        pg.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) pg.lineTo(pts[i]!, pts[i + 1]!);
        pg.stroke({ width: w, color: c, alpha: a * k, join: "round", cap: "round" });
      }
      pg.circle(b.x1, -b.y1, 0.35 + Math.random() * 0.15).fill({ color: WEAPON_ACCENT.lightning, alpha: 0.45 * a });
    }
    this.lightning = this.lightning.filter((b) => b.life > 0);
    // live ground (#72): a glowing band along the floor with arcs crackling over it; it flickers out at the end
    const ticks = sim.ruleset.weapons.table.lightning.groundTicks;
    for (const strip of sim.liveGround) {
      const pts = strip.points;
      if (!pts.length) continue;
      const fade = Math.min(1, strip.ticks / 30) * (strip.ticks < 30 && Math.random() < 0.3 ? 0.3 : 1);
      const fresh = Math.max(0, 1 - (ticks - strip.ticks) / 12);
      const x0 = pts[0]!.x - 0.25, x1 = pts[pts.length - 1]!.x + 0.25;
      pg.moveTo(x0, -pts[0]!.y - 0.05);
      for (const p of pts) pg.lineTo(p.x, -p.y - 0.05);
      pg.lineTo(x1, -pts[pts.length - 1]!.y - 0.05);
      pg.stroke({ width: 0.34 + fresh * 0.3, color: WEAPON_ACCENT.lightning, alpha: (0.3 + fresh * 0.4) * fade, cap: "round", join: "round" });
      for (let arc = 0; arc < 2; arc++) {
        pg.moveTo(x0, -pts[0]!.y - 0.1);
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]!;
          pg.lineTo(p.x + (Math.random() - 0.5) * 0.2, -(p.y + 0.08 + Math.random() * 0.32));
        }
        pg.lineTo(x1, -pts[pts.length - 1]!.y - 0.1);
        pg.stroke({ width: arc ? 0.035 : 0.07, color: arc ? 0xffffff : 0xd9ccff, alpha: 0.85 * fade, join: "round" });
      }
      if (Math.random() < 0.35) {
        const p = pts[Math.floor(Math.random() * pts.length)]!;
        fx.sparks(p.x, p.y + 0.1, 0, 1, WEAPON_ACCENT.lightning, 2);
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
      const hook = shooter.removed ? null : this.muzzleOf?.(r.from); // the line leaves the plush hook
      const sp = shooter.removed ? { x: r.x0, y: r.y0 } : hook ? { x: hook.x, y: hook.y - 0.25 } : xform(shooter.entity, alpha);
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
      this.sprite("hook", ex, ey, ex - sp.x, ey - (sp.y + 0.25), a);
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
