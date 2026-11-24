/**
 * The bot's Pen recorded to SVG (#18): the dialogue portrait and the HUD chips
 * come from the same drawing code as the in-game sprite. Pure: no DOM, no Pixi.
 */
import { hex } from "../html";
import type { FillStyle, Pen, StrokeStyle } from "./bot";

type Mat = [number, number, number, number, number, number];
type Op = ["rect", number, number, number, number] | ["rr", number, number, number, number, number] | ["ell", number, number, number, number] | ["poly", number[], boolean] | ["path", string] | ["M" | "L", number, number] | ["Q", number, number, number, number];
interface Item {
  kind: "fill" | "stroke";
  ops: Op[];
  m: Mat;
  st: { color: number; alpha: number; width?: number; cap?: string; join?: string };
}

const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const f3 = (n: number) => +n.toFixed(3);

export class SvgPen implements Pen {
  private m: Mat = [1, 0, 0, 1, 0, 0];
  private stack: Mat[] = [];
  private pend: Op[] = [];
  private pm: Mat = this.m;
  private painted = false;
  readonly items: Item[] = [];

  private op(o: Op): this {
    if (this.painted) {
      this.pend = [];
      this.painted = false;
    }
    if (!this.pend.length) this.pm = this.m.slice() as Mat;
    this.pend.push(o);
    return this;
  }
  rect(x: number, y: number, w: number, h: number) {
    return this.op(["rect", x, y, w, h]);
  }
  roundRect(x: number, y: number, w: number, h: number, r = 0) {
    return this.op(["rr", x, y, w, h, r]);
  }
  circle(x: number, y: number, r: number) {
    return this.op(["ell", x, y, r, r]);
  }
  ellipse(x: number, y: number, rx: number, ry: number) {
    return this.op(["ell", x, y, rx, ry]);
  }
  poly(p: number[], close = true) {
    return this.op(["poly", p, close]);
  }
  svgPath(d: string) {
    return this.op(["path", d]);
  }
  moveTo(x: number, y: number) {
    return this.op(["M", x, y]);
  }
  lineTo(x: number, y: number) {
    return this.op(["L", x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    return this.op(["Q", cx, cy, x, y]);
  }
  fill(s: FillStyle) {
    const st = typeof s === "number" ? { color: s, alpha: 1 } : { color: s.color, alpha: s.alpha ?? 1 };
    this.items.push({ kind: "fill", ops: this.pend, m: this.pm, st });
    this.painted = true;
    return this;
  }
  stroke(s: StrokeStyle) {
    this.items.push({ kind: "stroke", ops: this.pend, m: this.pm, st: { color: s.color, alpha: s.alpha ?? 1, width: s.width, cap: s.cap ?? "butt", join: s.join ?? "miter" } });
    this.painted = true;
    return this;
  }
  save() {
    this.stack.push(this.m.slice() as Mat);
    return this;
  }
  restore() {
    this.m = this.stack.pop() ?? [1, 0, 0, 1, 0, 0];
    return this;
  }
  translate(x: number, y: number) {
    this.m = mul(this.m, [1, 0, 0, 1, x, y]);
    return this;
  }
  scale(x: number, y = x) {
    this.m = mul(this.m, [x, 0, 0, y, 0, 0]);
    return this;
  }
  rotate(a: number) {
    const c = Math.cos(a), s = Math.sin(a);
    this.m = mul(this.m, [c, s, -s, c, 0, 0]);
    return this;
  }

  /** The recorded drawing as SVG elements (no <svg> wrapper). */
  toSvg(): string {
    return this.items
      .map((it) => {
        const d = it.ops.map(opD).join("");
        const tr = it.m.every((v, i) => v === [1, 0, 0, 1, 0, 0][i]) ? "" : ` transform="matrix(${it.m.map(f3).join(" ")})"`;
        const a = f3(it.st.alpha);
        return it.kind === "fill"
          ? `<path d="${d}"${tr} fill="${hex(it.st.color)}"${a < 1 ? ` fill-opacity="${a}"` : ""}/>`
          : `<path d="${d}"${tr} fill="none" stroke="${hex(it.st.color)}" stroke-width="${f3(it.st.width ?? 1)}" stroke-linecap="${it.st.cap}" stroke-linejoin="${it.st.join}"${a < 1 ? ` stroke-opacity="${a}"` : ""}/>`;
      })
      .join("");
  }
}

function opD(o: Op): string {
  switch (o[0]) {
    case "rect": {
      const [, x, y, w, h] = o;
      return `M${f3(x)} ${f3(y)}h${f3(w)}v${f3(h)}h${f3(-w)}z`;
    }
    case "rr": {
      const [, x, y, w, h] = o;
      const r = Math.max(0, Math.min(o[5], w / 2, h / 2));
      const a = (dx: number, dy: number) => `a${f3(r)} ${f3(r)} 0 0 1 ${f3(dx)} ${f3(dy)}`;
      return `M${f3(x + r)} ${f3(y)}h${f3(w - 2 * r)}${a(r, r)}v${f3(h - 2 * r)}${a(-r, r)}h${f3(-(w - 2 * r))}${a(-r, -r)}v${f3(-(h - 2 * r))}${a(r, -r)}z`;
    }
    case "ell": {
      const [, x, y, rx, ry] = o;
      return `M${f3(x - rx)} ${f3(y)}a${f3(rx)} ${f3(ry)} 0 1 0 ${f3(2 * rx)} 0a${f3(rx)} ${f3(ry)} 0 1 0 ${f3(-2 * rx)} 0z`;
    }
    case "poly": {
      const p = o[1];
      let d = `M${f3(p[0]!)} ${f3(p[1]!)}`;
      for (let i = 2; i < p.length; i += 2) d += `L${f3(p[i]!)} ${f3(p[i + 1]!)}`;
      return d + (o[2] ? "z" : "");
    }
    case "path":
      return o[1];
    case "M":
    case "L":
      return `${o[0]}${f3(o[1])} ${f3(o[2])}`;
    case "Q":
      return `Q${f3(o[1])} ${f3(o[2])} ${f3(o[3])} ${f3(o[4])}`;
  }
}
