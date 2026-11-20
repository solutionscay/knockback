/**
 * The bot's Pen on a Pixi 8 Graphics (#18): shape calls pass through; SVG
 * paths are parsed once and cached. Pixi transforms a shape's points but not
 * its stroke width, so the pen scales stroke widths itself (the bot only
 * scales uniformly).
 */
import { Graphics, GraphicsPath } from "pixi.js";
import type { Pen } from "./bot";

const paths = new Map<string, GraphicsPath>();

export function pixiPen(g: Graphics): Pen {
  let k = 1;
  const ks: number[] = [];
  return {
    rect: (x, y, w, h) => g.rect(x, y, w, h),
    roundRect: (x, y, w, h, r) => g.roundRect(x, y, w, h, r),
    circle: (x, y, r) => g.circle(x, y, r),
    ellipse: (x, y, rx, ry) => g.ellipse(x, y, rx, ry),
    poly: (p, close) => g.poly(p, close),
    moveTo: (x, y) => g.moveTo(x, y),
    lineTo: (x, y) => g.lineTo(x, y),
    quadraticCurveTo: (cx, cy, x, y) => g.quadraticCurveTo(cx, cy, x, y),
    fill: (s) => g.fill(s),
    stroke: (s) => g.stroke(k === 1 ? s : { ...s, width: s.width * k }),
    svgPath: (d) => {
      let p = paths.get(d);
      if (!p) paths.set(d, (p = new GraphicsPath(d)));
      return g.path(p);
    },
    save: () => {
      ks.push(k);
      return g.save();
    },
    restore: () => {
      k = ks.pop() ?? 1;
      return g.restore();
    },
    translate: (x, y) => g.translateTransform(x, y),
    scale: (x, y) => {
      k *= Math.sqrt(Math.abs(x * (y ?? x)));
      return g.scaleTransform(x, y ?? x);
    },
    rotate: (a) => g.rotateTransform(a),
  };
}
