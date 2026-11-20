/**
 * The PixiJS scene: terrain, props, fighters, effects, camera, health bars.
 * World units are meters with y up; the world container maps (x, y) to (x, -y).
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import { FIGHTER } from "../sim/constants";
import type { Controller } from "../sim/controller";
import { Mat } from "../sim/grid";
import type { Entity, Fighter, Sim, SimEvent } from "../sim/sim";
import { Fx } from "./fx";
import { PALETTES, POWER_COLOR, shade, type Palette } from "./palette";
import { drawProp as drawPropShape, drawWeapon } from "./props";
import { drawPiece, pieceSig, TerrainView } from "./terrainview";

const C = {
  skyTop: 0x0f1424,
  skyBottom: 0x2a2140,
  hills: 0x1a1f36,
  hills2: 0x232946,
  ground: 0x2c3448,
  groundDark: 0x222839,
  groundTop: 0x8fb3a3,
  platform: 0x3a4560,
  platformTop: 0xb7c7d9,
  block: 0xc8a06a,
  blockDark: 0x8d6a3f,
  blockLight: 0xe2c08c,
  crate: 0xa86d3a,
  crateDark: 0x6b4221,
  barrel: 0xd9342b,
  barrelDark: 0x8e1d17,
  plank: 0x8b5a33,
  zone: 0xff2a4a,
};

/**
 * Camera modes chosen by the viewer (view-only, never touches the sim):
 * auto = frame the busiest action, all = everyone on screen, follow = one fighter.
 */
export type CamMode = { kind: "auto" } | { kind: "all" } | { kind: "follow"; id: number };

interface Xform {
  x: number;
  y: number;
  a: number;
}

interface PropView {
  g: Graphics;
  e: Entity;
  hp: number;
  sig: string;
  every: boolean;
  flash: number;
  squash: number;
}

interface FighterView {
  f: Fighter;
  root: Container;
  body: Graphics;
  face: Graphics;
  gun: Graphics;
  flash: Graphics;
  aura: Graphics;
  over: Graphics;
  gunKind: string;
  swingT: number;
  swapT: number;
  wingT: number;
  sx: number;
  sy: number;
  spin: number;
  flashT: number;
  recoil: number;
  ghostHp: number;
  trailT: number;
  lastX: number;
  lastY: number;
}

interface FloatText {
  t: Text;
  x: number;
  y: number;
  life: number;
  max: number;
  vy: number;
  scale: number;
}

export class Scene {
  readonly app: Application;
  sim!: Sim;
  controllers: Controller[] = [];
  private sky = new Graphics();
  private hills = new Graphics();
  private world = new Container();
  private terrainView: TerrainView | null = null;
  private terrainLayer = new Container();
  pal: Palette = PALETTES.warehouse;
  /** Level card: frame the whole arena. */
  overview = false;
  private ropes: { from: number; x0: number; y0: number; x1: number; y1: number; target: number; life: number; max: number }[] = [];
  private zaps: { x0: number; y0: number; x1: number; y1: number; life: number }[] = [];
  private swings: { x: number; y: number; dx: number; dy: number; life: number; color: number }[] = [];
  private abyss = new Graphics();
  private zoneG = new Graphics();
  private propLayer = new Container();
  private fighterLayer = new Container();
  private fxBack = new Graphics();
  private fxFront = new Graphics();
  private projG = new Graphics();
  private planG = new Graphics();
  private overlay = new Container();
  private barsG = new Graphics();
  private textLayer = new Container();
  private flashScreen = new Graphics();
  readonly fx = new Fx();
  private props = new Map<number, PropView>();
  private fighters: FighterView[] = [];
  private prev = new Map<number, Xform>();
  private rocketPrev = new Map<number, { x: number; y: number }>();
  private floats: FloatText[] = [];
  cam = { x: 0, y: 4, s: 40 };
  private trauma = 0;
  private punch = 0;
  private punchX = 0;
  private punchY = 0;
  private screenFlash = 0;
  private tickHits = new Map<number, { dmg: number; x: number; y: number; kb: number }>();
  /**
   * Camera override: frame one fighter up close. offsetX shifts the fighter
   * off center (fraction of the view width), leaving room for cards.
   */
  focus: { id: number; offsetX: number; heightM: number } | null = null;
  /** Morale state per fighter for this round (faces). */
  morale: string[] = [];
  /** The viewer's camera choice; intro focus, level overview and celebrate override it. */
  camMode: CamMode = { kind: "all" };
  /** Called when a followed fighter has been out for a beat (the game switches to auto). */
  onFollowLost: (() => void) | null = null;
  private followLostT = -1;
  /** Winner id while celebrating, else -1. */
  celebrateId = -1;
  private dropMarks = new Map<number, number>(); // entity id -> color
  /** Camera interest per fighter (recent hits/shots), decays. */
  private activity: number[] = [0, 0, 0, 0];
  private hotspots: { x: number; y: number; w: number }[] = [];
  time = 0;

  constructor(app: Application) {
    this.app = app;
    const stage = app.stage;
    stage.addChild(this.sky, this.hills, this.world, this.overlay, this.flashScreen);
    this.world.addChild(this.abyss, this.zoneG, this.terrainLayer, this.fxBack, this.propLayer, this.planG, this.fighterLayer, this.projG, this.fxFront);
    this.overlay.addChild(this.barsG, this.textLayer);
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

  // ------------------------------------------------------------------ setup

  load(sim: Sim, controllers: Controller[]) {
    this.sim = sim;
    this.controllers = controllers;
    for (const v of this.props.values()) v.g.destroy();
    this.props.clear();
    for (const v of this.fighters) v.root.destroy({ children: true });
    this.fighters = [];
    for (const f of this.floats) f.t.destroy();
    this.floats = [];
    this.prev.clear();
    this.rocketPrev.clear();
    this.fx.parts = [];
    this.trauma = 0;
    this.punch = 0;
    this.focus = null;
    this.celebrateId = -1;
    this.dropMarks.clear();
    this.ropes = [];
    this.zaps = [];
    this.swings = [];
    this.overview = false;
    this.pal = PALETTES[sim.level.theme];
    if (this.terrainView) this.terrainView.container.destroy({ children: true });
    this.terrainView = new TerrainView(sim.grid, this.pal);
    this.terrainLayer.addChild(this.terrainView.container);
    this.terrainView.update();
    this.drawTerrain();
    for (const f of sim.fighters) this.fighters.push(this.makeFighter(f));
    this.syncProps();
    this.capturePrev();
    const xs = sim.alive().map((f) => sim.pos(f).x);
    this.cam.x = (Math.min(...xs) + Math.max(...xs)) / 2;
    this.cam.y = 4;
    this.cam.s = this.targetScale(Math.max(...xs) - Math.min(...xs) + 10, 16);
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
    const cam = this.cam;
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

  private makeFighter(f: Fighter): FighterView {
    const root = new Container();
    const body = new Graphics();
    const face = new Graphics();
    const gun = new Graphics();
    const flash = new Graphics();
    const aura = new Graphics();
    const over = new Graphics();
    const r = FIGHTER.radius;
    const hh = FIGHTER.halfHeight + FIGHTER.radius;
    body.roundRect(-r, -hh, r * 2, hh * 2, r).fill(f.color).stroke({ width: 0.07, color: shade(f.color, 0.45) });
    body.roundRect(-r * 0.55, -hh * 0.82, r * 0.5, hh * 0.9, r * 0.25).fill({ color: 0xffffff, alpha: 0.22 });
    // feet
    body.roundRect(-r * 0.85, hh - 0.12, r * 0.7, 0.16, 0.08).fill(shade(f.color, 0.4));
    body.roundRect(r * 0.15, hh - 0.12, r * 0.7, 0.16, 0.08).fill(shade(f.color, 0.4));
    // personality marks
    if (f.personality === "aggressive") body.rect(-r, -hh * 0.62, r * 2, 0.12).fill(0x2a0d0d);
    if (f.personality === "sniper") body.roundRect(-r * 0.2, -hh - 0.12, 0.08, 0.2, 0.04).fill(shade(f.color, 0.45));
    if (f.personality === "opportunist") body.poly([-0.22, -hh + 0.04, -0.15, -hh - 0.18, -0.05, -hh + 0.0, 0.05, -hh - 0.2, 0.13, -hh + 0.0, 0.22, -hh - 0.16, 0.26, -hh + 0.06]).fill(0xfff1a6);
    flash.roundRect(-r, -hh, r * 2, hh * 2, r).fill(0xffffff);
    flash.alpha = 0;
    root.addChild(aura, body, gun, face, flash, over);
    this.fighterLayer.addChild(root);
    return { f, root, body, face, gun, flash, aura, over, gunKind: "", swingT: 0, swapT: 0, wingT: 0, sx: 1, sy: 1, spin: 0, flashT: 0, recoil: 0, ghostHp: f.hp, trailT: 0, lastX: 0, lastY: 0 };
  }

  private drawGun(v: FighterView, kind: string) {
    if (v.gunKind === kind) return;
    v.gunKind = kind;
    v.gun.clear();
    drawWeapon(v.gun, kind, v.f.color);
  }

  // ----------------------------------------------------------- per tick

  /** Called before every sim tick so render can interpolate. */
  capturePrev() {
    this.prev.clear();
    for (const e of this.sim.entities.values()) {
      const t = e.body.translation();
      this.prev.set(e.id, { x: t.x, y: t.y, a: e.body.rotation() });
    }
    this.rocketPrev.clear();
    for (const r of this.sim.rockets) this.rocketPrev.set(r.id, { x: r.x, y: r.y });
    this.tickHits.clear();
  }

  private xform(e: Entity, alpha: number): Xform {
    const t = e.body.translation();
    const a = e.body.rotation();
    const p = this.prev.get(e.id);
    if (!p) return { x: t.x, y: t.y, a };
    let da = a - p.a;
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    return { x: p.x + (t.x - p.x) * alpha, y: p.y + (t.y - p.y) * alpha, a: p.a + da * alpha };
  }

  private fighterView(id: number) {
    return this.fighters[id]!;
  }

  addShake(amount: number) {
    this.trauma = Math.min(1.2, this.trauma + amount);
  }

  koPunch(x: number, y: number) {
    this.punch = 1;
    this.punchX = x;
    this.punchY = y;
  }

  onEvent(e: SimEvent) {
    const sim = this.sim;
    switch (e.type) {
      case "explosion": {
        const big = e.kind === "barrel" || e.kind === "tnt";
        this.hotspots.push({ x: e.x, y: e.y, w: big ? 2.5 : 1.2 });
        this.fx.explosion(e.x, e.y, e.radius, big);
        this.addShake(e.kind === "tnt" ? 1.0 : big ? 0.75 : e.kind === "grenade" ? 0.5 : 0.38);
        if (big) this.screenFlash = Math.max(this.screenFlash, 0.22);
        break;
      }
      case "break": {
        const color = e.kind === "block" ? C.block : e.kind === "crate" ? C.crate : 0x8a7a66;
        this.fx.debris(e.x, e.y, e.hw, e.hh, color, e.kind === "chunk" ? 4 : 8);
        break;
      }
      case "carve": {
        const n = e.cells.length;
        for (let i = 0; i < n; i++) {
          const c = e.cells[i]!;
          const col = this.pal.mat[c.mat] ?? 0x888888;
          if (i % (n > 30 ? 3 : 1) === 0) this.fx.debris(c.x, c.y, 0.2, 0.2, col, n > 30 ? 1 : 2);
        }
        break;
      }
      case "detach": {
        this.addShake(Math.min(0.5, 0.12 + e.cells * 0.02));
        this.fx.dust(e.x, e.y, 8);
        this.hotspots.push({ x: e.x, y: e.y, w: 1 });
        break;
      }
      case "swing": {
        const v = this.fighterView(e.fighter);
        v.swingT = 0.2;
        this.swings.push({ x: e.x, y: e.y, dx: e.dx, dy: e.dy, life: 0.14, color: e.hit ? 0xffffff : 0xd8d8d8 });
        if (e.hit) this.addShake(0.15);
        break;
      }
      case "grapple": {
        this.ropes.push({ from: e.fighter, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, target: e.hit === "fighter" ? e.target : -1, life: e.hit === "fighter" ? 0.4 : 0.22, max: e.hit === "fighter" ? 0.4 : 0.22 });
        if (e.hit !== "none") this.fx.sparks(e.x1, e.y1, 0, 0, 0xd8dce6, 6);
        break;
      }
      case "swap": {
        const v = this.fighterView(e.fighter);
        v.swapT = 0.22;
        break;
      }
      case "shatter": {
        for (let i = 0; i < 22; i++)
          this.fx.add({ x: e.x + (Math.random() - 0.5) * 0.2, y: e.y + (Math.random() - 0.5) * 1.6, vx: (Math.random() - 0.5) * 10, vy: Math.random() * 6, life: 0.8 + Math.random() * 0.5, size: 0.06 + Math.random() * 0.08, color: Math.random() < 0.5 ? 0xd8f6ff : 0x9fe8ff, kind: "square", gravity: 20, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 20 });
        this.fx.add({ x: e.x, y: e.y, kind: "flash", life: 0.08, size: 0.5, size1: 1.0, color: 0xe8fbff, alpha: 0.7 });
        break;
      }
      case "bounce": {
        const pad = [...this.props.values()].find((v) => v.e.kind === "pad" && Math.abs(v.e.body.translation().x - e.x) < 0.1);
        if (pad) pad.squash = 1;
        this.fx.dust(e.x, e.y, 4);
        this.fx.add({ x: e.x, y: e.y, kind: "ring", life: 0.3, size: 0.3, size1: 1.4, color: 0x44d06a, alpha: 0.9, aux: 0.12 });
        const v = this.fighterView(e.fighter);
        v.sx = 0.75;
        v.sy = 1.3;
        break;
      }
      case "lit": {
        const ent = this.sim.entities.get(e.entity);
        if (ent) {
          const t = ent.body.translation();
          this.fx.sparks(t.x, t.y + ent.hh, 0, 1, 0xffd23a, 8);
        }
        break;
      }
      case "snap":
        this.addShake(0.12);
        break;
      case "zap": {
        const z = this.sim.zone;
        const ex = e.dir > 0 ? z.center - z.half : z.center + z.half;
        this.zaps.push({ x0: ex, y0: e.y + 6, x1: e.x, y1: e.y, life: 0.25 });
        this.fighterView(e.fighter).flashT = 0.15;
        this.fx.sparks(e.x, e.y, 0, 0, 0xff6a7d, 12);
        this.addShake(0.2);
        break;
      }
      case "shieldPop": {
        this.fx.add({ x: e.x, y: e.y, kind: "ring", life: 0.4, size: 1.1, size1: 2.4, color: POWER_COLOR.shield!, alpha: 1, aux: 0.18 });
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2;
          this.fx.add({ x: e.x + Math.cos(a) * 1.1, y: e.y + Math.sin(a) * 1.1, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, life: 0.5, size: 0.1, color: POWER_COLOR.shield!, kind: "square", gravity: 8, vr: 10 });
        }
        this.float("SHIELD POP", e.x, e.y + 2, POWER_COLOR.shield!, 0.9);
        break;
      }
      case "power": {
        if (!e.on) break;
        const f = sim.fighters[e.fighter]!;
        const p = sim.pos(f);
        const col = POWER_COLOR[e.power] ?? 0xffffff;
        this.fx.add({ x: p.x, y: p.y, kind: "ring", life: 0.45, size: 0.4, size1: 2.2, color: col, alpha: 1, aux: 0.16 });
        break;
      }
      case "fire": {
        const v = this.fighterView(e.fighter);
        v.recoil = e.weapon === "shotgun" ? 0.35 : 0.25;
        const mx = e.x + e.dx * 1.0;
        const my = e.y + e.dy * 1.0;
        if (e.weapon !== "grenade") {
          this.fx.add({ x: mx, y: my, kind: "flash", life: 0.07, size: 0.35, size1: 0.55, color: 0xffe9a0 });
          this.fx.sparks(mx, my, e.dx, e.dy, 0xffd27a, e.weapon === "shotgun" ? 8 : 4);
          this.fx.add({ x: mx, y: my, vx: e.dx * 2, vy: e.dy * 2 + 0.5, kind: "smoke", life: 0.6, size: 0.2, size1: 0.6, color: 0x8a8790, alpha: 0.5, drag: 3, back: true });
        }
        if (e.weapon === "shotgun") this.addShake(0.08);
        break;
      }
      case "pellet": {
        this.tracer(e.x0, e.y0, e.x1, e.y1);
        if (e.hit) this.fx.sparks(e.x1, e.y1, -(e.x1 - e.x0) * 0.1, -(e.y1 - e.y0) * 0.1, 0xffe0a0, 3);
        break;
      }
      case "hit": {
        const v = this.fighterView(e.target);
        v.flashT = 0.12;
        this.activity[e.target] = Math.min(3, (this.activity[e.target] ?? 0) + e.damage * 0.15);
        if (e.source >= 0) this.activity[e.source] = Math.min(3, (this.activity[e.source] ?? 0) + e.damage * 0.08);
        const h = this.tickHits.get(e.target) ?? { dmg: 0, x: e.x, y: e.y, kb: 0 };
        h.dmg += e.damage;
        h.kb = Math.max(h.kb, e.kb);
        this.tickHits.set(e.target, h);
        if (e.cause === "shotgun") this.fx.sparks(e.x, e.y, 0, 0, sim.fighters[e.target]!.color, 2);
        break;
      }
      case "impact": {
        const f = sim.fighters[e.fighter]!;
        this.fx.dust(e.x, e.y - 0.8, 10);
        this.fx.sparks(e.x, e.y, 0, 0, 0xffffff, 8);
        this.addShake(0.25);
        this.fighterView(f.id).flashT = 0.1;
        if (e.damage >= 4) this.float(`${Math.round(e.damage)}`, e.x, e.y + 1, 0xffffff, 0.9);
        break;
      }
      case "ko": {
        const f = sim.fighters[e.fighter]!;
        if (e.cause === "ringout") {
          const dx = -Math.sign(e.x) * 0.3;
          this.fx.beam(clampN(e.x, -36, 36), Math.max(e.y, -8), e.y < -9 ? dx : -Math.sign(e.x), e.y < -9 ? 1 : 0.25, f.color);
          this.float("RING OUT!", clampN(e.x, -30, 30), Math.max(e.y, -4) + 4, f.color, 1.8);
        } else {
          this.fx.burst(e.x, e.y, f.color);
          this.float("K.O.", e.x, e.y + 2, f.color, 1.8);
        }
        this.addShake(0.9);
        this.screenFlash = Math.max(this.screenFlash, 0.3);
        break;
      }
      case "jump": {
        const f = sim.fighters[e.fighter]!;
        const v = this.fighterView(f.id);
        if (e.air) {
          v.wingT = 0.35;
          this.fx.add({ x: sim.pos(f).x, y: sim.feetY(f), kind: "ring", life: 0.3, size: 0.2, size1: 1.2, color: 0xffffff, alpha: 0.8, aux: 0.1 });
        }
        v.sx = 0.8;
        v.sy = 1.22;
        const p = sim.pos(f);
        this.fx.dust(p.x, sim.feetY(f), 1);
        break;
      }
      case "land": {
        const f = sim.fighters[e.fighter]!;
        const v = this.fighterView(f.id);
        const k = Math.min(1, e.speed / 16);
        v.sx = 1 + 0.35 * k;
        v.sy = 1 - 0.3 * k;
        const p = sim.pos(f);
        this.fx.dust(p.x, sim.feetY(f), e.speed * 0.4);
        break;
      }
      case "propDrop":
        this.dropMarks.set(e.entity, e.kind === "tnt" ? 0xff3030 : 0xff6a3d);
        break;
      case "itemSpawn":
        if (e.y > 8) this.dropMarks.set(e.entity, POWER_COLOR[e.item] ?? 0xffb347);
        break;
      case "pickup": {
        const col = POWER_COLOR[e.item] ?? 0xffb347;
        this.fx.burst(e.x, e.y, col);
        const label: Record<string, string> = { health: "+HP", shield: "SHIELD!", speed: "SPEED!", heavy: "HEAVY!", damage: "2x DAMAGE!", jump: "DOUBLE JUMP!" };
        this.float(label[e.item] ?? e.item.toUpperCase() + "!", e.x, e.y + 1.4, col, 1.0);
        break;
      }
    }
  }

  private tracers: { x0: number; y0: number; x1: number; y1: number; life: number }[] = [];
  private tracer(x0: number, y0: number, x1: number, y1: number) {
    this.tracers.push({ x0, y0, x1, y1, life: 0.1 });
  }

  /** End of a sim tick: emit grouped damage numbers. */
  afterTick(): { bigHit: number } {
    let bigHit = 0;
    for (const [id, h] of this.tickHits) {
      const f = this.sim.fighters[id]!;
      if (h.dmg >= 5 || h.kb >= 14) this.float(`${Math.round(h.dmg)}`, h.x, h.y + 1.2, h.kb >= 14 ? 0xffe14d : 0xffffff, h.kb >= 14 ? 1.25 : 0.85);
      if (h.kb >= 14) {
        bigHit = Math.max(bigHit, h.kb);
        this.addShake(Math.min(0.5, h.kb / 50));
        this.fx.sparks(h.x, h.y, 0, 0, f.color, 10);
        this.fx.add({ x: h.x, y: h.y, kind: "ring", life: 0.25, size: 0.3, size1: 1.8, color: 0xffffff, alpha: 0.9, aux: 0.12 });
      }
    }
    this.tickHits.clear();
    return { bigHit };
  }

  float(text: string, x: number, y: number, color: number, scale: number) {
    const t = new Text({
      text,
      style: {
        fontFamily: "Rubik, 'Arial Black', system-ui, sans-serif",
        fontWeight: "900",
        fontSize: 34,
        fill: color,
        stroke: { color: 0x0a0b12, width: 7, join: "round" },
      },
    });
    t.anchor.set(0.5);
    this.textLayer.addChild(t);
    this.floats.push({ t, x, y, life: scale > 1.5 ? 1.6 : 0.9, max: scale > 1.5 ? 1.6 : 0.9, vy: scale > 1.5 ? 0.8 : 2.2, scale });
  }

  // --------------------------------------------------------------- render

  minScale() {
    return this.H / 19;
  }

  private targetScale(spanX: number, spanY: number) {
    const s = Math.min(this.W / spanX, this.H / spanY);
    const maxS = this.H / 11;
    const minS = this.minScale();
    return Math.max(minS, Math.min(maxS, s));
  }

  private syncProps() {
    const sim = this.sim;
    for (const [id, v] of this.props) {
      if (v.e.dead) {
        v.g.destroy();
        this.props.delete(id);
      }
    }
    for (const e of sim.entities.values()) {
      if (e.kind === "fighter" || this.props.has(e.id)) continue;
      const g = new Graphics();
      this.propLayer.addChild(g);
      const v: PropView = { g, e, hp: -1, sig: "", every: true, flash: 0, squash: 0 };
      this.props.set(e.id, v);
    }
  }

  private drawProp(v: PropView) {
    const e = v.e;
    if (e.kind === "chunk") {
      const sig = pieceSig(e.cells!);
      if (sig !== v.sig) {
        v.sig = sig;
        drawPiece(v.g, this.pal, e.cells!);
      }
      return;
    }
    if (!v.every && v.hp === e.hp) return;
    if (v.hp >= 0 && v.hp !== e.hp) v.flash = 0.1;
    v.hp = e.hp;
    v.every = drawPropShape(v.g, e, this.time);
  }

  render(dt: number, alpha: number, fxDt: number) {
    this.time += dt;
    const sim = this.sim;
    const W = this.W;
    const H = this.H;
    this.syncProps();
    this.terrainView?.update();
    this.fx.update(fxDt);

    // ------------------------------------------------ camera
    // Frame the fighters. If they are spread wider than the max zoom-out,
    // frame the busiest window (recent hits, shots, rockets in flight).
    const all = this.camMode.kind === "all" && !this.focus && !this.overview;
    // "view all" must also show a fighter down in a crater (bedrock top is at -7)
    const floorY = all ? -6.6 : -3;
    const pts: { x: number; y: number; w: number; frame: boolean }[] = [];
    for (const f of sim.fighters) {
      if (!(f.alive || (!f.removed && sim.tick - f.koTick < 40))) continue;
      const p = this.xform(f.entity, alpha);
      pts.push({ x: p.x, y: Math.max(floorY, p.y), w: 1 + (this.activity[f.id] ?? 0), frame: true });
    }
    // rockets and explosions only pull the choice of window, not its size
    // (in "view all" they are framed too, kept inside the arena)
    const lx0 = sim.level.minX - 2;
    const lx1 = sim.level.maxX + 2;
    for (const r of sim.rockets) pts.push({ x: clampN(r.x, lx0, lx1), y: clampN(r.y, -3, 14), w: 0.4, frame: all });
    for (const h of this.hotspots) pts.push({ x: clampN(h.x, lx0, lx1), y: clampN(h.y, -3, 14), w: h.w, frame: all && h.w > 0.6 });
    if (!pts.some((p) => p.frame)) pts.push({ x: this.cam.x, y: 2, w: 1, frame: true });
    const padX = all ? 3.5 : 6;
    const padY = all ? 2.5 : 3.5;
    const maxSpan = all ? Infinity : this.W / this.minScale() - padX * 2;
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
    let ts = all
      ? clampN(Math.min(this.W / (x1 - x0 + padX * 2), this.H / (y1 - y0 + padY * 2 + 1.5)), this.H / 46, this.H / 11)
      : this.targetScale(x1 - x0 + padX * 2, y1 - y0 + padY * 2 + 1.5);
    // anchor near the bottom: the lowest fighter sits ~3 m above the bottom edge
    const viewH = this.H / ts;
    let ty = Math.max(y0 - 3.2 + viewH / 2, (y0 + y1) / 2 + 0.8);
    let rate = all ? 3.5 : 2.6;
    if (this.camMode.kind === "follow" && !this.focus && !this.overview) {
      const fo = sim.fighters[this.camMode.id];
      if (fo && fo.alive && !fo.removed) {
        this.followLostT = -1;
        const p = this.xform(fo.entity, alpha);
        ts = this.H / 15;
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
      const p = this.xform(ff.entity, alpha);
      ts = this.H / this.focus.heightM;
      tx = p.x - (this.W / ts) * this.focus.offsetX;
      ty = p.y + 0.6;
      rate = 5;
    } else if (this.overview) {
      // the whole generated arena
      const lw = sim.level.width + 4;
      ts = Math.min(this.W / lw, this.H / 22);
      tx = 0;
      ty = -8 + (this.H / ts) / 2 + 2.5;
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
    this.world.scale.set(s);
    this.world.position.set(W / 2 - (cx + shx) * s, H / 2 + (cy + shy) * s);
    this.world.rotation = (Math.random() * 2 - 1) * sh * 0.012;
    this.drawSky();

    // ------------------------------------------------ zone
    const z = this.sim.zone;
    const zg = this.zoneG;
    zg.clear();
    const zl = z.center - z.half;
    const zr = z.center + z.half;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
    const showZone = this.celebrateId < 0; // keep the celebrate screen clean
    if (showZone && zl > -60) {
      zg.rect(-80, -40, zl + 80, 60).fill({ color: C.zone, alpha: 0.12 + pulse * 0.05 });
      zg.rect(zl - 0.08, -40, 0.16, 60).fill({ color: C.zone, alpha: 0.7 });
    }
    if (showZone && zr < 60) {
      zg.rect(zr, -40, 80 - zr, 60).fill({ color: C.zone, alpha: 0.12 + pulse * 0.05 });
      zg.rect(zr - 0.08, -40, 0.16, 60).fill({ color: C.zone, alpha: 0.7 });
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

    this.projG.clear();
    // ------------------------------------------------ props
    for (const v of this.props.values()) {
      const e = v.e;
      const p = this.xform(e, alpha);
      this.drawProp(v);
      v.g.position.set(p.x, -p.y);
      v.g.rotation = -p.a;
      if (e.kind === "barrel" && e.fuse !== undefined) v.g.scale.set(1 + 0.12 * Math.sin(this.time * 60));
      if (e.kind === "item") v.g.position.y += Math.sin(this.time * 4) * 0.04;
      if (e.kind === "pad") {
        v.squash = Math.max(0, v.squash - dt * 5);
        v.g.scale.set(1 + v.squash * 0.2, 1 - v.squash * 0.45);
      }
      if (e.kind === "gas" && e.thrust !== undefined && Math.random() < 0.9) {
        // exhaust from the bottom of the canister
        const ux = Math.sin(-p.a);
        const uy = -Math.cos(-p.a);
        const bx = p.x + ux * e.hh;
        const by = p.y + uy * e.hh;
        this.fx.add({ x: bx, y: by, vx: ux * 6 + (Math.random() - 0.5), vy: uy * 6 + (Math.random() - 0.5), life: 0.25, size: 0.2, size1: 0.02, color: Math.random() < 0.5 ? 0xffd36a : 0xff7a2f });
        this.fx.add({ x: bx, y: by, vx: ux * 2, vy: uy * 2, kind: "smoke", life: 0.8, size: 0.15, size1: 0.6, color: 0x9a97a2, alpha: 0.5, drag: 2, back: true });
      }
      if (e.kind === "tnt" && e.fuse !== undefined && Math.random() < 0.6) {
        this.fx.add({ x: p.x + 0.05, y: p.y + e.hh + 0.1 + (0.5 * e.fuse) / 150, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 3, life: 0.2, size: 0.05, color: 0xffd23a, kind: "spark", gravity: 6 });
      }
      if (e.kind === "weight" && e.joint && e.ax !== undefined) {
        // the rope, from the anchor to the top of the weight
        const tx2 = p.x - Math.sin(p.a) * e.hh * -1;
        const ty2 = p.y + Math.cos(p.a) * e.hh;
        this.projG.moveTo(e.ax, -e.ay!).lineTo(tx2, -ty2).stroke({ width: 0.06, color: 0xb8a888 });
      }
      if (v.flash > 0) {
        v.flash -= dt;
        v.g.tint = 0xffaaaa;
      } else v.g.tint = 0xffffff;
    }

    // ------------------------------------------------ rockets
    const pg = this.projG;
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
        this.fx.add({ x: x - ux * L, y: y - uy * L, vx: -ux * 2 + (Math.random() - 0.5), vy: -uy * 2 + (Math.random() - 0.5), kind: "smoke", life: 0.7, size: 0.15, size1: 0.55, color: 0x9a97a2, alpha: 0.55, drag: 2, back: true });
        this.fx.add({ x: x - ux * L, y: y - uy * L, vx: -ux * 5, vy: -uy * 5, life: 0.12, size: 0.16, size1: 0.02, color: 0xffd36a });
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
      const sp = shooter.removed ? { x: r.x0, y: r.y0 } : this.xform(shooter.entity, alpha);
      let ex = r.x1;
      let ey = r.y1;
      if (r.target >= 0) {
        const t = sim.fighters[r.target]!;
        if (!t.removed) {
          const tp = this.xform(t.entity, alpha);
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

    // ------------------------------------------------ fighters
    const bars = this.barsG;
    bars.clear();
    const ui = this.ui;
    for (const v of this.fighters) {
      const f = v.f;
      if (f.removed) {
        v.root.visible = false;
        continue;
      }
      v.root.visible = true;
      const p = this.xform(f.entity, alpha);
      const vel = f.entity.body.linvel();
      const speed = Math.hypot(vel.x, vel.y);
      // squash & stretch relax
      v.sx += (1 - v.sx) * Math.min(1, dt * 12);
      v.sy += (1 - v.sy) * Math.min(1, dt * 12);
      v.recoil = Math.max(0, v.recoil - dt * 2.5);
      v.wingT = Math.max(0, v.wingT - dt);
      if (f.stun > 0 && !f.grounded && f.alive) v.spin += f.facing * -dt * Math.min(18, speed * 0.9);
      else if (f.alive) v.spin *= Math.max(0, 1 - dt * 14);
      if (Math.abs(v.spin) < 0.01 && f.alive) v.spin = 0;
      const rot = f.alive ? v.spin : -p.a;
      const hop = this.celebrateId === f.id ? Math.abs(Math.sin(this.time * 5.5)) * 0.9 : 0;
      v.root.position.set(p.x, -p.y - hop);
      v.root.rotation = rot;
      if (this.celebrateId === f.id) {
        if (hop < 0.08) {
          v.sx = 1.25;
          v.sy = 0.8;
        }
        if (Math.random() < 0.6) {
          const cols = [f.color, 0xffffff, 0xffe14d, 0xff7ab8, 0x7de0ff];
          this.fx.add({
            x: p.x + (Math.random() - 0.5) * 14,
            y: p.y + 7 + Math.random() * 2,
            vx: (Math.random() - 0.5) * 2,
            vy: -1 - Math.random() * 2,
            life: 2.5,
            size: 0.12 + Math.random() * 0.08,
            color: cols[(Math.random() * cols.length) | 0]!,
            kind: "square",
            gravity: 2,
            drag: 0.8,
            rot: Math.random() * 6,
            vr: (Math.random() - 0.5) * 12,
          });
        }
      }
      v.root.scale.set(v.sx * (f.facing < 0 ? -1 : 1), v.sy);
      if (this.celebrateId === f.id) v.root.scale.x = Math.abs(v.root.scale.x) * (Math.sin(this.time * 1.3) > 0 ? 1 : -1);
      v.root.alpha = f.alive ? 1 : Math.max(0, 1 - (sim.tick - f.koTick) / 120);
      // face
      const face = v.face;
      face.clear();
      const aimLocalX = f.aimX * f.facing;
      const aimLocalY = -f.aimY;
      const mood = this.morale[f.id] ?? "confident";
      const eyeR = mood === "desperate" ? 0.2 : 0.17;
      face.circle(0.14, -0.48, eyeR).fill(0xffffff);
      if (f.alive) {
        const pr = mood === "rattled" ? 0.055 : mood === "desperate" ? 0.1 : 0.085;
        const jitter = mood === "rattled" || mood === "desperate" ? (Math.random() - 0.5) * 0.03 : 0;
        face.circle(0.14 + aimLocalX * 0.07 + jitter, -0.48 + aimLocalY * 0.07, pr).fill(0x101018);
        // morale on the face (placeholder art)
        if (mood === "cocky") {
          face.rect(-0.05, -0.68, 0.4, 0.17).fill(f.color);
          face.moveTo(-0.04, -0.51).lineTo(0.34, -0.54).stroke({ width: 0.05, color: 0x101018, cap: "round" });
          face.moveTo(0.02, -0.22).quadraticCurveTo(0.16, -0.2, 0.28, -0.3).stroke({ width: 0.045, color: 0x101018, cap: "round" });
        } else if (mood === "furious") {
          face.moveTo(-0.06, -0.72).lineTo(0.34, -0.6).stroke({ width: 0.07, color: 0x101018, cap: "round" });
          face.moveTo(0.04, -0.2).quadraticCurveTo(0.16, -0.3, 0.28, -0.2).stroke({ width: 0.045, color: 0x101018, cap: "round" });
          if (Math.random() < 0.08) this.fx.add({ x: p.x + (Math.random() - 0.5) * 0.4, y: p.y + 0.95, vy: 1.5, kind: "smoke", life: 0.6, size: 0.08, size1: 0.25, color: 0xffffff, alpha: 0.6, back: false });
        } else if (mood === "rattled" || mood === "desperate") {
          face.poly([-0.36, -0.8, -0.3, -0.66, -0.42, -0.66]).fill({ color: 0x9fe0ff, alpha: 0.9 });
          face.circle(-0.36, -0.66, 0.06).fill({ color: 0x9fe0ff, alpha: 0.9 });
          if (mood === "desperate") face.ellipse(0.17, -0.24, 0.06, 0.08).fill(0x101018);
          else face.moveTo(0.02, -0.24).lineTo(0.08, -0.28).lineTo(0.14, -0.24).lineTo(0.2, -0.28).lineTo(0.26, -0.24).stroke({ width: 0.035, color: 0x101018 });
        } else {
          face.moveTo(0.04, -0.27).quadraticCurveTo(0.16, -0.2, 0.28, -0.27).stroke({ width: 0.04, color: 0x101018, cap: "round" });
        }
        if (f.stun > 0) {
          face.clear();
          face.moveTo(0.05, -0.57).lineTo(0.23, -0.39).moveTo(0.23, -0.57).lineTo(0.05, -0.39).stroke({ width: 0.06, color: 0x101018 });
        }
      } else {
        face.moveTo(0.05, -0.57).lineTo(0.23, -0.39).moveTo(0.23, -0.57).lineTo(0.05, -0.39).stroke({ width: 0.06, color: 0x101018 });
      }
      // gun
      this.drawGun(v, sim.weapon(f));
      v.gun.visible = f.alive;
      v.gun.position.set(-v.recoil * 0.5 * 1, -0.05);
      v.gun.rotation = Math.atan2(aimLocalY, aimLocalX);
      if (v.swingT > 0) {
        // bat swing: sweep from high to low
        v.swingT -= dt;
        v.gun.rotation += -1.3 + 2.6 * (v.swingT / 0.2);
      }
      v.swapT = Math.max(0, v.swapT - dt);
      v.gun.scale.set(1 + v.swapT * 2.2);
      v.gun.tint = v.swapT > 0.1 ? 0xffffff : 0xffffff;
      v.gun.alpha = v.swapT > 0.14 ? 0.5 : 1;
      // power-up visuals, readable on the fighter
      const pw = f.power;
      const au = v.aura;
      const ov = v.over;
      au.clear();
      ov.clear();
      if (f.alive) {
        if (pw.damage > 0) {
          const pr = 0.85 + 0.12 * Math.sin(this.time * 10);
          au.circle(0, 0, pr).fill({ color: POWER_COLOR.damage!, alpha: 0.28 });
          au.circle(0, 0, pr * 0.8).fill({ color: POWER_COLOR.damage!, alpha: 0.2 });
        }
        if (pw.speed > 0) {
          for (let i = 0; i < 3; i++) au.moveTo(-0.55, -0.4 + i * 0.4).lineTo(-1.1 - Math.random() * 0.3, -0.4 + i * 0.4).stroke({ width: 0.06, color: POWER_COLOR.speed!, alpha: 0.8 });
        }
        if (pw.jump > 0) {
          const flap = v.wingT > 0 ? Math.sin(this.time * 40) * 0.2 : 0;
          au.poly([-0.3, -0.35, -0.95, -0.75 - flap, -0.75, -0.25, -0.95, -0.05 + flap]).fill({ color: 0xffffff, alpha: 0.85 });
        }
        if (pw.heavy > 0) {
          ov.roundRect(-0.46, -0.1, 0.92, 0.32, 0.08).fill(0x4a4e58).stroke({ width: 0.05, color: 0x22252c });
          ov.circle(-0.28, 0.06, 0.05).fill(0xa8b0bc);
          ov.circle(0.28, 0.06, 0.05).fill(0xa8b0bc);
        }
        if (pw.shield > 0) {
          const ending = pw.shield < 90 && Math.floor(this.time * 10) % 2 === 0;
          const wob = 1.12 + 0.04 * Math.sin(this.time * 7);
          ov.circle(0, 0, wob).fill({ color: POWER_COLOR.shield!, alpha: ending ? 0.06 : 0.16 }).stroke({ width: 0.06, color: POWER_COLOR.shield!, alpha: ending ? 0.3 : 0.85 });
          ov.circle(-0.45, -0.5, 0.12).fill({ color: 0xffffff, alpha: 0.5 });
        }
      }
      v.root.scale.x *= pw.heavy > 0 ? 1.12 : 1;
      v.root.scale.y *= pw.heavy > 0 ? 1.1 : 1;
      // hit flash
      v.flashT = Math.max(0, v.flashT - dt);
      v.flash.alpha = v.flashT > 0 ? 0.85 : f.outsideZone && Math.floor(this.time * 8) % 2 === 0 ? 0.25 : 0;
      v.flash.tint = f.outsideZone && v.flashT <= 0 ? 0xff3355 : 0xffffff;
      // motion trail when launched
      v.trailT -= fxDt;
      if (speed > 11 && v.trailT <= 0 && f.alive) {
        v.trailT = 0.025;
        this.fx.add({ x: p.x, y: p.y, kind: "trail", life: 0.22, size: FIGHTER.halfHeight + FIGHTER.radius, aux: FIGHTER.radius, color: f.color, back: true });
      }
      if (f.outsideZone && Math.random() < 0.3) this.fx.add({ x: p.x + (Math.random() - 0.5) * 0.8, y: p.y + (Math.random() - 0.5) * 1.4, vy: 2, life: 0.4, size: 0.08, color: 0xff4060 });

      // off-screen marker
      if (f.alive) {
        const sx0 = W / 2 + (p.x - cx - shx) * s;
        const sy0 = H / 2 - (p.y - cy - shy) * s;
        const m = 26 * ui;
        if (sx0 < -10 || sx0 > W + 10 || sy0 < -10 || sy0 > H + 10) {
          const ex = Math.max(m, Math.min(W - m, sx0));
          const ey = Math.max(m + 60 * ui, Math.min(H - m, sy0));
          const ang = Math.atan2(sy0 - ey, sx0 - ex);
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const r = 20 * ui;
          bars.circle(ex, ey, r).fill({ color: 0x07080d, alpha: 0.75 }).stroke({ width: 3 * ui, color: f.color });
          bars.poly([ex + ca * r * 1.6, ey + sa * r * 1.6, ex + ca * r * 0.9 - sa * r * 0.6, ey + sa * r * 0.9 + ca * r * 0.6, ex + ca * r * 0.9 + sa * r * 0.6, ey + sa * r * 0.9 - ca * r * 0.6]).fill(f.color);
          bars.rect(ex - r * 0.7, ey + r * 0.15, (r * 1.4 * f.hp) / 100, r * 0.3).fill(f.color);
          bars.circle(ex, ey - r * 0.25, r * 0.32).fill(f.color);
        }
      }
      // health bar (screen space)
      if (f.alive) {
        v.ghostHp += (f.hp - v.ghostHp) * Math.min(1, dt * 3);
        if (v.ghostHp < f.hp) v.ghostHp = f.hp;
        const sx = W / 2 + (p.x - cx - shx) * s;
        const sy = H / 2 - (p.y - cy - shy) * s;
        const top = sy - (FIGHTER.halfHeight + FIGHTER.radius + 0.45) * s;
        const bw = 92 * ui;
        const bh = 12 * ui;
        const bx = sx - bw / 2;
        const by = top - bh;
        const low = f.hp < 30;
        bars.roundRect(bx - 3 * ui, by - 3 * ui, bw + 6 * ui, bh + 6 * ui, 5 * ui).fill({ color: 0x07080d, alpha: 0.8 });
        if (this.camMode.kind === "follow" && this.camMode.id === f.id && !this.focus && this.celebrateId < 0) {
          // followed: a bobbing marker above the bar
          const mx = sx;
          const my = by - 12 * ui - Math.abs(Math.sin(this.time * 4)) * 5 * ui;
          bars.poly([mx - 14 * ui, my - 16 * ui, mx + 14 * ui, my - 16 * ui, mx, my]).fill(f.color).stroke({ width: 3 * ui, color: 0x07080d });
          bars.roundRect(bx - 6 * ui, by - 6 * ui, bw + 12 * ui, bh + 12 * ui, 7 * ui).stroke({ width: 2.5 * ui, color: f.color });
        }
        bars.rect(bx, by, (bw * Math.max(0, v.ghostHp)) / 100, bh).fill({ color: 0xffffff, alpha: 0.85 });
        bars.rect(bx, by, (bw * Math.max(0, f.hp)) / 100, bh).fill(low && Math.floor(this.time * 6) % 2 === 0 ? 0xffffff : f.color);
        bars.rect(bx, by, (bw * Math.max(0, f.hp)) / 100, bh * 0.35).fill({ color: 0xffffff, alpha: 0.25 });
        for (let i = 1; i < 4; i++) bars.rect(bx + (bw * i) / 4 - 0.5 * ui, by, 1 * ui, bh).fill({ color: 0x07080d, alpha: 0.5 });
        let pi = 0;
        for (const k of ["shield", "speed", "heavy", "damage", "jump"] as const) {
          if (f.power[k] <= 0) continue;
          bars.circle(bx + 6 * ui + pi * 13 * ui, by + bh + 10 * ui, 5 * ui).fill(POWER_COLOR[k]!).stroke({ width: 1.5 * ui, color: 0x07080d });
          pi++;
        }
      }
    }

    // ------------------------------------------------ supply drop markers
    this.drawDropMarks(alpha);

    // ------------------------------------------------ effects
    this.fx.draw(this.fxBack, this.fxFront);

    // ------------------------------------------------ floating text
    const keep: FloatText[] = [];
    for (const ft of this.floats) {
      ft.life -= dt;
      if (ft.life <= 0) {
        ft.t.destroy();
        continue;
      }
      ft.y += ft.vy * dt;
      const t = 1 - ft.life / ft.max;
      const pop = t < 0.12 ? 0.6 + (t / 0.12) * 0.6 : 1.2 - Math.min(0.2, (t - 0.12) * 2);
      ft.t.scale.set(pop * ft.scale * ui);
      ft.t.alpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      ft.t.position.set(W / 2 + (ft.x - cx) * s, H / 2 - (ft.y - cy) * s);
      keep.push(ft);
    }
    this.floats = keep;

    // ------------------------------------------------ screen flash
    this.screenFlash = Math.max(0, this.screenFlash - dt * 1.8);
    this.flashScreen.clear();
    if (this.screenFlash > 0) this.flashScreen.rect(0, 0, W, H).fill({ color: 0xfff4e0, alpha: this.screenFlash });
  }

  private drawDropMarks(alpha: number) {
    const g = this.planG;
    g.clear();
    for (const [id, color] of this.dropMarks) {
      const e = this.sim.entities.get(id);
      if (!e) {
        this.dropMarks.delete(id);
        continue;
      }
      const p = this.xform(e, alpha);
      if (p.y < 2.2 || e.body.linvel().y > -0.5) {
        if (this.sim.tick > 0 && Math.abs(e.body.linvel().y) < 0.5) this.dropMarks.delete(id);
        continue;
      }
      const ground = this.sim.nav.surfaceAt(p.x, p.y)?.y ?? 0;
      const a = 0.18 + 0.08 * Math.sin(this.time * 12);
      g.rect(p.x - 0.4, -p.y, 0.8, p.y - ground).fill({ color, alpha: a });
      g.ellipse(p.x, -ground, 0.9, 0.18).fill({ color, alpha: 0.5 });
    }
  }

  /** Intro / countdown punctuation. */
  blam(id: number) {
    this.addShake(0.45);
    const f = this.sim.fighters[id];
    if (!f || f.removed) return;
    const p = this.sim.pos(f);
    this.fx.add({ x: p.x, y: p.y, kind: "ring", life: 0.45, size: 0.6, size1: 3.2, color: f.color, alpha: 1, aux: 0.22 });
    this.fx.sparks(p.x, p.y, 0, 0, f.color, 14);
    this.fighterView(id).flashT = 0.12;
    this.fighterView(id).sx = 1.3;
    this.fighterView(id).sy = 0.75;
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

function clampN(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
