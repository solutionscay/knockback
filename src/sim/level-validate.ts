/**
 * Level validation: a generated level must be playable and fit the camera. The generator (levelgen.ts) retries
 * with the next attempt number until a candidate passes, so these checks are part of what a seed gives.
 */
import { CELL, Liquid } from "./grid";
import { hasWallRoute } from "./level-walls";
import { spreadSpawnProblems } from "./level-spawns";
import type { LevelDef } from "./levelgen";
import { NavGraph } from "./nav";
import { CLASSIC, type Ruleset } from "./ruleset";

export interface Validation {
  ok: boolean;
  reasons: string[];
}

/** Checks a generated level is playable and fits the camera. */
export function validateLevel(lv: LevelDef, ruleset: Ruleset = CLASSIC): Validation {
  const { layout: L, spawns: S } = ruleset.arena;
  const reasons: string[] = [];
  const g = lv.grid;
  if (lv.width < 2 * L.halfWidth[0] || lv.width > 2 * L.halfWidth[1]) reasons.push(`width ${lv.width}`);
  if (lv.spawns.length !== 4) reasons.push(`spawns ${lv.spawns.length}`);
  const nav = NavGraph.fromGrid(g, 2, ruleset);
  const surf = lv.spawns.map((s) => nav.surfaceAt(s.x, s.y + 0.05, 0));
  if (surf.some((s) => !s)) reasons.push("spawn off a surface");
  else {
    for (let i = 0; i < surf.length; i++) {
      const s = surf[i]!;
      const sp = lv.spawns[i]!;
      if (s.y < S.minHeight) reasons.push("spawn in a pit");
      if ((s.dropLeft && sp.x - s.x0 < S.minDropMargin) || (s.dropRight && s.x1 - sp.x < S.minDropMargin)) reasons.push("spawn at a drop");
      const plan = nav.plan(s.id, sp.x);
      for (let j = 0; j < surf.length; j++) if (j !== i && plan.cost[surf[j]!.id] === Infinity) reasons.push(`no route ${i}->${j}`);
    }
    const xs = lv.spawns.map((s) => s.x);
    if (Math.max(...xs) - Math.min(...xs) > S.maxSpread) reasons.push("spawns too spread");
  }
  if (S.spread.enabled && lv.spawns.length === 4) reasons.push(...spreadSpawnProblems(lv.spawns, lv.width, lv.zoneCenter, ruleset));
  for (const wall of lv.walls ?? []) if (!hasWallRoute(g, nav, wall, ruleset)) reasons.push(`wall at ${wall.x0} has no route`);
  const cover = lv.props.filter((p) => p.kind === "block").length;
  if (cover < L.minimumCover) reasons.push(`cover ${cover}`);
  if (lv.props.length < L.minimumProps) reasons.push(`props ${lv.props.length}`);
  if (lv.platforms < L.minimumPlatforms) reasons.push(`platforms ${lv.platforms}`);
  // camera fit: nothing solid above L.top (#125: a cave's ceiling starts at it: everything above is the ceiling)
  if (!ruleset.arena.themes[lv.theme].stage.ceiling) for (let cy = g.cy(L.top + 0.01); cy < g.rows; cy++) for (let cx = 0; cx < g.cols; cx++) if (g.solid(cx, cy)) {
    reasons.push("too tall");
    cy = g.rows;
    break;
  }
  // a ledge to fall off near the action
  const hasDrop = nav.surfaces.some((s) => (s.dropLeft && Math.abs(s.x0 - lv.zoneCenter) < L.centerDropReach) || (s.dropRight && Math.abs(s.x1 - lv.zoneCenter) < L.centerDropReach));
  if (!hasDrop) reasons.push("no drop near the center");
  reasons.push(...poolExitProblems(lv, ruleset));
  return { ok: reasons.length === 0, reasons };
}

/** #152: rows of open air a fighter needs over a ledge to stand on it (it is 1.68 m tall) */
const STAND_ROWS = 4;

/**
 * #152: how high a swim stroke lifts a fighter's feet over the liquid's top, in this ruleset's gravity (a themed
 * ruleset: the space map's is lower). A stroke starts with the feet about 0.15 m under the surface (sim-liquid.ts:
 * bodyLiquid) and rises strokeSpeed² / 2g: about 0.69 m in water, slime and coolant at full gravity, 0.84 m in space.
 */
export function strokeReach(ruleset: Ruleset, liquid: number): number {
  const L = ruleset.liquids;
  const W = liquid === Liquid.Slime ? L.slime : liquid === Liquid.Coolant ? L.coolant : L.water;
  return (W.strokeSpeed * W.strokeSpeed) / (2 * ruleset.combat.gravity) - 0.15;
}

/**
 * #152: a pool's exits, one per side: how far the ledge beside the liquid stands over its top (m), and whether a
 * swimmer can climb out there (within a stroke's reach, with room to stand on it). Water, slime and coolant pools only
 * (a fighter in oil, lava or acid stands on the floor and jumps). From the grid as it stands: generated, or carved.
 */
export function poolExits(lv: LevelDef, ruleset: Ruleset): { x0: number; x1: number; lips: [number, number]; ok: [boolean, boolean] }[] {
  const g = lv.grid;
  const out: { x0: number; x1: number; lips: [number, number]; ok: [boolean, boolean] }[] = [];
  for (const p of lv.pools ?? []) {
    if (p.liquid !== Liquid.Water && p.liquid !== Liquid.Slime && p.liquid !== Liquid.Coolant) continue;
    const c0 = g.cx(p.x0 + CELL / 2);
    const c1 = g.cx(p.x1 - CELL / 2);
    let top = -1;
    for (let cx = c0; cx <= c1; cx++) for (let cy = 0; cy < g.rows; cy++) if (g.liqAt(cx, cy) === p.liquid) top = Math.max(top, cy);
    if (top < 0) continue;
    const reach = strokeReach(ruleset, p.liquid);
    const side = (cx: number): [number, boolean] => {
      if (!g.solid(cx, top)) return [0, true]; // open beside the liquid's top: it would have run out there
      let k = top;
      while (k + 1 < g.rows && g.solid(cx, k + 1)) k++;
      const lip = (k - top) * CELL;
      let room = true;
      for (let cy = k + 1; cy <= k + STAND_ROWS && cy < g.rows; cy++) if (g.solid(cx, cy)) room = false;
      return [lip, lip <= reach + 1e-9 && room];
    };
    const [l, lo] = side(c0 - 1);
    const [r, ro] = side(c1 + 1);
    out.push({ x0: p.x0, x1: p.x1, lips: [l, r], ok: [lo, ro] });
  }
  return out;
}

/** #152: no pool may have only exits a swimmer cannot reach (the generator then tries the next attempt). */
export function poolExitProblems(lv: LevelDef, ruleset: Ruleset): string[] {
  return poolExits(lv, ruleset).filter((e) => !e.ok[0] && !e.ok[1]).map((e) => `pool at ${e.x0}..${e.x1} has no exit a swimmer can reach (lips ${e.lips[0]} m, ${e.lips[1]} m)`);
}
