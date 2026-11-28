/**
 * The world-art lab page (scripts/world-lab.ts, #87): every world sprite at game size, on the arena's dark sky, at
 * ?s=45 screen pixels per meter (the View-all median at 1080p) and at twice that. A plush fighter stands at the start
 * of each row for scale. Pickups sit on their code badge (the game's frame), props show each damage state. View only.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import { idlePose, labCanvas } from "./art-lab";
import { WORLD_LAYOUT } from "./art/world/layout";
import { initPlushArt, loadPlushSheets, plushFormat, plushNeeds, PlushBot } from "./plush-bot";
import { drawPickup, pickupFrame } from "./props";
import { initWorldArt, setWorldFrame } from "./world-art";

const q = new URLSearchParams(location.search);
const S0 = Number(q.get("s") ?? "45");
await initPlushArt();
await initWorldArt();
await loadPlushSheets(plushNeeds("balanced", "none"));
const { app, label } = await labCanvas(2400, 1500);

function fighter(S: number, x: number, ground: number) {
  {
    const pl = new PlushBot(0x3fa7ff, "none", "balanced");
    pl.update(idlePose);
    const c = new Container();
    c.addChild(pl.back.c, pl.body.c, pl.feet, pl.fist.c, pl.sleeve.c, pl.arm.c);
    c.scale.set(S);
    c.position.set(x, ground);
    app.stage.addChild(c);
  }
}

const names = Object.keys(WORLD_LAYOUT.frames);
const by = (pre: (n: string) => boolean) => names.filter(pre).sort();
const grp = (n: string) => (WORLD_LAYOUT.frames as unknown as Record<string, { g: string }>)[n]!.g;
const rows: [string, string[]][] = [
  ["weapon pickups", by((n) => n.startsWith("w-"))],
  ["power-ups", by((n) => n.startsWith("p-"))],
  ["props (intact, damaged, nearly broken)", by((n) => grp(n) === "props")],
  ["projectiles", by((n) => grp(n) === "projectiles")],
];

let y = 30;
for (const S of [S0, S0 * 2]) {
  label(`${S} px per meter (${plushFormat()})`, 16, y - 22, 15);
  for (const [title, list] of rows) {
    if (!list.length) continue;
    const rowH = S * 2.1 + 16;
    label(title, 16, y + 2);
    const ground = y + rowH;
    fighter(S, 40, ground);
    let x = 60 + S * 1.4;
    for (const n of list) {
      const c = new Container();
      if (n.startsWith("w-") || n.startsWith("p-")) {
        const g = new Graphics();
        drawPickup(g, n.slice(2), 0.3);
        c.addChild(g);
        const s = new Sprite();
        setWorldFrame(s, pickupFrame(n.slice(2)));
        c.addChild(s);
      } else {
        const s = new Sprite();
        setWorldFrame(s, n);
        c.addChild(s);
      }
      const b = c.getLocalBounds();
      c.scale.set(S);
      c.position.set(x - b.x * S, ground - S * 0.8);
      app.stage.addChild(c);
      x += b.width * S + S * 0.35;
      if (x > 2300) break;
    }
    y += rowH + 18;
  }
  y += 20;
}
(window as unknown as { __ready: boolean }).__ready = true;
