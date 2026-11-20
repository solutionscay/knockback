/**
 * The chains that hang the floating platforms (#feet-and-chains): one tiling
 * sprite per anchor, from the anchor up to above the top of the view, sized
 * again every frame. Fighters fly far above the platforms (45 m in a live
 * match), and View all zooms out to show them, so a chain of fixed length
 * would end in mid-air. View only: reads the terrain grid.
 */
import { Container, Texture, TilingSprite } from "pixi.js";
import { CELL, F_ANCHOR, type Grid } from "../sim/grid";
import type { CameraFrame } from "./scene-camera";

const LINK_W = 0.14; // meters
const LINK_H = 0.32; // meters per link
const TEX_W = 28;
const TEX_H = 64;

let linkTexture: Texture | null = null;
/** One chain link, drawn once on a canvas (the same look as the old per-link outlines). */
function chainTexture(): Texture {
  if (linkTexture) return linkTexture;
  const cv = document.createElement("canvas");
  cv.width = TEX_W;
  cv.height = TEX_H;
  const c = cv.getContext("2d")!;
  const k = TEX_W / LINK_W; // px per meter
  c.strokeStyle = "rgba(138,138,150,0.8)";
  c.lineWidth = 0.035 * k;
  const w = 0.1 * k, h = 0.22 * k, r = 0.05 * k, x = (TEX_W - w) / 2, y = 0.03 * k;
  c.beginPath();
  c.roundRect(x, y, w, h, r);
  c.stroke();
  linkTexture = Texture.from(cv);
  return linkTexture;
}

export class ChainView {
  readonly container = new Container();
  private chains: { cx: number; cy: number; x: number; y: number; sprite: TilingSprite }[] = [];

  constructor(private readonly grid: Grid) {
    const tex = chainTexture();
    for (let cy = 0; cy < grid.rows; cy++)
      for (let cx = 0; cx < grid.cols; cx++) {
        if (!(grid.flags[grid.idx(cx, cy)]! & F_ANCHOR)) continue;
        const sprite = new TilingSprite({ texture: tex, width: LINK_W, height: 1 });
        sprite.tileScale.set(LINK_W / TEX_W, LINK_H / TEX_H);
        const x = grid.wx(cx) + CELL / 2, y = grid.wy(cy) + CELL; // the anchor cell's top, world meters (y up)
        sprite.x = x - LINK_W / 2;
        this.container.addChild(sprite);
        this.chains.push({ cx, cy, x, y, sprite });
      }
  }

  /** The highest world y the view can show this frame, with room for the shake (offset and a small rotation). */
  static viewTop(frame: CameraFrame, W: number, H: number): number {
    const halfDiag = Math.hypot(W, H) / 2 / frame.s;
    return frame.cy + Math.abs(frame.shy) + halfDiag + 2;
  }

  update(frame: CameraFrame, W: number, H: number) {
    const top = ChainView.viewTop(frame, W, H);
    for (const c of this.chains) {
      // the chain goes when its anchor cell is destroyed
      c.sprite.visible = this.grid.solid(c.cx, c.cy) && top > c.y;
      if (!c.sprite.visible) continue;
      // screen y grows downward: the sprite runs from -top down to the anchor (-y); links stay put as it grows
      const len = Math.ceil((top - c.y) / LINK_H) * LINK_H;
      c.sprite.y = -(c.y + len);
      c.sprite.height = len;
      c.sprite.tilePosition.y = 0;
    }
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
