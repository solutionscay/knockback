import { CELL } from "./grid";
import type { NavGraph, Surface } from "./nav";
import type { Rng } from "./rng";
import type { Ruleset } from "./ruleset";

const SEATS = 4;
const CANDIDATES_PER_QUARTER = 24;

export interface SpawnPoint {
  x: number;
  y: number;
}
interface Candidate extends SpawnPoint {
  surface: Surface;
  elevated: boolean;
  score: number;
}

export function arenaQuarter(minX: number, width: number, x: number): number {
  return Math.min(SEATS - 1, Math.max(0, Math.floor((x - minX) * SEATS / width)));
}

export function quarterCenter(minX: number, width: number, quarter: number): number {
  return minX + (quarter + 0.5) * width / SEATS;
}

export function spawnSafeBounds(width: number, center: number, ruleset: Ruleset): [number, number] {
  const half = width / 2 - ruleset.zone.boundary.edgeInset - ruleset.arena.spawns.spread.zoneMargin;
  return [Math.max(-width / 2, center - half), Math.min(width / 2, center + half)];
}

function tooClose(a: SpawnPoint, b: SpawnPoint, minDistance: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < minDistance * minDistance;
}

export function spreadSpawnProblems(points: readonly SpawnPoint[], width: number, center: number, ruleset: Ruleset): string[] {
  const spread = ruleset.arena.spawns.spread;
  const [lo, hi] = spawnSafeBounds(width, center, ruleset);
  const reasons: string[] = [];
  if (new Set(points.map(p => arenaQuarter(-width / 2, width, p.x))).size !== SEATS) reasons.push("need one spawn per arena quarter");
  if (points.some(p => p.x < lo || p.x > hi)) reasons.push("spawn too close to the starting zone edge");
  if (points.some((p, i) => points.slice(0, i).some(q => tooClose(p, q, spread.minDistance)))) reasons.push("spawns too close together");
  const ys = points.map(p => p.y);
  if (Math.max(...ys) - Math.min(...ys) < spread.heightDifference) reasons.push("spawns need more height variety");
  return reasons;
}

/** Pick one connected route across four quarters, preferring seeded X targets and mixed heights. */
export function spreadSpawns(
  nav: NavGraph, width: number, center: number, groundAt: (x: number) => number,
  rng: Rng, ruleset: Ruleset, isClear: (s: Surface, x: number) => boolean,
): SpawnPoint[] {
  const { spread, minHeight, minSurfaceWidth, ledgeMargin, minDropMargin } = ruleset.arena.spawns;
  const [lo, hi] = spawnSafeBounds(width, center, ruleset);
  const minX = -width / 2;
  const targets = Array.from({ length: SEATS }, (_, i) => {
    const outset = i === 0 || i === SEATS - 1 ? spread.outerOutset : spread.innerOutset;
    const direction = i < SEATS / 2 ? -1 : 1;
    return quarterCenter(minX, width, i) + (rng.range(-spread.jitter, spread.jitter) + direction * outset) * width / SEATS;
  });
  const elevatedParity = rng.int(0, 1);
  const byQuarter: Candidate[][] = Array.from({ length: SEATS }, () => []);
  for (const surface of nav.surfaces) {
    if (surface.fragile || surface.y < minHeight || surface.x1 - surface.x0 < minSurfaceWidth) continue;
    const left = surface.dropLeft ? Math.max(ledgeMargin, minDropMargin) : ledgeMargin;
    const right = surface.dropRight ? Math.max(ledgeMargin, minDropMargin) : ledgeMargin;
    for (let x = surface.x0 + left; x <= surface.x1 - right; x += CELL) {
      if (x < lo || x > hi || !isClear(surface, x)) continue;
      const quarter = arenaQuarter(minX, width, x);
      const elevated = surface.y - groundAt(x) >= spread.ledgeHeight;
      const heightPenalty = elevated === (quarter % 2 === elevatedParity) ? 0 : width / SEATS;
      byQuarter[quarter]!.push({ x, y: surface.y, surface, elevated, score: Math.abs(x - targets[quarter]!) + heightPenalty });
    }
  }
  if (byQuarter.some(candidates => !candidates.length)) return [];

  const reach = new Map<number, Set<number>>();
  const reachable = (id: number): Set<number> => {
    const cached = reach.get(id);
    if (cached) return cached;
    const seen = new Set([id]);
    const queue = [id];
    for (const from of queue) for (const { to } of nav.out[from]!) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
    reach.set(id, seen);
    return seen;
  };
  const connected = (a: Candidate, b: Candidate) =>
    reachable(a.surface.id).has(b.surface.id) && reachable(b.surface.id).has(a.surface.id);
  // Drop isolated surfaces before taking the best candidates. Stable sort leaves surface/X order as the tie-breaker.
  const choices = byQuarter.map((candidates, quarter) => candidates
    .filter(a => byQuarter.every((others, i) => i === quarter || others.some(b => connected(a, b))))
    .sort((a, b) => a.score - b.score)
    .slice(0, CANDIDATES_PER_QUARTER));
  const chosen: Candidate[] = [];
  const visit = (quarter: number): boolean => {
    if (quarter === SEATS) {
      const xs = chosen.map(p => p.x);
      const ys = chosen.map(p => p.y);
      return Math.max(...xs) - Math.min(...xs) <= ruleset.arena.spawns.maxSpread
        && Math.max(...ys) - Math.min(...ys) >= spread.heightDifference
        && chosen.some(p => p.elevated) && chosen.some(p => !p.elevated);
    }
    for (const next of choices[quarter]!) {
      if (chosen.some(p => !connected(next, p) || tooClose(next, p, spread.minDistance))) continue;
      chosen.push(next);
      if (visit(quarter + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  return visit(0) ? chosen.map(({ x, y }) => ({ x, y })) : [];
}
