/**
 * The hand-made arena: "The Gap". About 2.5 screens wide.
 * Pure data; the simulation builds physics bodies from it.
 */
export interface Rect {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  kind: "ground" | "platform";
}

export interface PropSpec {
  kind: "block" | "crate" | "barrel";
  x: number;
  /** y of the bottom face */
  y: number;
}

export interface MapDef {
  name: string;
  terrain: Rect[];
  props: PropSpec[];
  bridge: { x0: number; x1: number; y: number; planks: number } | null;
  spawns: { x: number; y: number }[];
  /** Horizontal world bounds for the camera and the safe zone. */
  minX: number;
  maxX: number;
}

const B = 0.9; // block size

function wall(x: number, y: number, cols: number, rows: number): PropSpec[] {
  const out: PropSpec[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ kind: "block", x: x + (c - (cols - 1) / 2) * B, y: y + r * B });
    }
  }
  return out;
}

function pyramid(x: number, y: number, base: number): PropSpec[] {
  const out: PropSpec[] = [];
  for (let r = 0; r < base; r++) {
    const n = base - r;
    for (let c = 0; c < n; c++) {
      out.push({ kind: "block", x: x + (c - (n - 1) / 2) * B, y: y + r * B });
    }
  }
  return out;
}

export const ARENA: MapDef = {
  name: "The Gap",
  minX: -32,
  maxX: 32,
  terrain: [
    { kind: "ground", x0: -30, x1: -3, top: 0, bottom: -7 },
    { kind: "ground", x0: 3, x1: 30, top: 0, bottom: -7 },
    { kind: "ground", x0: -30, x1: -24, top: 1.4, bottom: -1 },
    { kind: "ground", x0: 26, x1: 30, top: 2.0, bottom: -1 },
    { kind: "platform", x0: -21, x1: -15, top: 3.0, bottom: 2.5 },
    { kind: "platform", x0: -11, x1: -5.5, top: 5.0, bottom: 4.5 },
    { kind: "platform", x0: -2.5, x1: 2.5, top: 3.0, bottom: 2.5 },
    { kind: "platform", x0: 5.5, x1: 11, top: 4.6, bottom: 4.1 },
    { kind: "platform", x0: 14, x1: 20, top: 2.6, bottom: 2.1 },
  ],
  props: [
    // cover walls
    ...wall(-12, 0, 2, 3),
    ...wall(12, 0, 2, 3),
    ...wall(-18, 3.0, 1, 2),
    ...wall(17.5, 2.6, 1, 2),
    ...wall(-5.6, 0, 1, 1),
    ...wall(6.2, 0, 2, 1),
    ...pyramid(21.5, 0, 3),
    ...wall(-27.5, 1.4, 1, 2),
    // barrels (pairs make chain reactions possible)
    { kind: "barrel", x: -13.6, y: 0 },
    { kind: "barrel", x: -4.0, y: 0 },
    { kind: "barrel", x: -6.6, y: 0 },
    { kind: "barrel", x: 10.5, y: 0 },
    { kind: "barrel", x: 13.6, y: 0 },
    { kind: "barrel", x: 0, y: 3.0 },
    { kind: "barrel", x: -8.0, y: 5.0 },
    { kind: "barrel", x: 15.2, y: 2.6 },
    { kind: "barrel", x: 25.0, y: 0 },
    // crates
    { kind: "crate", x: -20.5, y: 0 },
    { kind: "crate", x: -29, y: 1.4 },
    { kind: "crate", x: 8.0, y: 0 },
    { kind: "crate", x: 8.0, y: 4.6 },
    { kind: "crate", x: 28.5, y: 2.0 },
    { kind: "crate", x: -16, y: 3.0 },
  ],
  bridge: { x0: -3, x1: 3, y: 0, planks: 8 },
  spawns: [
    { x: -25.5, y: 0 },
    { x: -9, y: 0 },
    { x: 9.5, y: 0 },
    { x: 24, y: 0 },
  ],
};
