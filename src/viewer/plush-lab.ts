/**
 * The plush lab page (scripts/plush-lab.ts). Everything at one camera scale (?s=45 screen pixels
 * per meter, the View-all median at 1080p: the bot about 75 px tall), on the arena's dark sky:
 *   row "moods": each mood (normal, hit, stun, cocky, win, KO) as the code bot and the plush bot;
 *   row "colors": twelve identity hues, plush (facing right, then left: the light stays put) and code;
 *   row "marks": every major mark on the plush head, the code bot's mark above it;
 *   row "moments": jump, flinch, KO, celebrate, launched, run frames; and the weapons.
 * View only.
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import { hsl, lightnessFloor, MAJOR_MARKS, type Identity, type Mark } from "../sim/identity";
import { drawVisor, faceFor, koFace, lodFor, type FaceMood } from "../art/bot";
import { hash } from "../art/hash";
import { pixiPen } from "./pixiPen";
import { initPlushArt, loadPlushSheets, plushFormat, plushMemory, PlushBot, type FeetOffsets, type PlushInput, type SheetName } from "./plush-bot";
import { PLUSH_LAYOUT } from "./art/plush/layout";

const q = new URLSearchParams(location.search);
const S = Number(q.get("s") ?? "45");
const lod = lodFor(S);
await initPlushArt();
await loadPlushSheets(Object.keys(PLUSH_LAYOUT.sheets) as SheetName[]);
const app = new Application();
await app.init({ background: 0x141a2e, width: 2400, height: 1700, antialias: true, resolution: 1, preference: "webgl" });
document.body.appendChild(app.canvas);

const hue = (h: number) => hsl(h, 0.75, Math.min(0.8, lightnessFloor(h, 0.75) + 0.09));
const look = (color: number, mark: Mark = "antenna", name = "Lab", minor: Mark = "none"): Identity => ({ name, shape: "squircle", eyes: "tall", mark, minor, color });

function label(text: string, x: number, y: number, size = 13) {
  const t = new Text({ text, style: { fill: 0xb8c2e0, fontSize: size, fontWeight: "700", fontFamily: "system-ui" } });
  t.position.set(x, y);
  app.stage.addChild(t);
}

/** A plush bot stepped through `steps` updates (each a partial PlushInput over a base pose). */
function plushBot(lk: Identity, mood: FaceMood, steps: Partial<PlushInput>[] = [{}], facing = 1, build = "balanced", feet?: FeetOffsets): Container {
  const root = new Container();
  const pl = new PlushBot(lk.color, lk.mark, build, lk.minor ?? "none");
  const outline = pl.makeSil();
  outline.tint = 0x07080d;
  outline.alpha = 0.8;
  const face = new Graphics();
  drawVisor(pixiPen(face), lk, mood === "ko" ? koFace(1) : faceFor(mood, 0.3, hash(lk.name), lk.eyes, { lookX: 1 }), lod, false);
  let m = null;
  for (const st of steps) m = pl.update({ dt: 1 / 12, alive: true, air: false, stunned: false, vx: 0, vy: 0, weapon: "fist", aim: 0, swingT: 0, recoil: 0, hitT: 0, celebrate: false, facing, ...st });
  if (feet) pl.setFeet(feet);
  face.setFromMatrix(m!);
  root.addChild(outline, pl.back.c, pl.body.c, pl.feet, pl.minor.c, face, pl.mark.c, pl.fist.c, pl.sleeve.c, pl.arm.c);
  if (facing < 0) root.scale.x = -1;
  return root;
}

function put(bot: Container, x: number, y: number) {
  bot.scale.x *= S;
  bot.scale.y *= S;
  bot.position.set(x, y);
  app.stage.addChild(bot);
}

const step = S * 1.5;
let y = 20;
// moods
const mem = plushMemory();
label(`MOODS at 1:1 (s = ${S} px/m)        atlases: ${plushFormat()}, ${mem.sheets.length} sheets, ${(mem.bytes / 1e6).toFixed(1)} MB GPU`, 12, y);
(window as unknown as { __plushMem: unknown }).__plushMem = { format: plushFormat(), ...mem };
y += 20 + S * 1.2;
const moods: [FaceMood, string, Partial<PlushInput>[]][] = [
  ["confident", "normal", [{}]],
  ["hit", "hit", [{ hitT: 0.42 }, { hitT: 0.34 }]],
  ["stun", "stun", [{ stunned: true }]],
  ["cocky", "cocky", [{}]],
  ["win", "win", [{ celebrate: true }, { celebrate: true }]],
  ["ko", "KO", [...Array.from({ length: 14 }, () => ({ alive: false }))]],
];
moods.forEach(([mood, name, steps], i) => {
  const x = 40 + i * step * 2.3;
  const lk = look(hue(210 + i * 25), "antenna", "Mo" + i);
  put(plushBot(lk, mood, steps), x + step * 0.5, y);
  label(name, x - 10, y + S * 1.0, 12);
});
y += S * 1.4;
// colors
label("IDENTITY COLORS: facing right, facing left (mirrored light)", 12, y);
y += 20 + S * 1.2;
for (let i = 0; i < 12; i++) {
  const c = hue(i * 30);
  const lk = look(c, "antenna", "Co" + i);
  const x = 30 + i * step * 0.98;
  put(plushBot(lk, "confident"), x, y);
  put(plushBot(lk, "confident", [{}], -1), x, y + S * 2.3);
}
y += S * 3.6;
// marks
label("MARKS", 12, y);
y += 20 + S * 1.5;
MAJOR_MARKS.forEach((mk, i) => {
  const lk = look(hue((i * 47) % 360), mk, "Mk" + i);
  const x = 30 + i * step * 0.85;
  put(plushBot(lk, "confident"), x, y);
  label(mk, x - 18, y + S * 1.05, 10);
});
y += S * 1.7;
// moments and weapons
label("MOMENTS and WEAPONS (plush)", 12, y);
y += 20 + S * 1.3;
const lk = look(hue(40), "crown", "Mm");
const moments: [string, Partial<PlushInput>[]][] = [
  ["jump", [{}, { air: true, vy: 5 }, { air: true }, { air: true }]],
  ["jump top", [{}, ...Array.from({ length: 9 }, () => ({ air: true }))]],
  ["flinch", [{ hitT: 0.42 }, { hitT: 0.3 }]],
  ["launched", [{ air: true, stunned: true }, { air: true, stunned: true }, { air: true, stunned: true }]],
  ["run", [{ vx: 6 }, { vx: 6 }, { vx: 6 }]],
  ["punch", [{ swingT: 0.2 }, { swingT: 0.2 }, { swingT: 0.2 }]],
  ["KO 0.3 s", [...Array.from({ length: 4 }, () => ({ alive: false }))]],
  ["celebrate", [{ celebrate: true }, { celebrate: true }, { celebrate: true }]],
  ["rocket", [{ weapon: "rocket" }]],
  ["rocket fire", [{ weapon: "rocket" }, { weapon: "rocket", recoil: 0.25 }, { weapon: "rocket", recoil: 0.24 }]],
  ["rifle", [{ weapon: "rifle", aim: -0.3 }]],
  ["bat swing", [{ weapon: "bat" }, { weapon: "bat", swingT: 0.2 }, { weapon: "bat", swingT: 0.2 }, { weapon: "bat", swingT: 0.2 }, { weapon: "bat", swingT: 0.2 }, { weapon: "bat", swingT: 0.2 }, { weapon: "bat", swingT: 0.2 }]],
];
moments.forEach(([name, steps], i) => {
  const x = 40 + i * step * 0.95;
  put(plushBot(lk, name.startsWith("KO") ? "ko" : "confident", steps), x, y);
  label(name, x - 20, y + S * 1.1, 10);
});
// every build, every moment and weapon; then marks on every build
y += S * 2.4;
label("BUILDS: balanced, tank, anchor, glass cannon, every moment (plush)", 12, y);
y += 20 + S * 1.3;
const BUILDS = ["balanced", "tank", "anchor", "glass"];
const marksOn: Mark[] = ["crown", "horns", "cape", "tophat", "catears", "beanie"];
BUILDS.forEach((b, r) => {
  const lb = look(hue(200 + r * 40), "antenna", "B" + r);
  label(b, 4, y - S * 0.2, 10);
  moments.forEach(([name, steps], i) => {
    put(plushBot(lb, name.startsWith("KO") ? "ko" : "confident", steps, 1, b), 70 + i * step * 0.95, y);
  });
  marksOn.forEach((mk, i) => {
    put(plushBot(look(hue(20 + i * 55), mk, "BM" + i), "confident", [{}], i % 2 ? -1 : 1, b), 70 + (moments.length + 0.6 + i * 0.85) * step * 0.95, y);
  });
  y += S * 2.5;
});
y -= S * 1.2;
// every rendered weapon on every build: held (aimed a little down), then on its fire frame
y += S * 2.4;
label("WEAPONS on every build: hold | fire (shared weapon layer pinned to each build's sleeve)", 12, y);
y += 20 + S * 1.3;
const GUNS = ["rocket", "bat", "rifle", "shotgun", "sniper", "crossbow", "railgun", "hammer", "flamethrower", "lightning", "grenade", "mine", "grapple"];
BUILDS.forEach((b, r) => {
  label(b, 4, y - S * 0.2, 10);
  GUNS.forEach((w, i) => {
    const lw = look(hue(160 + r * 50), "antenna", "W" + r + w);
    const hold = [{ weapon: w, aim: -0.15 }];
    const fire = w === "bat" || w === "hammer"
      ? [{ weapon: w }, ...Array.from({ length: 4 }, () => ({ weapon: w, swingT: 0.2 }))]
      : [{ weapon: w, aim: -0.15 }, { weapon: w, aim: -0.15, recoil: 0.25 }, { weapon: w, aim: -0.15, recoil: 0.24 }, { weapon: w, aim: -0.15, recoil: 0.23 }];
    const x = 70 + i * step * 1.9;
    put(plushBot(lw, "confident", hold, 1, b), x, y);
    put(plushBot(lw, "confident", fire, 1, b), x + step * 0.95, y);
    if (r === 0) label(w, x - 10, y - S * 1.55, 10);
  });
  y += S * 2.4;
});
y -= S * 1.1;
// marks in motion (frames by the clock; the antenna kicked by a start and a stop), the minor marks, the feet
y += S * 2.4;
label("MARKS IN MOTION: antenna whip, propeller spin, headband / cape / scarf flap    MINOR MARKS: bolts, scarf, scratch, bandage", 12, y);
y += 20 + S * 1.3;
{
  let x = 50;
  const run = (n: number, extra: Partial<PlushInput> = {}) => Array.from({ length: n }, (_, i) => ({ dt: 1 / 30, ...extra, vx: i < 3 ? 8 : 0 }));
  const moving: [Mark, Mark][] = [["antenna", "none"], ["propeller", "none"], ["headband", "none"], ["cape", "none"], ["beanie", "scarf"]];
  moving.forEach(([mk, mn], j) => {
    for (let f = 0; f < 4; f++) {
      put(plushBot(look(hue(30 + j * 60), mk, "Mv" + j, mn), "confident", run(3 + f * 2)), x, y);
      x += step * 0.8;
    }
    x += step * 0.3;
  });
  label("each mark: 4 moments a few frames apart", 50, y + S * 1.05, 10);
}
y += S * 2.5;
{
  let x = 50;
  (["bolts", "scarf", "scratch", "bandage"] as Mark[]).forEach((mn, j) => {
    const lk = look(hue(200 + j * 40), "horns", "Mn" + j, mn);
    put(plushBot(lk, "confident"), x, y);
    label(mn, x - 10, y + S * 1.05, 10);
    x += step * 1.3;
  });
  // feet: flat, the back foot down a step, the front foot on a slope, the front foot slid in off a crate's corner
  const feet: [string, FeetOffsets][] = [["flat", {}], ["back foot down 0.08 m", { dl: 0.08 }], ["front foot on a slope", { dr: -0.05, ar: -0.4 }], ["front foot slid in (corner)", { xr: -0.12, dr: 0.02, ar: 0.3 }]];
  x += step * 0.4;
  feet.forEach(([name, f], j) => {
    put(plushBot(look(hue(320), "crown", "Ft" + j), "confident", [{}], 1, "balanced", f), x, y);
    label(name, x - 20, y + S * 1.05, 10);
    x += step * 1.6;
  });
}
y += S * 1.2;
// the silhouette flash and halo, for reference
y += S * 2.4;
label("hit flash (silhouette) and build halo", 12, y);
y += 20 + S * 1.2;
{
  const lk2 = look(hue(300), "horns", "Fx");
  const pl = new PlushBot(lk2.color, lk2.mark);
  pl.update({ dt: 1 / 12, alive: true, air: false, stunned: false, vx: 0, vy: 0, weapon: "fist", aim: 0, swingT: 0, recoil: 0, hitT: 0, celebrate: false, facing: 1 });
  const root = new Container();
  const halo = pl.makeSil();
  halo.tint = 0x56e39a;
  halo.alpha = 0.6;
  halo.scale.set(1.28);
  halo.position.set(0, 0.06);
  const fl2 = pl.makeSil();
  fl2.alpha = 0.85;
  root.addChild(halo, pl.body.c, pl.feet, pl.mark.c, pl.fist.c, fl2);
  put(root, 40, y);
  const root2 = new Container();
  const pl2 = new PlushBot(lk2.color, lk2.mark);
  pl2.update({ dt: 1 / 12, alive: true, air: false, stunned: false, vx: 0, vy: 0, weapon: "fist", aim: 0, swingT: 0, recoil: 0, hitT: 0, celebrate: false, facing: 1 });
  const halo2 = pl2.makeSil();
  halo2.tint = 0x56e39a;
  halo2.alpha = 0.6;
  halo2.scale.set(1.28);
  halo2.position.set(0, 0.06);
  const face = new Graphics();
  root2.addChild(halo2, pl2.body.c, pl2.feet, pl2.mark.c, pl2.fist.c);
  put(root2, 40 + step, y);
  void face;
}
app.renderer.resize(2400, Math.ceil(y + S * 1.4));
(window as unknown as { __labReady: boolean }).__labReady = true;
