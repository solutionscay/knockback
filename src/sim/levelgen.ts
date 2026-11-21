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
import { CELL, F_ANCHOR, F_BRIDGE, Grid, Mat } from "./grid";
import { placeWalls, wallCorridor, type Wall } from "./level-walls";
import { NavGraph, type Surface } from "./nav";
import { Rng } from "./rng";

import { type PropKind, type Theme } from "./level-config";
import { validateLevel } from "./level-validate";
import { CLASSIC, RulesetError, type Ruleset } from "./ruleset";
import { spreadSpawns } from "./level-spawns";
export { PROP_HALF, THEMES, type PropKind, type Theme } from "./level-config";

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

export function generateLevel(seed: number, maxAttempts?: number, ruleset: Ruleset = CLASSIC): LevelDef {
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
    const base = theme === "rooftop" ? q1(rng.range(...L.rooftopHeight)) : q1(rng.range(...L.groundHeight));
    let h = base;
    let x = s.x0;
    while (x < s.x1 - 1e-6) {
      const run = theme === "rooftop" ? s.x1 - s.x0 : rng.range(...L.groundRun);
      const xe = Math.min(s.x1, q(x + run));
      for (let cx = cxOf(x); cx < cxOf(xe); cx++) top[cx] = h;
      if (T.stepy || theme === "warehouse") h = Math.max(base + L.groundMin, Math.min(base + L.groundMax, h + rng.pick(L.groundStep)));
      x = xe;
    }
  }
  for (let cx = 0; cx < grid.cols; cx++) {
    if (top[cx] === -Infinity) continue;
    const ty = cyOf(top[cx]!);
    for (let cy = 0; cy < ty; cy++) {
      let m: Mat = cy < L.bedrockRows ? Mat.Bedrock : cy === ty - 1 ? T.surface : T.body;
      if (theme === "junkyard" && m === Mat.Dirt && rng.chance(L.junkRockChance)) m = Mat.Rock;
      grid.set(cx, cy, m);
    }
  }
  // rooftop parapets
  if (theme === "rooftop") {
    for (const p of pits) {
      for (const [edge, dir] of [
        [cxOf(p.x0) - 1, -1],
        [cxOf(p.x1), 1],
      ] as const) {
        if (edge < 0 || edge >= grid.cols || top[edge] === -Infinity || !rng.chance(L.parapetChance)) continue;
        const cy = cyOf(top[edge]!);
        grid.set(edge + dir * 2, cy, Mat.Brick);
      }
    }
  }

  // ------------------------------------------------------------ overhangs + bridges
  let bridges = 0;
  for (const p of pits) {
    const lc = cxOf(p.x0) - 1;
    const rc = cxOf(p.x1);
    const lt = lc >= 0 ? top[lc]! : -Infinity;
    const rt = rc < grid.cols ? top[rc]! : -Infinity;
    const wide = p.x1 - p.x0;
    const isCenter = p.x0 < L.bridgeCenter && p.x1 > -L.bridgeCenter;
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
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cyBot; cy <= cyTop; cy++) grid.set(cx, cy, m);
    // anchors: the end cells hold the platform up (hanging from above)
    grid.flags[grid.idx(cx0, cyTop)]! |= F_ANCHOR;
    grid.flags[grid.idx(cx1, cyTop)]! |= F_ANCHOR;
    platforms++;
  }

  const walls = placeWalls(grid, top, rng.int(T.towers[0], T.towers[1]), T.tower, rng, ruleset);

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
    zoneCenter,
    platforms,
    towers: walls.length,
    walls,
    bridges,
  };
}
