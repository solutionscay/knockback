import { Container, Graphics, Sprite } from "pixi.js";
import type { Sim } from "../sim/sim";
import type { Entity } from "../sim/sim-types";
import type { Fx } from "./fx";
import type { Theme } from "../sim/level-config";
import { PROP_HALF } from "../sim/level-config";
import { drawProp as drawPropShape, pickupFrame, propFrame } from "./props";
import type { XformAt } from "./scene";
import { drawPiece, pieceSig } from "./terrainview";
import { setWorldFrame } from "./world-art";
import { levelReady, setLevelSprite } from "./level-art";

interface PropView {
  /** the view: the code frame (g) under the plush sprite (s); a loose terrain chunk's cells are sprites in `cells` */
  root: Container;
  g: Graphics;
  cells?: Container;
  s: Sprite;
  /** the sprite again, added on top: a lit fuse's white blink (a tint can only darken) */
  hi: Sprite;
  e: Entity;
  /** a new grenade is drawn from the thrower's drawn hand, easing onto its sim path (view only) */
  off?: { x: number; y: number };
  hp: number;
  sig: string;
  every: boolean;
  flash: number;
  squash: number;
  /** #111: the theme's atlas was loaded when the sprite was last set (its prop skins replace the world sprites) */
  skin: boolean;
}

const blink = { blink: false };

export class PropViews {
  /** #116: the liquids, for things floating at a surface to bob with it */
  liquid: { bob(x: number, y: number, hh: number): { dy: number; rot: number } } | null = null;
  readonly layer = new Container();
  readonly marks = new Graphics();
  /** the level's theme (loose chunks wear its terrain art) */
  theme: Theme = "warehouse";
  private props = new Map<number, PropView>();
  /** where a fighter's drawn hand or muzzle is (the plush bot), or null */
  muzzleOf: ((fighter: number) => { x: number; y: number } | null) | null = null;
  private dropMarks = new Map<number, number>();

  clear() {
    for (const v of this.props.values()) v.root.destroy({ children: true });
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
        v.root.destroy({ children: true });
        this.props.delete(id);
      }
    }
    for (const e of sim.entities.values()) {
      if (e.kind === "fighter" || this.props.has(e.id)) continue;
      const root = new Container();
      const g = new Graphics();
      const s = new Sprite();
      const hi = new Sprite();
      s.visible = hi.visible = false;
      hi.blendMode = "add";
      root.addChild(g, s, hi);
      this.layer.addChild(root);
      const v: PropView = { root, g, s, hi, e, hp: -1, sig: "", every: true, flash: 0, squash: 0, skin: false };
      if (e.kind === "grenade" && e.owner !== undefined && sim.tick - e.born < 3) {
        const m = this.muzzleOf?.(e.owner);
        const q = e.body.translation();
        if (m) v.off = { x: m.x - q.x, y: m.y - q.y };
      }
      this.props.set(e.id, v);
    }
  }

  private drawProp(v: PropView, time: number) {
    const e = v.e;
    if (e.kind === "chunk") {
      const sig = pieceSig(this.theme, e.cells!);
      if (sig !== v.sig) {
        v.sig = sig;
        if (!v.cells) v.cells = v.root.addChild(new Container());
        drawPiece(v.cells, this.theme, e.cells!);
      }
      return;
    }
    const skin = levelReady(this.theme);
    if (!v.every && v.hp === e.hp && v.skin === skin) return;
    v.skin = skin;
    if (v.hp >= 0 && v.hp !== e.hp) v.flash = 0.1;
    v.hp = e.hp;
    v.every = drawPropShape(v.g, e, time, blink);
    if (e.kind === "item") setWorldFrame(v.s, pickupFrame(e.itemType ?? "health"));
    const f = propFrame(e);
    if (f) {
      // the model is the default size: a ruleset that resizes a prop stretches its sprite to the body
      // (a grenade's body is a 0.22 m circle: the toy, its lever and pin fill about that)
      const half = e.kind === "grenade" ? [0.22 / 1.2, 0.22 / 1.2] : PROP_HALF[e.kind as keyof typeof PROP_HALF];
      // #111: a theme may skin a prop (the beach's driftwood crate, buoy, log bundle): its atlas first, then the world's
      const kx = e.hw / half[0]!, ky = e.hh / half[1]!;
      const set = (s: Sprite) => setLevelSprite(s, this.theme, `p-${f}`, kx, ky) || setWorldFrame(s, f, kx, ky);
      set(v.s);
      v.hi.visible = blink.blink && set(v.hi);
      v.hi.tint = e.kind === "grenade" ? 0xff3030 : 0xffffff;
    }
  }

  render(fx: Fx, projG: Graphics, time: number, dt: number, alpha: number, xform: XformAt) {
    for (const v of this.props.values()) {
      const e = v.e;
      const p = xform(e, alpha);
      this.drawProp(v, time);
      v.root.position.set(p.x, -p.y);
      if (v.off) {
        v.off.x *= Math.exp(-dt * 14);
        v.off.y *= Math.exp(-dt * 14);
        v.root.position.set(p.x + v.off.x, -(p.y + v.off.y));
      }
      v.root.rotation = -p.a;
      if (this.liquid && e.kind !== "item") {
        // #116: at a liquid's surface it rides the waves (visual only)
        const b = this.liquid.bob(p.x, p.y, e.hh);
        v.root.position.y -= b.dy;
        v.root.rotation -= b.rot;
      }
      if (e.kind === "barrel" && e.fuse !== undefined) v.root.scale.set(1 + 0.12 * Math.sin(time * 60));
      if (e.kind === "item") {
        // a pickup stays upright (its badge is round) and bobs gently, so it stands apart from crates and barrels
        v.root.rotation = 0;
        v.root.position.y += Math.sin(time * 3.2 + e.id) * 0.07;
      }
      if (e.kind === "pad") {
        v.squash = Math.max(0, v.squash - dt * 5);
        v.root.scale.set(1 + v.squash * 0.2, 1 - v.squash * 0.45);
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
        v.root.tint = 0xffaaaa;
      } else v.root.tint = 0xffffff;
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
