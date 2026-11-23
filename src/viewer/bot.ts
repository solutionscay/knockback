/**
 * The fighters' LED faces (#18), drawn in code from the generated identity (#17) on the rendered plush bot's visor
 * (#85: plush-bot.ts maps this drawing onto the visor of every sprite frame), plus the bot geometry the scene shares:
 * the feet line, the head's top edge (a bot standing on another bot's head), the dot grid.
 *
 * Everything draws through a small `Pen` (the shape calls of a Pixi 8 Graphics plus a transform stack): the game
 * draws with a Pixi pen (pixiPen.ts), the portraits with an SVG pen (svgPen.ts).
 *
 * Units are meters, y down, origin at the fighter capsule's center, facing right (the scene flips the container for
 * facing left). The capsule is 0.84 x 1.68 m. The face is drawn in a Skipper's own 32-unit grid.
 * Pure: no DOM, no Pixi. View only: nothing here touches the sim.
 */
import type { Eyes, Identity, Mark } from "../sim/identity";

export type FillStyle = number | { color: number; alpha?: number };
export interface StrokeStyle {
  width: number;
  color: number;
  alpha?: number;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
}

/** The shape calls a Pixi 8 Graphics already has (weapons draw with these). */
export interface ShapePen {
  rect(x: number, y: number, w: number, h: number): ShapePen;
  roundRect(x: number, y: number, w: number, h: number, r?: number): ShapePen;
  circle(x: number, y: number, r: number): ShapePen;
  ellipse(x: number, y: number, rx: number, ry: number): ShapePen;
  poly(points: number[], close?: boolean): ShapePen;
  moveTo(x: number, y: number): ShapePen;
  lineTo(x: number, y: number): ShapePen;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): ShapePen;
  fill(style: FillStyle): ShapePen;
  stroke(style: StrokeStyle): ShapePen;
}
/** ShapePen plus SVG paths and a transform stack. */
export interface Pen extends ShapePen {
  svgPath(d: string): unknown;
  save(): unknown;
  restore(): unknown;
  translate(x: number, y: number): unknown;
  scale(x: number, y?: number): unknown;
  rotate(a: number): unknown;
}

export function shade(color: number, k: number): number {
  const ch = (v: number) => Math.min(255, Math.max(0, v * k)) | 0;
  return (ch((color >> 16) & 255) << 16) | (ch((color >> 8) & 255) << 8) | ch(color & 255);
}
export function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

// ------------------------------------------------------------------ geometry

/** Skiff black: the visor glass. */
export const VISOR = 0x192230;
const SWEAT = 0x9fe0ff;
/** Meters per Skipper grid unit. */
export const K = 0.034;
/** The dot grid on the visor: columns, rows, pitch in grid units. */
export const COLS = 11;
export const ROWS = 6;
export const P = 1.55;
const VW = COLS * P + 1.4;
const VH = ROWS * P + 1.4;

/** The plush bot's head in the 32-unit grid: the visor's center line (grid y). */
const EYE = 15.5;

/**
 * The drawn top edge of the plush bot's head, in grid y, at grid columns x = 0..32; null where the head is not. A
 * bot standing on another bot stands on this edge (verified with tests/feet-chains.test.ts).
 */
const HEAD_TOP: (number | null)[] = [null, null, null, null, 10.5, 7.88, 6.5, 5.56, 4.94, 4.5, 4.19, 3.94, 3.75, 3.63, 3.56, 3.5, 3.5, 3.5, 3.56, 3.63, 3.75, 3.94, 4.19, 4.5, 5, 5.63, 6.56, 8, 10.75, null, null, null, null];

/** The top of the head at grid column u (0..32, fractional), or null off the head. */
export function headTopAt(u: number): number | null {
  const i = Math.floor(u), f = u - i;
  const a = HEAD_TOP[i], b = HEAD_TOP[i + 1];
  if (a == null || b == null) return null;
  return a + (b - a) * f;
}

// ------------------------------------------------------------------ faces

/** A lit cell: column, row, optional color and alpha. */
export type Bit = [c: number, r: number, color?: number, alpha?: number];
export interface Face {
  bits: Bit[];
  screen: "on" | "white" | "off";
  glow: number;
}
export type FaceMood = "confident" | "cocky" | "rattled" | "furious" | "desperate" | "hit" | "stun" | "win" | "ko" | "white" | "sleepy";
export const MORALE_FACES: FaceMood[] = ["confident", "cocky", "rattled", "furious", "desperate"];
export const ALL_FACES: FaceMood[] = [...MORALE_FACES, "hit", "stun", "ko", "win"];

type Cells = [number, number][];
/** Resting eyes, left eye in columns 1-4 (the right eye is its mirror, 10 - c). One per eye style in the identity pool. */
export const EYE_CELLS: Record<Eyes, Cells> = {
  tall: [[2, 1], [3, 1], [2, 2], [3, 2], [2, 3], [3, 3], [2, 4], [3, 4]],
  dots: [[2, 2], [3, 2], [2, 3], [3, 3]],
  big: [[2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [4, 2], [1, 3], [2, 3], [3, 3], [4, 3], [2, 4], [3, 4]],
  wide: [[1, 2], [2, 2], [3, 2], [4, 2], [1, 3], [2, 3], [3, 3], [4, 3]],
  set: [[1, 1], [2, 1], [2, 2], [3, 2], [2, 3], [3, 3], [3, 4], [4, 4]],
  unsure: [[3, 1], [4, 1], [2, 2], [3, 2], [2, 3], [3, 3], [1, 4], [2, 4]],
  ring: [[2, 1], [3, 1], [1, 2], [4, 2], [1, 3], [4, 3], [2, 4], [3, 4]],
  slit: [[3, 1], [3, 2], [3, 3], [3, 4]],
  square: [[2, 2], [3, 2], [4, 2], [2, 3], [3, 3], [4, 3], [2, 4], [3, 4], [4, 4]],
  plus: [[3, 1], [2, 2], [3, 2], [4, 2], [3, 3]],
  diamond: [[2, 1], [3, 1], [1, 2], [4, 2], [2, 3], [3, 3]],
  visor: [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3]],
};
const E: Record<string, Cells> = {
  lineUp: [[1, 2], [2, 2], [3, 2], [4, 2]],
  angry: [[1, 1], [1, 2], [2, 2], [1, 3], [2, 3], [3, 3], [1, 4], [2, 4], [3, 4], [4, 4]],
  ring: [[2, 1], [3, 1], [1, 2], [4, 2], [1, 3], [4, 3], [2, 4], [3, 4]],
  small: [[2, 2], [3, 2], [2, 3], [3, 3]],
  chev: [[1, 1], [2, 1], [3, 2], [4, 2], [3, 3], [4, 3], [1, 4], [2, 4]],
  x: [[1, 1], [4, 1], [2, 2], [3, 2], [2, 3], [3, 3], [1, 4], [4, 4]],
  arch: [[2, 1], [3, 1], [1, 2], [4, 2], [1, 3], [4, 3]],
};
const SPIN: Cells = [[2, 1], [3, 1], [4, 2], [4, 3], [3, 4], [2, 4], [1, 3], [1, 2]];
const mir = (cells: Cells): Cells => cells.map(([c, r]) => [10 - c, r]);
const both = (cells: Cells): Cells => [...cells, ...mir(cells)];
/** An eye closed: one row across its width. */
function closedEye(cells: Cells, row = 3): Cells {
  const cs = cells.map(([c]) => c);
  const out: Cells = [];
  for (let c = Math.min(...cs); c <= Math.max(...cs); c++) out.push([c, row]);
  return out;
}
/** Half-lidded: the lower half of the eye (at least its bottom row). */
function lidded(cells: Cells, up = 0): Cells {
  const rows = cells.map(([, r]) => r);
  const lo = Math.min(...rows), hi = Math.max(...rows);
  const cut = hi - lo >= 2 ? Math.ceil((lo + hi) / 2) : hi;
  return cells.filter(([, r]) => r >= cut).map(([c, r]) => [c, r - up]);
}

/** Skiff's blink: every 4 to 7 s, closed for the last 2.6 % of the period; one face in five blinks twice. */
export function blinkClosed(t: number, h: number): boolean {
  const p = 4 + ((h >>> 16) % 31) / 10;
  const ph = ((t + ((h >>> 4) % 70) / 10) % p) / p;
  return (h >>> 25) % 5 ? ph > 0.974 : (ph > 0.936 && ph < 0.954) || ph > 0.974;
}

/**
 * The dot face at time t (seconds). `h` is the identity's hash, `eyes` its
 * resting eye style. lookX/lookY move the eyes one dot toward the aim.
 * koT: seconds since the knockout (for "ko").
 */
export function faceFor(mood: FaceMood, t: number, h: number, eyes: Eyes = "tall", o: { lookX?: number; lookY?: number; koT?: number } = {}): Face {
  if (mood === "ko") return koFace(o.koT ?? t);
  if (mood === "white") return { bits: [], screen: "white", glow: 1 };
  const own = EYE_CELLS[eyes] ?? EYE_CELLS.tall;
  let bits: Bit[] = [];
  let glow = 1;
  let lx = o.lookX ?? 0;
  let ly = o.lookY ?? 0;
  const closed = blinkClosed(t, h);
  const step = (rate: number) => Math.floor(t * rate);
  switch (mood) {
    case "confident":
      bits = both(closed ? closedEye(own) : own);
      break;
    case "cocky": // half-lidded, the right eye a row higher with a brow; it winks where the others blink
      bits = [...lidded(own), ...mir(closed ? E.lineUp! : lidded(own, 1)), ...(closed ? [] : ([[7, 0], [8, 0]] as Cells))];
      break;
    case "rattled": // small eyes darting, a bead of sweat running down the edge
      bits = both(closed ? closedEye(E.small!) : E.small!);
      lx += [0, -1, 0, 1, -1][(step(2.2) + (h % 5)) % 5]!;
      {
        const r = step(6) % 9;
        if (r < 6) bits.push([10 - lx, r, SWEAT, 0.9]);
      }
      break;
    case "furious": // eyes cut by a scowl, the dots run hot and flicker; no blink
      bits = both(E.angry!);
      glow = step(14) % 3 === 0 ? 0.7 : 1.15;
      break;
    case "desperate": // wide rings, shaking; sweat on both sides
      bits = both(E.ring!);
      lx += step(11) % 2 ? 1 : -1;
      {
        const r = step(7) % 8;
        if (r < 6) bits.push([0 - lx, r, SWEAT, 0.9], [10 - lx, (r + 3) % 6, SWEAT, 0.9]);
      }
      break;
    case "hit":
      bits = both(E.chev!);
      break;
    case "stun": {
      // stunned = the "thinking" spinner in both eyes (the fighters are AI agents)
      const k = step(12) % 8;
      for (let i = 0; i < 3; i++) {
        const [c, r] = SPIN[(k - i + 8) % 8]!;
        const a = [1, 0.55, 0.25][i]!;
        bits.push([c, r, undefined, a], [10 - c, r, undefined, a]);
      }
      lx = 0;
      ly = 0;
      break;
    }
    case "sleepy": {
      // autopilot (#22): the agent is gone; "." ".." "..." typed slowly across a dimmed visor
      const n = step(1.6) % 4;
      for (let i = 0; i < n; i++) bits.push([3 + 2 * i, 4, undefined, 0.85]);
      glow = 0.7;
      lx = 0;
      ly = 0;
      break;
    }
    case "win": {
      // glad arches, sparkles in the corners
      bits = both(E.arch!);
      const corners: Cells = [[0, 0], [10, 5], [10, 0], [0, 5], [5, 0]];
      const k = step(4);
      bits.push([...corners[k % 5]!, undefined, 1], [...corners[(k + 2) % 5]!, undefined, 0.5]);
      lx = 0;
      ly = 0;
      break;
    }
  }
  const moved: Bit[] = bits.map(([c, r, col, a]) => (col === SWEAT ? [c, r, col, a] : [c + lx, r + ly, col, a]));
  return { bits: moved.filter(([c, r]) => c >= 0 && c < COLS && r >= 0 && r < ROWS), screen: "on", glow };
}

/** KO: X X, then the dots drop row by row and pile up on the bottom of the screen; then it powers down. */
export function koFace(k: number): Face {
  const X = both(E.x!);
  if (k < 0.5) return { bits: X, screen: "on", glow: 1 };
  if (k < 2.3) {
    const bits: Bit[] = [];
    for (let c = 0; c < COLS; c++) {
      const col = X.filter(([cc]) => cc === c).sort((a, b) => b[1] - a[1]);
      col.forEach(([, r], i) => {
        const target = ROWS - 1 - i;
        const delay = (ROWS - 1 - r) * 0.06 + (c % 3) * 0.02;
        bits.push([c, Math.min(target, r + Math.max(0, Math.floor((k - 0.5 - delay) / 0.07)))]);
      });
    }
    const flick = k > 1.9 && Math.floor(k * 14) % 2 === 0;
    return { bits: flick ? [] : bits, screen: "on", glow: flick ? 0 : 1 };
  }
  return { bits: Math.floor(k * 3) % 2 === 0 && k < 3.4 ? [[5, 5, undefined, 0.35]] : [], screen: "off", glow: 1 };
}

/** A short key of a face, to redraw the visor only when it changes. */
export function faceKey(f: Face, lod: Lod): string {
  return `${f.screen}${lod}${f.glow}|${f.bits.map((b) => `${b[0]},${b[1]},${b[2] ?? ""},${b[3] ?? ""}`).join(";")}`;
}

// ------------------------------------------------------------------ level of detail

/** full: portraits; game: 1080p play; tiny: square dots, no unlit grid (720p, far camera, HUD chips). */
export type Lod = "full" | "game" | "tiny";
/** The level of detail for a camera scale in screen pixels per meter (from the dot pitch). */
export function lodFor(pxPerMeter: number): Lod {
  const pitch = P * K * pxPerMeter;
  return pitch >= 6 ? "full" : pitch >= 2.6 ? "game" : "tiny";
}

// ------------------------------------------------------------------ drawing

/** The bottom of the feet: the capsule's bottom (0.84 m below its center), where the sim's body touches the ground. */
export const FEET_Y = 0.84;
/** How far (screen pixels) a standing bot's feet sink into the surface, so foot and ground always overlap. */
export const FEET_OVERLAP_PX = 1.75;
/** Where the feet sit across the body (local x of each foot's middle, facing right). */
export const FOOT_X: readonly [number, number] = [-0.205, 0.205];


export const ledColor = (look: Identity) => mix(0xffffff, look.color, 0.22);
export const hasMark = (look: Identity, m: Mark) => look.mark === m || look.minor === m;

/** Into the head's 32-unit grid: grid y 3.5 is the capsule's top. */
function headSpace(pen: Pen) {
  pen.save();
  pen.translate(-16 * K, -0.84 - 3.5 * K);
  pen.scale(K);
}

/**
 * The visor and its dots (redrawn when the face changes). `scratch` marks draw a crack on the glass.
 * glass false (#85): only the dots and the marks on the glass, over a rendered visor.
 */
export function drawVisor(pen: Pen, look: Identity, face: Face, lod: Lod, glass = true) {
  const led = ledColor(look);
  const sx = 1;
  headSpace(pen);
  const vx = 16, vy = EYE, vw = VW * sx;
  if (glass) {
    pen.roundRect(vx - vw / 2, vy - VH / 2, vw, VH, 3.5);
    pen.fill(VISOR);
    pen.roundRect(vx - vw / 2, vy - VH / 2, vw, VH * 0.45, 3.5);
    pen.fill({ color: 0xffffff, alpha: 0.06 }); // Skiff's soft light on the top of the visor
  }
  const ox = vx - (COLS * P * sx) / 2, oy = vy - (ROWS * P) / 2;
  const at = (c: number, r: number) => [ox + (c + 0.5) * P * sx, oy + (r + 0.5) * P] as const;
  const lit = new Map<number, Bit>();
  if (face.screen === "white") for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) lit.set(c + r * COLS, [c, r, 0xffffff, 1]);
  else for (const b of face.bits) lit.set(b[0] + b[1] * COLS, b);
  if (lod !== "tiny") {
    let any = false;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (!lit.has(c + r * COLS)) {
          const [x, y] = at(c, r);
          pen.circle(x, y, P * 0.34);
          any = true;
        }
    if (any) pen.fill({ color: 0xffffff, alpha: face.screen === "off" ? 0.03 : 0.07 });
  }
  const groups = new Map<string, [number, number][]>();
  for (const [c, r, col, a] of lit.values()) {
    const key = `${col ?? led}|${a ?? 1}`;
    const g = groups.get(key) ?? [];
    g.push([c, r]);
    groups.set(key, g);
  }
  for (const [key, cells] of groups) {
    const [col, a0] = key.split("|").map(Number) as [number, number];
    const a = Math.min(1, a0 * face.glow);
    if (a <= 0) continue;
    if (lod === "tiny") {
      for (const [c, r] of cells) {
        const [x, y] = at(c, r);
        pen.rect(x - P * 0.44, y - P * 0.44, P * 0.88, P * 0.88);
      }
      pen.fill({ color: col, alpha: a });
      continue;
    }
    for (const [c, r] of cells) {
      const [x, y] = at(c, r);
      pen.circle(x, y, P * (lod === "full" ? 0.66 : 0.6));
    }
    pen.fill({ color: col, alpha: 0.22 * a }); // halo
    for (const [c, r] of cells) {
      const [x, y] = at(c, r);
      pen.circle(x, y, P * 0.41);
    }
    pen.fill({ color: col, alpha: a }); // the dot
    if (lod === "full") {
      for (const [c, r] of cells) {
        const [x, y] = at(c, r);
        pen.circle(x - P * 0.1, y - P * 0.1, P * 0.15);
      }
      pen.fill({ color: 0xffffff, alpha: 0.5 * a }); // a hot center
    }
  }
  if (hasMark(look, "bandage")) {
    // a crossed plaster on the top corner, over the glass
    const x = vx + vw / 2 - 2.2, y = vy - VH / 2 + 0.6;
    for (const a of [0.6, -0.6]) {
      pen.save();
      pen.translate(x, y);
      pen.rotate(a);
      pen.roundRect(-3, -0.9, 6, 1.8, 0.6);
      pen.fill(0xf1d3a8);
      pen.restore();
    }
  }
  if (hasMark(look, "scratch")) {
    const x0 = vx + vw * 0.12, y0 = vy - VH / 2 + 0.4;
    pen.moveTo(x0, y0);
    pen.lineTo(x0 + 1.6, y0 + 3.2);
    pen.lineTo(x0 + 0.6, y0 + 5);
    pen.lineTo(x0 + 2.6, y0 + 8.6);
    pen.moveTo(x0 + 1.6, y0 + 3.2);
    pen.lineTo(x0 + 3.6, y0 + 3.8);
    pen.stroke({ width: 0.45, color: 0xffffff, alpha: 0.55, cap: "round", join: "round" });
  }
  pen.restore();
}

/** The white silhouette for the hit flash and the zone warning. */
