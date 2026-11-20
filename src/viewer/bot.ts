/**
 * Skipper-style bot fighters (#18), drawn in code from the generated identity
 * (#17): a Skipper body-shape head with an LED dot-matrix visor, a small
 * torso, stubby feet and one weapon arm.
 *
 * Everything draws through a small `Pen` (the shape calls of a Pixi 8
 * Graphics plus a transform stack). The game draws with a Pixi pen
 * (pixiPen.ts), the dialogue portraits with an SVG pen (svgPen.ts), so the
 * sprite and the portrait are one drawing.
 *
 * Units are meters, y down, origin at the fighter capsule's center, facing
 * right (the scene flips the container for facing left). The capsule is
 * 0.84 x 1.68 m. The head is drawn in a Skipper's own 32-unit grid.
 * Pure: no DOM, no Pixi. View only: nothing here touches the sim.
 */
import { darkenKeepChroma } from "../sim/color";
import type { Eyes, Identity, Mark, Shape } from "../sim/identity";

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
const INK = 0x15171d;
/** Meters per Skipper grid unit. */
export const K = 0.034;
/** The dot grid on the visor: columns, rows, pitch in grid units. */
export const COLS = 11;
export const ROWS = 6;
export const P = 1.55;
const VW = COLS * P + 1.4;
const VH = ROWS * P + 1.4;

export interface Head {
  /** body path in the 32-unit grid (Skiff draws it with a 3-unit round stroke) */
  d: string;
  /** the visor's center line */
  eye: number;
  /** topmost y at the middle, and the half-widths near the top and at the eye line (for marks) */
  top: number;
  tw: number;
  hw: number;
  /** horizontal squeeze of the visor for narrow heads */
  vs?: number;
}

/** One drawing per head shape in the identity pool. The first 8 are Skiff's Skipper bodies. */
export const HEADS: Record<Shape, Head> = {
  squircle: { d: "M16 5c8.5 0 11 2.5 11 11s-2.5 11-11 11S5 24.5 5 16 7.5 5 16 5z", eye: 15.5, top: 5, tw: 9.5, hw: 12.5 },
  dome: { d: "M5 26V16a11 11 0 0 1 22 0v10z", eye: 17, top: 5, tw: 9, hw: 12.5 },
  bun: { d: "M5 22c0-8 2.5-14 6-14 2 0 3 2 5 2s3-2 5-2c3.5 0 6 6 6 14 0 3-1.5 5-4.5 5h-13C6.5 27 5 25 5 22z", eye: 18.5, top: 9, tw: 9, hw: 12.5 },
  hex: { d: "M16 5l10 6v10l-10 6-10-6V11z", eye: 16, top: 5, tw: 6.5, hw: 11.5 },
  lemon: { d: "M3 16C7 5.5 25 5.5 29 16 25 26.5 7 26.5 3 16z", eye: 16, top: 8, tw: 9, hw: 13.5, vs: 0.9 },
  shield: { d: "M6 6h20v9c0 6.5-4.5 10.5-10 12.5C10.5 25.5 6 21.5 6 15z", eye: 13.5, top: 6, tw: 11.5, hw: 11.5 },
  keystone: { d: "M5 7h22l-4.5 19h-13z", eye: 15, top: 7, tw: 12.5, hw: 10.6, vs: 0.94 },
  pebble: { d: "M9 7l10-2 8 7.5-1.5 10.5-10 4L5 21z", eye: 15, top: 6, tw: 7, hw: 11 },
  tv: { d: "M5 8h22v18H5z", eye: 17, top: 8, tw: 12.5, hw: 12.5 },
  pill: { d: "M7 13a9 9 0 0 1 18 0v6a9 9 0 0 1-18 0z", eye: 16, top: 4, tw: 8, hw: 10.5, vs: 0.92 },
  barrel: { d: "M8 6h16q4 10.5 0 21H8q-4-10.5 0-21z", eye: 16.5, top: 6, tw: 9.5, hw: 11.5 },
  onion: { d: "M16 3c3 4 11 7 11 15v8H5v-8c0-8 8-11 11-15z", eye: 18, top: 3, tw: 5.5, hw: 12.5 },
  bell: { d: "M16 5c6 0 8 5 8 11 0 4 3 6 4 10H4c1-4 4-6 4-10 0-6 2-11 8-11z", eye: 16.5, top: 5, tw: 5.5, hw: 9.5, vs: 0.9 },
  octagon: { d: "M11 5h10l6 6v10l-6 6H11l-6-6V11z", eye: 16, top: 5, tw: 7.5, hw: 12.5 },
  gem: { d: "M9 6h14l5 7-12 15L4 13z", eye: 12.5, top: 6, tw: 8.5, hw: 13 },
  cloud: { d: "M8 26a5 5 0 0 1-1.5-9.8A6 6 0 0 1 12 9.2a6 6 0 0 1 9.5 0.6A5.5 5.5 0 0 1 27 16.5a4.8 4.8 0 0 1-1 9.5z", eye: 18, top: 7, tw: 6.5, hw: 12 },
  bucket: { d: "M9 6h14l4 21H5z", eye: 16.5, top: 6, tw: 8.5, hw: 11.5 },
  acorn: { d: "M3 13c0-5 6-7.5 13-7.5s13 2.5 13 7.5v1.5H3zM6 15h20v3a10 9 0 0 1-20 0z", eye: 18.5, top: 5.5, tw: 11, hw: 11.5 },
  mushroom: { d: "M3 16c0-6.5 6-11 13-11s13 4.5 13 11zM10 16h12v9a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z", eye: 12.5, top: 5, tw: 9.5, hw: 14 },
  egg: { d: "M16 4c6 0 11 9 11 15a11 8.5 0 0 1-22 0C5 13 10 4 16 4z", eye: 17.5, top: 4, tw: 5.5, hw: 12.5 },
};

/**
 * The drawn top edge of each head (its path plus the 3-unit round stroke), in
 * grid y, at grid columns x = 0..32; null where the head is not. Generated
 * from HEADS by rasterizing each path (the feet-contact task's
 * tools/head-profiles.ts); regenerate it when a head path changes. A bot
 * standing on another bot stands on this edge.
 */
export const HEAD_TOPS: Record<Shape, (number | null)[]> = {
  squircle: [null, null, null, null, 10.5, 7.88, 6.5, 5.56, 4.94, 4.5, 4.19, 3.94, 3.75, 3.63, 3.56, 3.5, 3.5, 3.5, 3.56, 3.63, 3.75, 3.94, 4.19, 4.5, 5, 5.63, 6.56, 8, 10.75, null, null, null, null],
  dome: [null, null, null, null, 12.44, 10, 8.44, 7.31, 6.38, 5.63, 5, 4.5, 4.19, 3.88, 3.69, 3.56, 3.5, 3.56, 3.69, 3.88, 4.19, 4.56, 5.06, 5.69, 6.44, 7.38, 8.56, 10.13, 12.63, null, null, null, null],
  bun: [null, null, null, null, 15.75, 12.13, 9.94, 8.5, 7.56, 6.94, 6.63, 6.5, 6.63, 7, 7.56, 8.19, 8.5, 8.13, 7.5, 6.94, 6.63, 6.5, 6.63, 7, 7.63, 8.63, 10.06, 12.31, 16.13, null, null, null, null],
  hex: [null, null, null, null, null, 9.88, 9.25, 8.63, 8.06, 7.44, 6.81, 6.25, 5.63, 5.06, 4.44, 3.81, 3.5, 3.88, 4.5, 5.06, 5.69, 6.25, 6.88, 7.5, 8.06, 8.69, 9.25, 9.94, null, null, null, null, null],
  lemon: [null, null, 14.44, 12.75, 11.5, 10.5, 9.69, 9.06, 8.5, 8, 7.63, 7.31, 7.06, 6.88, 6.75, 6.63, 6.63, 6.63, 6.75, 6.88, 7.06, 7.31, 7.63, 8.06, 8.5, 9.06, 9.75, 10.56, 11.56, 12.88, 14.63, null, null],
  shield: [null, null, null, null, null, 4.88, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.94, null, null, null, null, null],
  keystone: [null, null, null, null, 5.88, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.94, null, null, null, null],
  pebble: [null, null, null, null, 18.94, 15.44, 11.94, 8.44, 5.88, 5.44, 5.25, 5.06, 4.88, 4.69, 4.44, 4.25, 4.06, 3.88, 3.69, 3.5, 3.94, 4.88, 5.81, 6.75, 7.69, 8.63, 9.56, 10.5, 11.44, null, null, null, null],
  tv: [null, null, null, null, 6.88, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.94, null, null, null, null],
  pill: [null, null, null, null, null, null, 9.75, 7.56, 6.19, 5.19, 4.38, 3.75, 3.31, 2.94, 2.69, 2.56, 2.5, 2.56, 2.69, 2.94, 3.31, 3.81, 4.44, 5.19, 6.25, 7.69, 9.94, null, null, null, null, null, null],
  barrel: [null, null, null, null, null, 10.94, 7.06, 4.88, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.94, 7.31, 11.31, null, null, null, null, null],
  onion: [null, null, null, null, 14.44, 12.06, 10.5, 9.25, 8.25, 7.31, 6.44, 5.63, 4.75, 3.94, 3, 1.88, 1.5, 1.94, 3.06, 4, 4.81, 5.63, 6.5, 7.38, 8.25, 9.31, 10.56, 12.13, 14.63, null, null, null, null],
  bell: [null, null, null, 24.13, 22.06, 20.31, 18.38, 11.06, 8.25, 6.69, 5.63, 4.81, 4.31, 3.94, 3.69, 3.56, 3.5, 3.56, 3.69, 3.94, 4.31, 4.88, 5.69, 6.75, 8.38, 11.31, 18.5, 20.44, 22.19, 24.31, null, null, null],
  octagon: [null, null, null, null, 9.88, 8.88, 7.88, 6.88, 5.88, 4.88, 3.88, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.94, 4.94, 5.94, 6.94, 7.94, 8.94, 9.94, null, null, null, null],
  gem: [null, null, null, 11.75, 10.38, 9, 7.56, 6.19, 4.88, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.88, 6.25, 7.69, 9.06, 10.44, 11.88, null, null, null],
  cloud: [null, null, 18.19, 16.69, 15.75, 13.94, 11.25, 9.94, 9.13, 8.5, 8.06, 7.81, 7.13, 6.5, 6.06, 5.81, 5.69, 5.69, 5.81, 6.06, 6.5, 7.13, 8.06, 8.44, 8.75, 9.19, 9.88, 10.88, 12.5, 15.69, 16.38, 17.38, 19.25],
  bucket: [null, null, null, null, 24.06, 18.81, 13.56, 8.31, 4.88, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.94, 8.63, 13.88, 19.13, 24.38, null, null, null, null],
  acorn: [null, null, 10.25, 8.56, 7.5, 6.75, 6.13, 5.63, 5.25, 4.88, 4.63, 4.44, 4.25, 4.13, 4.06, 4, 4, 4, 4.06, 4.13, 4.25, 4.44, 4.69, 4.94, 5.25, 5.69, 6.19, 6.81, 7.56, 8.69, 10.44, null, null],
  mushroom: [null, null, 12.5, 10.25, 8.81, 7.69, 6.81, 6.06, 5.5, 5, 4.56, 4.25, 3.94, 3.75, 3.63, 3.56, 3.5, 3.56, 3.63, 3.75, 4, 4.25, 4.63, 5, 5.5, 6.13, 6.88, 7.75, 8.88, 10.38, 12.75, null, null],
  egg: [null, null, null, null, 15.06, 12.13, 10.06, 8.38, 7, 5.88, 4.94, 4.19, 3.56, 3.06, 2.75, 2.56, 2.5, 2.56, 2.75, 3.13, 3.63, 4.25, 5, 5.94, 7.06, 8.5, 10.19, 12.25, 15.31, null, null, null, null],
};

/** The drawn top of a head at grid column u (0..32, fractional), or null off the head. */
export function headTopAt(shape: Shape, u: number): number | null {
  const col = HEAD_TOPS[shape] ?? HEAD_TOPS.squircle;
  const i = Math.floor(u), f = u - i;
  const a = col[i], b = col[i + 1];
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

export { hash } from "./hash";
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

export interface BotState {
  /** seconds (marks flap in steps of it) */
  t: number;
  /** airborne: the feet tuck up */
  air?: boolean;
  /** aiming: the antenna lights */
  aiming?: boolean;
  /** false: leave the feet out (the game draws them in their own layer, set on the ground under each foot) */
  feet?: boolean;
}

/** The bottom of the feet: the capsule's bottom (0.84 m below its center), where the sim's body touches the ground. */
export const FEET_Y = 0.84;
/** How far (screen pixels) a standing bot's feet sink into the surface, so foot and ground always overlap. */
export const FEET_OVERLAP_PX = 1.75;
/** Where the feet sit across the body (local x of each foot's middle, facing right). */
export const FOOT_X: readonly [number, number] = [-0.205, 0.205];

/**
 * The two feet. `dl` / `dr` move the left / right foot down (or up, if
 * negative) in local meters, so each foot can stand on the ground under it
 * (a step edge, a slope of cells); `xl` / `xr` slide a foot sideways (onto a
 * ledge); `al` / `ar` tilt a foot about the middle of its sole (a slope). The feet are 0.16 m tall and overlap the
 * torso's rounded bottom, so no gap shows between body and feet.
 */
export function drawFeet(pen: Pen, look: Identity, s: { air?: boolean; dl?: number; dr?: number; xl?: number; xr?: number; al?: number; ar?: number } = {}) {
  const air = s.air ? 1 : 0;
  const fy = FEET_Y - 0.16 - air * 0.07;
  const color = colors(look).feet;
  // each foot turns about the middle of its sole (al / ar, radians), so it can lie flat on a slope
  const foot = (x: number, y: number, a: number) => {
    pen.save();
    pen.translate(x + 0.135, y + 0.16);
    if (a) pen.rotate(a);
    pen.roundRect(-0.135, -0.16, 0.27, 0.16, 0.07);
    pen.fill(color);
    pen.restore();
  };
  foot(-0.34 - air * 0.03 + (s.xl ?? 0), fy + (s.dl ?? 0), s.al ?? 0);
  foot(0.07 + air * 0.03 + (s.xr ?? 0), fy + air * 0.03 + (s.dr ?? 0), s.ar ?? 0);
}

/** Marks that move in steps (their layer is redrawn when the step changes). */
export const FLAPPING_MARKS: readonly Mark[] = ["headband", "cape", "scarf", "propeller"];
/** The marks a fighter wears: its major mark and its minor mark, if any. */
export const marksOf = (look: Identity): Mark[] => [look.mark, look.minor ?? "none"].filter((m) => m !== "none");
export const hasMark = (look: Identity, m: Mark) => look.mark === m || look.minor === m;
export const flapStep = (look: Identity, t: number) => (marksOf(look).some((m) => FLAPPING_MARKS.includes(m)) ? Math.floor(t * 6) % 2 : 0);

export const ledColor = (look: Identity) => mix(0xffffff, look.color, 0.22);
/** The torso, feet and dark-detail colors of a body color (exported for tests). */
export const darkPartsOf = (c: number) => ({ torso: darkenKeepChroma(c, 0.16), feet: darkenKeepChroma(c, 0.24), dark: darkenKeepChroma(c, 0.3) });
const colors = (look: Identity) => {
  const c = look.color;
  // the head keeps Skiff's color x 0.85; the darker parts drop OKLCH lightness and keep chroma (a yellow stays gold, not khaki)
  return { c, body: shade(c, 0.85), ...darkPartsOf(c) };
};

/** Into the head's 32-unit grid: grid y 3.5 is the capsule's top. */
function headSpace(pen: Pen) {
  pen.save();
  pen.translate(-16 * K, -0.84 - 3.5 * K);
  pen.scale(K);
}

/** Everything but the visor and the weapon arm: drawn once, again only when the feet or a flapping mark change. */
export function drawBody(pen: Pen, look: Identity, s: BotState) {
  const { c, body, torso, dark } = colors(look);
  const air = s.air ? 1 : 0;
  const flap = flapStep(look, s.t);
  const H = HEADS[look.shape] ?? HEADS.squircle;
  if (hasMark(look, "cape")) {
    const fl = flap ? 0.06 : 0;
    pen.poly([-0.2, -0.06, 0.18, -0.06, 0.02, 0.62, -0.5 - fl, 0.66 + fl * 0.5]);
    pen.fill(darkenKeepChroma(c, 0.28));
  }
  // back arm, feet, torso: behind the head
  pen.moveTo(-0.14, 0.16);
  pen.lineTo(-0.3 - air * 0.06, 0.38 - air * 0.14);
  pen.stroke({ width: 0.11, color: torso, cap: "round" });
  if (s.feet !== false) drawFeet(pen, look, { air: s.air });
  pen.roundRect(-0.27, -0.08, 0.54, 0.8, 0.15);
  pen.fill(torso);
  // chest plate: three status lights in the visor's LED color
  pen.roundRect(-0.14, 0.2, 0.28, 0.14, 0.05);
  pen.fill(VISOR);
  for (let i = 0; i < 3; i++) pen.circle(-0.075 + i * 0.075, 0.27, 0.024);
  pen.fill({ color: ledColor(look), alpha: 0.85 });
  if (hasMark(look, "scarf")) {
    const fl = flap ? 0.05 : 0;
    pen.roundRect(-0.29, -0.06, 0.58, 0.13, 0.06);
    pen.poly([-0.18, 0.0, -0.5 - fl, 0.12 - fl, -0.46 - fl, 0.24 - fl, -0.12, 0.07]);
    pen.fill(mix(c, 0xffffff, 0.55));
  }
  // ---- the head, in the Skipper grid
  headSpace(pen);
  for (const m of marksOf(look)) marksBehind(pen, m, look, H, flap);
  pen.svgPath(H.d);
  pen.fill(body);
  pen.stroke({ width: 3, color: body, join: "round" }); // Skiff: a round 3-unit stroke softens every corner
  pen.ellipse(11.5, Math.max(H.top + 2.5, H.eye - 6.5), 3.4, 1.7);
  pen.fill({ color: 0xffffff, alpha: 0.14 }); // a soft top-left light, a nod to Skiff's gummy finish
  for (const m of marksOf(look)) marksFront(pen, m, look, H, flap, !!s.aiming, dark);
  pen.restore();
}

function marksBehind(pen: Pen, mark: Mark, look: Identity, H: Head, flap: number) {
  const top = H.top, tw = H.tw;
  switch (mark) {
    case "headband": {
      const y = top + 2.2, fl = flap ? 1.2 : 0, x = 16 - tw - 1;
      pen.poly([x + 1, y + 0.6, x - 7, y - 2.5 - fl, x - 6, y + 1.5 - fl]);
      pen.poly([x + 1, y + 2, x - 6.5, y + 3 + fl, x - 5, y + 5 + fl]);
      pen.fill(0x2a0d0d);
      break;
    }
    case "horns":
      for (const s of [-1, 1]) pen.poly([16 + s * tw * 0.55, top + 2.2, 16 + s * (tw + 3.2), top - 4.2, 16 + s * (tw * 0.95), top + 2.6]);
      pen.fill(0xf2e6c8);
      break;
    case "ears": // a major mark: big enough to clear the head's outline at 720p
      for (const s of [-1, 1]) pen.circle(16 + s * (tw * 0.8 + 0.6), top + 0.2, 4.3);
      pen.fill(shade(look.color, 0.85));
      for (const s of [-1, 1]) pen.circle(16 + s * (tw * 0.8 + 0.6), top + 0.2, 2.3);
      pen.fill(darkenKeepChroma(look.color, 0.3));
      break;
    case "catears":
      for (const s of [-1, 1]) pen.poly([16 + s * (tw * 0.3), top + 1.8, 16 + s * (tw + 1.2), top - 4.5, 16 + s * (tw + 0.6), top + 3.5]);
      pen.fill(shade(look.color, 0.85));
      for (const s of [-1, 1]) pen.poly([16 + s * (tw * 0.55), top + 1.6, 16 + s * (tw + 0.6), top - 2.4, 16 + s * (tw + 0.4), top + 2.5]);
      pen.fill(0xffb3c8);
      break;
  }
}

function marksFront(pen: Pen, mark: Mark, look: Identity, H: Head, flap: number, aiming: boolean, dark: number) {
  const top = H.top, tw = H.tw, hw = H.hw;
  switch (mark) {
    case "headband":
      pen.roundRect(16 - tw - 1, top + 2.2, 2 * tw + 2, 3, 1);
      pen.fill(0x2a0d0d);
      break;
    case "antenna":
      pen.roundRect(15.3, top - 6.5, 1.4, 8, 0.7);
      pen.fill(dark);
      pen.circle(16, top - 7.6, 2.2);
      pen.fill(VISOR);
      pen.stroke({ width: 0.8, color: dark });
      pen.circle(16, top - 7.6, 1.05);
      pen.fill(aiming ? ledColor(look) : shade(ledColor(look), 0.45)); // lights while aiming
      break;
    case "crown": {
      const w = Math.min(tw, 8), y = top + 0.8;
      pen.poly([16 - w, y, 16 - w + 0.6, y - 6, 16 - w / 2, y - 2.3, 16, y - 7.1, 16 + w / 2, y - 2.3, 16 + w - 0.6, y - 6, 16 + w, y]);
      pen.fill(0xffe066);
      pen.stroke({ width: 0.9, color: 0x9a6d10, join: "round" });
      pen.circle(16, y - 2.1, 1);
      pen.fill(0xff4f6a);
      break;
    }
    case "propeller": {
      pen.ellipse(16, top - 0.2, 3.6, 2.2);
      pen.fill(0x3a5bd9);
      pen.rect(15.5, top - 4.5, 1, 4);
      pen.fill(INK);
      const w = flap ? 2.5 : 6.5;
      pen.ellipse(16 - w / 2 - 0.3, top - 4.8, w / 2, 0.9);
      pen.fill(0xffd23f);
      pen.ellipse(16 + w / 2 + 0.3, top - 4.8, w / 2, 0.9);
      pen.fill(0xff5a5a);
      break;
    }
    case "mohawk": { // a major mark: tall spikes in a darker tone of the body color
      const x0 = 16 - 5.5, sw = 2.75;
      const pts: number[] = [x0, top + 1.6];
      for (let i = 0; i < 4; i++) pts.push(x0 + i * sw + sw / 2, top - 6 - (i === 1 || i === 2 ? 1.2 : 0), x0 + (i + 1) * sw, top + 0.8);
      pen.poly(pts);
      pen.fill(darkenKeepChroma(look.color, 0.24));
      break;
    }
    case "halo":
      pen.ellipse(16, top - 3.6, 5.5, 1.6);
      pen.stroke({ width: 1.1, color: 0xffe066 });
      break;
    case "bolts":
      // neck bolts, low on the sides
      for (const s of [-1, 1]) {
        pen.roundRect(16 + s * (hw - 1.2) - 1.6, H.eye + 3.2, 3.2, 2.2, 0.5);
        pen.circle(16 + s * (hw + 0.9), H.eye + 4.3, 1.6);
      }
      pen.fill(0x9aa3b2);
      for (const s of [-1, 1]) pen.circle(16 + s * (hw + 0.9), H.eye + 4.3, 0.6);
      pen.fill(0x5d6472);
      break;
    case "beanie": {
      const w = tw + 1.5;
      pen.svgPath(`M${16 - w} ${top + 3.4}C${16 - w} ${top - 3.4} ${16 + w} ${top - 3.4} ${16 + w} ${top + 3.4}z`);
      pen.fill(shade(look.color, 0.42));
      pen.roundRect(16 - w - 0.3, top + 2.2, 2 * w + 0.6, 2.2, 1.1);
      pen.fill(shade(look.color, 0.3));
      pen.circle(16, top - 2.4, 1.8);
      pen.fill(0xf4f1ea);
      break;
    }
    case "bow": {
      const x = 16 + tw * 0.45, y = top - 0.4; // a major mark: a big bow
      pen.poly([x, y, x - 5, y - 3.4, x - 5, y + 3.4]);
      pen.poly([x, y, x + 5, y - 3.4, x + 5, y + 3.4]);
      pen.fill(0xff6fa8);
      pen.circle(x, y, 1.5);
      pen.fill(0xd94a85);
      break;
    }
    case "sprout":
      pen.moveTo(16, top + 0.5); // a major mark: a tall sprout with two big leaves
      pen.quadraticCurveTo(15.3, top - 3.5, 16.5, top - 6.5);
      pen.stroke({ width: 1.3, color: 0x3f9a3a, cap: "round" });
      pen.ellipse(13.4, top - 6.4, 3.4, 1.7);
      pen.ellipse(19.6, top - 7.6, 3.4, 1.7);
      pen.fill(0x6fdc5a);
      break;
    case "tophat":
      pen.roundRect(16 - 8, top - 1.4, 16, 2, 1);
      pen.rect(16 - 5, top - 9.4, 10, 8.4);
      pen.fill(0x1d1f27);
      pen.rect(16 - 5, top - 3.6, 10, 1.6);
      pen.fill(look.color);
      break;
  }
}

/** The visor and its dots (redrawn when the face changes). `scratch` marks draw a crack on the glass. */
export function drawVisor(pen: Pen, look: Identity, face: Face, lod: Lod) {
  const H = HEADS[look.shape] ?? HEADS.squircle;
  const led = ledColor(look);
  const sx = H.vs ?? 1;
  headSpace(pen);
  const vx = 16, vy = H.eye, vw = VW * sx;
  pen.roundRect(vx - vw / 2, vy - VH / 2, vw, VH, 3.5);
  pen.fill(VISOR);
  pen.roundRect(vx - vw / 2, vy - VH / 2, vw, VH * 0.45, 3.5);
  pen.fill({ color: 0xffffff, alpha: 0.06 }); // Skiff's soft light on the top of the visor
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
export function drawSilhouette(pen: Pen, look: Identity) {
  const H = HEADS[look.shape] ?? HEADS.squircle;
  pen.roundRect(-0.27, -0.08, 0.54, 0.8, 0.15);
  pen.fill(0xffffff);
  headSpace(pen);
  pen.svgPath(H.d);
  pen.fill(0xffffff);
  pen.stroke({ width: 3, color: 0xffffff, join: "round" });
  pen.restore();
}

/** The front arm from the shoulder to the hand at the weapon grip (gun origin gx, gy; angle a). */
export function drawArm(pen: Pen, look: Identity, gx: number, gy: number, a: number) {
  pen.moveTo(0.04, 0.2);
  pen.lineTo(gx + Math.cos(a) * 0.02, gy + Math.sin(a) * 0.02);
  pen.stroke({ width: 0.11, color: colors(look).torso, cap: "round" });
}

/** The hand on the grip, in the weapon's own (rotated) space. */
export function drawHand(pen: ShapePen, look: Identity) {
  const { body, dark } = colors(look);
  pen.circle(0.02, 0, 0.085);
  pen.fill(body);
  pen.stroke({ width: 0.03, color: dark });
}

/** Weapons draw at this scale on a bot, so they do not cover the visor. */
export const WEAPON_SCALE = 0.85;
