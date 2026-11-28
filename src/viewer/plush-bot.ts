import { faceMatrix } from "../art/visor-geometry";
/**
 * The fighters (#85): the plush brawler rendered in Blender (tools/art/plush_sprites.py) as sprite sheets. View only.
 *
 * - Body: frames at about 12 fps (idle, run, punch, launched, jump, flinch, KO, celebrate). The head is turned
 *   toward the camera in the renders, so the visor (and the code LED face drawn on it) faces the viewer.
 * - Layers: the suit fabric, mitts and visor rim are rendered neutral grey and colored here by a gradient map
 *   (PlushRamp: shadow, base, highlight from the fighter's color in OKLCH; yellow stays yellow in shade); the
 *   fixed parts (fleece, leather, boots, glass, stitches, weapons) are drawn as rendered.
 * - Facings: every frame is rendered twice, the second time with the lights mirrored. A bot facing left is the
 *   mirrored sprite of that second render, so the key light stays on the same side of the screen.
 * - Identity: the fighter's major mark and its minor mark (bolts, scarf; the scratch and the bandage are drawn on
 *   the visor glass by the code face) are overlay sheets, moved per body frame by the head anchors (center, +x, +z of
 *   the head bone, projected) or, for the cape (behind the body) and the scarf, the torso anchors. Marks in motion
 *   have a few frames: the headband, cape and scarf flap, the propeller spins, the antenna whips on a spring.
 * - Feet: on the ground loops (idle, run, punch, flinch) each boot is its own layer: setFeet stands it on the ground
 *   under it (a step, a slope, a crate's corner) with the scene's feet offsets.
 * - Silhouette: every frame has a white silhouette layer (alpha grown a few pixels): the dark outline behind the
 *   bot, the hit flash and the build halos (makeSil).
 * - Arms: the body sheets have no near arm. The fist is its own layer (the near arm with the plain mitt, rendered
 *   with the body as a holdout, same frames). A weapon (all 13: rocket, bat, rifle, shotgun, sniper, crossbow,
 *   railgun, hammer, flamethrower, lightning, grenade, mine, grapple) replaces it with two layers: the build's own
 *   sleeve in that weapon's loop (pinned at the body's shoulder) and the weapon with its mitt and socket, shared by
 *   every build (pinned to the sleeve at the wrist); both turn about the shoulder by the aim. The muzzle is in the
 *   frame metadata (muzzle()): the muzzle flash and the projectile start there (the grenade and the mine: the object
 *   in the mitt, where the thrown or placed one starts).
 * - Memory: a round loads only its fighters' builds and marks (plushRound); a weapon layer loads the first time a
 *   fighter holds that weapon (the plain mitt shows for those few frames). Frames are trimmed and packed, the
 *   silhouette is half resolution, and the atlases are KTX2 (Basis UASTC -> BC7/ASTC/ETC2 on the GPU) or WebP.
 * - Face: the LED dots stay code (bot.ts drawVisor without its glass), mapped onto the rendered visor per frame.
 */
import { Assets, Container, defaultFilterVert, Filter, getSupportedTextureFormats, GlProgram, Matrix, Rectangle, setKTXTranscoderPath, Sprite, Texture, UniformGroup } from "pixi.js";
import "pixi.js/ktx2";
import { buildShape, type Build } from "../sim/build";
import type { Mark } from "../sim/identity";
import { FEET_Y } from "../art/bot";
import { PLUSH_LAYOUT, PLUSH_URLS } from "./art/plush/layout";
import { plushRamp, RAMP_STOPS } from "../art/plush-ramp";
import { BEHIND_MARKS, markFrame, TORSO_MARKS } from "../art/plush-motion";
// the KTX2 transcoder pixi.js ships (not in its package exports): bundled as file URLs, served with the viewer
// @ts-expect-error: a file URL (Bun's file loader), not a module to type
import ktxJsUrl from "../../node_modules/pixi.js/transcoders/ktx/libktx.js" with { type: "file" };
import ktxWasmUrl from "../../node_modules/pixi.js/transcoders/ktx/libktx.wasm" with { type: "file" };

export type SheetName = keyof typeof PLUSH_LAYOUT.sheets;
type Pt = readonly number[];
interface FrameMeta {
  visor: readonly Pt[];
  head: readonly Pt[];
  torso: readonly Pt[];
  shoulder: Pt;
  /** a boot's sole middle (boot sheets): the foot stands and tilts about it */
  sole?: Pt;
  /** the near wrist (sleeve and weapon sheets): the weapon layer is pinned to the sleeve here */
  wrist?: Pt;
  angle?: number;
  muzzle?: Pt;
  /** the frame's trim in the cell [x, y, w, h], and the atlas positions of its five layers */
  trim: readonly number[];
  at: readonly Pt[];
}
interface SheetMeta {
  n: number;
  ground: Pt;
  frames: readonly FrameMeta[];
}
const sheetMeta = (n: SheetName) => PLUSH_LAYOUT.sheets[n] as unknown as SheetMeta;
const has = (n: string): n is SheetName => n in PLUSH_LAYOUT.sheets;
const CELL = PLUSH_LAYOUT.cell;

/** The weapons with a rendered layer; the others keep the code drawing. */
export const PLUSH_WEAPONS = new Set(["rocket", "bat", "rifle", "shotgun", "sniper", "crossbow", "railgun", "hammer", "flamethrower", "lightning", "grenade", "mine", "grapple"]);
/** How long a weapon's fire frames play (seconds): the loop's hold, fire, recoil and recover. */
const FIRE_DUR: Record<string, number> = { rocket: 0.9, rifle: 0.45, shotgun: 0.6, sniper: 0.7, crossbow: 0.85, railgun: 0.7, flamethrower: 0.5, lightning: 0.55, grenade: 0.8, mine: 0.8, grapple: 0.6 };
/**
 * Where a fire loop starts (the share of the loop already gone): the grenade and the mine leave the mitt on loop
 * frame 8 of 24, the tick the sim spawns them, so the throw (place) starts just before its release.
 */
const FIRE_FROM: Record<string, number> = { grenade: 0.25, mine: 0.22 };
/** Drawn as rendered, not turned by the aim: the swung weapons and the thrown or placed ones. */
const NO_AIM = new Set(["bat", "hammer", "grenade", "mine"]);
/**
 * Swung weapons (the view's swing timer starts them; drawn as rendered, not turned by the aim): how long the swing
 * plays and where it starts (the share of the loop already gone, so the hit lands when the sim's hit does). Hit
 * frames, in the 24 fps loops: bat 11-12 of 32, hammer 12-13 of 32 (the slam).
 */
const SWING: Record<string, { dur: number; from: number }> = { bat: { dur: 0.5, from: 0 }, hammer: { dur: 0.6, from: 0.25 } };
/** The lightning sword also thrusts on a melee swing (its loop is the thrust). */
const SWING_FIRES = new Set(["lightning"]);
/** Weapons whose fire loop keeps cycling while they keep firing (the flamethrower fires every few ticks). */
const FIRE_LOOPS = new Set(["flamethrower"]);
/** The body loops every build has (a body sheet and a fist sheet each). */
export const PLUSH_LOOPS = ["idle", "run", "punch", "launched", "jump", "flinch", "ko", "celebrate"] as const;
type Loop = (typeof PLUSH_LOOPS)[number];

/** The plush body a build is drawn with: its shape's own sheets once rendered, else BALANCED's. */
const SHAPE_BODY: Record<string, string> = { BALANCED: "balanced", TANK: "tank", ANCHOR: "anchor", "GLASS CANNON": "glass", FORTRESS: "tank", SCRAPPER: "tank", WRECKER: "anchor" };
export function plushBuild(b: Build): string {
  const body = SHAPE_BODY[buildShape(b)] ?? "balanced";
  return has(`${body}-body-idle`) ? body : "balanced";
}

/**
 * The sheets a fighter needs before it can be drawn: its build's body, fist and boot sheets, its major and minor
 * marks. Weapons load on first use.
 */
export function plushNeeds(build: string, mark: Mark, minor: Mark = "none"): SheetName[] {
  const out = PLUSH_LOOPS.flatMap((l) => [`${build}-body-${l}`, `${build}-fist-${l}`, `${build}-bootl-${l}`, `${build}-bootr-${l}`]).filter(has);
  for (const mk of [mark, minor]) {
    const m = `mark-${mk}`;
    if (has(m)) out.push(m);
  }
  return out;
}

// ------------------------------------------------------------------ loading (per match)

interface SheetTex {
  R: { tint: Texture[]; fixed: Texture[] };
  L: { tint: Texture[]; fixed: Texture[] };
  sil: Texture[];
}
const loaded = new Map<SheetName, SheetTex>();
const pending = new Map<SheetName, Promise<void>>();
let format: "ktx2" | "webp" | null = null;

/**
 * Pick the atlas format once: KTX2 (Basis UASTC, transcoded to the GPU's own block format: a quarter of the memory)
 * when the GPU takes BC7, ASTC, ETC2 or BC3; else WebP (KTX2 would only be decoded to full RGBA). ?plushtex=webp
 * forces WebP (for comparisons).
 */
export async function initPlushArt(): Promise<void> {
  if (format) return;
  const forced = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("plushtex");
  const gpu = await getSupportedTextureFormats();
  const block = ["bc7-rgba-unorm", "astc-4x4-unorm", "etc2-rgba8unorm", "bc3-rgba-unorm"].some((f) => gpu.includes(f as never));
  format = forced === "webp" || !block ? "webp" : "ktx2";
  if (format === "ktx2") setKTXTranscoderPath({ jsUrl: ktxJsUrl, wasmUrl: ktxWasmUrl });
}

/** The format the atlases load in ("ktx2" or "webp"), once initPlushArt has run. */
export const plushFormat = () => format;

function cutSheet(name: SheetName, base: Texture): SheetTex {
  const L = sheetMeta(name);
  const orig = new Rectangle(0, 0, CELL, CELL);
  const half = new Rectangle(0, 0, CELL / 2, CELL / 2);
  const cut = (layer: number) =>
    L.frames.map((f) => {
      const [tx, ty, w, h] = f.trim as [number, number, number, number];
      const [ax, ay] = f.at[layer] as [number, number];
      if (layer === 4) return new Texture({ source: base.source, frame: new Rectangle(ax, ay, w / 2, h / 2), orig: half, trim: new Rectangle(tx / 2, ty / 2, w / 2, h / 2) });
      return new Texture({ source: base.source, frame: new Rectangle(ax, ay, w, h), orig, trim: new Rectangle(tx, ty, w, h) });
    });
  return { R: { tint: cut(0), fixed: cut(1) }, L: { tint: cut(2), fixed: cut(3) }, sil: cut(4) };
}

/** Load sheets (those already loaded or loading are skipped). */
export function loadPlushSheets(names: readonly SheetName[]): Promise<void> {
  return Promise.all(
    names.map((n) => {
      if (loaded.has(n)) return undefined;
      let p = pending.get(n);
      if (!p) {
        const url = PLUSH_URLS[n][format ?? "webp"];
        p = Assets.load<Texture>({ src: url, loadParser: format === "ktx2" ? "loadKTX2" : undefined }).then((t) => {
          if (pending.has(n)) loaded.set(n, cutSheet(n, t));
          pending.delete(n);
        });
        pending.set(n, p);
      }
      return p;
    }),
  ).then(() => undefined);
}

/** Wait until no sheet is loading; true if something was. */
export async function plushSettle(): Promise<boolean> {
  if (!pending.size) return false;
  while (pending.size) await Promise.all([...pending.values()]);
  return true;
}

/** A loaded sheet, or null (then it starts loading: weapons load the first time a fighter holds one). */
function sheet(n: SheetName): SheetTex | null {
  const t = loaded.get(n);
  if (!t && !pending.has(n)) void loadPlushSheets([n]);
  return t ?? null;
}

/**
 * A new round: load what its fighters need and free every other sheet (GPU and CPU), except the weapon layers of
 * the builds still in play (they come back on the next pickup anyway).
 */
export function plushRound(needs: readonly SheetName[]): Promise<void> {
  const keep = new Set<string>(needs);
  const builds = new Set(needs.map((n) => n.split("-")[0]));
  for (const n of loaded.keys()) {
    const [b, kind] = n.split("-"); // weapon-<w> sheets are shared by every build: kept once loaded
    if (keep.has(n) || (kind === "sleeve" && builds.has(b)) || b === "weapon") continue;
    loaded.delete(n);
    void Assets.unload(PLUSH_URLS[n][format ?? "webp"]);
  }
  return loadPlushSheets(needs);
}

/** What is loaded now: sheet names and their GPU bytes (block formats: 1 byte per pixel; WebP: 4). */
export function plushMemory(): { sheets: string[]; bytes: number } {
  let bytes = 0;
  for (const n of loaded.keys()) {
    const s = (PLUSH_LAYOUT.sheets[n] as unknown as { size: [number, number] }).size;
    bytes += s[0] * s[1] * (format === "ktx2" ? 1 : 4);
  }
  return { sheets: [...loaded.keys()], bytes };
}

// ------------------------------------------------------------------ the gradient map

const RAMP_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec3 uStop;
void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  if (c.a < 0.002) { finalColor = vec4(0.0); return; }
  float l = dot(c.rgb / c.a, vec3(0.299, 0.587, 0.114));
  vec3 o;
  if (l < uStop.x) o = mix(uC0, uC1, l / uStop.x);
  else if (l < uStop.y) o = mix(uC1, uC2, (l - uStop.x) / (uStop.y - uStop.x));
  else o = mix(uC2, uC3, clamp((l - uStop.y) / (uStop.z - uStop.y), 0.0, 1.0));
  finalColor = vec4(o * c.a, c.a);
}`;
let rampProgram: GlProgram | null = null;
const rgb = (c: number) => new Float32Array([((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]);

/** The gradient-map filter of one fighter's color (shared by all its tinted sprites). */
export function rampFilter(color: number): Filter {
  rampProgram ??= GlProgram.from({ vertex: defaultFilterVert, fragment: RAMP_FRAG, name: "plush-ramp" });
  const [c0, c1, c2, c3] = plushRamp(color);
  const u = new UniformGroup({
    uC0: { value: rgb(c0), type: "vec3<f32>" },
    uC1: { value: rgb(c1), type: "vec3<f32>" },
    uC2: { value: rgb(c2), type: "vec3<f32>" },
    uC3: { value: rgb(c3), type: "vec3<f32>" },
    uStop: { value: new Float32Array(RAMP_STOPS), type: "vec3<f32>" },
  });
  return new Filter({ glProgram: rampProgram, resources: { rampUniforms: u }, resolution: "inherit", antialias: "inherit" });
}

// ------------------------------------------------------------------ geometry

const PPM = PLUSH_LAYOUT.ppm;
/** Sheet pixel -> the fighter's local meters (feet on y = FEET_Y, facing right, y down). */
function meters(L: SheetMeta, q: Pt): [number, number] {
  return [(q[0]! - L.ground[0]!) / PPM, FEET_Y + (q[1]! - L.ground[1]!) / PPM];
}
/** a ∘ b: apply b, then a. */
function mul(a: Matrix, b: Matrix): Matrix {
  return a.clone().append(b);
}
/** Sheet pixels -> local meters for a sheet placed as rendered. */
const place = (L: SheetMeta) => {
  const [x, y] = meters(L, [0, 0]);
  return new Matrix(1 / PPM, 0, 0, 1 / PPM, x, y);
};
/** The affine frame of a bone's three projected anchors (center, +x, +z), in local meters. */
function anchor(L: SheetMeta, pts: readonly Pt[]): Matrix {
  const [c, x, z] = pts.map((q) => meters(L, q)) as [[number, number], [number, number], [number, number]];
  return new Matrix(x[0] - c[0], x[1] - c[1], z[0] - c[0], z[1] - c[1], c[0], c[1]);
}

/** A tinted and a fixed sprite of one sheet frame. */
class Layered {
  readonly c = new Container();
  readonly tint = new Sprite();
  readonly fixed = new Sprite();
  constructor(ramp: Filter) {
    this.tint.filters = [ramp];
    this.c.addChild(this.tint, this.fixed);
  }
  show(t: SheetTex, k: number, facing: "R" | "L", m: Matrix) {
    this.tint.texture = t[facing].tint[k]!;
    this.fixed.texture = t[facing].fixed[k]!;
    this.tint.setFromMatrix(m);
    this.fixed.setFromMatrix(m);
  }
}

type PartKey = "back" | "body" | "bootl" | "bootr" | "mark" | "minor" | "fist" | "sleeve" | "arm";
const PART_KEYS: readonly PartKey[] = ["back", "body", "bootl", "bootr", "mark", "minor", "fist", "sleeve", "arm"];
/** The code bot's feet offsets (bot.ts FeetState): back foot (l) and front foot (r). */
export interface FeetOffsets { dl?: number; dr?: number; xl?: number; xr?: number; al?: number; ar?: number }
/** The parts the silhouettes copy each frame: sheet, frame, matrix, shown. */
interface PartState {
  t: SheetTex | null;
  k: number;
  m: Matrix;
}
const SIL_SCALE = new Matrix(2, 0, 0, 2, 0, 0); // the silhouette layer is stored at half resolution

export interface PlushInput {
  dt: number;
  alive: boolean;
  air: boolean;
  stunned: boolean;
  vx: number;
  vy: number;
  weapon: string;
  /** the aim's angle in the fighter's local space (y down), radians */
  aim: number;
  /** the view's swing and recoil timers (rising edges start the punch, swing and fire frames) */
  swingT: number;
  recoil: number;
  /** the view's "hit" face timer: a rising edge on the ground starts the flinch */
  hitT: number;
  celebrate: boolean;
  /** which way the bot is drawn on screen: -1 picks the mirrored-light frames */
  facing: number;
}

/** One fighter's plush bot. */
export class PlushBot {
  /** the mark behind the body (the cape) */
  readonly back: Layered;
  /** the body without its near arm, in place of the code bot's body and feet */
  readonly body: Layered;
  /** the head mark, over the face */
  readonly mark: Layered;
  /** the minor mark (bolts on the head, the scarf on the torso), over the body */
  readonly minor: Layered;
  /** the boots of the ground loops, one layer each (they stand on the ground under them: setFeet) */
  readonly bootl: Layered;
  readonly bootr: Layered;
  /** the near arm with its plain mitt (the fist), over the face */
  readonly fist: Layered;
  /** the near arm's sleeve in a weapon's loop (this build's own), over the face */
  readonly sleeve: Layered;
  /** the weapon with its mitt and socket (shared by every build), pinned to the sleeve at the wrist */
  readonly arm: Layered;
  /** the feet layer: the two boots of the ground loops (the capture-mode feet check looks at it; airborne frames
   * keep their boots in the body) */
  readonly feet = new Container();
  /** the plush body (build) this bot is drawn with */
  readonly build: string;
  /** the marks this bot wears: its major mark (on the mark layer, or the back layer for the cape) and its minor one */
  private readonly marks: { name: string; sheet: SheetName; key: "back" | "mark" | "minor" }[] = [];
  private clock = 0;
  private lastVx = 0;
  private wasAirM = false;
  private whip = 0;
  private whipV = 0;
  /** this frame's body sheet and frame, and the boots' feet offsets (code-bot feet, local meters) */
  private bootAt: { name: string; k: number; facing: "R" | "L" } | null = null;
  private feetNow: FeetOffsets = {};
  private readonly parts: Record<PartKey, PartState>;
  private readonly sils: { root: Container; s: Record<PartKey, Sprite> }[] = [];
  private muzzleAt: { x: number; y: number } | null = null;
  private phase = 0;
  private action: { kind: "punch" | "fire" | "swing"; t: number; dur: number; loop?: boolean } | null = null;
  private land = -1;
  private wasLaunched = false;
  private wasAir = false;
  private jumpT = -1;
  private flinchT = -1;
  private koT = 0;
  private lastSwing = 0;
  private lastRecoil = 0;
  private lastHit = 0;

  constructor(color: number, mark: Mark, build = "balanced", minor: Mark = "none") {
    const ramp = rampFilter(color);
    this.back = new Layered(ramp);
    this.body = new Layered(ramp);
    this.mark = new Layered(ramp);
    this.minor = new Layered(ramp);
    this.bootl = new Layered(ramp);
    this.bootr = new Layered(ramp);
    this.feet.addChild(this.bootl.c, this.bootr.c);
    this.fist = new Layered(ramp);
    this.sleeve = new Layered(ramp);
    this.arm = new Layered(ramp);
    this.build = has(`${build}-body-idle`) ? build : "balanced";
    if (has(`mark-${mark}`)) this.marks.push({ name: mark, sheet: `mark-${mark}` as SheetName, key: BEHIND_MARKS.has(mark) ? "back" : "mark" });
    if (minor !== "none" && has(`mark-${minor}`)) this.marks.push({ name: minor, sheet: `mark-${minor}` as SheetName, key: "minor" });
    const none = () => ({ t: null, k: 0, m: new Matrix() });
    this.parts = { back: none(), body: none(), bootl: none(), bootr: none(), mark: none(), minor: none(), fist: none(), sleeve: none(), arm: none() };
    for (const L of this.layers()) L.c.visible = false;
  }

  /** A white silhouette of the whole bot (body, mark, arm), kept in step with it: tint and fade it. */
  makeSil(): Container {
    const root = new Container();
    const s = { back: new Sprite(), body: new Sprite(), bootl: new Sprite(), bootr: new Sprite(), mark: new Sprite(), minor: new Sprite(), fist: new Sprite(), sleeve: new Sprite(), arm: new Sprite() };
    root.addChild(s.back, s.body, s.bootl, s.bootr, s.minor, s.mark, s.fist, s.sleeve, s.arm);
    this.sils.push({ root, s });
    this.syncSils();
    return root;
  }

  /** The muzzle of the rendered weapon this frame (local meters), or null (no aimed weapon layer). */
  muzzle(): { x: number; y: number } | null {
    return this.muzzleAt;
  }

  /** The build's sleeve and the shared weapon sheet of a rendered weapon, once both are loaded (else null). */
  private weaponSheets(w: string): [SheetTex, SheetTex] | null {
    if (!PLUSH_WEAPONS.has(w)) return null;
    const a = sheet(`${this.build}-sleeve-${w}` as SheetName), b = sheet(`weapon-${w}` as SheetName);
    return a && b ? [a, b] : null;
  }

  private layers(): Layered[] {
    return [this.back, this.body, this.bootl, this.bootr, this.minor, this.mark, this.fist, this.sleeve, this.arm];
  }

  /**
   * Stand each boot on the ground under it, as the code bot's feet (scene-fighters computes the offsets while the
   * bot stands): foot 0 is the back foot, 1 the front; d drops it (y down), x slides it, a tilts it about its sole.
   */
  setFeet(f: FeetOffsets) {
    this.feetNow = f;
    this.placeBoots();
    this.syncSils();
  }

  private placeBoots() {
    const at = this.bootAt;
    const names = at ? [`${this.build}-bootl-${at.name}`, `${this.build}-bootr-${at.name}`].filter(has) : [];
    const tex = names.map((n) => sheet(n));
    if (!at || names.length < 2 || !tex[0] || !tex[1]) {
      this.show("bootl", this.bootl, null, 0, "R", new Matrix());
      this.show("bootr", this.bootr, null, 0, "R", new Matrix());
      return;
    }
    const metas = names.map((n) => sheetMeta(n as SheetName));
    const soles = metas.map((M) => meters(M, M.frames[at.k]!.sole!));
    const back = soles[0]![0] <= soles[1]![0] ? 0 : 1; // the boot further left on screen is the back foot
    const f = this.feetNow;
    ([0, 1] as const).forEach((i) => {
      const foot = i === back ? 0 : 1;
      const dx = (foot === 0 ? f.xl : f.xr) ?? 0, dy = (foot === 0 ? f.dl : f.dr) ?? 0, a = (foot === 0 ? f.al : f.ar) ?? 0;
      const [sx, sy] = soles[i]!;
      const turn = new Matrix().translate(-sx, -sy).rotate(a).translate(sx + dx, sy + dy);
      this.show(i === 0 ? "bootl" : "bootr", i === 0 ? this.bootl : this.bootr, tex[i]!, at.k, at.facing, mul(turn, place(metas[i]!)));
    });
  }

  private syncSils() {
    for (const { s } of this.sils) {
      for (const key of PART_KEYS) {
        const p = this.parts[key];
        s[key].visible = !!p.t;
        if (!p.t) continue;
        s[key].texture = p.t.sil[p.k]!;
        s[key].setFromMatrix(mul(p.m, SIL_SCALE));
      }
    }
  }

  private show(key: PartKey, L: Layered, t: SheetTex | null, k: number, facing: "R" | "L", m: Matrix) {
    L.c.visible = !!t;
    this.parts[key] = { t, k, m };
    if (t) L.show(t, k, facing, m);
  }

  private hideAll() {
    for (const key of PART_KEYS) this.parts[key] = { t: null, k: 0, m: new Matrix() };
    for (const L of this.layers()) L.c.visible = false;
    this.muzzleAt = null;
    this.syncSils();
  }

  /**
   * Pick and place this frame's sprites; returns the matrix for the code face (drawn in code-bot meters), or null
   * while the bot's sheets are still loading (nothing is drawn).
   */
  update(s: PlushInput): Matrix | null {
    const w = s.weapon;
    const fist = w === "fist";
    const facing = s.facing < 0 ? "L" : "R";
    // rising edges of the view's timers: a punch or swing, a shot, a hit
    if (s.swingT > this.lastSwing + 1e-6) {
      const sw = SWING[w];
      if (fist) this.action = { kind: "punch", t: 0, dur: 0.42 };
      else if (sw) this.action = { kind: "swing", t: sw.from * sw.dur, dur: sw.dur };
      else if (SWING_FIRES.has(w)) this.action = { kind: "fire", t: 0, dur: FIRE_DUR[w]! };
    }
    if (s.recoil > this.lastRecoil + 0.01 && FIRE_DUR[w]) {
      if (FIRE_LOOPS.has(w) && this.action?.kind === "fire") this.action.dur = Math.max(this.action.dur, this.action.t + 0.25); // still spraying
      else this.action = { kind: "fire", t: (FIRE_FROM[w] ?? 0) * FIRE_DUR[w]!, dur: FIRE_DUR[w]!, loop: FIRE_LOOPS.has(w) };
    }
    const hitNow = s.hitT > this.lastHit + 1e-6;
    this.lastSwing = s.swingT;
    this.lastRecoil = s.recoil;
    this.lastHit = s.hitT;
    if (this.action) {
      this.action.t += s.dt;
      if (this.action.t >= this.action.dur) this.action = null;
    }
    const launched = s.alive && s.air && s.stunned;
    if (this.wasLaunched && !s.air) this.land = 0;
    this.wasLaunched = launched;
    if (s.air && !this.wasAir && !launched) this.jumpT = 0;
    if (!s.air) this.jumpT = -1;
    this.wasAir = s.air;
    if (hitNow && !launched && !s.air && s.alive) this.flinchT = 0;
    this.koT = s.alive ? 0 : this.koT + s.dt;
    const armSheet = s.alive && !s.celebrate ? this.weaponSheets(w) : null;
    // the body loop and frame
    let loop: Loop;
    let k: number;
    if (!s.alive) {
      loop = "ko";
      k = Math.min(11, Math.floor(this.koT * 12));
    } else if (s.celebrate) {
      loop = "celebrate";
      this.phase += s.dt * 12;
      k = Math.floor(this.phase) % 12;
    } else if (launched) {
      loop = "launched";
      this.phase += s.dt * 12;
      k = 2 + (Math.floor(this.phase) % 7);
    } else if (this.land >= 0 && this.land < 4 / 12) {
      loop = "launched";
      k = 10 + Math.min(3, Math.floor(this.land * 12));
      this.land += s.dt;
    } else if (this.flinchT >= 0 && this.flinchT < 0.45) {
      loop = "flinch";
      k = Math.min(5, Math.floor((this.flinchT / 0.45) * 6));
      this.flinchT += s.dt;
    } else if (this.action?.kind === "punch") {
      loop = "punch";
      k = Math.min(11, Math.floor((this.action.t / this.action.dur) * 12));
    } else if (s.air) {
      loop = "jump";
      if (this.jumpT >= 0) this.jumpT += s.dt;
      k = this.jumpT >= 0 ? Math.min(7, 1 + Math.floor(this.jumpT * 12)) : 7;
    } else if (Math.abs(s.vx) > 0.8) {
      loop = "run";
      this.phase += s.dt * 12 * Math.min(1.6, Math.max(0.7, Math.abs(s.vx) / 5));
      k = Math.floor(this.phase) % 12;
    } else {
      loop = "idle";
      this.phase += s.dt * 12;
      k = Math.floor(this.phase) % 12;
    }
    if (this.land >= 4 / 12) this.land = -1;
    if (this.flinchT >= 0.45) this.flinchT = -1;
    const name = `${this.build}-body-${loop}` as SheetName;
    const bodyT = sheet(name);
    const fistT = sheet(`${this.build}-fist-${loop}` as SheetName);
    const markTs = this.marks.map((m) => sheet(m.sheet));
    if (!bodyT || !fistT || markTs.some((t) => !t)) {
      this.hideAll();
      return null;
    }
    const L = sheetMeta(name);
    const fr = L.frames[k]!;
    const m0 = place(L);
    this.show("body", this.body, bodyT, k, facing, m0);
    const sh = meters(L, fr.shoulder);
    // the boots (ground loops: the body frames have none), each on the ground under it
    this.bootAt = has(`${this.build}-bootl-${loop}`) ? { name: loop, k, facing } : null;
    this.placeBoots();
    // the marks, moved from their render pose by this frame's head (torso) anchors; in motion: the flap and the spin
    // run on the clock (faster at a run), the antenna whips on a spring the body's moves drive
    this.clock += s.dt;
    const vx = s.vx * (s.facing < 0 ? -1 : 1);
    const ax = s.dt > 0 ? (vx - this.lastVx) / s.dt : 0;
    const kick = (s.air !== this.wasAirM ? (s.air ? -0.8 : 1.2) : 0) - Math.max(-30, Math.min(30, ax)) * 0.03;
    this.lastVx = vx;
    this.wasAirM = s.air;
    this.whipV += (-60 * this.whip - 7 * this.whipV) * s.dt + kick;
    this.whip = Math.max(-1, Math.min(1, this.whip + this.whipV * s.dt));
    this.marks.forEach((mk, i) => {
      const M = sheetMeta(mk.sheet);
      const bone = TORSO_MARKS.has(mk.name) ? "torso" : "head";
      const ref = anchor(M, M.frames[0]![bone]).invert();
      const m = mul(mul(anchor(L, fr[bone]), ref), place(M));
      const kk = markFrame(mk.name, M.n, this.clock, vx, this.whip);
      this.show(mk.key, mk.key === "back" ? this.back : mk.key === "minor" ? this.minor : this.mark, markTs[i]!, kk, facing, m);
    });
    // the near arm: the weapon layer, or the plain mitt of this body frame (the fist, or a weapon still loading)
    this.muzzleAt = null;
    this.show("fist", this.fist, armSheet ? null : fistT, k, facing, m0);
    if (armSheet) {
      const S = sheetMeta(`${this.build}-sleeve-${w}` as SheetName);
      const A = sheetMeta(`weapon-${w}` as SheetName);
      const act = this.action && this.action.kind !== "punch" ? this.action : null;
      const ak = !act ? 0 : act.loop ? Math.floor(act.t * 12) % A.n : Math.min(A.n - 1, Math.floor((act.t / act.dur) * A.n));
      const sf = S.frames[ak]!, af = A.frames[ak]!;
      const ssh = meters(S, sf.shoulder), swr = meters(S, sf.wrist!), awr = meters(A, af.wrist!);
      // the sleeve's shoulder on the body's shoulder, the weapon's wrist on the sleeve's wrist; then both turn about
      // the shoulder by the aim (the bat swings as rendered)
      const base = A.frames[0]!.angle ?? 0;
      const rot = NO_AIM.has(w) ? 0 : Math.max(-1.3, Math.min(1.3, s.aim - base));
      const turn = new Matrix().translate(-sh[0], -sh[1]).rotate(rot).translate(sh[0], sh[1]);
      const ms = mul(turn, mul(new Matrix(1, 0, 0, 1, sh[0] - ssh[0], sh[1] - ssh[1]), place(S)));
      const ma = mul(turn, mul(new Matrix(1, 0, 0, 1, swr[0] - ssh[0] + sh[0] - awr[0], swr[1] - ssh[1] + sh[1] - awr[1]), place(A)));
      this.show("sleeve", this.sleeve, armSheet[0], ak, facing, ms);
      this.show("arm", this.arm, armSheet[1], ak, facing, ma);
      if (af.muzzle) this.muzzleAt = ma.apply({ x: af.muzzle[0]!, y: af.muzzle[1]! });
    } else {
      this.show("sleeve", this.sleeve, null, 0, facing, new Matrix());
      this.show("arm", this.arm, null, 0, facing, new Matrix());
    }
    this.syncSils();
    // the code face, mapped onto this frame's visor. The rendered points sit at 0.42 of the visor's width either side
    // of its middle (screen right r, screen left l) and 0.4 of its height above (u). The glass wraps around the turned
    // head, so the face is centered between r and l, not on the glass's 3D center.
    return new Matrix(...faceMatrix(fr.visor.map((q) => meters(L, q))));
  }
}
