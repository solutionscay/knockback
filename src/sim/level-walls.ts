import { CELL, Grid, Mat } from "./grid";
import { NavGraph } from "./nav";
import { CLASSIC, type Ruleset } from "./ruleset";
import type { Rng } from "./rng";

export interface Wall {
  x0: number;
  x1: number;
  y: number;
  top: number;
}

/** Room for a run-up and a full jump on both sides of a generated wall. */
export function wallCorridor(wall: Wall, x0: number, x1: number, y: number, height: number, ruleset: Ruleset = CLASSIC) {
  const W = ruleset.arena.walls;
  return x0 < wall.x1 + W.approach && x1 > wall.x0 - W.approach &&
    y < wall.y + W.clearance && y + height > wall.y;
}

/** The cap must link directly to each approach in both directions. */
export function hasWallRoute(grid: Grid, nav: NavGraph, wall: Wall, ruleset: Ruleset = CLASSIC): boolean {
  const W = ruleset.arena.walls;
  const first = grid.cx(wall.x0);
  const last = grid.cx(wall.x1) - 1;
  const ground = grid.cy(wall.y);
  const cap = grid.cy(wall.top);
  const ceiling = grid.cy(wall.y + W.clearance) - 1;
  const shoulder = W.approach / CELL;
  if (!grid.emptyRect(first - shoulder, ground, first - 1, ceiling) ||
      !grid.emptyRect(last + 1, ground, last + shoulder, ceiling) ||
      !grid.emptyRect(first, cap, last, ceiling)) return false;

  const top = nav.surfaceAt((wall.x0 + wall.x1) / 2, wall.top, 0);
  const left = nav.surfaceAt(wall.x0 - W.approach / 2, wall.y, 0);
  const right = nav.surfaceAt(wall.x1 + W.approach / 2, wall.y, 0);
  if (!top || !left || !right || top.y !== wall.top || left.y !== wall.y || right.y !== wall.y) return false;
  return [left, right].every((side) =>
    nav.out[side.id]!.some((link) => link.to === top.id && link.kind === "jump") &&
    nav.out[top.id]!.some((link) => link.to === side.id));
}

/** Put low, crossable barricades on clear ground, with pre-cracked courses. */
export function placeWalls(grid: Grid, groundTop: readonly number[], count: number, material: Mat, rng: Rng, ruleset: Ruleset = CLASSIC): Wall[] {
  const W = ruleset.arena.walls;
  const walls: Wall[] = [];
  const shoulder = W.approach / CELL;
  for (let attempt = 0; attempt < count * W.attemptsPerWall && walls.length < count; attempt++) {
    const first = rng.int(shoulder, grid.cols - 8);
    const last = first + rng.int(...W.widthCells);
    const y = groundTop[first]!;
    if (!Number.isFinite(y)) continue;
    if (groundTop.slice(first - shoulder, last + shoulder + 1).some((ground) => ground !== y)) continue;
    const wall = { x0: grid.wx(first), x1: grid.wx(last + 1), y, top: y + rng.pick(W.heights) };
    if (walls.some((other) => wall.x0 < other.x1 + W.spacing && wall.x1 > other.x0 - W.spacing)) continue;
    const bottom = grid.cy(y);
    const top = grid.cy(wall.top) - 1;
    if (!grid.emptyRect(first - shoulder, bottom, last + shoulder, grid.cy(y + W.clearance) - 1)) continue;

    for (let cy = bottom; cy <= top; cy++) {
      for (let cx = first; cx <= last; cx++) {
        grid.set(cx, cy, material);
        const cracked = cy === bottom + 1 || (cx + cy) % 3 === 0;
        grid.hp[grid.idx(cx, cy)] = grid.hitPoints[material]! * (cracked ? W.crackedHp : W.regularHp);
      }
    }
    if (hasWallRoute(grid, NavGraph.fromGrid(grid, 2, ruleset), wall, ruleset)) walls.push(wall);
    else grid.fillRect(first, bottom, last, top, Mat.Empty);
  }
  return walls;
}
