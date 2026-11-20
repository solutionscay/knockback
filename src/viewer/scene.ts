/**
 * The PixiJS scene: terrain, props, fighters, effects, camera, health bars.
 * World units are meters with y up; the world container maps (x, y) to (x, -y).
 */
import { Container, Graphics, Rectangle, type Application } from "pixi.js";
import type { Entity, Sim, SimEvent } from "../sim/sim";
import type { Callout } from "./callouts";
import { PALETTES } from "./palette";
import { SceneCamera, type CameraFrame } from "./scene-camera";
import { CalloutViews } from "./scene-callouts";
import { SceneEffects } from "./scene-effects";
import { FighterViews } from "./scene-fighters";
import { ProjectileViews } from "./scene-projectiles";
import { PropViews } from "./scene-props";
import { ChainView } from "./chains";
import { TerrainView } from "./terrainview";

export type { CamMode } from "./scene-camera";

interface Xform {
  x: number;
  y: number;
  a: number;
}

export type XformAt = (e: Entity, alpha: number) => Xform;

const ZONE_COLOR = 0xff2a4a;

export class Scene {
  private sim!: Sim;
  private sky = new Graphics();
  private hills = new Graphics();
  private world = new Container();
  private terrainView: TerrainView | null = null;
  private chainView: ChainView | null = null;
  private readonly chainLayer = new Container();
  /** the camera of the last rendered frame (capture-mode screenshot scripts read it) */
  lastFrame: CameraFrame | null = null;
  private terrainLayer = new Container();
  private pal = PALETTES.warehouse;
  private abyss = new Graphics();
  private zoneG = new Graphics();
  private overlay = new Container();
  private readonly props = new PropViews();
  private readonly fighters = new FighterViews();
  private readonly effects = new SceneEffects();
  private readonly projectiles = new ProjectileViews();
  private readonly calloutViews = new CalloutViews();
  readonly camera = new SceneCamera();
  private prev = new Map<number, Xform>();
  private time = 0;

  constructor(private readonly app: Application) {
    app.stage.addChild(this.sky, this.hills, this.world, this.overlay, this.effects.flashScreen);
    this.world.addChild(this.abyss, this.zoneG, this.chainLayer, this.terrainLayer, this.effects.back, this.props.layer, this.props.marks, this.fighters.layer, this.projectiles.graphics, this.effects.front);
    this.overlay.addChild(this.fighters.barsG, this.effects.textLayer, this.calloutViews.lines, this.calloutViews.layer);
  }

  /**
   * Capture-mode check (feet contact; view only): the alpha of one group of
   * layers exactly as drawn this frame, full screen, one byte per pixel.
   * "surface" = terrain cells, platforms and props; "feet" = only the bots'
   * feet; "bodies" = the bots without their feet, except fighter `except`
   * (to check a bot standing on another). Everything is restored afterwards.
   */
  maskAlpha(kind: "surface" | "feet" | "bodies", except = -1): { width: number; height: number; alpha: Uint8Array } {
    const keep: Container[] = kind === "surface" ? [this.terrainLayer, this.props.layer] : [this.fighters.layer];
    const stageSaved = this.app.stage.children.map((c) => [c, c.visible] as const);
    const worldSaved = this.world.children.map((c) => [c, c.visible] as const);
    for (const c of this.app.stage.children) c.visible = c === this.world;
    for (const c of this.world.children) c.visible = keep.includes(c);
    const restoreFeet = kind === "feet" ? this.fighters.feetOnly() : kind === "bodies" ? this.fighters.bodiesOnly(except) : () => {};
    const { pixels, width, height } = this.app.renderer.extract.pixels({ target: this.app.stage, frame: new Rectangle(0, 0, this.W, this.H), antialias: true });
    restoreFeet();
    for (const [c, v] of worldSaved) c.visible = v;
    for (const [c, v] of stageSaved) c.visible = v;
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]!;
    return { width, height, alpha };
  }

  /** The standing feet of each fighter, world x of each sole's middle (capture-mode check). */
  soles() {
    return this.fighters.soles();
  }

  get W() {
    return this.app.renderer.width / this.app.renderer.resolution;
  }
  get H() {
    return this.app.renderer.height / this.app.renderer.resolution;
  }
  get ui() {
    return this.H / 1080;
  }

  set morale(states: string[]) {
    this.fighters.morale = states;
  }

  set celebrateId(id: number) {
    this.fighters.celebrateId = id;
  }

  load(sim: Sim) {
    this.calloutViews.clear();
    this.sim = sim;
    this.props.clear();
    this.fighters.clear();
    this.effects.clearText();
    this.prev.clear();
    this.projectiles.reset();
    this.effects.fx.parts = [];
    this.camera.reset();
    this.celebrateId = -1;
    this.props.clearDrops();
    this.pal = PALETTES[sim.level.theme];
    if (this.terrainView) this.terrainView.container.destroy({ children: true });
    this.terrainView = new TerrainView(sim.grid, this.pal);
    this.terrainLayer.addChild(this.terrainView.container);
    this.chainView?.destroy();
    this.chainView = new ChainView(sim.grid);
    this.chainLayer.addChild(this.chainView.container);
    this.terrainView.update();
    this.drawTerrain();
    this.fighters.load(sim);
    this.props.sync(sim);
    this.capturePrev();
    this.camera.center(sim, this.W, this.H);
  }

  private drawTerrain() {
    // abyss: darkness rising from the bottom so falls read as "gone"
    const a = this.abyss;
    a.clear();
    for (let i = 0; i < 16; i++) {
      const y0 = -2 - i * 0.75;
      a.rect(-80, -y0, 160, 0.8).fill({ color: 0x05060c, alpha: Math.min(1, i / 11) });
    }
    a.rect(-80, 14, 160, 60).fill(0x05060c);
  }

  private drawSky() {
    const W = this.W;
    const H = this.H;
    const s = this.sky;
    s.clear();
    const n = 18;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const c = lerpColor(this.pal.sky[0], this.pal.sky[1], t);
      s.rect(0, (H * i) / n, W, H / n + 1).fill(c);
    }
    // hills with parallax
    const h = this.hills;
    h.clear();
    const cam = this.camera.cam;
    const par = 0.25;
    const base = H * 0.62 + cam.y * cam.s * 0.15;
    const ox = -cam.x * cam.s * par;
    const pts: number[] = [];
    for (let x = -200; x <= W + 200; x += 40) {
      const wx = (x - ox) / 90;
      pts.push(x, base - (Math.sin(wx) * 60 + Math.sin(wx * 2.3 + 1) * 30 + 90) * this.ui);
    }
    pts.push(W + 200, H, -200, H);
    h.poly(pts).fill(this.pal.hills[1]);
    const pts2: number[] = [];
    const ox2 = -cam.x * cam.s * 0.45;
    const base2 = H * 0.72 + cam.y * cam.s * 0.25;
    for (let x = -200; x <= W + 200; x += 30) {
      const wx = (x - ox2) / 70;
      pts2.push(x, base2 - (Math.sin(wx * 1.3 + 2) * 40 + Math.sin(wx * 3.1) * 14 + 40) * this.ui);
    }
    pts2.push(W + 200, H, -200, H);
    h.poly(pts2).fill(this.pal.hills[0]);
  }

  /** Called before every sim tick so render can interpolate. */
  capturePrev() {
    this.prev.clear();
    for (const e of this.sim.entities.values()) {
      const t = e.body.translation();
      this.prev.set(e.id, { x: t.x, y: t.y, a: e.body.rotation() });
    }
    this.projectiles.capturePrev(this.sim);
    this.effects.clearHits();
  }

  private readonly xform: XformAt = (e, alpha) => {
    const t = e.body.translation();
    const a = e.body.rotation();
    const p = this.prev.get(e.id);
    if (!p) return { x: t.x, y: t.y, a };
    let da = a - p.a;
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    return { x: p.x + (t.x - p.x) * alpha, y: p.y + (t.y - p.y) * alpha, a: p.a + da * alpha };
  };

  addShake(amount: number) {
    this.camera.addShake(amount);
  }

  koPunch(x: number, y: number) {
    this.camera.koPunch(x, y);
  }

  onEvent(e: SimEvent) {
    this.effects.onEvent(e, this.sim, this.pal, this.camera, this.fighters, this.props, this.projectiles);
  }

  afterTick() {
    return this.effects.afterTick(this.sim, this.camera);
  }

  float(text: string, x: number, y: number, color: number, scale: number) {
    this.effects.float(text, x, y, color, scale);
  }

  setCallouts(list: Callout[], now: number) {
    this.calloutViews.setCallouts(list, now);
  }

  blam(id: number) {
    this.effects.blam(id, this.sim, this.camera, this.fighters);
  }

  render(dt: number, alpha: number, fxDt: number) {
    this.time += dt;
    const sim = this.sim;
    const W = this.W;
    const H = this.H;
    const fx = this.effects.fx;
    this.props.sync(sim);
    this.terrainView?.update();
    fx.update(fxDt);

    const frame = this.camera.render(sim, this.world, W, H, dt, alpha, this.xform);
    this.lastFrame = frame;
    this.chainView?.update(frame, W, H);
    this.drawSky();
    this.drawZone();
    const projectiles = this.projectiles.graphics;
    projectiles.clear();
    this.props.render(this.pal, fx, projectiles, this.time, dt, alpha, this.xform);
    this.projectiles.render(sim, fx, dt, alpha, fxDt, this.xform);
    this.fighters.render(sim, fx, this.camera, frame, W, H, this.time, dt, alpha, fxDt, this.xform);
    this.props.drawDropMarks(sim, this.time, alpha, this.xform);
    this.calloutViews.render(sim, this.fighters, W, this.ui);
    this.effects.render(frame, W, H, dt, this.ui);
  }

  private drawZone() {
    const z = this.sim.zone;
    const zg = this.zoneG;
    zg.clear();
    const zl = z.center - z.half;
    const zr = z.center + z.half;
    const sudden = this.sim.suddenDeath >= 0;
    const pulse = sudden ? 0.9 + 0.6 * Math.sin(this.time * 9) : 0.5 + 0.5 * Math.sin(this.time * 4);
    const showZone = this.fighters.celebrateId < 0; // keep the celebrate screen clean
    if (showZone && zl > -60) {
      zg.rect(-80, -40, zl + 80, 60).fill({ color: ZONE_COLOR, alpha: 0.12 + pulse * 0.05 });
      zg.rect(zl - 0.08, -40, 0.16, 60).fill({ color: ZONE_COLOR, alpha: 0.7 });
    }
    if (showZone && zr < 60) {
      zg.rect(zr, -40, 80 - zr, 60).fill({ color: ZONE_COLOR, alpha: 0.12 + pulse * 0.05 });
      zg.rect(zr - 0.08, -40, 0.16, 60).fill({ color: ZONE_COLOR, alpha: 0.7 });
    }
    // chevrons pointing inward: the zone pushes
    const drift = (this.time * 1.6) % 1.6;
    for (let row = 0; row < (showZone ? 4 : 0); row++) {
      const y = -(1 + row * 2.6);
      for (let i = 0; i < 3; i++) {
        const lx = zl - 1.0 - i * 1.6 + drift;
        if (lx < zl - 0.3) g3(zg, lx, y, 1, (1 - (zl - lx) / 5) * 0.55);
        const rx = zr + 1.0 + i * 1.6 - drift;
        if (rx > zr + 0.3) g3(zg, rx, y, -1, (1 - (rx - zr) / 5) * 0.55);
      }
    }
  }
}

function g3(g: Graphics, x: number, y: number, dir: 1 | -1, alpha: number) {
  if (alpha <= 0) return;
  g.moveTo(x - 0.2 * dir, y - 0.3)
    .lineTo(x + 0.17 * dir, y)
    .lineTo(x - 0.2 * dir, y + 0.3)
    .stroke({ width: 0.12, color: 0xff6a7d, alpha, cap: "round", join: "round" });
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  return (((ar + (br - ar) * t) | 0) << 16) | (((ag + (bg - ag) * t) | 0) << 8) | ((ab + (bb - ab) * t) | 0);
}
