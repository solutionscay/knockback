import { WEAPONS } from "./constants";
import { CELL, Mat, type Grid } from "./grid";

/** Walk exact distances inside grid cells. A thin layer spends part of the beam's penetration budget. */
export function traceRail(grid: Grid, x: number, y: number, dx: number, dy: number, range: number,
  touch?: (cx: number, cy: number) => void, penetration: number = WEAPONS.railgun.terrainPenetration): number {
  let cx = grid.cx(x), cy = grid.cy(y);
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const stepX = sx === 0 ? Infinity : CELL / Math.abs(dx);
  const stepY = sy === 0 ? Infinity : CELL / Math.abs(dy);
  let nextX = sx === 0 ? Infinity : (grid.wx(cx + (sx > 0 ? 1 : 0)) - x) / dx;
  let nextY = sy === 0 ? Infinity : (grid.wy(cy + (sy > 0 ? 1 : 0)) - y) / dy;
  let distance = 0;
  let left = penetration;
  while (distance < range) {
    const end = Math.min(nextX, nextY, range);
    const mat = grid.matAt(cx, cy);
    if (mat !== Mat.Empty && end > distance) {
      if (mat === Mat.Bedrock) return distance;
      touch?.(cx, cy);
      if (end - distance > left) return distance + left;
      left -= end - distance;
    }
    if (nextX === end) {
      cx += sx;
      nextX += stepX;
    }
    if (nextY === end) {
      cy += sy;
      nextY += stepY;
    }
    distance = end;
  }
  return range;
}
