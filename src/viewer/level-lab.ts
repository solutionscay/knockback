/**
 * The level-art lab page (scripts/level-lab.ts, #92): each theme's terrain at game size (1:1), built from a small
 * grid the way the game draws it (TerrainView): its ground and every platform material, a carved hole, cells at
 * crack stages 1 and 2, burned cells, a loose chunk and a chain anchor; then the glass pane, the jump pad and the
 * weight, and a plush fighter for scale. ?s= screen pixels per meter (45: the View-all median at 1080p). View only.
 *
 * #94: a last row, the testbed theme: a pool of each liquid (water, oil, lava, acid; drawn by liquidview.ts, #116), sand
 * ground, and columns of sand, mud, ice and rock (one cracked), an ice platform, a fighter wading in the water.
 * ?t= seconds into the liquids' loop (stills).
 *
 * #111: the beach row: dry sand over wet sand over the rock frame, a carved crater, a tide pool with a fighter wading,
 * a column of each beach material (cracked at stages 1 and 2), a boardwalk platform; under it, its prop skins (driftwood
 * crate, buoy, driftwood logs) at their three damage states.
 *
 * #114: the forest row: grassy soil over the rock frame, a carved crater, a muddy creek (mud walls and banks) with a
 * fighter wading, a column of each forest material (cracked at stages 1 and 2), a tree trunk, a branch and a canopy
 * platform; under it, its prop skins (a tree stump, a beehive, a log pile) at their three damage states.
 */
import { Application, Container, Sprite, Text } from "pixi.js";
import { F_ANCHOR, F_CHARRED, F_ONEWAY, Grid, Liquid, Mat, MAT_HP } from "../sim/grid";
import { LiquidView } from "./liquidview";
import { LEVEL_THEMES, PROP_HALF, type Theme } from "../sim/level-config";
import { levelLoad, levelMemory, setLevelSprite } from "./level-art";
import { initPlushArt, loadPlushSheets, plushFormat, plushNeeds, PlushBot } from "./plush-bot";
import { drawPiece, TerrainView } from "./terrainview";
import { initWorldArt, setWorldFrame } from "./world-art";

const q = new URLSearchParams(location.search);
const S = Number(q.get("s") ?? "45");
const THEMES: Theme[] = ["rooftop", "warehouse", "junkyard", "construction", "testbed", "beach", "forest", "cave", "space"];
const T0 = Number(q.get("t") ?? "0");
await initPlushArt();
await initWorldArt();
await loadPlushSheets(plushNeeds("balanced", "none"));
const app = new Application();
await app.init({ background: 0x141a2e, width: Math.round(S * 14.5), height: Math.round(S * 81), antialias: true, resolution: 1, preference: "webgl" });
document.body.appendChild(app.canvas);

function label(text: string, x: number, y: number, size = 13) {
  const t = new Text({ text, style: { fill: 0xb8c2e0, fontSize: size, fontWeight: "700", fontFamily: "system-ui" } });
  t.position.set(x, y);
  app.stage.addChild(t);
}

/** A 22 x 8 cell (11 x 4 m) patch: ground of the theme's body with its surface on top, a carved crater, cracked and burned
 * cells, a column of every platform material, and a platform held by a chain anchor. */
function patch(theme: Theme): Grid {
  const T = LEVEL_THEMES[theme];
  const g = new Grid(22, 8, 0, 0);
  for (let cx = 0; cx < 22; cx++) {
    for (let cy = 0; cy < 4; cy++) g.set(cx, cy, cy === 0 ? Mat.Bedrock : cy === 3 ? T.surface : T.body);
  }
  // a crater, carved
  for (const [cx, cy] of [[5, 3], [6, 3], [7, 3], [6, 2], [5, 2], [6, 1]]) g.clear(cx!, cy!);
  // cracks next to it: stage 1 and stage 2
  const crack = (cx: number, cy: number, k: number) => (g.hp[g.idx(cx, cy)] = MAT_HP[g.mat[g.idx(cx, cy)]!]! * k);
  crack(4, 3, 0.5); crack(8, 3, 0.5); crack(4, 2, 0.2); crack(7, 2, 0.2); crack(5, 1, 0.5); crack(7, 1, 0.2);
  // burned planks
  for (let cx = 10; cx < 13; cx++) g.set(cx, 4, Mat.Wood, cx === 11 ? F_CHARRED : 0);
  g.flags[g.idx(10, 4)]! |= F_CHARRED;
  // every material, a column each
  const mats = [Mat.Dirt, Mat.Rock, Mat.Wood, Mat.Steel, Mat.Concrete, Mat.Crumble, Mat.Brick];
  mats.forEach((m, i) => { g.set(14 + i, 4, m); g.set(14 + i, 5, m); });
  crack(15, 5, 0.5); crack(17, 5, 0.2);
  // a platform from an anchor
  for (let cx = 1; cx < 4; cx++) g.set(cx, 7, T.platform[0]!, cx === 2 ? F_ANCHOR : 0);
  return g;
}

/** #94, the testbed: four pools and the new materials. */
function proving(): Grid {
  const g = new Grid(22, 8, 0, 0);
  for (let cx = 0; cx < 22; cx++) for (let cy = 0; cy < 4; cy++) g.set(cx, cy, cy === 0 ? Mat.Bedrock : cy === 3 ? Mat.Sand : cy === 1 && cx % 5 === 2 ? Mat.Rock : Mat.Dirt);
  const pool = (c0: number, c1: number, cy0: number, l: Liquid) => {
    for (let cx = c0; cx <= c1; cx++) for (let cy = cy0; cy < 4; cy++) {
      g.clear(cx, cy);
      g.liq[g.idx(cx, cy)] = l;
    }
  };
  pool(1, 4, 1, Liquid.Water);
  pool(6, 8, 2, Liquid.Oil);
  pool(10, 12, 2, Liquid.Lava);
  pool(14, 16, 2, Liquid.Acid);
  [Mat.Sand, Mat.Mud, Mat.Ice, Mat.Rock].forEach((m, i) => { g.set(18 + i, 4, m); g.set(18 + i, 5, m); });
  g.hp[g.idx(20, 5)] = MAT_HP[Mat.Ice]! * 0.2;
  g.hp[g.idx(18, 5)] = MAT_HP[Mat.Sand]! * 0.5;
  for (let cx = 7; cx < 13; cx++) g.set(cx, 7, Mat.Ice, cx === 7 || cx === 12 ? F_ANCHOR : 0);
  for (let cx = 1; cx < 4; cx++) g.set(cx, 6, Mat.Mud);
  return g;
}
/** #111, the beach: sand over wet sand over rock, a crater, a tide pool, its materials cracked, a boardwalk. */
function beachPatch(): Grid {
  const g = new Grid(22, 8, 0, 0);
  for (let cx = 0; cx < 22; cx++) for (let cy = 0; cy < 4; cy++) g.set(cx, cy, cy === 0 ? Mat.Bedrock : cy === 1 ? Mat.Rock : cy === 2 ? (cx % 6 === 4 ? Mat.Sand : Mat.Dirt) : Mat.Sand);
  for (const [cx, cy] of [[5, 3], [6, 3], [7, 3], [6, 2], [5, 2]]) g.clear(cx!, cy!);
  const crack = (cx: number, cy: number, k: number) => (g.hp[g.idx(cx, cy)] = MAT_HP[g.mat[g.idx(cx, cy)]!]! * k);
  crack(4, 3, 0.5); crack(8, 3, 0.2); crack(4, 2, 0.2); crack(7, 2, 0.5); crack(6, 1, 0.5);
  for (let cx = 9; cx <= 12; cx++) for (let cy = 2; cy < 4; cy++) {
    g.clear(cx, cy);
    g.liq[g.idx(cx, cy)] = Liquid.Water;
  }
  [Mat.Sand, Mat.Dirt, Mat.Rock, Mat.Wood, Mat.Crumble].forEach((m, i) => { g.set(15 + i, 4, m); g.set(15 + i, 5, m); });
  crack(15, 5, 0.5); crack(16, 5, 0.2); crack(17, 5, 0.5); crack(18, 4, 0.2);
  for (let cx = 1; cx < 6; cx++) g.set(cx, 7, Mat.Wood, F_ONEWAY | (cx === 1 || cx === 5 ? F_ANCHOR : 0));
  return g;
}
/** #114, the forest: soil over rock, a crater, a muddy creek, its materials cracked, a trunk, a branch, a canopy. */
function forestPatch(): Grid {
  const g = new Grid(22, 8, 0, 0);
  for (let cx = 0; cx < 22; cx++) for (let cy = 0; cy < 4; cy++) g.set(cx, cy, cy === 0 ? Mat.Bedrock : cy === 1 ? Mat.Rock : cx % 7 === 3 && cy === 2 ? Mat.Rock : Mat.Dirt);
  for (const [cx, cy] of [[5, 3], [6, 3], [7, 3], [6, 2], [5, 2]]) g.clear(cx!, cy!);
  const crack = (cx: number, cy: number, k: number) => (g.hp[g.idx(cx, cy)] = MAT_HP[g.mat[g.idx(cx, cy)]!]! * k);
  crack(4, 3, 0.5); crack(8, 3, 0.2); crack(4, 2, 0.2); crack(7, 2, 0.5); crack(6, 1, 0.5);
  // the creek: water in a basin, mud on its walls and two cells of bank each side (as levelgen's bankCells)
  for (let cx = 10; cx <= 13; cx++) for (let cy = 2; cy < 4; cy++) {
    g.clear(cx, cy);
    g.liq[g.idx(cx, cy)] = Liquid.Water;
  }
  for (let cy = 1; cy < 4; cy++) { g.set(9, cy, Mat.Mud); g.set(14, cy, Mat.Mud); }
  for (const cx of [8, 15]) g.set(cx, 3, Mat.Mud);
  [Mat.Dirt, Mat.Rock, Mat.Wood, Mat.Crumble, Mat.Mud].forEach((m, i) => { g.set(16 + i, 4, m); g.set(16 + i, 5, m); });
  crack(16, 5, 0.5); crack(17, 5, 0.2); crack(18, 5, 0.5); crack(19, 4, 0.2); crack(20, 5, 0.5);
  for (let cy = 4; cy < 8; cy++) g.set(0, cy, Mat.Wood); // a tree trunk
  for (let cx = 1; cx < 5; cx++) g.set(cx, 7, Mat.Wood, F_ONEWAY | (cx === 4 ? F_ANCHOR : 0)); // a branch off it
  for (let cx = 5; cx < 9; cx++) g.set(cx, 6, Mat.Crumble, F_ONEWAY | (cx === 5 || cx === 8 ? F_ANCHOR : 0)); // canopy
  return g;
}

/**
 * #125, the cave: gravel over the rock frame over bedrock, a crater, a slime pool, its materials cracked, a timber
 * jump-through ledge, and a strip of the ceiling with a stalactite hanging from it.
 */
function cavePatch(): Grid {
  const g = new Grid(22, 8, 0, 0);
  for (let cx = 0; cx < 22; cx++) for (let cy = 0; cy < 4; cy++) g.set(cx, cy, cy === 0 ? Mat.Bedrock : cy === 1 ? Mat.Rock : cx % 7 === 3 && cy === 2 ? Mat.Rock : Mat.Dirt);
  for (const [cx, cy] of [[5, 3], [6, 3], [7, 3], [6, 2], [5, 2]]) g.clear(cx!, cy!);
  const crack = (cx: number, cy: number, k: number) => (g.hp[g.idx(cx, cy)] = MAT_HP[g.mat[g.idx(cx, cy)]!]! * k);
  crack(4, 3, 0.5); crack(8, 3, 0.2); crack(4, 2, 0.2); crack(7, 2, 0.5); crack(6, 1, 0.5);
  for (let cx = 9; cx <= 12; cx++) for (let cy = 2; cy < 4; cy++) {
    g.clear(cx, cy);
    g.liq[g.idx(cx, cy)] = Liquid.Slime;
  }
  [Mat.Dirt, Mat.Rock, Mat.Wood, Mat.Crumble, Mat.Ice].forEach((m, i) => { g.set(14 + i, 4, m); g.set(14 + i, 5, m); });
  crack(14, 5, 0.5); crack(15, 5, 0.2); crack(16, 5, 0.5); crack(18, 4, 0.2);
  for (let cx = 1; cx < 6; cx++) g.set(cx, 6, Mat.Wood, F_ONEWAY);
  // the ceiling: a row of rock, a stalactite (3 wide, then 1) under it
  for (let cx = 8; cx < 22; cx++) g.set(cx, 7, Mat.Rock);
  for (const [cx, cy] of [[19, 6], [20, 6], [21, 6], [20, 5]]) g.set(cx!, cy!, Mat.Rock);
  crack(20, 6, 0.5);
  return g;
}

/**
 * #127, space: regolith (ice chunks in it) over the asteroid rock over bedrock, a crater, a coolant pool, its materials
 * cracked, a steel jump-through catwalk.
 */
function spacePatch(): Grid {
  const g = new Grid(22, 8, 0, 0);
  for (let cx = 0; cx < 22; cx++) for (let cy = 0; cy < 4; cy++) g.set(cx, cy, cy === 0 ? Mat.Bedrock : cy === 1 ? Mat.Rock : cx % 7 === 3 && cy === 3 ? Mat.Ice : Mat.Dirt);
  for (const [cx, cy] of [[5, 3], [6, 3], [7, 3], [6, 2], [5, 2]]) g.clear(cx!, cy!);
  const crack = (cx: number, cy: number, k: number) => (g.hp[g.idx(cx, cy)] = MAT_HP[g.mat[g.idx(cx, cy)]!]! * k);
  crack(4, 3, 0.5); crack(8, 3, 0.2); crack(4, 2, 0.2); crack(7, 2, 0.5); crack(6, 1, 0.5);
  for (let cx = 9; cx <= 12; cx++) for (let cy = 2; cy < 4; cy++) {
    g.clear(cx, cy);
    g.liq[g.idx(cx, cy)] = Liquid.Coolant;
  }
  [Mat.Dirt, Mat.Rock, Mat.Steel, Mat.Concrete, Mat.Crumble, Mat.Ice].forEach((m, i) => { g.set(14 + i, 4, m); g.set(14 + i, 5, m); });
  crack(14, 5, 0.5); crack(15, 5, 0.2); crack(16, 5, 0.5); crack(17, 4, 0.2); crack(19, 5, 0.5);
  for (let cx = 1; cx < 6; cx++) g.set(cx, 7, Mat.Steel, F_ONEWAY | (cx === 1 || cx === 5 ? F_ANCHOR : 0));
  return g;
}
const liquidViews: LiquidView[] = [];

function fighter(x: number, ground: number) {
  const pl = new PlushBot(0x3fa7ff, "none", "balanced");
  pl.update({ dt: 1 / 12, alive: true, air: false, stunned: false, vx: 0, vy: 0, weapon: "fist", aim: 0, swingT: 0, recoil: 0, hitT: 0, celebrate: false, facing: 1 });
  const c = new Container();
  c.addChild(pl.back.c, pl.body.c, pl.feet, pl.fist.c, pl.sleeve.c, pl.arm.c);
  c.scale.set(S);
  c.position.set(x, ground);
  app.stage.addChild(c);
}

let y = 24;
const bytes: number[] = [];
for (const theme of THEMES) {
  await levelLoad(theme);
  bytes.push(levelMemory(theme).bytes);
  const rowH = S * 7.4;
  label(`${theme} (${S} px/m, ${plushFormat()})`, 12, y);
  const g = theme === "testbed" ? proving() : theme === "beach" ? beachPatch() : theme === "forest" ? forestPatch() : theme === "cave" ? cavePatch() : theme === "space" ? spacePatch() : patch(theme);
  const tv = new TerrainView(g, theme);
  tv.update();
  const world = new Container();
  world.addChild(tv.container);
  if (theme === "testbed" || theme === "beach" || theme === "forest" || theme === "cave" || theme === "space") {
    const lv = new LiquidView(g, theme);
    lv.update(T0);
    liquidViews.push(lv);
    world.scale.set(S);
    world.position.set(S * 1.5, y + S * 7.2);
    app.stage.addChild(world);
    fighter(theme === "beach" ? S * 7.0 : theme === "forest" ? S * 7.5 : theme === "cave" || theme === "space" ? S * 7.0 : S * 2.9, y + S * 5.2 + S * 1.0);
    world.addChild(lv.container);
    app.stage.addChild(world); // the liquid in front of the wading fighter
    y += rowH + 8;
    if (theme === "beach" || theme === "forest" || theme === "cave" || theme === "space") {
      // its prop skins, three damage states each, standing on a line (the same props: crate, barrel, block)
      label(theme === "beach" ? "beach prop skins: driftwood crate, buoy (the explosive barrel), driftwood logs (cover); damage 0, 1, 2"
        : theme === "forest" ? "forest prop skins: tree stump (the crate), beehive (the explosive barrel), log pile (cover); damage 0, 1, 2"
        : theme === "cave" ? "cave prop skins: mine cart (crate), crystal cluster (the explosive barrel), boulders (cover); damage 0, 1, 2"
        : "space prop skins: cargo pod (crate), fuel canister (the explosive barrel), hull plates (cover); damage 0, 1, 2", 12, y);
      const row = new Container();
      let x = 0.8;
      for (const [k, w] of [["crate", 0.8], ["barrel", 0.68], ["block", 0.9]] as const) {
        for (let st = 0; st < 3; st++) {
          const sp = new Sprite();
          setLevelSprite(sp, theme, `p-${k}-${st}`);
          sp.position.set(x + w / 2, -PROP_HALF[k][1]);
          row.addChild(sp);
          x += w + 0.35;
        }
      }
      row.scale.set(S);
      row.position.set(S * 0.5, y + S * 2.6);
      app.stage.addChild(row);
      y += S * 3 + 8;
    }
    continue;
  }
  // a loose chunk (a broken-off piece), turned a little
  const piece = new Container();
  drawPiece(piece, theme, [{ lx: 0, ly: 0, mat: LEVEL_THEMES[theme].platform[1]!, hp: 99 }, { lx: 1, ly: 0, mat: LEVEL_THEMES[theme].platform[1]!, hp: 6 }, { lx: 1, ly: 1, mat: LEVEL_THEMES[theme].platform[1]!, hp: 99 }]);
  piece.position.set(5.6, -3.6);
  piece.rotation = -0.25;
  world.addChild(piece);
  // the level props, standing on the ground
  // (meters: the ground's top is at 2 m; the weight hangs)
  for (const [k, x, y0] of [["glass", 10.75, 2], ["pad", 4.6, 2], ["weight", 8.3, 3.6]] as const) {
    const s = new Sprite();
    setWorldFrame(s, k);
    s.position.set(x, -(y0 + PROP_HALF[k][1]));
    world.addChild(s);
  }
  world.scale.set(S);
  world.position.set(S * 1.5, y + S * 7.2);
  app.stage.addChild(world);
  fighter(S * 3.2, y + S * 5.2);
  y += rowH + 8;
}
app.ticker.add(() => {
  for (const lv of liquidViews) lv.update(T0 + app.ticker.lastTime / 1000);
});
label(`GPU per theme (its atlas + the shared one): ${bytes.map((b) => (b / 1e6).toFixed(2) + " MB").join(", ")}`, 12, y);
(window as unknown as { __ready: boolean; __levelBytes: number[] }).__ready = true;
(window as unknown as { __levelBytes: number[] }).__levelBytes = bytes;
