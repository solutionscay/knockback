import { Container, Graphics } from "pixi.js";
import type { Entity, Sim } from "../sim/sim";
import type { Fx } from "./fx";
import type { Palette } from "./palette";
import { drawProp as drawPropShape } from "./props";
import type { XformAt } from "./scene";
import { drawPiece, pieceSig } from "./terrainview";

interface PropView {
  g: Graphics;
  e: Entity;
  hp: number;
  sig: string;
  every: boolean;
  flash: number;
  squash: number;
}

export class PropViews {
  readonly layer = new Container();
  readonly marks = new Graphics();
  private props = new Map<number, PropView>();
  private dropMarks = new Map<number, number>();

  clear() {
    for (const v of this.props.values()) v.g.destroy();
    this.props.clear();
  }

  clearDrops() {
    this.dropMarks.clear();
  }

  markDrop(id: number, color: number) {
    this.dropMarks.set(id, color);
  }

  bounce(x: number) {
    const pad = [...this.props.values()].find((v) => v.e.kind === "pad" && Math.abs(v.e.body.translation().x - x) < 0.1);
    if (pad) pad.squash = 1;
  }

  sync(sim: Sim) {
    for (const [id, v] of this.props) {
      if (v.e.dead) {
        v.g.destroy();
        this.props.delete(id);
      }
    }
    for (const e of sim.entities.values()) {
      if (e.kind === "fighter" || this.props.has(e.id)) continue;
      const g = new Graphics();
      this.layer.addChild(g);
      const v: PropView = { g, e, hp: -1, sig: "", every: true, flash: 0, squash: 0 };
      this.props.set(e.id, v);
    }
  }

  private drawProp(v: PropView, pal: Palette, time: number) {
    const e = v.e;
    if (e.kind === "chunk") {
      const sig = pieceSig(e.cells!);
      if (sig !== v.sig) {
        v.sig = sig;
        drawPiece(v.g, pal, e.cells!);
      }
      return;
    }
    if (!v.every && v.hp === e.hp) return;
    if (v.hp >= 0 && v.hp !== e.hp) v.flash = 0.1;
    v.hp = e.hp;
    v.every = drawPropShape(v.g, e, time);
  }

  render(pal: Palette, fx: Fx, projG: Graphics, time: number, dt: number, alpha: number, xform: XformAt) {
    for (const v of this.props.values()) {
      const e = v.e;
      const p = xform(e, alpha);
      this.drawProp(v, pal, time);
      v.g.position.set(p.x, -p.y);
      v.g.rotation = -p.a;
      if (e.kind === "barrel" && e.fuse !== undefined) v.g.scale.set(1 + 0.12 * Math.sin(time * 60));
      if (e.kind === "item") {
        // a pickup stays upright (its badge is round) and bobs gently, so it stands apart from crates and barrels
        v.g.rotation = 0;
        v.g.position.y += Math.sin(time * 3.2 + e.id) * 0.07;
      }
      if (e.kind === "pad") {
        v.squash = Math.max(0, v.squash - dt * 5);
        v.g.scale.set(1 + v.squash * 0.2, 1 - v.squash * 0.45);
      }
      if (e.kind === "gas" && e.thrust !== undefined && Math.random() < 0.9) {
        // exhaust from the bottom of the canister
        const ux = Math.sin(-p.a);
        const uy = -Math.cos(-p.a);
        const bx = p.x + ux * e.hh;
        const by = p.y + uy * e.hh;
        fx.add({ x: bx, y: by, vx: ux * 6 + (Math.random() - 0.5), vy: uy * 6 + (Math.random() - 0.5), life: 0.25, size: 0.2, size1: 0.02, color: Math.random() < 0.5 ? 0xffd36a : 0xff7a2f });
        fx.add({ x: bx, y: by, vx: ux * 2, vy: uy * 2, kind: "smoke", life: 0.8, size: 0.15, size1: 0.6, color: 0x9a97a2, alpha: 0.5, drag: 2, back: true });
      }
      if (e.kind === "tnt" && e.fuse !== undefined && Math.random() < 0.6) {
        fx.add({ x: p.x + 0.05, y: p.y + e.hh + 0.1 + (0.5 * e.fuse) / 150, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 3, life: 0.2, size: 0.05, color: 0xffd23a, kind: "spark", gravity: 6 });
      }
      if (e.kind === "weight" && e.joint && e.ax !== undefined) {
        // the rope, from the anchor to the top of the weight
        const tx2 = p.x - Math.sin(p.a) * e.hh * -1;
        const ty2 = p.y + Math.cos(p.a) * e.hh;
        projG.moveTo(e.ax, -e.ay!).lineTo(tx2, -ty2).stroke({ width: 0.06, color: 0xb8a888 });
      }
      if (v.flash > 0) {
        v.flash -= dt;
        v.g.tint = 0xffaaaa;
      } else v.g.tint = 0xffffff;
    }
  }

  drawDropMarks(sim: Sim, time: number, alpha: number, xform: XformAt) {
    const g = this.marks;
    g.clear();
    for (const [id, color] of this.dropMarks) {
      const e = sim.entities.get(id);
      if (!e) {
        this.dropMarks.delete(id);
        continue;
      }
      const p = xform(e, alpha);
      if (p.y < 2.2 || e.body.linvel().y > -0.5) {
        if (sim.tick > 0 && Math.abs(e.body.linvel().y) < 0.5) this.dropMarks.delete(id);
        continue;
      }
      const ground = sim.nav.surfaceAt(p.x, p.y)?.y ?? 0;
      const a = 0.18 + 0.08 * Math.sin(time * 12);
      g.rect(p.x - 0.4, -p.y, 0.8, p.y - ground).fill({ color, alpha: a });
      g.ellipse(p.x, -ground, 0.9, 0.18).fill({ color, alpha: 0.5 });
    }
  }

}
