/**
 * The chains that hang the floating platforms (#feet-and-chains, #34): tiling
 * sprites from each anchor up to above the top of the view, sized again every
 * frame. Fighters fly far above the platforms (45 m in a live match), and View
 * all zooms out to show them, so a chain of fixed length would end in mid-air.
 *
 * Breakable chains (#34, sim-chains.ts):
 *   intact, static platform   one straight chain from the anchor bolt to the top
 *   holding a swinging piece  anchor -> pivot (slanted, follows the swing), a ring
 *                             at the pivot, then straight up to the top
 *   broken                    the upper part hangs from the top down to where it
 *                             snapped, recoils and sways; a short stub stays on
 *                             the platform's anchor cell
 * View only: reads the Sim, never writes it.
 */
import { Container, Graphics, TilingSprite } from "pixi.js";
import { CELL } from "../sim/grid";
import type { Sim } from "../sim/sim";
import type { Chain } from "../sim/sim-chains";
import { chainAttach } from "../sim/sim-chains";
import type { Entity } from "../sim/sim-types";
import type { PieceCell } from "../sim/terrain";
import type { CameraFrame } from "./scene-camera";
import type { XformAt } from "./scene";
import { worldTile } from "./world-art";

/** meters per link (the plush chain tile is one link tall) */
const LINK_H = 0.32;
/** the swaying end of a broken chain (meters) */
const DANGLE = 1.6;
/** the stub left on the platform (meters) */
const STUB = 0.55;

interface ChainSprites {
  ch: Chain;
  /** the long part: up to the top of the view */
  up: TilingSprite;
  /** anchor -> pivot while swinging; the swaying end once broken */
  low: TilingSprite;
  /** what stays on the platform once broken */
  stub: TilingSprite;
}

/** Where a pose puts a piece cell's local point (world meters). */
function onPiece(p: { x: number; y: number; a: number }, lx: number, ly: number): { x: number; y: number } {
  const co = Math.cos(p.a), si = Math.sin(p.a);
  return { x: p.x + lx * co - ly * si, y: p.y + lx * si + ly * co };
}

export class ChainView {
  readonly container = new Container();
  /** bolts and pivot rings, drawn in front of the platforms (scene.ts layers it above the props) */
  readonly front = new Graphics();
  private chains: ChainSprites[] = [];

  constructor(private readonly sim: Sim) {
    // one plush link per tile (#87, tools/art/plush_world.py): 0.14 m wide, a link every 0.32 m
    const tile = worldTile("chain");
    const sprite = () => {
      const s = new TilingSprite({ texture: tile.texture, width: tile.w, height: 1 });
      s.tileScale.set(tile.w / tile.texture.width, tile.h / tile.texture.height);
      s.alpha = 0.9;
      s.anchor.set(0.5, 0);
      this.container.addChild(s);
      return s;
    };
    for (const ch of sim.chains) this.chains.push({ ch, up: sprite(), low: sprite(), stub: sprite() });
  }

  /** The highest world y the view can show this frame, with room for the shake (offset and a small rotation). */
  static viewTop(frame: CameraFrame, W: number, H: number): number {
    const halfDiag = Math.hypot(W, H) / 2 / frame.s;
    return frame.cy + Math.abs(frame.shy) + halfDiag + 2;
  }

  /**
   * Lay a sprite from world point (x0, y0) toward (x1, y1). The links start at
   * (x0, y0), so the end that stays put should be the first point.
   */
  static lay(s: TilingSprite, x0: number, y0: number, x1: number, y1: number) {
    const dx = x1 - x0;
    const dy = -(y1 - y0); // screen y grows downward
    const len = Math.hypot(dx, dy);
    s.visible = len > 0.01;
    if (!s.visible) return;
    s.position.set(x0, -y0);
    s.rotation = Math.atan2(-dx, dy); // the sprite's +y axis along the segment
    s.height = len;
    s.tilePosition.y = 0;
  }

  update(frame: CameraFrame, W: number, H: number, alpha = 1, xform?: XformAt) {
    const sim = this.sim;
    const top = ChainView.viewTop(frame, W, H);
    const g = this.front;
    g.clear();
    const pose = (e: Entity) => (xform ? xform(e, alpha) : { ...e.body.translation(), a: e.body.rotation() });
    const now = sim.tick;
    for (const c of this.chains) {
      const ch = c.ch;
      c.low.visible = false;
      c.stub.visible = false;
      if (!ch.broken && ch.piece < 0) {
        // static platform: one straight chain from the anchor (its bolt is part of the terrain drawing)
        const a = chainAttach(sim, ch);
        if (top > a.y) ChainView.lay(c.up, a.x, a.y, a.x, Math.ceil((top - a.y) / LINK_H) * LINK_H + a.y);
        else c.up.visible = false;
        continue;
      }
      if (!ch.broken) {
        // holding a swinging piece: anchor -> pivot, a ring, then up
        const e = sim.entities.get(ch.piece);
        const cell = e?.cells?.find((k) => k.chain === ch.id);
        if (!e || !cell) {
          c.up.visible = false;
          continue;
        }
        const p = pose(e);
        const a = onPiece(p, (cell.lx + 0.5) * CELL, (cell.ly + 1) * CELL);
        ChainView.lay(c.low, ch.px, ch.py, a.x, a.y);
        ChainView.lay(c.up, ch.px, ch.py, ch.px, Math.max(ch.py, top));
        const b = onPiece(p, (cell.lx + 0.5) * CELL, (cell.ly + 0.5) * CELL);
        g.circle(b.x, -b.y, 0.09).fill(0x2a2a30).stroke({ width: 0.03, color: 0xb0b0b8 });
        g.circle(ch.px, -ch.py, 0.08).stroke({ width: 0.035, color: 0x8a8a96 });
        continue;
      }
      // broken: the upper part recoils a little, then its end sways and settles
      const t = Math.max(0, now - ch.brokenTick) / 60;
      const endY = ch.breakY + 0.5 * (1 - Math.exp(-t * 9));
      const hinge = endY + DANGLE;
      if (top > hinge) ChainView.lay(c.up, ch.px, hinge, ch.px, Math.max(hinge, top));
      else c.up.visible = false;
      const sway = 0.5 * Math.exp(-t * 0.9) * Math.sin(t * 4.2 + ch.id);
      ChainView.lay(c.low, ch.px, hinge, ch.px + Math.sin(sway) * DANGLE, hinge - Math.cos(sway) * DANGLE);
    }
    // stubs: broken chains' anchor cells, still in the level or on a loose piece
    for (const c of this.chains) {
      const ch = c.ch;
      if (!ch.broken) continue;
      let base: { x: number; y: number } | null = null;
      let a0 = 0;
      if (sim.grid.solid(ch.cx, ch.cy) && ch.piece < 0) base = { x: sim.grid.wx(ch.cx) + CELL / 2, y: sim.grid.wy(ch.cy) + CELL };
      else {
        const found = this.stubCell(ch);
        if (found) {
          const p = pose(found.e);
          base = onPiece(p, (found.cell.lx + 0.5) * CELL, (found.cell.ly + 1) * CELL);
          a0 = p.a;
          const b = onPiece(p, (found.cell.lx + 0.5) * CELL, (found.cell.ly + 0.5) * CELL);
          g.circle(b.x, -b.y, 0.09).fill(0x2a2a30).stroke({ width: 0.03, color: 0xb0b0b8 });
        }
      }
      if (!base) continue;
      // a short limp end, leaning off the piece's up direction
      const lean = a0 + 0.6 * (ch.id % 2 ? 1 : -1);
      ChainView.lay(c.stub, base.x, base.y, base.x - Math.sin(lean) * STUB, base.y + Math.cos(lean) * STUB);
    }
  }

  /** The loose piece cell a broken chain's stub hangs on, if it is still around. */
  private stubCell(ch: Chain): { e: Entity; cell: PieceCell } | null {
    for (const e of this.sim.entities.values()) {
      if (e.kind !== "chunk" || e.dead) continue;
      const cell = e.cells!.find((k) => k.stub === ch.id);
      if (cell) return { e, cell };
    }
    return null;
  }

  destroy() {
    this.container.destroy({ children: true });
    this.front.destroy();
  }
}
