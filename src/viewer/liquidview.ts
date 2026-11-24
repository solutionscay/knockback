/**
 * Liquids (#94, #116): the grid's liquid layer (`Grid.liq`) drawn as liquid, in front of the fighters, so a fighter
 * in a pool shows through it, tinted.
 *
 * One renderer for every liquid; how each one looks and moves is a parameter entry (liquid-looks.ts).
 * - Each pool's open surface is one continuous span (not per-cell tiles): a wavy top edge from a few layered ambient
 *   waves plus a spring height field (4 samples per cell) that carries ripples out from where something hits it.
 *   A foam line runs along the top, and a gloss line under it for glossy liquids.
 * - The body follows the pool's carved shape cell by cell (it refills or drains with the grid). It shades from
 *   translucent at the surface to darker and denser at depth. A faint caustic shimmer runs on the floor of clear
 *   liquids, and a glow sits over glowing ones (lava).
 * - Where the surface meets a wall it climbs a small meniscus. The wall above it is darkened (a wet edge), and the
 *   body bleeds a little into the ground, so there are no square corners.
 * - It reacts, read-only from the sim: a fighter, prop, chunk, weapon or projectile crossing the surface splashes
 *   (droplets plus a ripple). Swimming leaves a small wake, and an explosion near the surface pushes a bigger wave.
 *   Things floating at the surface bob with it (bob()), and fighters below it wobble (submerged()).
 *
 * Deterministic for a given frame sequence: the springs step at a fixed 60 Hz from the time the scene passes in,
 * and the droplets use a seeded generator (no Math.random), so a replay or teaser capture renders the same frames.
 * Visual only: nothing here writes to the sim.
 */
import { Container, FillGradient, Graphics } from "pixi.js";
import { CELL, LIQUID_NAMES, type Grid } from "../sim/grid";
import type { Sim } from "../sim/sim";
import type { SimEvent } from "../sim/sim-types";
import type { Theme } from "../sim/themes";
import { liquidLook, type LiquidLook } from "./liquid-looks";

/** surface samples per cell */
const SPC = 4;
const DX = CELL / SPC;
const STEP = 1 / 60;
const MAX_DROPS = 320;

interface Span {
  L: number;
  look: LiquidLook;
  cx0: number;
  cx1: number;
  /** world y of each column's surface at rest (top of its top cell), cx0..cx1; the highest */
  tops: number[];
  top: number;
  /** world y of each column's floor (bottom of its run), cx0..cx1 */
  floor: number[];
  /** walls at the ends (ground beside the surface): meniscus and wet edge */
  wallL: boolean;
  wallR: boolean;
  /** first sample index (grid-wide) and count */
  s0: number;
  n: number;
  fill: FillGradient;
}

/** a run of liquid with no open top (under an overhang): drawn as a deep block */
interface Hidden { L: number; look: LiquidLook; x: number; y0: number; y1: number }

interface Drop { x: number; y: number; vx: number; vy: number; life: number; size: number; color: number }

interface Body { inside: boolean; seen: number }

export class LiquidView {
  readonly container = new Container();
  private readonly back = new Graphics();
  private readonly lines = new Graphics();
  private readonly glow = new Graphics();
  private readonly dropsG = new Graphics();
  private readonly sig: Uint8Array;
  private spans: Span[] = [];
  private hidden: Hidden[] = [];
  /** per column: the span whose surface covers it (the highest), or -1 */
  private spanAt: Int32Array;
  /** spring height field over the whole grid width, per sample: height (m), velocity, owning span (-1: none) */
  private readonly h: Float32Array;
  private readonly v: Float32Array;
  private readonly own: Int32Array;
  private drops: Drop[] = [];
  private readonly bodies = new Map<string, Body>();
  private time = -1;
  private acc = 0;
  private frame = 0;
  private seed = 0x9e3779b9;
  private any = false;
  private drawn = false;

  constructor(
    private readonly grid: Grid,
    readonly theme: Theme,
  ) {
    this.sig = new Uint8Array(grid.cols * grid.rows).fill(255);
    this.spanAt = new Int32Array(grid.cols).fill(-1);
    this.h = new Float32Array(grid.cols * SPC);
    this.v = new Float32Array(grid.cols * SPC);
    this.own = new Int32Array(grid.cols * SPC).fill(-1);
    this.glow.blendMode = "add";
    this.container.addChild(this.back, this.glow, this.lines, this.dropsG);
  }

  /**
   * Draw the liquids at `time` (seconds). With `sim`, also react to what moves through them (splashes, wakes); the
   * level lab passes none (still pools).
   */
  update(time: number, sim?: Sim) {
    const dt = this.time < 0 ? 0 : Math.max(0, time - this.time);
    this.time = time;
    this.rebuildIfChanged();
    if (!this.any && !this.drops.length) {
      // no liquid on this map (or it all drained): nothing to draw, nothing to step
      if (this.drawn) { this.back.clear(); this.lines.clear(); this.glow.clear(); this.dropsG.clear(); this.drawn = false; }
      return;
    }
    // a long gap (fast-forward without drawing, a new round): no splashes for what crossed meanwhile
    const jumped = dt > 0.25;
    if (sim && this.any) this.observe(sim, jumped);
    this.acc = Math.min(this.acc + (jumped ? 0 : dt), STEP * 4);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step();
    }
    this.stepDrops(jumped ? 0 : dt);
    this.draw();
    this.drawn = true;
  }

  /** Sim events the liquids answer: an explosion near a surface pushes a wave and throws drops. */
  event(e: SimEvent) {
    if (e.type !== "explosion" || !this.any) return;
    const reach = e.radius * 2.5;
    for (const sp of this.spans) {
      const x0 = this.grid.wx(sp.cx0), x1 = this.grid.wx(sp.cx1) + CELL;
      const nx = Math.min(x1, Math.max(x0, e.x));
      const d = Math.hypot(nx - e.x, this.rest(sp, nx) - e.y);
      if (d > reach) continue;
      const k = 1 - d / reach;
      this.impulse(sp, nx, -0.16 * e.radius * k, e.radius * 0.9);
      this.burst(sp, nx, Math.round(10 * k * sp.look.drops) + 2, 2 + 4 * k, 0.4 + e.radius * 0.3);
    }
  }

  /** How far (m) a floating thing at (x, y) with half height `hh` bobs, and its tilt; zero when not at a surface. */
  bob(x: number, y: number, hh: number): { dy: number; rot: number } {
    const sp = this.surfaceSpan(x);
    if (!sp) return { dy: 0, rot: 0 };
    const r = this.rest(sp, x);
    if (Math.abs(y - r) > hh + 0.25) return { dy: 0, rot: 0 };
    const a = this.surfY(sp, x - DX), b = this.surfY(sp, x + DX);
    return { dy: this.surfY(sp, x) - r, rot: Math.atan2(b - a, 2 * DX) * 0.6 };
  }

  /** How deep (m) under a surface the point is (0: not under one): fighters below it wobble. */
  submerged(x: number, y: number): number {
    if (!this.any || !this.grid.liquidAt(x, y)) return 0;
    const sp = this.surfaceSpan(x);
    return sp ? Math.max(0, this.rest(sp, x) - y) : 1;
  }

  // ---- the pools from the grid

  private rebuildIfChanged() {
    const g = this.grid;
    let changed = false;
    for (let i = 0; i < g.liq.length; i++) {
      const L = g.liq[i]!;
      if (L !== this.sig[i]) { this.sig[i] = L; changed = true; }
    }
    if (changed) this.rebuild();
  }

  private rebuild() {
    const g = this.grid;
    const old = this.spans;
    this.spans = [];
    this.hidden = [];
    this.spanAt.fill(-1);
    const own = new Int32Array(this.own.length).fill(-1);
    // per column, its runs of one liquid; a run whose top cell has open air (or another liquid) above is a surface
    type Run = { cx: number; L: number; top: number; bot: number };
    const surf: Run[] = [];
    for (let cx = 0; cx < g.cols; cx++) {
      let cy = g.rows - 1;
      while (cy >= 0) {
        const L = g.liqAt(cx, cy);
        if (!L) { cy--; continue; }
        const top = cy;
        while (cy >= 0 && g.liqAt(cx, cy) === L) cy--;
        const bot = cy + 1;
        const open = top + 1 >= g.rows || !g.solid(cx, top + 1);
        if (open) surf.push({ cx, L, top, bot });
        else this.hidden.push({ L, look: liquidLook(LIQUID_NAMES[L] ?? "water"), x: g.wx(cx), y0: g.wy(bot), y1: g.wy(top) + CELL });
      }
    }
    // neighbouring columns of one liquid whose runs touch make one span, even where the level steps by a cell (the
    // grid settles whole cells): the surface eases across the step instead of standing up in a wall
    surf.sort((a, b) => a.L - b.L || a.cx - b.cx || b.top - a.top);
    const chains: Run[][] = [];
    for (const r of surf) {
      const ch = chains.find((c) => {
        const last = c[c.length - 1]!;
        return last.L === r.L && last.cx === r.cx - 1 && r.bot <= last.top + 1 && r.top + 1 >= last.bot;
      });
      if (ch) ch.push(r);
      else chains.push([r]);
    }
    for (const runs of chains) {
      const a = runs[0]!, b = runs[runs.length - 1]!;
      const look = liquidLook(LIQUID_NAMES[a.L] ?? "water");
      const tops = runs.map((r) => g.wy(r.top) + CELL);
      // a lone column standing a cell above its neighbours (the grid settles whole cells, often against a wall) reads as
      // a frozen crest: draw it at its neighbours' level (one cell of liquid against the wall goes unpainted)
      for (let i = 0; i < tops.length && tops.length > 1; i++) {
        const l = i > 0 ? tops[i - 1]! : -Infinity, r = i < tops.length - 1 ? tops[i + 1]! : -Infinity;
        if (tops[i]! > Math.max(l, r)) tops[i] = Math.max(l, r);
      }
      const top = Math.max(...tops);
      const sp: Span = {
        L: a.L, look, cx0: a.cx, cx1: b.cx, tops, top,
        floor: runs.map((r) => g.wy(r.bot)),
        wallL: g.solid(a.cx - 1, a.top), wallR: g.solid(b.cx + 1, b.top),
        s0: a.cx * SPC, n: (b.cx - a.cx + 1) * SPC,
        fill: this.gradient(look, top),
      };
      const id = this.spans.length;
      this.spans.push(sp);
      for (let s = sp.s0; s < sp.s0 + sp.n; s++) own[s] = id;
      for (let cx = sp.cx0; cx <= sp.cx1; cx++) {
        const cur = this.spanAt[cx]!;
        if (cur < 0 || this.spans[cur]!.top < top) this.spanAt[cx] = id;
      }
    }
    // keep the ripples where the surface stayed (same row), drop them where it moved
    const restCol = (sp: Span | undefined, cx: number) => (sp && cx >= sp.cx0 && cx <= sp.cx1 ? sp.tops[cx - sp.cx0] : NaN);
    for (let s = 0; s < own.length; s++) {
      const was = this.own[s]!, now = own[s]!, cx = Math.floor(s / SPC);
      if (now < 0 || was < 0 || restCol(old[was], cx) !== restCol(this.spans[now], cx)) { this.h[s] = 0; this.v[s] = 0; }
    }
    this.own.set(own);
    for (const sp of old) sp.fill.destroy();
    this.any = this.spans.length > 0 || this.hidden.length > 0;
  }

  /** translucent at the surface, darker and denser over the look's depth (world y down from the surface) */
  private gradient(look: LiquidLook, top: number) {
    const hex = (c: number, a: number) => `#${c.toString(16).padStart(6, "0")}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
    const mid = mix(look.color, look.deep, 0.45);
    return new FillGradient({
      type: "linear",
      start: { x: 0, y: -top },
      end: { x: 0, y: -top + look.depthM },
      colorStops: [
        { offset: 0, color: hex(look.color, look.alpha) },
        { offset: 0.35, color: hex(mid, (look.alpha + look.deepAlpha) / 2) },
        { offset: 1, color: hex(look.deep, look.deepAlpha) },
      ],
      textureSpace: "global",
    });
  }

  // ---- motion

  private step() {
    const { h, v } = this;
    for (const sp of this.spans) {
      const k = 0.022 * sp.look.waveSpeed;
      const damp = 0.012 + 0.12 * sp.look.viscosity;
      const spread = 0.2 * Math.min(1, sp.look.waveSpeed + 0.2);
      const e = sp.s0 + sp.n;
      for (let s = sp.s0; s < e; s++) {
        v[s]! += -k * h[s]! - damp * v[s]!;
        h[s]! += v[s]!;
      }
      // ripples travel: each pass, every sample pulls its neighbours (only within its own span)
      for (let pass = 0; pass < 3; pass++) {
        for (let s = sp.s0 + 1; s < e; s++) {
          const d = spread * (h[s]! - h[s - 1]!) * 0.5;
          v[s - 1]! += d;
          v[s]! -= d;
        }
      }
      for (let s = sp.s0; s < e; s++) h[s] = Math.max(-0.22, Math.min(0.22, h[s]!));
    }
    this.frame++;
  }

  private impulse(sp: Span, x: number, amount: number, width: number) {
    const amt = amount * (1 - 0.7 * sp.look.viscosity);
    const c = (x - this.grid.x0) / DX - 0.5;
    const w = Math.max(1, width / DX);
    const a = Math.max(sp.s0, Math.floor(c - w)), b = Math.min(sp.s0 + sp.n - 1, Math.ceil(c + w));
    for (let s = a; s <= b; s++) {
      const u = (s - c) / w;
      if (Math.abs(u) <= 1) this.v[s]! += amt * 0.5 * (1 + Math.cos(Math.PI * u));
    }
  }

  private rand() {
    // mulberry32: the same frames give the same drops
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private burst(sp: Span, x: number, n: number, speed: number, spreadX: number) {
    for (let i = 0; i < n && this.drops.length < MAX_DROPS; i++) {
      const r = this.rand(), q = this.rand();
      this.drops.push({
        x: x + (r - 0.5) * spreadX, y: this.surfY(sp, x) + 0.02,
        vx: (q - 0.5) * speed * 1.1, vy: speed * (0.55 + 0.6 * this.rand()),
        life: 0.45 + 0.4 * this.rand(), size: 0.035 + 0.045 * this.rand(), color: sp.look.drop,
      });
    }
  }

  private stepDrops(dt: number) {
    if (!this.drops.length) return;
    const keep: Drop[] = [];
    for (const d of this.drops) {
      d.life -= dt;
      d.vy -= 14 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      // a drop that falls back into a surface is gone (a tiny ring there)
      const sp = this.surfaceSpan(d.x);
      if (sp && d.vy < 0 && d.y <= this.surfY(sp, d.x)) {
        this.impulse(sp, d.x, -0.004, 0.12);
        continue;
      }
      if (d.life > 0) keep.push(d);
    }
    this.drops = keep;
  }

  /** what moves through the liquids: fighters, props and chunks, and rockets */
  private observe(sim: Sim, jumped: boolean) {
    const tick = sim.tick;
    const seen = (key: string, x: number, y: number, vx: number, vy: number, size: number) => {
      const inside = this.grid.liquidAt(x, y) !== 0;
      const b = this.bodies.get(key);
      if (!b) { this.bodies.set(key, { inside, seen: tick }); return; }
      b.seen = tick;
      const sp = this.surfaceSpan(x);
      if (b.inside !== inside && !jumped && sp) {
        const speed = Math.hypot(vx, vy);
        if (inside) {
          // in: a dip and a crown of drops, bigger the harder it hits
          this.impulse(sp, x, -Math.min(0.2, 0.025 + 0.014 * speed) * (0.6 + size), 0.3 + size);
          this.burst(sp, x, Math.round(Math.min(18, 4 + speed * 1.6) * sp.look.drops * (0.5 + size)), 2 + speed * 0.35, 0.2 + size);
        } else {
          // out: a lift and a few drops falling off it
          this.impulse(sp, x, Math.min(0.12, 0.02 + 0.008 * speed), 0.25 + size * 0.5);
          this.burst(sp, x, Math.round(4 * sp.look.drops), 1.5 + speed * 0.2, 0.2);
        }
      } else if (inside && sp && !jumped && this.rest(sp, x) - y < 0.9 && Math.abs(vx) > 0.8) {
        // swimming near the top: a small wake behind
        this.impulse(sp, x - Math.sign(vx) * 0.3, -0.0012 * Math.min(6, Math.abs(vx)), 0.55);
        if ((this.frame + (key.length * 7)) % 9 === 0) this.burst(sp, x - Math.sign(vx) * 0.2, 1, 1.4, 0.15);
      }
      b.inside = inside;
    };
    for (const f of sim.fighters) {
      if (!f.alive || f.removed) continue;
      const p = sim.pos(f), v = sim.vel(f);
      seen(`f${f.id}`, p.x, p.y, v.x, v.y, 0.6);
    }
    for (const e of sim.entities.values()) {
      if (e.dead || e.fighter) continue;
      const p = e.body.translation(), v = e.body.linvel();
      seen(`e${e.id}`, p.x, p.y, v.x, v.y, Math.min(0.6, Math.max(e.hw, e.hh)));
    }
    for (const r of sim.rockets) seen(`r${r.id}`, r.x, r.y, r.vx, r.vy, 0.15);
    for (const [k, b] of this.bodies) if (b.seen !== tick) this.bodies.delete(k);
  }

  // ---- drawing

  private surfaceSpan(x: number): Span | null {
    const cx = this.grid.cx(x);
    if (cx < 0 || cx >= this.grid.cols) return null;
    const id = this.spanAt[cx]!;
    return id < 0 ? null : this.spans[id]!;
  }

  /** the surface's resting world y at x: each column's level, eased between column centres where it steps */
  private rest(sp: Span, x: number) {
    const u = (x - this.grid.wx(sp.cx0)) / CELL - 0.5;
    const n = sp.tops.length;
    const a = Math.max(0, Math.min(n - 1, Math.floor(u))), b = Math.min(n - 1, a + 1);
    const t = Math.max(0, Math.min(1, u - a));
    const k = t * t * (3 - 2 * t);
    return sp.tops[a]! + (sp.tops[b]! - sp.tops[a]!) * k;
  }

  /** the surface's world y at x: rest + ripples + the swell + the meniscus at walls */
  private surfY(sp: Span, x: number) {
    const s = Math.min(sp.s0 + sp.n - 1, Math.max(sp.s0, Math.round((x - this.grid.x0) / DX - 0.5)));
    let d = this.h[s]! + this.swell(sp, x);
    // beside a wall the liquid cannot climb over the ground: only the meniscus rises there
    const g = this.grid;
    const wall = Math.min(sp.wallL ? x - g.wx(sp.cx0) : Infinity, sp.wallR ? g.wx(sp.cx1) + CELL - x : Infinity);
    if (wall < 0.3) d = Math.min(d, 0.02 + (wall / 0.3) * 0.12);
    return this.rest(sp, x) + d + this.meniscus(sp, x);
  }

  private swell(sp: Span, x: number) {
    const t = this.time * sp.look.waveSpeed;
    const H = sp.look.waveHeight;
    return H * (0.55 * Math.sin(x * 2.1 + t * 1.6) + 0.3 * Math.sin(x * 4.7 - t * 2.3 + 1.7) + 0.15 * Math.sin(x * 9.3 + t * 3.6 + 0.4));
  }

  private meniscus(sp: Span, x: number) {
    const g = this.grid;
    const l = x - g.wx(sp.cx0), r = g.wx(sp.cx1) + CELL - x;
    const m = 0.055 * (1 - 0.5 * sp.look.viscosity);
    let y = 0;
    if (sp.wallL && l < 0.2) y += m * (1 - l / 0.2) ** 2;
    if (sp.wallR && r < 0.2) y += m * (1 - r / 0.2) ** 2;
    return y;
  }

  private draw() {
    const g = this.grid;
    const back = this.back.clear();
    const lines = this.lines.clear();
    const glow = this.glow.clear();
    for (const hd of this.hidden) {
      back.rect(hd.x, -hd.y1, CELL, hd.y1 - hd.y0).fill({ color: hd.look.deep, alpha: hd.look.deepAlpha });
    }
    for (const sp of this.spans) {
      const look = sp.look;
      const x0 = g.wx(sp.cx0), x1 = g.wx(sp.cx1) + CELL;
      // the top edge: one point per sample, plus the two ends
      const pts: number[] = [x0, -this.surfY(sp, x0 + 0.001)];
      for (let i = 0; i < sp.n; i++) {
        const x = x0 + (i + 0.5) * DX;
        pts.push(x, -this.surfY(sp, x));
      }
      pts.push(x1, -this.surfY(sp, x1 - 0.001));
      // the body: the top edge, then down the right wall and back along each column's floor
      back.moveTo(pts[0]!, pts[1]!);
      for (let i = 2; i < pts.length; i += 2) back.lineTo(pts[i]!, pts[i + 1]!);
      for (let c = sp.cx1; c >= sp.cx0; c--) {
        const fy = -sp.floor[c - sp.cx0]!;
        back.lineTo(g.wx(c) + CELL, fy);
        back.lineTo(g.wx(c), fy);
      }
      back.closePath().fill(sp.fill);
      // a lighter band just under the surface: the light caught in the top of the liquid
      if (look.band > 0) {
        back.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) back.lineTo(pts[i]!, pts[i + 1]!);
        for (let i = pts.length - 2; i >= 0; i -= 2) back.lineTo(pts[i]!, pts[i + 1]! + 0.16);
        back.closePath().fill({ color: look.foam, alpha: look.band * 0.35 });
      }
      // the soft edge: the liquid bleeds a little into the walls below its surface; above, the wall is wet
      const tL = sp.tops[0]!, tR = sp.tops[sp.tops.length - 1]!;
      if (sp.wallL) {
        back.rect(x0 - 0.06, -tL, 0.06, tL - sp.floor[0]!).fill({ color: look.deep, alpha: look.alpha * 0.45 });
        back.rect(x0 - 0.14, -tL - 0.12, 0.14, 0.12).fill({ color: 0x000000, alpha: 0.12 });
      }
      if (sp.wallR) {
        back.rect(x1, -tR, 0.06, tR - sp.floor[sp.floor.length - 1]!).fill({ color: look.deep, alpha: look.alpha * 0.45 });
        back.rect(x1, -tR - 0.12, 0.14, 0.12).fill({ color: 0x000000, alpha: 0.12 });
      }
      // caustics: a faint moving shimmer just above the floor of clear liquids
      if (look.caustics > 0) {
        let drew = false;
        for (let i = 0; i < sp.n; i += 1) {
          const x = x0 + (i + 0.5) * DX;
          const c = Math.floor((x - x0) / CELL);
          const floor = sp.floor[c]!;
          if (sp.tops[c]! - floor < CELL * 1.5) continue;
          const n = Math.sin(x * 6.3 + this.time * 1.9) + Math.sin(x * 2.7 - this.time * 1.2 + 2);
          if (n < 0.9) continue;
          const y = -(floor + 0.07 + 0.03 * Math.sin(x * 11 + this.time * 3));
          lines.moveTo(x - DX * 0.45, y).lineTo(x + DX * 0.45, y - 0.01);
          drew = true;
        }
        if (drew) lines.stroke({ width: 0.035, color: 0xffffff, alpha: 0.32 * look.caustics });
      }
      // the foam (or crust) line along the top, and a gloss line just under it
      lines.moveTo(pts[0]!, pts[1]!);
      for (let i = 2; i < pts.length; i += 2) lines.lineTo(pts[i]!, pts[i + 1]!);
      lines.stroke({ width: look.foamWidth, color: look.foam, alpha: look.foamAlpha, cap: "round", join: "round" });
      if (look.gloss > 0) {
        lines.moveTo(pts[0]! + 0.08, pts[1]! + 0.07);
        for (let i = 2; i < pts.length - 2; i += 2) lines.lineTo(pts[i]!, pts[i + 1]! + 0.07);
        lines.stroke({ width: 0.025, color: 0xffffff, alpha: 0.5 * look.gloss });
      }
      if (look.glowAlpha > 0) {
        glow.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) glow.lineTo(pts[i]!, pts[i + 1]!);
        glow.stroke({ width: 0.3, color: look.glow, alpha: look.glowAlpha * 0.6 });
      }
    }
    const dg = this.dropsG.clear();
    for (const d of this.drops) dg.circle(d.x, -d.y, d.size).fill({ color: d.color, alpha: Math.min(1, d.life * 2.5) * 0.9 });
  }
}

function mix(a: number, b: number, t: number) {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
