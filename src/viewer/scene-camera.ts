import type { Container } from "pixi.js";
import { clamp, type Sim } from "../sim/sim";
import type { XformAt } from "./scene";

/**
 * Camera modes chosen by the viewer (view-only, never touches the sim):
 * auto = frame the busiest action, all = everyone on screen, follow = one fighter.
 */
export type CamMode = { kind: "auto" } | { kind: "all" } | { kind: "follow"; id: number };

export interface CameraFrame {
  cx: number;
  cy: number;
  s: number;
  shx: number;
  shy: number;
}

/**
 * View all (#41): the most world height the frame zooms out to for fighters high above the rest. Above that the
 * frame keeps the lowest fighters in view and a fighter above the top edge shows as an off-screen marker
 * (scene-fighters.ts). Width is not capped: View all still shows everyone across the arena.
 */
export const ALL_MAX_VIEW_HEIGHT = 26;
const ALL_PAD_X = 3.5;
const ALL_PAD_Y = 2.5;
/** "view all" must also show a fighter down in a crater (bedrock top is at -7) */
export const ALL_FLOOR_Y = -6.6;

/** View all target framing for the points to frame (world meters): scale s (px/m) and center (cx, cy). Pure. */
export function viewAllTarget(pts: readonly { x: number; y: number; frame: boolean }[], W: number, H: number) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (!p.frame) continue;
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  y0 = Math.max(y0, ALL_FLOOR_Y);
  y1 = Math.max(y1, y0 + 2);
  const spanY = y1 - y0 + ALL_PAD_Y * 2 + 1.5;
  const s = clamp(Math.min(W / (x1 - x0 + ALL_PAD_X * 2), H / Math.min(spanY, ALL_MAX_VIEW_HEIGHT)), H / 46, H / 11);
  // anchor near the bottom: the lowest fighter sits ~3 m above the bottom edge; when the fighters span more
  // height than the frame shows, keep the bottom in view (those above get an edge marker)
  const viewH = H / s;
  const cy = spanY > viewH ? y0 - 3.2 + viewH / 2 : Math.max(y0 - 3.2 + viewH / 2, (y0 + y1) / 2 + 0.8);
  return { s, cx: (x0 + x1) / 2, cy, x0, x1, y0, y1 };
}

export class SceneCamera {
  overview = false;
  private trauma = 0;
  private punch = 0;
  private punchX = 0;
  private punchY = 0;
  /**
   * Camera override: frame one fighter up close. offsetX shifts the fighter
   * off center (fraction of the view width), leaving room for cards.
   */
  focus: { id: number; offsetX: number; heightM: number } | null = null;
  /** The viewer's camera choice; intro focus, level overview and celebrate override it. */
  camMode: CamMode = { kind: "all" };
  /** Called when a followed fighter has been out for a beat (the game switches to auto). */
  onFollowLost: (() => void) | null = null;
  private followLostT = -1;
  /** Camera interest per fighter (recent hits/shots), decays. */
  private activity: number[] = [0, 0, 0, 0];
  private hotspots: { x: number; y: number; w: number }[] = [];
  readonly cam = { x: 0, y: 4, s: 40 };

  reset() {
    this.trauma = 0;
    this.punch = 0;
    this.focus = null;
    this.overview = false;
  }

  center(sim: Sim, W: number, H: number) {
    const xs = sim.alive().map((f) => sim.pos(f).x);
    this.cam.x = (Math.min(...xs) + Math.max(...xs)) / 2;
    this.cam.y = 4;
    this.cam.s = this.targetScale(Math.max(...xs) - Math.min(...xs) + 10, 16, W, H);

  }

  hotspot(x: number, y: number, w: number) {
    this.hotspots.push({ x, y, w });
  }

  hit(id: number, interest: number) {
    this.activity[id] = Math.min(3, (this.activity[id] ?? 0) + interest);
  }

  addShake(amount: number) {
    this.trauma = Math.min(1.2, this.trauma + amount);
  }

  koPunch(x: number, y: number) {
    this.punch = 1;
    this.punchX = x;
    this.punchY = y;
  }

  private minScale(H: number) {
    return H / 19;
  }

  private targetScale(spanX: number, spanY: number, W: number, H: number) {
    const s = Math.min(W / spanX, H / spanY);
    const maxS = H / 11;
    const minS = this.minScale(H);
    return Math.max(minS, Math.min(maxS, s));
  }

  render(sim: Sim, world: Container, W: number, H: number, dt: number, alpha: number, xform: XformAt): CameraFrame {
    // Frame the fighters. If they are spread wider than the max zoom-out,
    // frame the busiest window (recent hits, shots, rockets in flight).
    const all = this.camMode.kind === "all" && !this.focus && !this.overview;
    const floorY = all ? ALL_FLOOR_Y : -3;
    const pts: { x: number; y: number; w: number; frame: boolean }[] = [];
    for (const f of sim.fighters) {
      if (!(f.alive || (!f.removed && sim.tick - f.koTick < 40))) continue;
      const p = xform(f.entity, alpha);
      pts.push({ x: p.x, y: Math.max(floorY, p.y), w: 1 + (this.activity[f.id] ?? 0), frame: true });
    }
    // rockets and explosions only pull the choice of window, not its size
    // (in "view all" they are framed too, kept inside the arena)
    const lx0 = sim.level.minX - 2;
    const lx1 = sim.level.maxX + 2;
    for (const r of sim.rockets) pts.push({ x: clamp(r.x, lx0, lx1), y: clamp(r.y, -3, 14), w: 0.4, frame: all });
    for (const h of this.hotspots) pts.push({ x: clamp(h.x, lx0, lx1), y: clamp(h.y, -3, 14), w: h.w, frame: all && h.w > 0.6 });
    if (!pts.some((p) => p.frame)) pts.push({ x: this.cam.x, y: 2, w: 1, frame: true });
    const padX = all ? ALL_PAD_X : 6;
    const padY = all ? ALL_PAD_Y : 3.5;
    const maxSpan = all ? Infinity : W / this.minScale(H) - padX * 2;
    pts.sort((a, b) => a.x - b.x);
    let bestW = -1;
    let bi = 0;
    let bj = 0;
    for (let i = 0; i < pts.length; i++) {
      let w = 0;
      let j = i;
      while (j < pts.length && pts[j]!.x - pts[i]!.x <= maxSpan) w += pts[j++]!.w;
      if (w > bestW) {
        bestW = w;
        bi = i;
        bj = j;
      }
    }
    let inView = pts.slice(bi, bj).filter((p) => p.frame);
    if (inView.length === 0) inView = pts.filter((p) => p.frame).slice(0, 1);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const p of inView) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
    }
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of inView) {
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    y0 = Math.max(y0, floorY);
    y1 = Math.max(y1, y0 + 2);
    let tx = (x0 + x1) / 2;
    let ts: number;
    let ty: number;
    if (all) {
      ({ s: ts, cy: ty } = viewAllTarget(inView, W, H));
    } else {
      ts = this.targetScale(x1 - x0 + padX * 2, y1 - y0 + padY * 2 + 1.5, W, H);
      // anchor near the bottom: the lowest fighter sits ~3 m above the bottom edge
      const viewH = H / ts;
      ty = Math.max(y0 - 3.2 + viewH / 2, (y0 + y1) / 2 + 0.8);
    }
    let rate = all ? 3.5 : 2.6;
    if (this.camMode.kind === "follow" && !this.focus && !this.overview) {
      const fo = sim.fighters[this.camMode.id];
      if (fo && fo.alive && !fo.removed) {
        this.followLostT = -1;
        const p = xform(fo.entity, alpha);
        ts = H / 15;
        tx = p.x;
        ty = Math.max(p.y + 1.6, -7 + 7.5);
        rate = 4;
      } else {
        // knocked out: hold on the spot for a beat, then hand back to auto
        if (this.followLostT < 0) this.followLostT = 0;
        this.followLostT += dt;
        if (this.followLostT > 1.8) {
          this.followLostT = -1;
          this.onFollowLost?.();
        }
      }
    }
    const ff = this.focus ? sim.fighters[this.focus.id] : undefined;
    if (this.focus && ff && !ff.removed) {
      const p = xform(ff.entity, alpha);
      ts = H / this.focus.heightM;
      tx = p.x - (W / ts) * this.focus.offsetX;
      ty = p.y + 0.6;
      rate = 5;
    } else if (this.overview) {
      // the whole generated arena
      const lw = sim.level.width + 4;
      ts = Math.min(W / lw, H / 22);
      tx = 0;
      ty = -8 + (H / ts) / 2 + 2.5;
      rate = 6;
    }
    const k = 1 - Math.exp(-dt * rate);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.s += (ts - this.cam.s) * k;
    for (let i = 0; i < 4; i++) this.activity[i] = Math.max(0, (this.activity[i] ?? 0) - dt * 0.6);
    for (const h of this.hotspots) h.w -= dt * 1.2;
    this.hotspots = this.hotspots.filter((h) => h.w > 0);
    this.punch = Math.max(0, this.punch - dt * 0.9);
    const pk = this.punch * this.punch;
    let cx = this.cam.x + (this.punchX - this.cam.x) * pk * 0.35;
    let cy = this.cam.y + (this.punchY - this.cam.y) * pk * 0.35;
    const s = this.cam.s * (1 + pk * 0.25);
    // keep the bottom of the view from showing too much abyss
    const minCy = (all ? -7.6 : -7) + H / s / 2;
    if (cy < minCy) cy = minCy;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const sh = this.trauma * this.trauma;
    const shx = (Math.random() * 2 - 1) * sh * 0.9;
    const shy = (Math.random() * 2 - 1) * sh * 0.9;
    world.scale.set(s);
    world.position.set(W / 2 - (cx + shx) * s, H / 2 + (cy + shy) * s);
    world.rotation = (Math.random() * 2 - 1) * sh * 0.012;
    return { cx, cy, s, shx, shy };
  }
}
