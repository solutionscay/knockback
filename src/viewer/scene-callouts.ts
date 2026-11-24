import { Container, Graphics, Text } from "pixi.js";
import type { Sim } from "../sim/sim";
import { CALLOUT, type Callout } from "./callouts";
import type { FighterViews } from "./scene-fighters";

export class CalloutViews {
  /** plan thoughts and rule tags over the fighters (#10, #11): set by the game every frame */
  private callouts: Callout[] = [];
  private calloutNow = 0;
  readonly layer = new Container();
  readonly lines = new Graphics();
  private calloutViews = new Map<string, { g: Graphics; t: Text; t2: Text | null }>();

  clear() {
    for (const v of this.calloutViews.values()) {
      v.g.destroy();
      v.t.destroy();
      v.t2?.destroy();
    }
    this.calloutViews.clear();
    this.callouts = [];
  }

  setCallouts(list: Callout[], now: number) {
    this.callouts = list;
    this.calloutNow = now;
  }

  /**
   * Callout bubbles above the fighters: dotted outline = a thought, solid in the fighter's color = a rule tag. `top`:
   * where the page's fight HUD (the plan chips) ends, in screen px; a bubble stays below it (#132: under the chips, two
   * bubbles pushed to the top edge printed over each other).
   */
  render(sim: Sim, fighters: FighterViews, W: number, ui: number, top = 0) {
    const keep = new Set<string>();
    const lines = this.lines;
    lines.clear();
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const c of this.callouts) {
      const f = sim.fighters[c.fighter];
      if (!f || f.removed) continue;
      const key = `${c.kind}:${c.fighter}:${c.shownAt}`;
      keep.add(key);
      let v = this.calloutViews.get(key);
      if (!v) {
        const style = (size: number, fill: number, italic = false) => ({
          fontFamily: "Rubik, 'Arial Black', system-ui, sans-serif",
          fontWeight: (italic ? "600" : "800") as "600" | "800",
          fontStyle: (italic ? "italic" : "normal") as "italic" | "normal",
          fontSize: size,
          fill,
        });
        const t = new Text({ text: c.text, style: style(30, c.kind === "rule" ? f.color : 0xffffff) });
        const t2 = c.line ? new Text({ text: `“${c.line.length > 60 ? `${c.line.slice(0, 59)}…` : c.line}”`, style: style(22, 0xd7dbe6, true) }) : null;
        const g = new Graphics();
        this.layer.addChild(g, t);
        if (t2) this.layer.addChild(t2);
        t.anchor.set(0.5, 0);
        t2?.anchor.set(0.5, 0);
        v = { g, t, t2 };
        this.calloutViews.set(key, v);
      }
      const age = this.calloutNow - (c.shownAt ?? this.calloutNow);
      const life = c.kind === "thought" ? CALLOUT.thoughtSeconds : CALLOUT.ruleSeconds;
      const alpha = Math.min(1, age / 0.15, (life - age) / 0.3);
      const k = ui * (age < 0.12 ? 0.85 + age * 1.25 : 1);
      v.t.scale.set(k);
      v.t2?.scale.set(k);
      const w = Math.max(v.t.width, v.t2?.width ?? 0) + 28 * ui;
      const h = v.t.height + (v.t2 ? v.t2.height + 4 * ui : 0) + 16 * ui;
      const gp = fighters.get(f.id).root.getGlobalPosition();
      let x = Math.min(W - w / 2 - 12 * ui, Math.max(w / 2 + 12 * ui, gp.x));
      const minY = Math.max(12 * ui, top + 8 * ui);
      let y = Math.max(minY, gp.y - 120 * ui - h);
      // two callouts never overlap: stack the second one above the first, or below it when there is no room above
      for (let pass = 0; pass <= placed.length; pass++) {
        const p = placed.find((p) => x + w / 2 > p.x0 && x - w / 2 < p.x1 && y + h > p.y0 && y < p.y1);
        if (!p) break;
        const up = p.y0 - h - 8 * ui;
        y = up >= minY ? up : p.y1 + 8 * ui;
      }
      placed.push({ x0: x - w / 2, x1: x + w / 2, y0: y, y1: y + h });
      const g = v.g;
      g.clear();
      g.roundRect(x - w / 2, y, w, h, 12 * ui).fill({ color: 0x0b0d14, alpha: 0.82 });
      if (c.kind === "rule") g.roundRect(x - w / 2, y, w, h, 12 * ui).stroke({ width: 3 * ui, color: f.color });
      else {
        // dotted outline: a thought, not a spoken line
        const dot = 7 * ui;
        for (let px = x - w / 2 + 10 * ui; px < x + w / 2 - 10 * ui; px += dot * 2) {
          g.circle(px, y, 1.8 * ui).fill(0xffffff);
          g.circle(px, y + h, 1.8 * ui).fill(0xffffff);
        }
        for (let py = y + 10 * ui; py < y + h - 8 * ui; py += dot * 2) {
          g.circle(x - w / 2, py, 1.8 * ui).fill(0xffffff);
          g.circle(x + w / 2, py, 1.8 * ui).fill(0xffffff);
        }
        // thought dots down to the fighter
        g.circle(x, y + h + 10 * ui, 4 * ui).fill({ color: 0xffffff, alpha: 0.85 });
        g.circle(x, y + h + 22 * ui, 2.5 * ui).fill({ color: 0xffffff, alpha: 0.7 });
      }
      g.alpha = alpha;
      v.t.alpha = alpha;
      v.t.position.set(x, y + 8 * ui);
      if (v.t2) {
        v.t2.alpha = alpha;
        v.t2.position.set(x, y + 8 * ui + v.t.height + 4 * ui);
      }
      // rule tag: a thin line to the subject for the first second
      if (c.kind === "rule" && c.subject !== undefined && c.subject >= 0 && age < CALLOUT.ruleLineSeconds) {
        const sf = sim.fighters[c.subject];
        if (sf && !sf.removed) {
          const sp = fighters.get(sf.id).root.getGlobalPosition();
          lines.moveTo(x, y + h).lineTo(sp.x, sp.y - 40 * ui).stroke({ width: 3 * ui, color: f.color, alpha: alpha * (1 - age / CALLOUT.ruleLineSeconds) * 0.9 });
          lines.circle(sp.x, sp.y - 40 * ui, 6 * ui).stroke({ width: 3 * ui, color: f.color, alpha: alpha * 0.9 });
        }
      }
    }
    for (const [k, v] of this.calloutViews) {
      if (keep.has(k)) continue;
      v.g.destroy();
      v.t.destroy();
      v.t2?.destroy();
      this.calloutViews.delete(k);
    }
  }

}
