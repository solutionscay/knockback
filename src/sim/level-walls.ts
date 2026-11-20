import { CELL, Grid, MAT_HP, Mat } from "./grid";
import { NavGraph } from "./nav";
import type { Rng } from "./rng";

export interface Wall {
  x0: number;
  x1: number;
  y: number;
  top: number;
}

const APPROACH = 1.5;
export const WALL_CLEARANCE = 5.5;

/** Room for a run-up and a full jump on both sides of a generated wall. */
export function wallCorridor(wall: Wall, x0: number, x1: number, y: number, height: number) {
  return x0 < wall.x1 + APPROACH && x1 > wall.x0 - APPROACH &&
    y < wall.y + WALL_CLEARANCE && y + height > wall.y;
}

/** The cap must link directly to each approach in both directions. */
export function hasWallRoute(grid: Grid, nav: NavGraph, wall: Wall): boolean {
  const first = grid.cx(wall.x0);
  const last = grid.cx(wall.x1) - 1;
  const ground = grid.cy(wall.y);
  const cap = grid.cy(wall.top);
  const ceiling = grid.cy(wall.y + WALL_CLEARANCE) - 1;
  const shoulder = APPROACH / CELL;
  if (!grid.emptyRect(first - shoulder, ground, first - 1, ceiling) ||
      !grid.emptyRect(last + 1, ground, last + shoulder, ceiling) ||
      !grid.emptyRect(first, cap, last, ceiling)) return false;

  const top = nav.surfaceAt((wall.x0 + wall.x1) / 2, wall.top, 0);
  const left = nav.surfaceAt(wall.x0 - APPROACH / 2, wall.y, 0);
  const right = nav.surfaceAt(wall.x1 + APPROACH / 2, wall.y, 0);
  if (!top || !left || !right || top.y !== wall.top || left.y !== wall.y || right.y !== wall.y) return false;
  return [left, right].every((side) =>
    nav.out[side.id]!.some((link) => link.to === top.id && link.kind === "jump") &&
    nav.out[top.id]!.some((link) => link.to === side.id));
}

/** Put low, crossable barricades on clear ground, with pre-cracked courses. */
export function placeWalls(grid: Grid, groundTop: readonly number[], count: number, material: Mat, rng: Rng): Wall[] {
  const walls: Wall[] = [];
  const shoulder = APPROACH / CELL;
  for (let attempt = 0; attempt < count * 50 && walls.length < count; attempt++) {
    const first = rng.int(shoulder, grid.cols - 8);
    const last = first + rng.int(1, 3);
    const y = groundTop[first]!;
    if (!Number.isFinite(y)) continue;
    if (groundTop.slice(first - shoulder, last + shoulder + 1).some((ground) => ground !== y)) continue;
    const wall = { x0: grid.wx(first), x1: grid.wx(last + 1), y, top: y + rng.pick([1.5, 2]) };
    if (walls.some((other) => wall.x0 < other.x1 + 5 && wall.x1 > other.x0 - 5)) continue;
    const bottom = grid.cy(y);
    const top = grid.cy(wall.top) - 1;
    if (!grid.emptyRect(first - shoulder, bottom, last + shoulder, grid.cy(y + WALL_CLEARANCE) - 1)) continue;

    for (let cy = bottom; cy <= top; cy++) {
      for (let cx = first; cx <= last; cx++) {
        grid.set(cx, cy, material);
        const cracked = cy === bottom + 1 || (cx + cy) % 3 === 0;
        grid.hp[grid.idx(cx, cy)] = MAT_HP[material]! * (cracked ? 0.3 : 0.65);
      }
    }
    if (hasWallRoute(grid, NavGraph.fromGrid(grid), wall)) walls.push(wall);
    else grid.fillRect(first, bottom, last, top, Mat.Empty);
  }
  return walls;
}
