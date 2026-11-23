/**
 * How liquids and sand settle (#94), on the grid alone (the generator settles a new level with it; the sim runs it
 * with its terrain, sim-liquid.ts). Whole cells, no pressure: a liquid cell falls into an empty cell below it, or
 * steps sideways into an empty cell it can fall from; sand falls into an empty or liquid cell below it (the liquid
 * rises into its place); a liquid's top cell also runs along its surface (up to LEVEL_REACH cells) to a lower free
 * cell, so a pool levels to within a cell. So a pool drains into a hole carved under or beside it, pours over a broken
 * rim and down a cliff, and runs out of the arena through a pit; it does not rise through a U-bend (no pressure).
 *
 * Deterministic: one fixed scan per step (bottom row first, the side tried first alternating per cell and step),
 * each cell moving at most once per step.
 */
import { Grid, Liquid, Mat } from "./grid";

/** How far (cells) a liquid's top cell runs along its surface to a lower free cell. */
const LEVEL_REACH = 8;

/** Move a solid cell (sand) from grid index `from` to `to` (empty, or holding a liquid that takes `from`'s place). */
export type MoveSolid = (from: number, to: number) => void;

export function moveSolidOnGrid(g: Grid, from: number, to: number) {
  const liq = g.liq[to]!;
  g.mat[to] = g.mat[from]!;
  g.hp[to] = g.hp[from]!;
  g.flags[to] = g.flags[from]!;
  g.liq[to] = Liquid.None;
  g.mat[from] = Mat.Empty;
  g.hp[from] = 0;
  g.flags[from] = 0;
  g.liq[from] = liq;
}

/** One settle step. `seen` (grid size) marks cells moved into this step. Returns true when anything moved. */
export function flowStep(
  g: Grid, step: number, moveSolid: MoveSolid = (a, b) => moveSolidOnGrid(g, a, b), seen = new Uint8Array(g.mat.length),
  dropSolid: (i: number) => void = (i) => g.clear(i % g.cols, Math.floor(i / g.cols)),
): boolean {
  const { cols, rows } = g;
  let moved = false;
  const free = (cx: number, cy: number) => g.mat[cy * cols + cx] === Mat.Empty && g.liq[cy * cols + cx] === Liquid.None;
  for (let cy = 0; cy < rows; cy++) {
    for (let k = 0; k < cols; k++) {
      const cx = (cy + step) & 1 ? cols - 1 - k : k;
      const i = cy * cols + cx;
      if (seen[i]) continue;
      const L = g.liq[i]!;
      if (L !== Liquid.None) {
        if (cy === 0) {
          // the arena's floor is open (a pit): it runs out
          if (g.mat[i] === Mat.Empty) {
            g.liq[i] = Liquid.None;
            moved = true;
          }
          continue;
        }
        if (free(cx, cy - 1)) {
          g.liq[i] = Liquid.None;
          g.liq[i - cols] = L;
          seen[i - cols] = 1;
          moved = true;
          continue;
        }
        const first = (cx + cy + step) & 1 ? 1 : -1;
        const top = cy + 1 >= rows || g.liq[i + cols] === Liquid.None;
        for (const d of [first, -first]) {
          const nx = cx + d;
          if (nx < 0 || nx >= cols) {
            // over the arena's side: gone
            g.liq[i] = Liquid.None;
            moved = true;
            break;
          }
          if (!free(nx, cy)) continue;
          if (free(nx, cy - 1)) {
            g.liq[i] = Liquid.None;
            g.liq[i + d] = L;
            seen[i + d] = 1;
            moved = true;
            break;
          }
          // levelling: a cell on top runs along the surface (over liquid, under nothing) to a lower free cell
          if (!top) continue;
          let to = -1;
          for (let k = 2; k <= LEVEL_REACH; k++) {
            const x = cx + d * k;
            if (x < 0 || x >= cols || !free(x, cy) || g.liq[(cy - 1) * cols + x - d] === Liquid.None) break;
            if (free(x, cy - 1)) {
              to = (cy - 1) * cols + x;
              break;
            }
            if (g.liq[(cy - 1) * cols + x] === Liquid.None) break;
          }
          if (to >= 0) {
            g.liq[i] = Liquid.None;
            g.liq[to] = L;
            seen[to] = 1;
            moved = true;
            break;
          }
        }
        continue;
      }
      if (g.mat[i] === Mat.Sand && cy === 0) {
        // sand that fell down a pit to the arena's floor: out
        dropSolid(i);
        moved = true;
        continue;
      }
      if (g.mat[i] === Mat.Sand && cy > 0 && g.mat[i - cols] === Mat.Empty) {
        moveSolid(i, i - cols);
        seen[i - cols] = 1;
        if (g.liq[i] !== Liquid.None) seen[i] = 1;
        moved = true;
      }
    }
  }
  return moved;
}

/** Settle a grid to rest (the generator, before its level is validated); at most `maxSteps` steps. */
export function settleGrid(g: Grid, maxSteps = 400): number {
  const seen = new Uint8Array(g.mat.length);
  for (let s = 0; s < maxSteps; s++) {
    seen.fill(0);
    if (!flowStep(g, s, undefined, seen)) return s;
  }
  return maxSteps;
}
