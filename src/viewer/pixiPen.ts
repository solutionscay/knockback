/**
 * The bot's Pen on a Pixi 8 Graphics (#18): shape calls pass through; SVG
 * paths are parsed once and cached.
 *
 * Two differences from canvas/SVG are handled here: Pixi's translateTransform
 * and scaleTransform apply in the parent's space (the pen keeps its own
 * matrix, composed in local space as in SVG, and sets it whole), and Pixi
 * transforms a shape's points but not its stroke width (the pen scales the
 * width; the bot only scales uniformly).
 */
import { Graphics, GraphicsPath } from "pixi.js";
import type { Pen } from "./bot";

type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const paths = new Map<string, GraphicsPath>();

export function pixiPen(g: Graphics): Pen {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  const set = (n: Mat) => {
    m = n;
    return g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  };
  const k = () => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  set(m);
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
    stroke: (s) => g.stroke({ ...s, width: s.width * k() }),
    svgPath: (d) => {
      let p = paths.get(d);
      if (!p) paths.set(d, (p = new GraphicsPath(d)));
      return g.path(p);
    },
    save: () => {
      stack.push(m);
      return g;
    },
    restore: () => set(stack.pop() ?? [1, 0, 0, 1, 0, 0]),
    translate: (x, y) => set(mul(m, [1, 0, 0, 1, x, y])),
    scale: (x, y) => set(mul(m, [x, 0, 0, y ?? x, 0, 0])),
    rotate: (a) => set(mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0])),
  };
}
