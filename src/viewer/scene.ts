/**
 * The PixiJS scene: terrain, props, fighters, effects, camera, health bars.
 * World units are meters with y up; the world container maps (x, y) to (x, -y).
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import { FIGHTER, WEAPONS } from "../sim/constants";
import type { Controller } from "../sim/controller";
import type { Entity, Fighter, Order, Sim, SimEvent } from "../sim/sim";
import { Fx } from "./fx";

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

function shade(color: number, k: number): number {
  const r = Math.min(255, Math.max(0, ((color >> 16) & 255) * k));
  const g = Math.min(255, Math.max(0, ((color >> 8) & 255) * k));
  const b = Math.min(255, Math.max(0, (color & 255) * k));
  return ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
}

interface Xform {
  x: number;
  y: number;
  a: number;
}

interface PropView {
  g: Graphics;
  e: Entity;
  hp: number;
  flash: number;
}

interface FighterView {
  f: Fighter;
  root: Container;
  body: Graphics;
  face: Graphics;
  gun: Graphics;
  flash: Graphics;
  gunKind: string;
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
  private terrain = new Graphics();
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
  private tags: Text[] = [];
  cam = { x: 0, y: 4, s: 40 };
  private trauma = 0;
  private punch = 0;
  private punchX = 0;
  private punchY = 0;
  private screenFlash = 0;
  private tickHits = new Map<number, { dmg: number; x: number; y: number; kb: number }>();
  /** 0..1 progress of the "orders locked" beat, or -1 when hidden. */
  planT = -1;
  /** Camera interest per fighter (recent hits/shots), decays. */
  private activity: number[] = [0, 0, 0, 0];
  private hotspots: { x: number; y: number; w: number }[] = [];
  orders: Order[] = [];
  time = 0;

  constructor(app: Application) {
    this.app = app;
    const stage = app.stage;
    stage.addChild(this.sky, this.hills, this.world, this.overlay, this.flashScreen);
    this.world.addChild(this.abyss, this.zoneG, this.terrain, this.fxBack, this.propLayer, this.planG, this.fighterLayer, this.projG, this.fxFront);
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
    const g = this.terrain;
    g.clear();
    const map = this.sim.map;
    for (const r of map.terrain) {
      const w = r.x1 - r.x0;
      const h = r.top - r.bottom;
      if (r.kind === "ground") {
        g.rect(r.x0, -r.top, w, h + 30).fill(C.ground);
        // strata
        for (let y = r.top - 1.2; y > r.bottom - 30; y -= 1.4) {
          g.rect(r.x0, -y, w, 0.12).fill({ color: C.groundDark, alpha: 0.8 });
        }
        g.rect(r.x0, -r.top, w, 0.22).fill(C.groundTop);
        g.rect(r.x0, -r.top + 0.22, w, 0.08).fill({ color: 0x000000, alpha: 0.25 });
      } else {
        g.roundRect(r.x0, -r.top, w, h, 0.12).fill(C.platform);
        g.rect(r.x0 + 0.05, -r.top, w - 0.1, 0.14).fill(C.platformTop);
        for (let x = r.x0 + 0.6; x < r.x1 - 0.3; x += 1.5) g.circle(x, -r.top + h * 0.6, 0.06).fill({ color: 0x0b0e18, alpha: 0.6 });
        // struts
        g.rect(r.x0 + 0.5, -r.bottom, 0.12, 0.5).fill({ color: C.platform, alpha: 0.6 });
        g.rect(r.x1 - 0.62, -r.bottom, 0.12, 0.5).fill({ color: C.platform, alpha: 0.6 });
      }
    }
    // bridge anchors
    if (map.bridge) {
      g.rect(map.bridge.x0 - 0.15, -map.bridge.y - 0.5, 0.3, 0.6).fill(0x55402a);
      g.rect(map.bridge.x1 - 0.15, -map.bridge.y - 0.5, 0.3, 0.6).fill(0x55402a);
    }
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
      const c = lerpColor(C.skyTop, C.skyBottom, t);
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
    h.poly(pts).fill(C.hills2);
    const pts2: number[] = [];
    const ox2 = -cam.x * cam.s * 0.45;
    const base2 = H * 0.72 + cam.y * cam.s * 0.25;
    for (let x = -200; x <= W + 200; x += 30) {
      const wx = (x - ox2) / 70;
      pts2.push(x, base2 - (Math.sin(wx * 1.3 + 2) * 40 + Math.sin(wx * 3.1) * 14 + 40) * this.ui);
    }
    pts2.push(W + 200, H, -200, H);
    h.poly(pts2).fill(C.hills);
  }

  private makeFighter(f: Fighter): FighterView {
    const root = new Container();
    const body = new Graphics();
    const face = new Graphics();
    const gun = new Graphics();
    const flash = new Graphics();
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
    root.addChild(body, gun, face, flash);
    this.fighterLayer.addChild(root);
    return { f, root, body, face, gun, flash, gunKind: "", sx: 1, sy: 1, spin: 0, flashT: 0, recoil: 0, ghostHp: f.hp, trailT: 0, lastX: 0, lastY: 0 };
  }

  private drawGun(v: FighterView, kind: string) {
    if (v.gunKind === kind) return;
    v.gunKind = kind;
    const g = v.gun;
    g.clear();
    if (kind === "rocket") {
      g.roundRect(-0.15, -0.15, 1.0, 0.3, 0.08).fill(0x3b4150).stroke({ width: 0.04, color: 0x15171d });
      g.rect(0.72, -0.17, 0.16, 0.34).fill(v.f.color);
      g.rect(0.15, 0.1, 0.1, 0.18).fill(0x15171d);
    } else if (kind === "shotgun") {
      g.roundRect(-0.1, -0.08, 0.95, 0.14, 0.04).fill(0x2a2d35);
      g.rect(0.25, -0.09, 0.3, 0.2).fill(0x6b4a2c);
      g.rect(-0.2, -0.06, 0.25, 0.2).fill(0x6b4a2c);
    } else {
      g.circle(0.35, 0, 0.2).fill(0x4b5a2a).stroke({ width: 0.04, color: 0x1d2410 });
      g.rect(0.3, -0.27, 0.1, 0.1).fill(0x888888);
    }
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
        const big = e.kind === "barrel";
        this.hotspots.push({ x: e.x, y: e.y, w: big ? 2.5 : 1.2 });
        this.fx.explosion(e.x, e.y, e.radius, big);
        this.addShake(big ? 0.75 : e.kind === "grenade" ? 0.5 : 0.38);
        if (big) this.screenFlash = Math.max(this.screenFlash, 0.22);
        break;
      }
      case "break": {
        const color = e.kind === "block" ? C.block : e.kind === "crate" ? C.crate : C.plank;
        this.fx.debris(e.x, e.y, e.hw, e.hh, color, e.kind === "plank" ? 5 : 8);
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
          this.float(e.cause === "zone" ? "ZONED" : "K.O.", e.x, e.y + 2, f.color, 1.8);
        }
        this.addShake(0.9);
        this.screenFlash = Math.max(this.screenFlash, 0.3);
        break;
      }
      case "jump": {
        const f = sim.fighters[e.fighter]!;
        const v = this.fighterView(f.id);
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
      case "pickup": {
        const f = sim.fighters[e.fighter]!;
        this.fx.burst(e.x, e.y, e.item === "health" ? 0x7dffa0 : 0xc6e05a);
        this.float(e.item === "health" ? "+HP" : "+2 GRENADES", e.x, e.y + 1.4, e.item === "health" ? 0x7dffa0 : 0xd8f06a, 1.0);
        void f;
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
      const v: PropView = { g, e, hp: -1, flash: 0 };
      this.props.set(e.id, v);
    }
  }

  private drawProp(v: PropView) {
    const e = v.e;
    const g = v.g;
    if (v.hp === e.hp && e.kind !== "barrel" && e.kind !== "item" && e.kind !== "grenade") return;
    const firstDraw = v.hp < 0;
    if (!firstDraw && v.hp !== e.hp) v.flash = 0.1;
    v.hp = e.hp;
    g.clear();
    const w = e.hw;
    const h = e.hh;
    const dmg = 1 - Math.max(0, e.hp) / e.maxHp;
    switch (e.kind) {
      case "block": {
        g.rect(-w, -h, w * 2, h * 2).fill(C.block);
        g.rect(-w, -h, w * 2, 0.1).fill(C.blockLight);
        g.rect(-w, h - 0.1, w * 2, 0.1).fill(C.blockDark);
        g.rect(-w, -h, w * 2, h * 2).stroke({ width: 0.05, color: 0x4e3a22 });
        if (dmg > 0.25) g.moveTo(-w * 0.6, -h * 0.9).lineTo(-w * 0.1, -h * 0.2).lineTo(-w * 0.35, h * 0.4).stroke({ width: 0.05, color: 0x4e3a22 });
        if (dmg > 0.6) g.moveTo(w * 0.7, -h * 0.5).lineTo(w * 0.1, h * 0.1).lineTo(w * 0.4, h * 0.85).stroke({ width: 0.05, color: 0x4e3a22 });
        break;
      }
      case "crate": {
        g.rect(-w, -h, w * 2, h * 2).fill(C.crate).stroke({ width: 0.06, color: C.crateDark });
        g.moveTo(-w, -h).lineTo(w, h).moveTo(w, -h).lineTo(-w, h).stroke({ width: 0.09, color: C.crateDark });
        g.rect(-w, -h, w * 2, h * 2).stroke({ width: 0.12, color: C.crateDark, alpha: 0.6 });
        if (dmg > 0.4) g.moveTo(-w * 0.2, -h).lineTo(w * 0.3, -h * 0.1).stroke({ width: 0.05, color: 0x2a170a });
        break;
      }
      case "barrel": {
        const armed = e.fuse !== undefined;
        const blink = armed && Math.floor(this.time * 30) % 2 === 0;
        g.roundRect(-w, -h, w * 2, h * 2, 0.1).fill(blink ? 0xffffff : C.barrel).stroke({ width: 0.05, color: C.barrelDark });
        g.rect(-w, -h * 0.55, w * 2, 0.1).fill(C.barrelDark);
        g.rect(-w, h * 0.45, w * 2, 0.1).fill(C.barrelDark);
        g.poly([0, -0.18, 0.17, 0.13, -0.17, 0.13]).fill(0xffd23a);
        g.rect(-0.02, -0.08, 0.04, 0.12).fill(0x1a1a1a);
        if (dmg > 0.2 && !armed) g.circle(w * 0.4, -h * 0.2, 0.05).fill(0x2a0a08);
        break;
      }
      case "plank": {
        g.rect(-w, -h, w * 2, h * 2).fill(C.plank).stroke({ width: 0.04, color: 0x3e2614 });
        g.circle(-w + 0.08, 0, 0.03).fill(0x222222);
        g.circle(w - 0.08, 0, 0.03).fill(0x222222);
        break;
      }
      case "item": {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
        g.circle(0, 0, 0.55 + pulse * 0.12).fill({ color: e.itemType === "health" ? 0x7dffa0 : 0xd8f06a, alpha: 0.18 + pulse * 0.12 });
        if (e.itemType === "health") {
          g.roundRect(-w, -h, w * 2, h * 2, 0.08).fill(0xf4f4f4).stroke({ width: 0.05, color: 0x7a7a7a });
          g.rect(-0.07, -0.18, 0.14, 0.36).fill(0xe23b3b);
          g.rect(-0.18, -0.07, 0.36, 0.14).fill(0xe23b3b);
        } else {
          g.roundRect(-w, -h, w * 2, h * 2, 0.08).fill(0x4b5a2a).stroke({ width: 0.05, color: 0x1d2410 });
          g.circle(0, 0.03, 0.14).fill(0x2a3315);
          g.rect(-0.04, -0.2, 0.08, 0.1).fill(0xd8f06a);
        }
        break;
      }
      case "grenade": {
        const blink = Math.floor(this.time * ((e.ticksLeft ?? 60) < 40 ? 16 : 6)) % 2 === 0;
        g.circle(0, 0, w).fill(0x4b5a2a).stroke({ width: 0.04, color: 0x1d2410 });
        g.circle(0, -w * 0.4, 0.07).fill(blink ? 0xff3030 : 0x551010);
        break;
      }
    }
  }

  render(dt: number, alpha: number, fxDt: number) {
    this.time += dt;
    const sim = this.sim;
    const W = this.W;
    const H = this.H;
    this.syncProps();
    this.fx.update(fxDt);

    // ------------------------------------------------ camera
    // Frame the fighters. If they are spread wider than the max zoom-out,
    // frame the busiest window (recent hits, shots, rockets in flight).
    const pts: { x: number; y: number; w: number; frame: boolean }[] = [];
    for (const f of sim.fighters) {
      if (!(f.alive || (!f.removed && sim.tick - f.koTick < 40))) continue;
      const p = this.xform(f.entity, alpha);
      pts.push({ x: p.x, y: Math.max(-3, p.y), w: 1 + (this.activity[f.id] ?? 0), frame: true });
    }
    // rockets and explosions only pull the choice of window, not its size
    for (const r of sim.rockets) pts.push({ x: r.x, y: r.y, w: 0.4, frame: false });
    for (const h of this.hotspots) pts.push({ x: h.x, y: h.y, w: h.w, frame: false });
    if (!pts.some((p) => p.frame)) pts.push({ x: this.cam.x, y: 2, w: 1, frame: true });
    const padX = 6;
    const padY = 3.5;
    const maxSpan = this.W / this.minScale() - padX * 2;
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
    y0 = Math.max(y0, -3);
    y1 = Math.max(y1, y0 + 2);
    const tx = (x0 + x1) / 2;
    const ts = this.targetScale(x1 - x0 + padX * 2, y1 - y0 + padY * 2 + 1.5);
    // anchor near the bottom: the lowest fighter sits ~3 m above the bottom edge
    const viewH = this.H / ts;
    const ty = Math.max(y0 - 3.2 + viewH / 2, (y0 + y1) / 2 + 0.8);
    const k = 1 - Math.exp(-dt * 2.6);
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
    const minCy = -7 + H / s / 2;
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
    if (zl > -60) {
      zg.rect(-80, -40, zl + 80, 60).fill({ color: C.zone, alpha: 0.12 + pulse * 0.05 });
      zg.rect(zl - 0.08, -40, 0.16, 60).fill({ color: C.zone, alpha: 0.7 });
    }
    if (zr < 60) {
      zg.rect(zr, -40, 80 - zr, 60).fill({ color: C.zone, alpha: 0.12 + pulse * 0.05 });
      zg.rect(zr - 0.08, -40, 0.16, 60).fill({ color: C.zone, alpha: 0.7 });
    }

    // ------------------------------------------------ props
    for (const v of this.props.values()) {
      const e = v.e;
      const p = this.xform(e, alpha);
      this.drawProp(v);
      v.g.position.set(p.x, -p.y);
      v.g.rotation = -p.a;
      if (e.kind === "barrel" && e.fuse !== undefined) v.g.scale.set(1 + 0.12 * Math.sin(this.time * 60));
      if (e.kind === "item") v.g.position.y += Math.sin(this.time * 4) * 0.04;
      if (v.flash > 0) {
        v.flash -= dt;
        v.g.tint = 0xffaaaa;
      } else v.g.tint = 0xffffff;
    }

    // ------------------------------------------------ rockets
    const pg = this.projG;
    pg.clear();
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
      if (f.stun > 0 && !f.grounded && f.alive) v.spin += f.facing * -dt * Math.min(18, speed * 0.9);
      else if (f.alive) v.spin *= Math.max(0, 1 - dt * 14);
      if (Math.abs(v.spin) < 0.01 && f.alive) v.spin = 0;
      const rot = f.alive ? v.spin : -p.a;
      v.root.position.set(p.x, -p.y);
      v.root.rotation = rot;
      v.root.scale.set(v.sx * (f.facing < 0 ? -1 : 1), v.sy);
      v.root.alpha = f.alive ? 1 : Math.max(0, 1 - (sim.tick - f.koTick) / 120);
      // face
      const face = v.face;
      face.clear();
      const aimLocalX = f.aimX * f.facing;
      const aimLocalY = -f.aimY;
      face.circle(0.14, -0.48, 0.17).fill(0xffffff);
      if (f.alive) {
        face.circle(0.14 + aimLocalX * 0.07, -0.48 + aimLocalY * 0.07, 0.085).fill(0x101018);
        if (f.stun > 0) {
          face.clear();
          face.moveTo(0.05, -0.57).lineTo(0.23, -0.39).moveTo(0.23, -0.57).lineTo(0.05, -0.39).stroke({ width: 0.06, color: 0x101018 });
        }
      } else {
        face.moveTo(0.05, -0.57).lineTo(0.23, -0.39).moveTo(0.23, -0.57).lineTo(0.05, -0.39).stroke({ width: 0.06, color: 0x101018 });
      }
      // gun
      const ctl = this.controllers[f.id];
      let weapon: string = ctl ? ctl.order.weapon : "rocket";
      if (weapon === "grenade" && f.grenades <= 0) weapon = "rocket";
      if (ctl && weapon === "rocket" && ctl.targetId >= 0) {
        const t = sim.fighters[ctl.targetId]!;
        if (t.alive && !t.removed) {
          const tp = sim.pos(t);
          if (Math.hypot(tp.x - p.x, tp.y - p.y) < WEAPONS.rocket.minRange) weapon = "shotgun";
        }
      }
      this.drawGun(v, weapon);
      v.gun.visible = f.alive;
      v.gun.position.set(-v.recoil * 0.5 * 1, -0.05);
      v.gun.rotation = Math.atan2(aimLocalY, aimLocalX);
      // hit flash
      v.flashT = Math.max(0, v.flashT - dt);
      v.flash.alpha = v.flashT > 0 ? 0.85 : f.inZoneDamage && Math.floor(this.time * 8) % 2 === 0 ? 0.25 : 0;
      v.flash.tint = f.inZoneDamage && v.flashT <= 0 ? 0xff3355 : 0xffffff;
      // motion trail when launched
      v.trailT -= fxDt;
      if (speed > 11 && v.trailT <= 0 && f.alive) {
        v.trailT = 0.025;
        this.fx.add({ x: p.x, y: p.y, kind: "trail", life: 0.22, size: FIGHTER.halfHeight + FIGHTER.radius, aux: FIGHTER.radius, color: f.color, back: true });
      }
      if (f.inZoneDamage && Math.random() < 0.3) this.fx.add({ x: p.x + (Math.random() - 0.5) * 0.8, y: p.y + (Math.random() - 0.5) * 1.4, vy: 2, life: 0.4, size: 0.08, color: 0xff4060 });

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
        bars.rect(bx, by, (bw * Math.max(0, v.ghostHp)) / 100, bh).fill({ color: 0xffffff, alpha: 0.85 });
        bars.rect(bx, by, (bw * Math.max(0, f.hp)) / 100, bh).fill(low && Math.floor(this.time * 6) % 2 === 0 ? 0xffffff : f.color);
        bars.rect(bx, by, (bw * Math.max(0, f.hp)) / 100, bh * 0.35).fill({ color: 0xffffff, alpha: 0.25 });
        for (let i = 1; i < 4; i++) bars.rect(bx + (bw * i) / 4 - 0.5 * ui, by, 1 * ui, bh).fill({ color: 0x07080d, alpha: 0.5 });
        for (let i = 0; i < f.grenades; i++) bars.circle(bx + 5 * ui + i * 11 * ui, by + bh + 9 * ui, 4 * ui).fill(0xc6e05a);
      }
    }

    // ------------------------------------------------ planning lines
    this.drawPlan(alpha);

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

  private drawPlan(alpha: number) {
    const g = this.planG;
    g.clear();
    for (const t of this.tags) t.visible = false;
    if (this.planT < 0) return;
    const sim = this.sim;
    const t = Math.min(1, this.planT * 2.2);
    let ti = 0;
    for (const f of sim.fighters) {
      if (!f.alive) continue;
      const o = this.orders[f.id];
      if (!o) continue;
      const tgt = sim.fighters[o.target];
      if (!tgt || !tgt.alive || tgt.id === f.id) continue;
      const a = this.xform(f.entity, alpha);
      const b = this.xform(tgt.entity, alpha);
      const ex = a.x + (b.x - a.x) * t;
      const ey = a.y + (b.y - a.y) * t;
      // dashed line
      const len = Math.hypot(ex - a.x, ey - a.y);
      const n = Math.max(1, Math.floor(len / 0.6));
      const off = (this.time * 2) % 1;
      for (let i = 0; i < n; i++) {
        const u0 = (i + off * 0.5) / n;
        const u1 = Math.min(1, (i + 0.55 + off * 0.5) / n);
        g.moveTo(a.x + (ex - a.x) * u0, -(a.y + (ey - a.y) * u0))
          .lineTo(a.x + (ex - a.x) * u1, -(a.y + (ey - a.y) * u1))
          .stroke({ width: 0.12, color: f.color, alpha: 0.9, cap: "round" });
      }
      if (t >= 1) {
        // crosshair on target, offset per attacker so overlapping marks stay visible
        const r = 0.95 + 0.12 * f.id;
        g.circle(b.x, -b.y, r).stroke({ width: 0.09, color: f.color, alpha: 0.95 });
      }
      // order tag under the fighter
      let tag = this.tags[ti];
      if (!tag) {
        tag = new Text({
          text: "",
          style: { fontFamily: "Rubik, 'Arial Black', system-ui, sans-serif", fontWeight: "800", fontSize: 20, fill: 0xffffff, stroke: { color: 0x07080d, width: 5, join: "round" }, letterSpacing: 1 },
        });
        tag.anchor.set(0.5, 0);
        this.textLayer.addChild(tag);
        this.tags.push(tag);
      }
      ti++;
      const weapon = o.weapon === "grenade" && f.grenades <= 0 ? "rocket" : o.weapon;
      tag.text = `${o.stance.toUpperCase()} · ${weapon.toUpperCase()}`;
      tag.style.fill = f.color;
      tag.visible = true;
      tag.scale.set(this.ui);
      const W = this.W;
      const H = this.H;
      const s = this.world.scale.x;
      const wx = this.world.position.x;
      const wy = this.world.position.y;
      tag.position.set(wx + a.x * s, wy - (a.y - FIGHTER.halfHeight - FIGHTER.radius - 0.15) * s);
      void W;
      void H;
    }
  }
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
