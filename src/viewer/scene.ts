/**
 * The PixiJS scene: terrain, props, fighters, effects, camera, health bars.
 * World units are meters with y up; the world container maps (x, y) to (x, -y).
 */
import { Container, Graphics, Rectangle, Sprite, type Application } from "pixi.js";
import { CELL, type Grid } from "../sim/grid";
import type { Sim } from "../sim/sim";
import type { Entity, SimEvent } from "../sim/sim-types";
import type { Callout } from "./callouts";
import { PALETTES } from "./palette";
import { SceneCamera, type CameraFrame } from "./scene-camera";
import { CalloutViews } from "./scene-callouts";
import { SceneEffects } from "./scene-effects";
import { FighterViews } from "./scene-fighters";
import { EntranceView } from "./scene-entrance";
import type { Identity } from "../sim/identity";
import { ProjectileViews } from "./scene-projectiles";
import { PropViews } from "./scene-props";
import { ChainView } from "./chains";
import { FireView } from "./fire";
import { levelFrame, levelRound, setLevelSprite } from "./level-art";
import { TerrainView } from "./terrainview";
import { LiquidView } from "./liquidview";


interface Xform {
  x: number;
  y: number;
  a: number;
}

export type XformAt = (e: Entity, alpha: number) => Xform;

const ZONE_COLOR = 0xff2a4a;
/** #133: the beach sea's horizon hangs this far (m) under the level's lowest ground, below every fighter's feet */
const SEA_BELOW = 0.6;

export class Scene {
  private sim!: Sim;
  private sky = new Graphics();
  private hills = new Graphics();
  /** #111: the beach's backdrop sprites (sun, clouds, island, the sea strips), between the sky and the near dunes; #114 the
   * forest's (the moon, two rows of pines); #125 the cave's (two rows of rock columns, glowing crystals); #127 space's (stars, a planet, a station, asteroids) */
  private backdrop = new Container();
  private world = new Container();
  private terrainView: TerrainView | null = null;
  /** #94: the liquids, in front of the fighters */
  private liquidView: LiquidView | null = null;
  private readonly liquidLayer = new Container();
  private chainView: ChainView | null = null;
  private readonly chainLayer = new Container();
  /** chain bolts and pivot rings on swinging platforms (#34), in front of the pieces */
  private readonly chainFront = new Container();
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
  /** flames and smoke on whatever burns (#33) */
  private readonly fireView = new FireView();
  private readonly projectiles = new ProjectileViews();
  private readonly calloutViews = new CalloutViews();
  /** the entrance (#66): an agent drops in and kicks the house bot out */
  private readonly entrance = new EntranceView();
  /** seconds into the entrance beat, this frame and the last one drawn */
  private entranceU = 0;
  private entranceDrawn = 0;
  readonly camera = new SceneCamera();
  private prev = new Map<number, Xform>();
  private time = 0;
  /** #133: the beach: the top of the level's lowest ground (m), where the sea's horizon hangs (drawBeach) */
  private seaLevel = 0;

  constructor(private readonly app: Application) {
    app.stage.addChild(this.sky, this.backdrop, this.hills, this.world, this.overlay, this.effects.flashScreen);
    this.world.addChild(this.abyss, this.zoneG, this.chainLayer, this.terrainLayer, this.effects.back, this.props.layer, this.chainFront, this.props.marks, this.fighters.layer, this.liquidLayer, this.entrance.layer, this.projectiles.graphics, this.projectiles.sprites, this.effects.front);
    this.overlay.addChild(this.fighters.barsG, this.effects.textLayer, this.calloutViews.lines, this.calloutViews.layer);
    this.projectiles.muzzleOf = (id) => this.fighters.muzzle(id); // rockets, mines, the grapple line leave the plush hand
    this.props.muzzleOf = (id) => this.fighters.muzzle(id); // ... and grenades
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
    return this.app.screen.width;
  }
  get H() {
    return this.app.screen.height;
  }
  get ui() {
    return this.H / 1080;
  }

  /** fighters on autopilot (#22): sleepy face */
  set autopilot(on: boolean[]) {
    this.fighters.autopilot = on;
  }

  set morale(states: string[]) {
    this.fighters.morale = states;
  }

  set celebrateId(id: number) {
    this.fighters.celebrateId = id;
  }

  /** a dot face changed mood (sound) */
  set onMood(cb: ((id: number, mood: string, x: number, y: number) => void) | null) {
    this.fighters.onMood = cb;
  }

  /** the camera as the sound mix hears it: center, pixels per meter, screen size */
  listener() {
    const f = this.lastFrame;
    return f ? { cx: f.cx, cy: f.cy, s: f.s, w: this.W, h: this.H } : null;
  }

  load(sim: Sim) {
    this.entrance.end(this.fighters);
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
    this.props.theme = sim.level.theme;
    this.pal = PALETTES[sim.level.theme];
    this.seaLevel = lowestGround(sim.grid);
    if (this.terrainView) this.terrainView.container.destroy({ children: true });
    void levelRound(sim.level.theme); // the theme's terrain art (the view draws once it arrives)
    this.terrainView = new TerrainView(sim.grid, sim.level.theme);
    this.terrainLayer.addChild(this.terrainView.container);
    if (this.liquidView) this.liquidView.container.destroy({ children: true });
    this.liquidView = new LiquidView(sim.grid, sim.level.theme);
    this.liquidLayer.addChild(this.liquidView.container);
    this.fighters.liquid = this.liquidView;
    this.props.liquid = this.liquidView;
    this.chainView?.destroy();
    this.chainView = new ChainView(sim);
    this.chainLayer.addChild(this.chainView.container);
    this.chainFront.addChild(this.chainView.front);
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
    const cam = this.camera.cam;
    if (this.pal.background === "beach") return this.drawBeach(W, H);
    if (this.pal.background === "forest") return this.drawForest(W, H);
    if (this.pal.background === "cave") return this.drawCave(W, H);
    if (this.pal.background === "space") return this.drawSpace(W, H);
    this.backdrop.visible = false;
    // hills with parallax
    const h = this.hills;
    h.clear();
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

  /**
   * #111: the beach. Below the sky: the sea from the horizon down (its color, then the plush sea strip repeated along
   * the horizon), the sun over it, two clouds drifting, a far island; low dunes in front. Slow sideways parallax, as the
   * hills. Before the atlas arrives, only the colors.
   *
   * #133: the horizon sits in the world, SEA_BELOW m under the level's lowest ground (seaLevel), not at a fixed share of the
   * screen: a fighter standing anywhere stands above the sea line, on the beach, in View all and in the close cameras
   * alike. The sea shows past the level's ends and down its pits; the sun and clouds keep to the sky.
   */
  private drawBeach(W: number, H: number) {
    const cam = this.camera.cam;
    const f = this.lastFrame ?? { cx: cam.x, cy: cam.y, s: cam.s };
    const k = H / 1080; // atlas pixels to screen pixels: the sea strip is 128 px tall at 1080p
    const horizon = H / 2 + (f.cy - (this.seaLevel - SEA_BELOW)) * f.s;
    const sky = Math.min(horizon, H * 0.62); // the sun and clouds: over the sea, never under the bottom of the sky
    this.sky.rect(0, horizon, W, H - horizon).fill(this.pal.hills[0]);
    const b = this.backdrop;
    b.visible = true;
    const theme = this.sim.level.theme;
    let i = 0;
    const put = (name: string, x: number, y: number, scale = k, alpha = 1, tint = 0xffffff) => {
      let s = b.children[i] as Sprite | undefined;
      if (!s) s = b.addChild(new Sprite());
      i++;
      if (!setLevelSprite(s, theme, name)) return (s.visible = false);
      s.scale.set(scale);
      s.anchor.set(0.5, 1);
      s.position.set(x, y);
      s.alpha = alpha;
      s.tint = tint;
      return true;
    };
    const wrap = (x: number, span: number) => ((x % span) + span) % span - span * 0.2;
    put("bg-sun", W * 0.7 - cam.x * cam.s * 0.02, sky - H * 0.09, k * 0.9);
    put("bg-cloud-0", wrap(W * 0.2 + this.time * 6 * k - cam.x * cam.s * 0.05, W * 1.4), sky - H * 0.3, k * 0.85, 0.92);
    put("bg-cloud-1", wrap(W * 0.95 + this.time * 4 * k - cam.x * cam.s * 0.04, W * 1.4), sky - H * 0.2, k * 0.7, 0.85);
    put("bg-island", wrap(W * 0.28 - cam.x * cam.s * 0.08, W * 1.6), horizon + 10 * k, k * 0.7, 0.85, 0xb0b8c0);
    const sea = levelFrame(theme, "bg-sea");
    if (sea) {
      const tw = sea.tex.frame.width * k;
      const ox = ((-cam.x * cam.s * 0.12) % tw + tw) % tw - tw;
      for (let x = ox; x < W + 1; x += tw) {
        // darker than the tide pools in front, so the level's water reads as the level's
        put("bg-sea", x + tw / 2, horizon + sea.tex.frame.height * k - 2 * k, k, 1, 0xa0aab4);
        const s = b.children[i - 1] as Sprite;
        s.width = tw + 1; // no hairline between the strips
      }
    }
    for (let j = i; j < b.children.length; j++) b.children[j]!.visible = false;
    // the near dunes
    const h = this.hills;
    h.clear();
    const ox2 = -cam.x * cam.s * 0.45;
    const base2 = horizon + H * 0.3; // under the sea strip, as far below the horizon as before
    const pts: number[] = [];
    for (let x = -200; x <= W + 200; x += 30) {
      const wx = (x - ox2) / 110;
      pts.push(x, base2 - (Math.sin(wx * 1.1 + 2) * 26 + Math.sin(wx * 2.7) * 9 + 30) * this.ui);
    }
    pts.push(W + 200, H, -200, H);
    h.poly(pts).fill(this.pal.hills[1]);
  }

  /**
   * #114: the forest. The moon high in the sky, then two rows of the plush pine strip repeated sideways (far: smaller,
   * slower; near: larger, darker), low on the screen, each filled below in its own trees' color so the row and the fill
   * are one dark mass with only the treetops for an edge: no flat band (the lesson of the beach's sea), nothing that
   * reads as the creek's water or as ground. Before the atlas arrives, only the colors.
   */
  private drawForest(W: number, H: number) {
    const cam = this.camera.cam;
    const k = H / 1080;
    const b = this.backdrop;
    b.visible = true;
    const theme = this.sim.level.theme;
    let i = 0;
    const put = (name: string, x: number, y: number, scale: number, tint = 0xffffff) => {
      let s = b.children[i] as Sprite | undefined;
      if (!s) s = b.addChild(new Sprite());
      i++;
      if (!setLevelSprite(s, theme, name)) return (s.visible = false);
      s.scale.set(scale);
      s.anchor.set(0.5, 1);
      s.position.set(x, y);
      s.alpha = 1;
      s.tint = tint;
      return true;
    };
    put("bg-moon", W * 0.74 - cam.x * cam.s * 0.02, H * 0.24, k * 0.7, 0xc8ccbb);
    const pines = levelFrame(theme, "bg-pines");
    const row = (base: number, scale: number, par: number, tint: number) => {
      if (!pines) return;
      const tw = pines.tex.frame.width * scale;
      const ox = ((-cam.x * cam.s * par) % tw + tw) % tw - tw;
      for (let x = ox; x < W + 1; x += tw) {
        put("bg-pines", x + tw / 2, base + 1, scale, tint);
        (b.children[i - 1] as Sprite).width = tw + 1;
      }
    };
    // the pine felt renders about 0x1c3024: these tints bring it to hills[0] and hills[1], the fills below the rows
    const tint = (c: number) => {
      const ch = (sh: number, base: number) => Math.min(255, Math.round((((c >> sh) & 255) / base) * 255));
      return (ch(16, 0x1c) << 16) | (ch(8, 0x30) << 8) | ch(0, 0x24);
    };
    const far = H * 0.74 + cam.y * cam.s * 0.08;
    const near = H * 0.88 + cam.y * cam.s * 0.16;
    // the fills start under the lowest boughs (32 atlas px up), so no sky shows between the trunks
    this.sky.rect(0, far - 32 * k * 0.8, W, H).fill(this.pal.hills[0]);
    row(far, k * 0.8, 0.08, tint(this.pal.hills[0]));
    row(near, k * 1.15, 0.16, tint(this.pal.hills[1]));
    for (let j = i; j < b.children.length; j++) b.children[j]!.visible = false;
    const h = this.hills;
    h.clear();
    h.rect(0, near - 32 * k * 1.15, W, H).fill(this.pal.hills[1]);
  }

  /**
   * #125: the cave's back wall. Two rows of the plush column strip repeated sideways (far: smaller, slower, darker; near:
   * larger), each a band of stalactites hanging over stalagmites, filled above and below in its own color, so the wall
   * is one dark mass with only the columns' points for edges: no flat band at the fighters' height, nothing that reads
   * as the slime. A few glowing crystal clusters sit among the columns (the map's light), each in a soft halo. The
   * level's own ceiling and floor cover the top and the bottom. Before the atlas arrives, only the colors.
   */
  private drawCave(W: number, H: number) {
    const cam = this.camera.cam;
    const k = H / 1080;
    const b = this.backdrop;
    b.visible = true;
    const theme = this.sim.level.theme;
    let i = 0;
    const put = (name: string, x: number, y: number, scale: number, tint = 0xffffff, alpha = 1) => {
      let s = b.children[i] as Sprite | undefined;
      if (!s) s = b.addChild(new Sprite());
      i++;
      if (!setLevelSprite(s, theme, name)) return (s.visible = false);
      s.scale.set(scale);
      s.anchor.set(0.5, 1);
      s.position.set(x, y);
      s.alpha = alpha;
      s.tint = tint;
      return true;
    };
    // the column felt renders about 0x292835: these tints bring it to hills[0] and hills[1], the fills above and below
    const tint = (c: number) => {
      const ch = (sh: number, base: number) => Math.min(255, Math.round((((c >> sh) & 255) / base) * 255));
      return (ch(16, 0x29) << 16) | (ch(8, 0x28) << 8) | ch(0, 0x35);
    };
    const cols = levelFrame(theme, "bg-columns");
    const h = this.hills;
    h.clear();
    const row = (mid: number, scale: number, par: number, color: number, layer: Graphics) => {
      const th = (cols?.tex.frame.height ?? 307) * scale;
      const top = mid - th / 2, foot = mid + th / 2;
      // the fills reach a few atlas px into the strip: under the column roots, so no sky shows along its edges
      layer.rect(0, -10, W, top + 6 * scale + 10).fill(color);
      layer.rect(0, foot - 6 * scale, W, H - foot + 6 * scale + 10).fill(color);
      if (!cols) return;
      const tw = cols.tex.frame.width * scale;
      const ox = ((-cam.x * cam.s * par) % tw + tw) % tw - tw;
      for (let x = ox; x < W + 1; x += tw) {
        put("bg-columns", x + tw / 2, foot, scale, tint(color));
        (b.children[i - 1] as Sprite).width = tw + 1;
      }
    };
    const midY = H * 0.5 + cam.y * cam.s * 0.06;
    row(midY, k * 2.2, 0.06, this.pal.hills[0], this.sky);
    // crystals among the far columns: fixed spots along a wide loop, slow parallax, each in a soft halo
    const span = W * 1.8;
    const spots: [number, number, number, number][] = [[0.08, 0.66, 0.9, 0x8a5cff], [0.31, 0.3, 0.6, 0x3ad8ff], [0.47, 0.72, 1.1, 0xb66bff], [0.69, 0.36, 0.7, 0x8a5cff], [0.86, 0.68, 0.85, 0x3ad8ff]];
    for (const [fx, fy, sc, glow] of spots) {
      const x = ((fx * span - cam.x * cam.s * 0.1) % span + span) % span - W * 0.4;
      const y = midY + (fy - 0.5) * H * 0.9;
      for (let r = 3; r >= 1; r--) this.sky.circle(x, y - 30 * k * sc, 46 * k * sc * r).fill({ color: glow, alpha: 0.035 });
      put("bg-crystal", x, y, k * sc, 0xd8d0e8, 0.9);
    }
    row(midY + H * 0.04, k * 3.0, 0.14, this.pal.hills[1], h);
    for (let j = i; j < b.children.length; j++) b.children[j]!.visible = false;
  }

  /**
   * #127: space. A starfield (fixed points from a seeded hash, two depths of slow parallax), a ringed planet high up, a far
   * station, two asteroids drifting across in the `hills` tints. No ground and no horizon: nothing runs as a band
   * behind the fighters, and the void below is the level's own abyss. Before the atlas arrives, only the stars.
   */
  private drawSpace(W: number, H: number) {
    const cam = this.camera.cam;
    const k = H / 1080;
    const s = this.sky;
    // stars: 220 points over a loop 1.5 screens wide, parallax 0.01 (far) and 0.03 (near)
    const span = W * 1.5;
    let h = 0x9e3779b1;
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0), h / 4294967296);
    for (let i = 0; i < 220; i++) {
      const near = i % 4 === 0;
      const x = ((rnd() * span - cam.x * cam.s * (near ? 0.03 : 0.01)) % span + span) % span - W * 0.25;
      const y = rnd() * H;
      const r = (near ? 1.6 : 0.9 + rnd() * 0.6) * Math.max(1, k);
      const tw = 0.55 + 0.45 * Math.sin(this.time * (0.6 + (i % 7) * 0.2) + i);
      s.circle(x, y, r).fill({ color: i % 9 === 0 ? 0xffe2b8 : i % 7 === 0 ? 0xb8d4ff : 0xffffff, alpha: (near ? 0.85 : 0.55) * tw });
    }
    const b = this.backdrop;
    b.visible = true;
    const theme = this.sim.level.theme;
    let i = 0;
    const put = (name: string, x: number, y: number, scale: number, tint = 0xffffff, alpha = 1, rot = 0) => {
      let sp = b.children[i] as Sprite | undefined;
      if (!sp) sp = b.addChild(new Sprite());
      i++;
      if (!setLevelSprite(sp, theme, name)) return (sp.visible = false);
      sp.scale.set(scale);
      sp.anchor.set(0.5, 0.5);
      sp.position.set(x, y);
      sp.alpha = alpha;
      sp.tint = tint;
      sp.rotation = rot;
      return true;
    };
    const wrap = (x: number, w: number) => ((x % w) + w) % w - w * 0.2;
    put("bg-planet", W * 0.78 - cam.x * cam.s * 0.015, H * 0.2, k * 0.9, 0xb8b4cc);
    put("bg-station", wrap(W * 0.22 - cam.x * cam.s * 0.025, W * 1.5), H * 0.3, k * 0.75, 0x9aa0b4, 0.9);
    put("bg-rock", wrap(W * 0.55 + this.time * 5 * k - cam.x * cam.s * 0.05, W * 1.6), H * 0.12, k * 0.55, this.pal.hills[1] | 0x404040, 0.85, this.time * 0.05);
    put("bg-rock", wrap(W * 1.1 + this.time * 3 * k - cam.x * cam.s * 0.04, W * 1.6), H * 0.42, k * 0.35, this.pal.hills[0] | 0x404040, 0.7, -this.time * 0.04);
    for (let j = i; j < b.children.length; j++) b.children[j]!.visible = false;
    this.hills.clear();
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
    this.liquidView?.event(e);
    this.effects.onEvent(e, this.sim, this.pal, this.camera, this.fighters, this.props, this.projectiles);
  }

  afterTick() {
    return this.effects.afterTick(this.sim, this.camera);
  }

  float(text: string, x: number, y: number, color: number, scale: number) {
    this.effects.float(text, x, y, color, scale);
  }

  /** where the page's fight HUD ends (screen px from the canvas top): callouts stay below it (#132) */
  calloutTop = 0;

  setCallouts(list: Callout[], now: number) {
    this.calloutViews.setCallouts(list, now);
  }

  /** The canvas's top edge on the page (px), to measure the HTML HUD against. */
  canvasTop(): number {
    return this.app.canvas.getBoundingClientRect().top;
  }

  /** Start an agent's entrance (#66): the house bot `evicted` (none: nobody to kick) stands in the seat. */
  startEntrance(seat: number, evicted: Identity | undefined) {
    this.entrance.start(this.sim, seat, evicted, this.fighters);
    this.entranceU = 0;
    this.entranceDrawn = 0;
  }

  /** The entrance is `u` seconds in (drawn at the next render). */
  set entranceTime(u: number) {
    this.entranceU = u;
  }

  /** The entrance is over: the agent's fighter stands in its seat. */
  endEntrance() {
    this.entrance.end(this.fighters);
  }

  /** The entrance on now: when its kick lands, and where it happens (sound). */
  get entranceInfo() {
    return this.entrance.active ? { kick: this.entrance.kickStep(), where: this.entrance.where()! } : null;
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
    this.liquidView?.update(this.time, sim);
    fx.update(fxDt);
    this.fireView.emit(sim, fx, fxDt, alpha, this.xform);

    const frame = this.camera.render(sim, this.world, W, H, dt, alpha, this.xform);
    this.lastFrame = frame;
    this.chainView?.update(frame, W, H, alpha, this.xform);
    this.drawSky();
    this.drawZone();
    const projectiles = this.projectiles.graphics;
    projectiles.clear();
    this.props.render(fx, projectiles, this.time, dt, alpha, this.xform);
    this.projectiles.render(sim, fx, dt, alpha, fxDt, this.xform);
    if (this.entrance.active) {
      this.entrance.update(this.entranceU, this.entranceDrawn, this.time, sim, this.fighters, fx, this.camera, frame, W, H);
      this.entranceDrawn = this.entranceU;
    }
    this.fighters.render(sim, fx, this.camera, frame, W, H, this.time, dt, alpha, fxDt, this.xform);
    this.props.drawDropMarks(sim, this.time, alpha, this.xform);
    this.calloutViews.render(sim, this.fighters, W, this.ui, this.calloutTop);
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

/**
 * The top (m) of the level's lowest ground: per column, the solid run up from the grid's bottom row (a pool's liquid
 * counts as ground), the lowest of those tops. Columns with nothing at the bottom (pits, the void) don't count.
 */
function lowestGround(g: Grid): number {
  let low = Infinity;
  for (let cx = 0; cx < g.cols; cx++) {
    let cy = 0;
    while (cy < g.rows && (g.solid(cx, cy) || g.liq[cy * g.cols + cx]! > 0)) cy++;
    if (cy > 0) low = Math.min(low, g.wy(cy - 1) + CELL);
  }
  return isFinite(low) ? low : 0;
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
