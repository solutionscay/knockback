/**
 * Level validation: a generated level must be playable and fit the camera. The generator (levelgen.ts) retries
 * with the next attempt number until a candidate passes, so these checks are part of what a seed gives.
 */
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
  return { ok: reasons.length === 0, reasons };
}
