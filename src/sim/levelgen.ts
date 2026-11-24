/**
 * Seeded procedural level generator. Deterministic: the same seed always gives
 * the same level (the seed is in the match record). Each level gets a theme
 * that changes the shapes, materials and prop mix.
 *
 * Layout: ground masses separated by pits and void edges, steps, overhangs,
 * bridges, jumpable walls, and many floating platforms (hung from anchor
 * cells). Every cell except the bottom bedrock rows can be destroyed.
 *
 * If a candidate fails validation (level-validate.ts) the generator retries
 * with the next attempt number (also deterministic).
 */
import { CELL, F_ANCHOR, F_BRIDGE, F_ONEWAY, Grid, Liquid, Mat } from "./grid";
import { placeWalls, wallCorridor, type Wall } from "./level-walls";
import { NavGraph, type Surface } from "./nav";
import { Rng } from "./rng";

import { type PropKind, type Theme } from "./level-config";
import { validateLevel } from "./level-validate";
import { CLASSIC, RulesetError, themedRuleset, type Ruleset } from "./ruleset";
import { settleGrid } from "./liquid-flow";
import { spreadSpawns } from "./level-spawns";

export interface PropSpec {
  kind: PropKind;
  x: number;
  /** y of the bottom face */
  y: number;
  /** hanging weights: rope anchor point and length */
  ax?: number;
  ay?: number;
  len?: number;
}

export interface LevelDef {
  seed: number;
  attempt: number;
  theme: Theme;
  name: string;
  width: number;
  minX: number;
  maxX: number;
  grid: Grid;
  props: PropSpec[];
  spawns: { x: number; y: number }[];
  pits: { x0: number; x1: number }[];
  /** #94: liquid pools: basins dug into the ground, filled to the rim (x0..x1, rim height y, depth in cells) */
  pools?: { x0: number; x1: number; y: number; depth: number; liquid: Liquid }[];
  zoneCenter: number;
  platforms: number;
  towers: number;
  walls?: Wall[];
  bridges: number;
}

const q = (v: number) => Math.round(v * 2) / 2; // to the cell grid
const q1 = (v: number) => Math.round(v);

/** Theme for a seed (stable across generator attempts). */
export function themeFor(seed: number, ruleset: Ruleset = CLASSIC): Theme {
  const THEMES = ruleset.arena.enabledThemes;
  return THEMES[new Rng((seed ^ 0x7e3a11) >>> 0).u32() % THEMES.length]!;
}

export function generateLevel(seed: number, maxAttempts?: number, baseRuleset: Ruleset = CLASSIC): LevelDef {
  // the theme's physics (#94) shape the jumps the level is built and checked for
  const ruleset = themedRuleset(baseRuleset, themeFor(seed, baseRuleset));
  let last: LevelDef | null = null;
  let reasons: string[] = [];
  for (let attempt = 0; attempt < (maxAttempts ?? ruleset.arena.layout.attempts); attempt++) {
    const lv = buildCandidate(seed, attempt, ruleset);
    last = lv;
    const validation = validateLevel(lv, ruleset);
    if (validation.ok) return lv;
    reasons = validation.reasons;
  }
  if (ruleset.arena.spawns.spread.enabled) {
    throw new RulesetError("arena.spawns", `seed ${seed} has no playable spread-out layout (${reasons.join(", ")})`);
  }
  // The original layout keeps its fallback for Close Quarters.
  return last!;
}

function buildCandidate(seed: number, attempt: number, ruleset: Ruleset): LevelDef {
  const { layout: L, spawns: S, propHalf, terrain } = ruleset.arena;
  const theme = themeFor(seed, ruleset);
  const T = ruleset.arena.themes[theme];
  const rng = new Rng((Math.imul(seed >>> 0, 0x9e3779b1) ^ (attempt * 0x85ebca6b) ^ 0x2545f491) >>> 0);
  const W = 2 * rng.int(...L.halfWidth);
  const grid = new Grid(W / CELL, L.rows, -W / 2, L.bottom, terrain.hitPoints, terrain.density);
  const cyOf = (y: number) => Math.round((y - L.bottom) / CELL);
  const cxOf = (x: number) => Math.round((x + W / 2) / CELL);

  // ------------------------------------------------------------ pits
  const left = -W / 2 + q(rng.range(...L.edgeInset));
  const right = W / 2 - q(rng.range(...L.edgeInset));
  const pits: { x0: number; x1: number }[] = [];
  if (rng.chance(T.pitChance)) {
    const w = q(rng.range(...L.mainPitWidth));
    const x0 = q(rng.range(-L.mainPitWindow, L.mainPitWindow - w));
    pits.push({ x0, x1: x0 + w });
  }
  const extra = rng.int(T.extraPits[0], T.extraPits[1]);
  for (let i = 0; i < extra * 3 && pits.length < 1 + extra; i++) {
    const w = q(rng.range(...L.extraPitWidth));
    const side = rng.chance(0.5) ? -1 : 1;
    const x0 = side < 0 ? q(rng.range(left + L.pitEdgeMargin, -L.extraPitOffset - w)) : q(rng.range(L.extraPitOffset, right - L.pitEdgeMargin - w));
    if (pits.every((p) => x0 > p.x1 + L.pitSpacing || x0 + w < p.x0 - L.pitSpacing)) pits.push({ x0, x1: x0 + w });
  }
  pits.sort((a, b) => a.x0 - b.x0);

  // ------------------------------------------------------------ ground
  const top = new Array<number>(grid.cols).fill(-Infinity); // ground top y per column
  const segs: { x0: number; x1: number }[] = [];
  let sx = left;
  for (const p of pits) {
    segs.push({ x0: sx, x1: p.x0 });
    sx = p.x1;
  }
  segs.push({ x0: sx, x1: right });
  for (const s of segs) {
    const base = T.ground.heights === "roof" ? q1(rng.range(...L.rooftopHeight)) : q1(rng.range(...L.groundHeight));
    let h = base;
    let x = s.x0;
    while (x < s.x1 - 1e-6) {
      const run = T.ground.runs === "whole" ? s.x1 - s.x0 : rng.range(...L.groundRun);
      const xe = Math.min(s.x1, q(x + run));
      for (let cx = cxOf(x); cx < cxOf(xe); cx++) top[cx] = h;
      if (T.stepy || T.ground.steps) h = Math.max(base + L.groundMin, Math.min(base + L.groundMax, h + rng.pick(L.groundStep)));
      x = xe;
    }
  }
  const speckle = T.speckle.chance > 0 ? T.speckle : null;
  // #100: soft over hard: softDepth rows of the theme's ground on a hard frame (its color tells what breaks)
  const soft = T.stage.frame ? rng.int(T.stage.softDepth[0], T.stage.softDepth[1]) : Infinity;
  // #111: rows of surface on top (one in the first themes: no draw, so their levels are as before)
  const topRows = T.stage.topRows[1] > 1 ? rng.int(T.stage.topRows[0], T.stage.topRows[1]) : 1;
  for (let cx = 0; cx < grid.cols; cx++) {
    if (top[cx] === -Infinity) continue;
    const ty = cyOf(top[cx]!);
    for (let cy = 0; cy < ty; cy++) {
      let m: Mat = cy < L.bedrockRows ? Mat.Bedrock : cy >= ty - topRows ? T.surface : cy < ty - soft ? (T.stage.frame as Mat) : T.body;
      if (speckle && m === speckle.on && rng.chance(speckle.chance)) m = speckle.mat;
      grid.set(cx, cy, m);
    }
  }
  // parapets (rooftop)
  if (T.parapet) {
    for (const p of pits) {
      for (const [edge, dir] of [
        [cxOf(p.x0) - 1, -1],
        [cxOf(p.x1), 1],
      ] as const) {
        if (edge < 0 || edge >= grid.cols || top[edge] === -Infinity || !rng.chance(L.parapetChance)) continue;
        const cy = cyOf(top[edge]!);
        grid.set(edge + dir * 2, cy, T.parapet);
      }
    }
  }

  // ------------------------------------------------------------ liquid pools (#94)
  const pools = digPools(grid, top, pits, left, right, T.hazards, rng, cxOf, cyOf, L.bedrockRows);

  // ------------------------------------------------------------ overhangs + bridges
  let bridges = 0;
  for (const p of pits) {
    const lc = cxOf(p.x0) - 1;
    const rc = cxOf(p.x1);
    const lt = lc >= 0 ? top[lc]! : -Infinity;
    const rt = rc < grid.cols ? top[rc]! : -Infinity;
    const wide = p.x1 - p.x0;
    const isCenter = p.x0 < L.bridgeCenter && p.x1 > -L.bridgeCenter;
    if (T.stage.catwalk && lt > -Infinity && rt > -Infinity) {
      // #100: a hanging jump-through catwalk over the gap, catwalkHeight above the lower rim, a cell past each rim
      const cy = cyOf(Math.min(lt, rt) + T.stage.catwalkHeight) - 1;
      const m = rng.pick(T.bridge);
      const c0 = lc, c1 = rc;
      for (let cx = c0; cx <= c1; cx++) grid.set(cx, cy, m, F_ONEWAY);
      grid.flags[grid.idx(c0, cy)]! |= F_ANCHOR;
      grid.flags[grid.idx(c1, cy)]! |= F_ANCHOR;
      bridges++;
      continue;
    }
    if (lt > -Infinity && rt > -Infinity && Math.abs(lt - rt) <= L.bridgeHeightGap && rng.chance(isCenter ? L.bridgeCenterChance : L.bridgeChance) && wide <= L.bridgeMaxWidth) {
      const cy = cyOf(Math.min(lt, rt)) - 1;
      const m = rng.pick(T.bridge);
      for (let cx = lc + 1; cx < rc; cx++) grid.set(cx, cy, m, F_BRIDGE);
      bridges++;
    } else {
      for (const [c, t, dir] of [
        [lc, lt, 1],
        [rc, rt, -1],
      ] as const) {
        if (t === -Infinity || !rng.chance(L.overhangChance)) continue;
        const n = Math.min(rng.int(...L.overhangCells), Math.floor((wide - L.overhangGap) / CELL / 2));
        const cy = cyOf(t) - 1;
        for (let k = 1; k <= n; k++) grid.set(c + dir * k, cy, T.surface);
      }
    }
  }

  // sand that would not hold (an overhang over a pit) falls before anyone sees it
  if (pools.length || T.surface === Mat.Sand || T.body === Mat.Sand) settleGrid(grid);

  const groundAt = (x: number) => {
    const cx = Math.max(0, Math.min(grid.cols - 1, cxOf(x)));
    return top[cx] === -Infinity ? 0 : top[cx]!;
  };
  let platforms = 0;
  const clear = (cx0: number, cy0: number, cx1: number, cy1: number) => grid.emptyRect(cx0 - L.platformXClearCells, cy0 - L.platformYClearCells, cx1 + L.platformXClearCells, cy1 + L.platformYClearCells);

  // ------------------------------------------------------------ floating platforms
  const target = rng.int(T.platforms[0], T.platforms[1]);
  for (let i = 0; i < L.platformAttempts && platforms < target; i++) {
    const len = q(rng.range(...L.platformLength));
    const cxm = cxOf(q(rng.range(left + 2, right - 2)));
    const n = len / CELL;
    const cx0 = cxm - Math.floor(n / 2);
    const cx1 = cx0 + n - 1;
    if (cx0 < 2 || cx1 >= grid.cols - 2) continue;
    let gy = -Infinity;
    for (let cx = cx0; cx <= cx1; cx++) gy = Math.max(gy, top[cx]!);
    if (gy === -Infinity) gy = 0;
    const y = q(gy + rng.pick(L.platformHeights));
    const thick = rng.chance(L.thickPlatformChance) ? 2 : 1;
    const cyTop = cyOf(y) - 1;
    const cyBot = cyTop - thick + 1;
    if (y > L.top || !clear(cx0, cyBot, cx1, cyTop)) continue;
    const m = rng.chance(T.crumble) ? Mat.Crumble : rng.pick(T.platform);
    // #100: most single-row hanging platforms are jump-through; the thick ones stay solid (cover)
    const through = T.stage.oneWay > 0 && thick === 1 && rng.chance(T.stage.oneWay) ? F_ONEWAY : 0;
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cyBot; cy <= cyTop; cy++) grid.set(cx, cy, m, through);
    // anchors: the end cells hold the platform up (hanging from above)
    grid.flags[grid.idx(cx0, cyTop)]! |= F_ANCHOR;
    grid.flags[grid.idx(cx1, cyTop)]! |= F_ANCHOR;
    platforms++;
  }

  // no wall stands over a pool: its columns have no ground top for placeWalls
  let wallTop: readonly number[] = top;
  if (pools.length) {
    const t = top.slice();
    for (const p of pools) for (let cx = cxOf(p.x0) - 1; cx <= cxOf(p.x1); cx++) if (cx >= 0 && cx < t.length) t[cx] = -Infinity;
    wallTop = t;
  }
  const walls = placeWalls(grid, wallTop, rng.int(T.towers[0], T.towers[1]), T.tower, rng, ruleset);

  // ------------------------------------------------------------ spawns + props
  const nav = NavGraph.fromGrid(grid, 2, ruleset);
  const occupied: { s: number; x0: number; x1: number }[] = [];
  const free = (s: Surface, x0: number, x1: number) =>
    x0 >= s.x0 + L.propClearance && x1 <= s.x1 - L.propClearance && occupied.every((o) => o.s !== s.id || x1 < o.x0 || x0 > o.x1);
  const headroom = (x0: number, x1: number, y: number, h: number) => grid.emptyRect(grid.cx(x0 + 0.01), grid.cy(y + 0.01), grid.cx(x1 - 0.01), grid.cy(y + h - 0.01));

  // Tight layouts draw their zone at the original point in the RNG sequence.
  const chooseZoneCenter = () => {
    const near = pits.filter(p => Math.abs((p.x0 + p.x1) / 2) < L.zonePitReach);
    return near.length ? q((near[0]!.x0 + near[0]!.x1) / 2) : q(rng.range(-L.zoneCenterJitter, L.zoneCenterJitter));
  };
  const spreadCenter = S.spread.enabled ? chooseZoneCenter() : undefined;
  const spawns = spreadCenter === undefined ? [] : spreadSpawns(nav, W, spreadCenter, groundAt, rng, ruleset,
    (s, x) => free(s, x - S.bodyClearance, x + S.bodyClearance) && headroom(x - S.bodyClearance, x + S.bodyClearance, s.y,
      (ruleset.combat.fighter.radius + ruleset.combat.fighter.halfHeight) * 2));
  if (spreadCenter !== undefined) {
    for (const p of spawns) {
      const s = nav.surfaceAt(p.x, p.y + 0.05, 0)!;
      occupied.push({ s: s.id, x0: p.x - S.propClearance, x1: p.x + S.propClearance });
    }
  } else {
    const cands: { s: Surface; x: number }[] = [];
    for (const s of nav.surfaces) {
      if (s.fragile || s.x1 - s.x0 < S.minSurfaceWidth) continue;
      for (let x = s.x0 + S.ledgeMargin; x <= s.x1 - S.ledgeMargin; x += 0.5) if (x > -S.centerWindow && x < S.centerWindow) cands.push({ s, x });
    }
    rng.shuffle(cands);
    for (const c of cands) {
      if (spawns.length >= 4) break;
      if (spawns.some((p) => Math.abs(p.x - c.x) < S.minXGap && Math.abs(p.y - c.s.y) < S.minYGap)) continue;
      if (!free(c.s, c.x - S.bodyClearance, c.x + S.bodyClearance)) continue;
      spawns.push({ x: c.x, y: c.s.y });
      occupied.push({ s: c.s.id, x0: c.x - S.propClearance, x1: c.x + S.propClearance });
    }
  }

  const props: PropSpec[] = [];
  const spots = (): { s: Surface; x: number }[] => {
    const out: { s: Surface; x: number }[] = [];
    for (const s of nav.surfaces) for (let x = s.x0 + L.propEdgeInset; x <= s.x1 - L.propEdgeInset; x += 0.5) out.push({ s, x });
    return rng.shuffle(out);
  };
  const place = (kind: PropKind, count: number, opts: { ground?: boolean; cols?: number; rows?: number } = {}) => {
    const [hw, hh] = propHalf[kind];
    const cols = opts.cols ?? 1;
    const rows = opts.rows ?? 1;
    const halfW = hw * cols;
    let placed = 0;
    for (const sp of spots()) {
      if (placed >= count) break;
      if (opts.ground && sp.s.y > L.groundCoverHeight + groundAt(sp.x)) continue;
      if (sp.s.fragile && kind !== "crate" && kind !== "barrel") continue;
      if (sp.s.liquid) continue;
      const x0 = sp.x - halfW - 0.15;
      const x1 = sp.x + halfW + 0.15;
      const height = hh * 2 * rows + 0.2;
      if (walls.some((wall) => wallCorridor(wall, x0, x1, sp.s.y, height, ruleset))) continue;
      const approach = kind === "block" ? L.blockApproach : 0;
      if (!free(sp.s, x0 - approach, x1 + approach) || !headroom(x0 - approach, x1 + approach, sp.s.y, kind === "block" ? ruleset.arena.walls.clearance : height)) continue;
      occupied.push({ s: sp.s.id, x0: x0 - L.propClearance, x1: x1 + L.propClearance });
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) props.push({ kind, x: sp.x + (c - (cols - 1) / 2) * hw * 2, y: sp.s.y + r * hh * 2 });
      placed++;
    }
    return placed;
  };
  // cover first: block walls and pyramids-ish stacks on the ground
  const nCover = rng.int(...L.coverStacks);
  for (let i = 0; i < nCover; i++) place("block", 1, { ground: i < L.groundCoverStacks, cols: rng.int(...L.coverColumns), rows: rng.int(...L.coverRows) });
  for (const [k, r] of Object.entries(T.props) as [PropKind, [number, number]][]) {
    if (k === "weight") continue;
    const n = rng.int(r[0], r[1]);
    if (k === "barrel") {
      // some in pairs so chain reactions happen
      const pairs = Math.floor(n / L.barrelPairDivisor);
      place("barrel", pairs, { cols: 2 });
      place("barrel", n - pairs * 2);
    } else place(k, n);
  }
  // hanging weights: under platforms with a long drop below
  const nW = rng.int(T.props.weight?.[0] ?? 0, T.props.weight?.[1] ?? 0);
  let hung = 0;
  for (let i = 0; i < L.weightAttempts && hung < nW; i++) {
    const cx = rng.int(2, grid.cols - 3);
    const cy = rng.int(cyOf(L.weightMinAnchorY), cyOf(L.top));
    if (!grid.solid(cx, cy) || grid.solid(cx, cy - 1) || cy - 1 < 0) continue;
    if (!grid.emptyRect(cx - 2, cy - L.weightFloorClearCells, cx + 2, cy - 1)) continue;
    const ax = grid.wx(cx) + CELL / 2;
    const ay = grid.wy(cy);
    if (spawns.some((s) => Math.abs(s.x - ax) < L.weightSpawnGap)) continue;
    const len = q(rng.range(...L.weightLength));
    props.push({ kind: "weight", x: ax, y: ay - len - 1, ax, ay, len });
    hung++;
  }

  // zone center: near a pit close to the middle (ring-outs), else near 0
  const zoneCenter = spreadCenter ?? chooseZoneCenter();

  return {
    seed,
    attempt,
    theme,
    name: theme.toUpperCase(),
    width: W,
    minX: -W / 2,
    maxX: W / 2,
    grid,
    props,
    spawns,
    pits,
    // a level with no pools has no key (its fingerprint is as before #94)
    ...(pools.length ? { pools } : {}),
    zoneCenter,
    platforms,
    towers: walls.length,
    walls,
    bridges,
  };
}

/**
 * Liquid pools (#94): each a basin dug into one flat stretch of ground (its rim the same height on both sides), away
 * from the pits, the arena's edges and the other pools, its floor above the bedrock, filled to the rim. Static until
 * the terrain around it is carved (sim-liquid.ts lets it spill and settle). Themes with no pools draw nothing here.
 */
function digPools(
  grid: Grid, top: number[], pits: { x0: number; x1: number }[], left: number, right: number, H: Ruleset["arena"]["themes"][Theme]["hazards"],
  rng: Rng, cxOf: (x: number) => number, cyOf: (y: number) => number, bedrockRows: number,
): NonNullable<LevelDef["pools"]> {
  const pools: NonNullable<LevelDef["pools"]> = [];
  if (H.pools[1] <= 0) return pools;
  const want = rng.int(H.pools[0], H.pools[1]);
  const kinds: [Liquid, number][] = [[Liquid.Water, H.water], [Liquid.Oil, H.oil], [Liquid.Lava, H.lava], [Liquid.Acid, H.acid]];
  const total = kinds.reduce((a, k) => a + k[1], 0);
  for (let i = 0; i < want * 12 && pools.length < want; i++) {
    const w = Math.max(CELL * 2, q(rng.range(...H.width)));
    const x0 = q(rng.range(left + 3, right - 3 - w));
    const x1 = x0 + w;
    const depth = rng.int(H.depth[0], H.depth[1]);
    let pick = rng.range(0, total);
    let liquid = Liquid.Water;
    for (const [k, wt] of kinds) {
      if (wt <= 0) continue;
      liquid = k;
      if ((pick -= wt) < 0) break;
    }
    const c0 = cxOf(x0);
    const c1 = cxOf(x1) - 1;
    const y = top[c0]!;
    if (!Number.isFinite(y)) continue;
    let flat = true;
    for (let cx = c0 - 2; cx <= c1 + 2; cx++) if (top[cx] !== y) flat = false;
    if (!flat) continue;
    if (pits.some((p) => x0 < p.x1 + 2 && x1 > p.x0 - 2)) continue;
    if (pools.some((p) => x0 < p.x1 + 4 && x1 > p.x0 - 4)) continue;
    const ty = cyOf(y);
    if (ty - depth < bedrockRows + 1) continue;
    for (let cx = c0; cx <= c1; cx++) {
      for (let cy = ty - depth; cy < ty; cy++) {
        grid.clear(cx, cy);
        grid.liq[grid.idx(cx, cy)] = liquid;
      }
    }
    // #114: a muddy creek: mud lines the basin's walls and tops the banks (not its floor: mud's weaker jump would leave
    // a fighter on the floor of a drained basin unable to climb out)
    const bank = H.bankCells;
    if (bank > 0) {
      const mud = (cx: number, cy: number) => { const m = grid.matAt(cx, cy); if (cy >= bedrockRows && m !== Mat.Empty && m !== Mat.Bedrock) grid.set(cx, cy, Mat.Mud, grid.flags[grid.idx(cx, cy)]); };
      for (let cy = ty - depth - 1; cy < ty; cy++) { mud(c0 - 1, cy); mud(c1 + 1, cy); }
      for (let k = 1; k <= bank; k++) { mud(c0 - k, ty - 1); mud(c1 + k, ty - 1); }
    }
    pools.push({ x0, x1, y, depth, liquid });
  }
  return pools;
}
