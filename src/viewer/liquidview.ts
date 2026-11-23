/**
 * Liquids (#94): the grid's liquid layer (`Grid.liq`) as plush sprites from the nature atlas (level-art.ts), drawn in
 * front of the fighters, see-through where the liquid is (water most), so a fighter in a pool shows through it.
 *
 * A liquid cell with no liquid above it is a surface cell: its tile shows the surface in the top part of the cell and
 * loops over 8 frames (each column a frame apart, so the wave travels). Every other liquid cell is a body tile. Only
 * chunks whose liquid changed are rebuilt; the surfaces' frames step every frame.
 */
import { Container, type Sprite } from "pixi.js";
import { CELL, Liquid, LIQUID_NAMES, type Grid } from "../sim/grid";
import type { Theme } from "../sim/themes";
import { levelFrame, levelReady } from "./level-art";
import { Pool } from "./terrainview";

const CH = 16;
const FRAMES = 8;
/** surface loop frames per second */
const FPS = 8;

interface Surf { s: Sprite; name: string; phase: number }

export class LiquidView {
  readonly container = new Container();
  private readonly chunks: Pool[] = [];
  private readonly surfs: Surf[][] = [];
  private readonly sig: Uint8Array;
  private readonly cols: number;
  private ready = false;
  private frame = -1;

  constructor(
    private readonly grid: Grid,
    private readonly theme: Theme,
  ) {
    this.cols = Math.ceil(grid.cols / CH);
    const rows = Math.ceil(grid.rows / CH);
    this.sig = new Uint8Array(grid.cols * grid.rows);
    for (let k = 0; k < this.cols * rows; k++) {
      const c = new Container();
      this.container.addChild(c);
      this.chunks.push(new Pool(c));
      this.surfs.push([]);
    }
  }

  /** Rebuild changed chunks, then step the surfaces' loop to `time` (seconds). */
  update(time: number) {
    if (!this.ready) {
      if (!levelReady(this.theme)) return;
      this.ready = true;
      this.sig.fill(255);
    }
    const g = this.grid;
    const dirty = new Set<number>();
    for (let i = 0; i < g.liq.length; i++) {
      const L = g.liq[i]!;
      const up = i + g.cols < g.liq.length ? g.liq[i + g.cols]! : 0;
      const s = L === Liquid.None ? 0 : L * 2 + (up === L ? 1 : 0);
      if (s === this.sig[i]) continue;
      this.sig[i] = s;
      const cx = i % g.cols;
      const cy = (i - cx) / g.cols;
      dirty.add(Math.floor(cy / CH) * this.cols + Math.floor(cx / CH));
    }
    for (const k of dirty) this.drawChunk(k);
    const f = Math.floor(time * FPS);
    if (f === this.frame && !dirty.size) return;
    this.frame = f;
    for (const list of this.surfs) {
      for (const u of list) {
        const fr = levelFrame(this.theme, `${u.name}-${(f + u.phase) % FRAMES}`);
        if (fr) u.s.texture = fr.tex;
      }
    }
  }

  private drawChunk(k: number) {
    const g = this.grid;
    const p = this.chunks[k]!;
    const list: Surf[] = [];
    p.begin();
    const kx = k % this.cols;
    const ky = Math.floor(k / this.cols);
    for (let cy = ky * CH; cy < Math.min(g.rows, ky * CH + CH); cy++) {
      for (let cx = kx * CH; cx < Math.min(g.cols, kx * CH + CH); cx++) {
        const L = g.liq[g.idx(cx, cy)]!;
        if (!L) continue;
        const name = LIQUID_NAMES[L]!;
        const top = -(g.wy(cy) + CELL);
        if (g.liqAt(cx, cy + 1) === L) {
          p.put(this.theme, `q-${name}-${(cx * 7 + cy * 3) % 5 < 2 ? 1 : 0}`, g.wx(cx), top);
        } else {
          const phase = ((cx % FRAMES) + FRAMES) % FRAMES;
          const s = p.put(this.theme, `s-${name}-${phase}`, g.wx(cx), top);
          if (s) list.push({ s, name: `s-${name}`, phase });
        }
      }
    }
    p.end();
    this.surfs[k] = list;
  }
}
