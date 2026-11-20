/**
 * Seeded procedural level generator. Deterministic: the same seed always gives
 * the same level (the seed is in the match record). Each level gets a theme
 * that changes the shapes, materials and prop mix.
 *
 * Layout: ground masses separated by pits and void edges, steps, overhangs,
 * bridges, jumpable walls, and many floating platforms (hung from anchor
 * cells). Every cell except the bottom bedrock rows can be destroyed.
 *
 * If a candidate fails validation the generator retries with the next attempt
 * number (also deterministic).
 */
import { CELL, F_ANCHOR, F_BRIDGE, Grid, Mat } from "./grid";
import { hasWallRoute, placeWalls, wallCorridor, WALL_CLEARANCE, type Wall } from "./level-walls";
import { NavGraph, type Surface } from "./nav";
import { Rng } from "./rng";

export type Theme = "warehouse" | "rooftop" | "junkyard" | "construction";
export const THEMES: readonly Theme[] = ["warehouse", "rooftop", "junkyard", "construction"];

export type PropKind = "block" | "crate" | "barrel" | "gas" | "tnt" | "steel" | "glass" | "pad" | "weight";

/** Half extents per prop kind (meters). */
export const PROP_HALF: Record<PropKind, [number, number]> = {
  block: [0.45, 0.45],
  crate: [0.4, 0.4],
  barrel: [0.34, 0.5],
  gas: [0.22, 0.55],
  tnt: [0.4, 0.3],
  steel: [0.5, 0.5],
  glass: [0.08, 0.9],
  pad: [0.6, 0.15],
  weight: [0.5, 0.5],
};

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

export interface Validation {
  ok: boolean;
  reasons: string[];
}

const ROWS = 64; // 32 m tall: y from -8 to 24
const Y0 = -8;
const MAX_TOP = 13; // nothing solid above this (camera fit)

const q = (v: number) => Math.round(v * 2) / 2; // to the cell grid
const q1 = (v: number) => Math.round(v);

interface ThemeSpec {
  body: Mat;
  surface: Mat;
  platform: Mat[];
  tower: Mat;
  bridge: Mat[];
  pitChance: number;
  extraPits: [number, number];
  towers: [number, number];
  platforms: [number, number];
  crumble: number;
  props: Partial<Record<PropKind, [number, number]>>;
  stepy: boolean;
}

const SPEC: Record<Theme, ThemeSpec> = {
  warehouse: {
    body: Mat.Concrete,
    surface: Mat.Concrete,
    platform: [Mat.Steel, Mat.Wood, Mat.Wood],
    tower: Mat.Steel,
    bridge: [Mat.Steel, Mat.Wood],
    pitChance: 0.6,
    extraPits: [0, 1],
    towers: [2, 3],
    platforms: [11, 15],
    crumble: 0.08,
    props: { crate: [6, 9], steel: [2, 4], barrel: [4, 6], gas: [2, 4], glass: [1, 3], weight: [1, 3], pad: [1, 2], tnt: [0, 1] },
    stepy: false,
  },
  rooftop: {
    body: Mat.Brick,
    surface: Mat.Concrete,
    platform: [Mat.Concrete, Mat.Wood, Mat.Steel],
    tower: Mat.Brick,
    bridge: [Mat.Wood, Mat.Wood, Mat.Steel],
    pitChance: 0.85,
    extraPits: [1, 2],
    towers: [1, 2],
    platforms: [10, 14],
    crumble: 0.12,
    props: { glass: [4, 6], gas: [2, 3], barrel: [3, 5], crate: [3, 5], pad: [2, 3], tnt: [1, 2], weight: [1, 2], steel: [1, 2] },
    stepy: false,
  },
  junkyard: {
    body: Mat.Dirt,
    surface: Mat.Dirt,
    platform: [Mat.Steel, Mat.Wood, Mat.Steel],
    tower: Mat.Steel,
    bridge: [Mat.Wood, Mat.Steel],
    pitChance: 0.55,
    extraPits: [0, 1],
    towers: [1, 2],
    platforms: [10, 13],
    crumble: 0.15,
    props: { barrel: [7, 10], steel: [3, 5], tnt: [1, 3], crate: [3, 5], gas: [1, 3], pad: [1, 2], glass: [0, 1], weight: [0, 1] },
    stepy: true,
  },
  construction: {
    body: Mat.Dirt,
    surface: Mat.Dirt,
    platform: [Mat.Steel, Mat.Wood, Mat.Crumble],
    tower: Mat.Steel,
    bridge: [Mat.Steel, Mat.Wood],
    pitChance: 0.6,
    extraPits: [0, 1],
    towers: [2, 3],
    platforms: [11, 15],
    crumble: 0.22,
    props: { tnt: [2, 4], weight: [2, 3], crate: [3, 5], barrel: [3, 5], gas: [1, 3], steel: [1, 3], pad: [1, 2], glass: [0, 2] },
    stepy: true,
  },
};

/** Theme for a seed (stable across generator attempts). */
export function themeFor(seed: number): Theme {
  return THEMES[new Rng((seed ^ 0x7e3a11) >>> 0).u32() % THEMES.length]!;
}

export function generateLevel(seed: number, maxAttempts = 30): LevelDef {
  let last: LevelDef | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const lv = buildCandidate(seed, attempt);
    last = lv;
    if (validateLevel(lv).ok) return lv;
  }
  // Practically unreachable (see tests); fall back to the last candidate.
  return last!;
}

function buildCandidate(seed: number, attempt: number): LevelDef {
  const theme = themeFor(seed);
  const T = SPEC[theme];
  const rng = new Rng((Math.imul(seed >>> 0, 0x9e3779b1) ^ (attempt * 0x85ebca6b) ^ 0x2545f491) >>> 0);
  const W = 2 * rng.int(28, 38);
  const grid = new Grid(W / CELL, ROWS, -W / 2, Y0);
  const cyOf = (y: number) => Math.round((y - Y0) / CELL);
  const cxOf = (x: number) => Math.round((x + W / 2) / CELL);

  // ------------------------------------------------------------ pits
  const left = -W / 2 + q(rng.range(1.5, 4));
  const right = W / 2 - q(rng.range(1.5, 4));
  const pits: { x0: number; x1: number }[] = [];
  if (rng.chance(T.pitChance)) {
    const w = q(rng.range(3.5, 6));
    const x0 = q(rng.range(-5, 5 - w));
    pits.push({ x0, x1: x0 + w });
  }
  const extra = rng.int(T.extraPits[0], T.extraPits[1]);
  for (let i = 0; i < extra * 3 && pits.length < 1 + extra; i++) {
    const w = q(rng.range(3.5, 5.5));
    const side = rng.chance(0.5) ? -1 : 1;
    const x0 = side < 0 ? q(rng.range(left + 6, -11 - w)) : q(rng.range(11, right - 6 - w));
    if (pits.every((p) => x0 > p.x1 + 7 || x0 + w < p.x0 - 7)) pits.push({ x0, x1: x0 + w });
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
    const base = theme === "rooftop" ? q1(rng.range(-1, 3.5)) : q1(rng.range(-0.5, 1));
    let h = base;
    let x = s.x0;
    while (x < s.x1 - 1e-6) {
      const run = theme === "rooftop" ? s.x1 - s.x0 : rng.range(3, 7);
      const xe = Math.min(s.x1, q(x + run));
      for (let cx = cxOf(x); cx < cxOf(xe); cx++) top[cx] = h;
      if (T.stepy || theme === "warehouse") h = Math.max(base - 1, Math.min(base + 2, h + rng.pick([-1, 0, 0, 1])));
      x = xe;
    }
  }
  for (let cx = 0; cx < grid.cols; cx++) {
    if (top[cx] === -Infinity) continue;
    const ty = cyOf(top[cx]!);
    for (let cy = 0; cy < ty; cy++) {
      let m: Mat = cy < 2 ? Mat.Bedrock : cy === ty - 1 ? T.surface : T.body;
      if (theme === "junkyard" && m === Mat.Dirt && rng.chance(0.12)) m = Mat.Rock;
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
        if (edge < 0 || edge >= grid.cols || top[edge] === -Infinity || !rng.chance(0.5)) continue;
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
    const isCenter = p.x0 < 6 && p.x1 > -6;
    if (lt > -Infinity && rt > -Infinity && Math.abs(lt - rt) <= 1 && rng.chance(isCenter ? 0.85 : 0.5) && wide <= 7) {
      const cy = cyOf(Math.min(lt, rt)) - 1;
      const m = rng.pick(T.bridge);
      for (let cx = lc + 1; cx < rc; cx++) grid.set(cx, cy, m, F_BRIDGE);
      bridges++;
    } else {
      for (const [c, t, dir] of [
        [lc, lt, 1],
        [rc, rt, -1],
      ] as const) {
        if (t === -Infinity || !rng.chance(0.4)) continue;
        const n = Math.min(rng.int(2, 4), Math.floor((wide - 3) / CELL / 2));
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
  const clear = (cx0: number, cy0: number, cx1: number, cy1: number) => grid.emptyRect(cx0 - 2, cy0 - 4, cx1 + 2, cy1 + 4);

  // ------------------------------------------------------------ floating platforms
  const target = rng.int(T.platforms[0], T.platforms[1]);
  for (let i = 0; i < 160 && platforms < target; i++) {
    const len = q(rng.range(3, 7));
    const cxm = cxOf(q(rng.range(left + 2, right - 2)));
    const n = len / CELL;
    const cx0 = cxm - Math.floor(n / 2);
    const cx1 = cx0 + n - 1;
    if (cx0 < 2 || cx1 >= grid.cols - 2) continue;
    let gy = -Infinity;
    for (let cx = cx0; cx <= cx1; cx++) gy = Math.max(gy, top[cx]!);
    if (gy === -Infinity) gy = 0;
    const y = q(gy + rng.pick([3, 3, 3.5, 5.5, 6, 8, 8.5, 10.5]));
    const thick = rng.chance(0.25) ? 2 : 1;
    const cyTop = cyOf(y) - 1;
    const cyBot = cyTop - thick + 1;
    if (y > MAX_TOP || !clear(cx0, cyBot, cx1, cyTop)) continue;
    const m = rng.chance(T.crumble) ? Mat.Crumble : rng.pick(T.platform);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cyBot; cy <= cyTop; cy++) grid.set(cx, cy, m);
    // anchors: the end cells hold the platform up (hanging from above)
    grid.flags[grid.idx(cx0, cyTop)]! |= F_ANCHOR;
    grid.flags[grid.idx(cx1, cyTop)]! |= F_ANCHOR;
    platforms++;
  }

  const walls = placeWalls(grid, top, rng.int(T.towers[0], T.towers[1]), T.tower, rng);

  // ------------------------------------------------------------ spawns + props
  const nav = NavGraph.fromGrid(grid);
  const occupied: { s: number; x0: number; x1: number }[] = [];
  const free = (s: Surface, x0: number, x1: number) =>
    x0 >= s.x0 + 0.3 && x1 <= s.x1 - 0.3 && occupied.every((o) => o.s !== s.id || x1 < o.x0 || x0 > o.x1);
  const headroom = (x0: number, x1: number, y: number, h: number) => grid.emptyRect(grid.cx(x0 + 0.01), grid.cy(y + 0.01), grid.cx(x1 - 0.01), grid.cy(y + h - 0.01));

  // spawns: near the center, apart, not on fragile surfaces or right at a drop
  const spawns: { x: number; y: number }[] = [];
  const cands: { s: Surface; x: number }[] = [];
  for (const s of nav.surfaces) {
    if (s.fragile || s.x1 - s.x0 < 2.5) continue;
    for (let x = s.x0 + 1.2; x <= s.x1 - 1.2; x += 0.5) if (x > -12 && x < 12) cands.push({ s, x });
  }
  rng.shuffle(cands);
  for (const c of cands) {
    if (spawns.length >= 4) break;
    if (spawns.some((p) => Math.abs(p.x - c.x) < 3.5 && Math.abs(p.y - c.s.y) < 2)) continue;
    if (!free(c.s, c.x - 0.7, c.x + 0.7)) continue;
    spawns.push({ x: c.x, y: c.s.y });
    occupied.push({ s: c.s.id, x0: c.x - 1.4, x1: c.x + 1.4 });
  }

  const props: PropSpec[] = [];
  const spots = (): { s: Surface; x: number }[] => {
    const out: { s: Surface; x: number }[] = [];
    for (const s of nav.surfaces) for (let x = s.x0 + 0.8; x <= s.x1 - 0.8; x += 0.5) out.push({ s, x });
    return rng.shuffle(out);
  };
  const place = (kind: PropKind, count: number, opts: { ground?: boolean; cols?: number; rows?: number } = {}) => {
    const [hw, hh] = PROP_HALF[kind];
    const cols = opts.cols ?? 1;
    const rows = opts.rows ?? 1;
    const halfW = hw * cols;
    let placed = 0;
    for (const sp of spots()) {
      if (placed >= count) break;
      if (opts.ground && sp.s.y > 2.5 + groundAt(sp.x)) continue;
      if (sp.s.fragile && kind !== "crate" && kind !== "barrel") continue;
      const x0 = sp.x - halfW - 0.15;
      const x1 = sp.x + halfW + 0.15;
      const height = hh * 2 * rows + 0.2;
      if (walls.some((wall) => wallCorridor(wall, x0, x1, sp.s.y, height))) continue;
      const approach = kind === "block" ? 0.75 : 0;
      if (!free(sp.s, x0 - approach, x1 + approach) || !headroom(x0 - approach, x1 + approach, sp.s.y, kind === "block" ? WALL_CLEARANCE : height)) continue;
      occupied.push({ s: sp.s.id, x0: x0 - 0.3, x1: x1 + 0.3 });
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) props.push({ kind, x: sp.x + (c - (cols - 1) / 2) * hw * 2, y: sp.s.y + r * hh * 2 });
      placed++;
    }
    return placed;
  };
  // cover first: block walls and pyramids-ish stacks on the ground
  const nCover = rng.int(3, 5);
  for (let i = 0; i < nCover; i++) place("block", 1, { ground: i < 3, cols: rng.int(1, 2), rows: rng.int(1, 2) });
  for (const [k, r] of Object.entries(T.props) as [PropKind, [number, number]][]) {
    if (k === "weight") continue;
    const n = rng.int(r[0], r[1]);
    if (k === "barrel") {
      // some in pairs so chain reactions happen
      const pairs = Math.floor(n / 3);
      place("barrel", pairs, { cols: 2 });
      place("barrel", n - pairs * 2);
    } else place(k, n);
  }
  // hanging weights: under platforms with a long drop below
  const nW = rng.int(T.props.weight?.[0] ?? 0, T.props.weight?.[1] ?? 0);
  let hung = 0;
  for (let i = 0; i < 200 && hung < nW; i++) {
    const cx = rng.int(2, grid.cols - 3);
    const cy = rng.int(cyOf(3), cyOf(MAX_TOP));
    if (!grid.solid(cx, cy) || grid.solid(cx, cy - 1) || cy - 1 < 0) continue;
    if (!grid.emptyRect(cx - 2, cy - 10, cx + 2, cy - 1)) continue;
    const ax = grid.wx(cx) + CELL / 2;
    const ay = grid.wy(cy);
    if (spawns.some((s) => Math.abs(s.x - ax) < 2)) continue;
    const len = q(rng.range(1.5, 2.5));
    props.push({ kind: "weight", x: ax, y: ay - len - 1, ax, ay, len });
    hung++;
  }

  // zone center: near a pit close to the middle (ring-outs), else near 0
  const near = pits.filter((p) => Math.abs((p.x0 + p.x1) / 2) < 12);
  const zoneCenter = near.length ? q((near[0]!.x0 + near[0]!.x1) / 2) : q(rng.range(-4, 4));

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

/** Checks a generated level is playable and fits the camera. */
export function validateLevel(lv: LevelDef): Validation {
  const reasons: string[] = [];
  const g = lv.grid;
  if (lv.width < 56 || lv.width > 76) reasons.push(`width ${lv.width}`);
  if (lv.spawns.length !== 4) reasons.push(`spawns ${lv.spawns.length}`);
  const nav = NavGraph.fromGrid(g);
  const surf = lv.spawns.map((s) => nav.surfaceAt(s.x, s.y + 0.05, 0));
  if (surf.some((s) => !s)) reasons.push("spawn off a surface");
  else {
    for (let i = 0; i < surf.length; i++) {
      const s = surf[i]!;
      const sp = lv.spawns[i]!;
      if (s.y < -1.5) reasons.push("spawn in a pit");
      if ((s.dropLeft && sp.x - s.x0 < 1) || (s.dropRight && s.x1 - sp.x < 1)) reasons.push("spawn at a drop");
      const plan = nav.plan(s.id, sp.x);
      for (let j = 0; j < surf.length; j++) if (j !== i && plan.cost[surf[j]!.id] === Infinity) reasons.push(`no route ${i}->${j}`);
    }
    const xs = lv.spawns.map((s) => s.x);
    if (Math.max(...xs) - Math.min(...xs) > 24) reasons.push("spawns too spread");
  }
  for (const wall of lv.walls ?? []) if (!hasWallRoute(g, nav, wall)) reasons.push(`wall at ${wall.x0} has no route`);
  const cover = lv.props.filter((p) => p.kind === "block").length;
  if (cover < 6) reasons.push(`cover ${cover}`);
  if (lv.props.length < 18) reasons.push(`props ${lv.props.length}`);
  if (lv.platforms < 7) reasons.push(`platforms ${lv.platforms}`);
  // camera fit: nothing solid above MAX_TOP
  for (let cy = g.cy(MAX_TOP + 0.01); cy < g.rows; cy++) for (let cx = 0; cx < g.cols; cx++) if (g.solid(cx, cy)) {
    reasons.push("too tall");
    cy = g.rows;
    break;
  }
  // a ledge to fall off near the action
  const hasDrop = nav.surfaces.some((s) => (s.dropLeft && Math.abs(s.x0 - lv.zoneCenter) < 16) || (s.dropRight && Math.abs(s.x1 - lv.zoneCenter) < 16));
  if (!hasDrop) reasons.push("no drop near the center");
  return { ok: reasons.length === 0, reasons };
}
