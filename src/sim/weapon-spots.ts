/**
 * Where weapons appear (#95): start weapons, supply drops and sky drops pick their spot here, so weapons stay few and
 * spread out. The rules (ruleset pickups.spots):
 *   - a nav point on solid ground with room above it, inside the zone as it will be a little later;
 *   - one that as many fighters as possible can reach (at the start: every spawn);
 *   - at least itemGap from loose weapons, fighterGap from fighters (spawns at the start) and recentGap from where a
 *     weapon was picked up lately; when no point qualifies, the gaps shrink step by step;
 *   - across areas: the arena's quarters, each split into low ground and high, the emptiest area first.
 * Pure over the sim state and the given rng (deterministic).
 */
import { arenaQuarter } from "./level-spawns";
import type { Rng } from "./rng";
import type { Sim } from "./sim";
import { isPickupWeapon, type Entity, type Fighter } from "./sim-types";

type Point = { x: number; y: number };

/** Loose weapons on the floor. */
export function looseWeapons(sim: Sim): Point[] {
  const out: Point[] = [];
  for (const e of sim.entities.values()) if (e.kind === "item" && !e.dead && isPickupWeapon(e.itemType)) out.push(e.body.translation());
  return out;
}

/**
 * Loose weapons still in play: inside the zone (or within the 2 m past its edge that spots may use), on ground some living fighter can go to and come back from. Weapons
 * outside the zone or stranded count for nothing (the cap on loose weapons counts only these, #95).
 */
export function liveWeapons(sim: Sim): number {
  const z = sim.zone;
  const nav = sim.nav;
  const origins = sim.alive().flatMap((f) => (f.surface >= 0 && f.surface < nav.surfaces.length ? [f.surface] : []));
  let counts: number[] | null = null;
  let n = 0;
  for (const p of looseWeapons(sim)) {
    if (Math.abs(p.x - z.center) > z.half + 2) continue;
    const s = nav.surfaceAt(p.x, p.y + 0.3, 0.2);
    if (s && origins.length) {
      counts ??= reachCounts(sim, origins);
      if (!counts[s.id]) continue;
    }
    n++;
  }
  return n;
}

/** Bare-handed, or what it carries does not reach the nearest rival (#95: one slot, a duel across a pit). */
export function needy(sim: Sim, f: Fighter): boolean {
  const w = f.weapons[1];
  if (w === "fist") return true;
  const p = sim.pos(f);
  let d = Infinity;
  for (const o of sim.alive()) if (o !== f && !o.removed) d = Math.min(d, Math.hypot(sim.pos(o).x - p.x, sim.pos(o).y - p.y));
  return Number.isFinite(d) && sim.ruleset.tactics.weapons.reach[w].max < d;
}

/** Where a weapon was picked up within the last recentTicks (older ones are dropped from the list). */
function recentPickups(sim: Sim): Point[] {
  const keep = sim.ruleset.pickups.spots.recentTicks;
  sim.recentPickups = sim.recentPickups.filter((p) => sim.tick - p.tick <= keep);
  return sim.recentPickups;
}

/** Per surface, how many origin surfaces can go there and come back (the round trip the start caches use, #16). */
function reachCounts(sim: Sim, origins: number[]): number[] {
  const nav = sim.nav;
  const back: number[][] = nav.surfaces.map(() => []);
  for (const links of nav.out) for (const l of links) back[l.to]?.push(l.from);
  const walk = (start: number, next: (id: number) => Iterable<number>) => {
    const seen = new Set([start]);
    const queue = [start];
    for (const from of queue) for (const to of next(from)) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
    return seen;
  };
  const counts = nav.surfaces.map(() => 0);
  for (const start of origins) {
    const there = walk(start, (id) => (nav.out[id] ?? []).map((l) => l.to));
    const home = walk(start, (id) => back[id] ?? []);
    for (const s of there) if (home.has(s)) counts[s]!++;
  }
  return counts;
}

const nearest = (p: Point, others: readonly Point[]) => others.reduce((d, q) => Math.min(d, Math.hypot(p.x - q.x, p.y - q.y)), Infinity);

/**
 * A spot for a new weapon, or null when the arena has no ground for it. `spawns`: the round start (the spawns stand in
 * for fighters, every spawn must reach the spot); `placed`: weapons placed in the same batch, not yet in the world.
 */
export function weaponSpot(sim: Sim, rng: Rng, spawns: readonly Point[] | null = null, placed: readonly Point[] = []): Point | null {
  const cfg = sim.ruleset.pickups.spots;
  const nav = sim.nav;
  const z = sim.zone;
  const size = sim.ruleset.pickups.item.size;
  const props = spawns ? sim.level.props : [];
  const underProp = (p: Point) => props.some((prop) => {
    const [hw, hh] = sim.ruleset.arena.propHalf[prop.kind];
    return Math.abs(prop.x - p.x) < hw + 0.25 && p.y + 0.4 >= prop.y && p.y + 0.4 < prop.y + hh * 2 + 0.25;
  });
  // reachable by as many fighters as possible; mid-round, by as many of the needy ones (bare-handed, or carrying
  // nothing that reaches the nearest rival)
  const known = (f: Fighter) => f.surface >= 0 && f.surface < nav.surfaces.length;
  const bareOnes = spawns ? [] : sim.alive().filter((f) => known(f) && needy(sim, f));
  const origins = spawns
    ? spawns.flatMap((p) => {
      const s = nav.surfaceAt(p.x, p.y + 0.05);
      return s ? [s.id] : [];
    })
    : (bareOnes.length ? bareOnes : sim.alive().filter(known)).map((f) => f.surface);
  const counts = origins.length ? reachCounts(sim, origins) : null;
  // inside the zone (a meter in from its edge); a narrow zone with nothing reachable inside widens to its edge, then
  // a little past it (fighters at bay on the ledges either side of a sudden-death zone)
  const half0 = Math.min(z.half, sim.zoneHalfAhead(cfg.zoneAhead));
  let points: typeof nav.points = [];
  for (const margin of [-1, 0, 2]) {
    const lo = Math.max(sim.level.minX + 1, z.center - half0 - margin);
    const hi = Math.min(sim.level.maxX - 1, z.center + half0 + margin);
    points = nav.points.filter((p) => p.x >= lo && p.x <= hi && !nav.surfaces[p.surface]!.fragile && !sim.grid.solidAt(p.x, p.y + size) && !underProp(p));
    if (counts) {
      const best = Math.max(0, ...points.map((p) => counts[p.surface]!));
      // nowhere they can get to: no spot (the caller drops the old way)
      points = best === 0 ? [] : points.filter((p) => counts[p.surface] === best);
    }
    if (points.length) break;
  }
  if (!points.length) return null;
  // not on the lip of a drop: a fighter running for it should not run off the edge
  const inside = points.filter((p) => {
    const s = nav.surfaces[p.surface]!;
    return !(s.dropLeft && p.x - s.x0 < cfg.edgeGap) && !(s.dropRight && s.x1 - p.x < cfg.edgeGap);
  });
  if (inside.length) points = inside;
  const items = [...looseWeapons(sim), ...placed];
  const people = spawns ?? sim.alive().map((f) => sim.pos(f));
  const peopleGap = spawns ? cfg.startSpawnGap : cfg.fighterGap;
  const recent = spawns ? [] : recentPickups(sim);
  const scored = points.map((p) => ({ p, items: nearest(p, items), people: nearest(p, people), recent: nearest(p, recent) }));
  let eligible: typeof scored = [];
  for (let k = 0, f = 1; k < 6 && !eligible.length; k++, f *= cfg.relax) {
    eligible = scored.filter((s) => s.items >= cfg.itemGap * f && s.people >= peopleGap * f && s.recent >= cfg.recentGap * f);
  }
  if (!eligible.length) {
    // nothing clear: the point furthest from everything
    const far = (s: (typeof scored)[number]) => Math.min(s.items, s.people * (cfg.itemGap / peopleGap), s.recent);
    return scored.reduce((a, b) => (far(b) > far(a) ? b : a)).p;
  }
  // the emptiest area (quarter x low/high), then a point in it
  const ground = (x: number) => {
    let g = Infinity;
    for (const s of nav.surfaces) if (!s.fragile && s.x0 <= x && s.x1 >= x && s.y < g) g = s.y;
    return g;
  };
  const area = (p: Point) => arenaQuarter(sim.level.minX, sim.level.width, p.x) * 2 + (p.y - ground(p.x) > cfg.highRise ? 1 : 0);
  const occupancy = new Map<number, number>();
  for (const q of items) occupancy.set(area(q), (occupancy.get(area(q)) ?? 0) + 1);
  const areas = [...new Set(eligible.map((s) => area(s.p)))].sort((a, b) => a - b);
  const fewest = Math.min(...areas.map((a) => occupancy.get(a) ?? 0));
  const open = areas.filter((a) => (occupancy.get(a) ?? 0) === fewest);
  // mid-round, a race (#95): in the emptiest areas, the spot the bare-handed fighters reach at about the same time
  // (as near to them as the gaps allow), one of the closest few at random
  const bare = spawns ? [] : sim.alive().filter((f) => needy(sim, f)).map((f) => sim.pos(f));
  if (bare.length) {
    const race = (p: Point) => {
      const d = bare.map((q) => Math.hypot(p.x - q.x, p.y - q.y)).sort((a, b) => a - b);
      return d[0]! + (d.length > 1 ? Math.abs(d[1]! - d[0]!) : 0);
    };
    const best = eligible.filter((s) => open.includes(area(s.p))).map((s) => ({ p: s.p, r: race(s.p) })).sort((a, b) => a.r - b.r || a.p.x - b.p.x);
    return rng.pick(best.slice(0, cfg.raceChoices)).p;
  }
  const pick = rng.pick(open);
  return rng.pick(eligible.filter((s) => area(s.p) === pick)).p;
}

/**
 * Weapons left outside the zone (more than 2.5 m past its edge; spots go up to 2 m past it) for outsideTicks are gone (#95): out of play, they would only lure fighters out and
 * crowd the floor. Checked every 30 ticks.
 */
export function clearOutsideWeapons(sim: Sim) {
  if (sim.tick % 30 !== 0) return;
  const z = sim.zone;
  for (const e of [...sim.entities.values()]) {
    if (e.kind !== "item" || e.dead || !isPickupWeapon(e.itemType)) continue;
    const t = e.body.translation();
    if (Math.abs(t.x - z.center) <= z.half + 2.5) {
      e.outSince = undefined;
      continue;
    }
    e.outSince ??= sim.tick;
    if (sim.tick - e.outSince < sim.ruleset.pickups.spots.outsideTicks) continue;
    sim.events.push({ type: "itemGone", tick: sim.tick, entity: e.id, item: e.itemType!, x: t.x, y: t.y });
    sim.entityStore.remove(e);
  }
}

/**
 * At the cap on loose weapons (twice supply.maxLooseWeapons, live or not), the oldest loose weapon is cleared away to
 * make room for one more (#95: sudden death keeps its drops coming).
 */
export function makeRoomForWeapon(sim: Sim) {
  let oldest: Entity | null = null;
  let n = 0;
  for (const e of sim.entities.values()) {
    if (e.kind !== "item" || e.dead || !isPickupWeapon(e.itemType)) continue;
    n++;
    if (!oldest || e.born < oldest.born || (e.born === oldest.born && e.id < oldest.id)) oldest = e;
  }
  if (!oldest || n < 2 * sim.ruleset.pickups.supply.maxLooseWeapons) return;
  const t = oldest.body.translation();
  sim.events.push({ type: "itemGone", tick: sim.tick, entity: oldest.id, item: oldest.itemType!, x: t.x, y: t.y });
  sim.entityStore.remove(oldest);
}

/** How high above a spot a dropped item can start and still fall onto it: up to `top`, below anything solid. */
export function dropHeight(sim: Sim, p: Point, top: number): number {
  const g = sim.grid;
  for (let y = p.y + 0.6; y < top; y += 0.25) if (g.solidAt(p.x, y + 0.6)) return Math.max(p.y + 0.4, y);
  return top;
}
