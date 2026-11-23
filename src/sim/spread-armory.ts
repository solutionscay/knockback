import { quarterCenter } from "./level-spawns";
import { isPickupWeapon, type Weapon } from "./sim-types";
import type { Sim } from "./sim";
import type { SpawnPoint } from "./level-spawns";
import { weaponSpot } from "./weapon-spots";

type PickupWeapon = Exclude<Weapon, "fist">;

/** Ordinary crates and drops use the same weapon pool as the start caches. */
export function ordinaryWeapons(sim: Sim): readonly PickupWeapon[] {
  const enabled = sim.ruleset.weapons.enabled.filter(isPickupWeapon);
  const spread = sim.ruleset.pickups.armory.spread;
  if (!spread.enabled) return enabled;
  const eligible = enabled.filter(w => !spread.powerWeapons.includes(w));
  return eligible.length ? eligible : enabled;
}

/**
 * Contested start (#16): no weapon belongs to one spawn. Ordinary caches lie between neighbouring spawns, on low
 * ground every fighter can reach and come back from; the power weapons go high or exposed; more weapons fall from
 * the sky early in the round (sim-items skyDrop).
 */
export function stockSpreadArmory(sim: Sim, spawns: readonly SpawnPoint[]) {
  const { minX, width } = sim.level;
  const armory = sim.ruleset.pickups.armory;
  const { spread } = armory;
  const z = sim.zone;
  const nav = sim.nav;
  const lo = Math.max(minX + 1, z.center - z.half + 1);
  const hi = Math.min(sim.level.maxX - 1, z.center + z.half - 1);
  const distance = (x: number, y: number, p: SpawnPoint) => (x - p.x) ** 2 + (y - p.y) ** 2;
  // Surfaces every fighter can reach from its spawn and come back from.
  const back: number[][] = nav.surfaces.map(() => []);
  for (const links of nav.out) for (const l of links) back[l.to]!.push(l.from);
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
  const routes = spawns.flatMap(sp => {
    const s = nav.surfaceAt(sp.x, sp.y + 0.05);
    return s ? [walk(s.id, id => nav.out[id]!.map(l => l.to)), walk(s.id, id => back[id]!)] : [];
  });
  const reachable = (surface: number) => routes.length > 0 && routes.every(set => set.has(surface));
  // Reserve safe landing points with clear space for the pickup collider.
  const candidates = nav.points.filter(p => p.x >= lo && p.x <= hi && reachable(p.surface)
    && !nav.surfaces[p.surface]!.fragile
    && !sim.grid.solidAt(p.x, p.y + sim.ruleset.pickups.item.size));
  // How high a point is above the lowest walkable ground at its x.
  const ground = (x: number) => Math.min(...nav.surfaces.filter(s => !s.fragile && s.x0 <= x && s.x1 >= x).map(s => s.y));
  const low = (p: SpawnPoint) => p.y - ground(p.x) <= spread.cacheMaxRise;
  const placed: SpawnPoint[] = sim.items().map(e => e.body.translation());
  const blockedByProp = (p: SpawnPoint) => sim.level.props.some(prop => {
    const [hw, hh] = sim.ruleset.arena.propHalf[prop.kind];
    return Math.abs(prop.x - p.x) < hw + 0.25 && p.y + 0.4 >= prop.y && p.y + 0.4 < prop.y + hh * 2 + 0.25;
  });
  const free = (p: SpawnPoint) => !placed.some(q => distance(p.x, p.y, q) < armory.minGap ** 2) && !blockedByProp(p);
  const closestSpawn2 = (p: SpawnPoint) => Math.min(...spawns.map(s => distance(p.x, p.y, s)));
  const away = (p: SpawnPoint, min: number) => closestSpawn2(p) >= min * min;
  const choose = (eligible: (p: SpawnPoint) => boolean, score: (p: SpawnPoint) => number): SpawnPoint | null => {
    let best: SpawnPoint | null = null;
    let lowest = Infinity;
    for (const p of candidates) {
      if (!eligible(p) || !free(p)) continue;
      const s = score(p);
      if (s < lowest) {
        best = p;
        lowest = s;
      }
    }
    return best;
  };
  const put = (item: Weapon | "jetpack", p: SpawnPoint) => {
    sim.spawnItem(item, p.x, p.y + 0.4);
    placed.push(p);
  };
  const rare = spread.powerWeapons.filter(w => sim.ruleset.weapons.enabled.includes(w));
  // #95: only powerStart of them are on the map, a different pick each round
  const onMap = sim.rng.shuffle(rare.slice()).slice(0, spread.powerStart);
  for (const w of rare.filter(w => onMap.includes(w))) {
    const aim = quarterCenter(minX, width, sim.rng.int(0, 3));
    const exposed = (p: SpawnPoint) => {
      const g = sim.grid;
      return g.emptyRect(g.cx(p.x), g.cy(p.y + 0.5), g.cx(p.x), g.rows - 1);
    };
    const risky = (p: SpawnPoint) => p.y >= spread.powerMinHeight || exposed(p);
    const p = choose(p => risky(p) && away(p, spread.powerMinDistance), p => Math.abs(p.x - aim) - p.y * 3)
      ?? choose(risky, p => Math.abs(p.x - aim) - p.y * 3 - closestSpawn2(p) * 0.5);
    if (p) put(w, p);
  }
  const bag = sim.rng.shuffle(sim.ruleset.weapons.enabled.filter(isPickupWeapon).filter(w => !rare.includes(w)));
  let i = 0;
  // Between neighbouring spawns: midway, as near equally far from both as the ground allows.
  const byX = spawns.slice().sort((a, b) => a.x - b.x);
  for (let k = 0; k + 1 < byX.length && bag.length; k++) {
    const a = byX[k]!;
    const b = byX[k + 1]!;
    const mid = (a.x + b.x) / 2;
    const between = (p: SpawnPoint) => p.x > a.x && p.x < b.x;
    const score = (p: SpawnPoint) => Math.abs(p.x - mid) + Math.abs(Math.sqrt(distance(p.x, p.y, a)) - Math.sqrt(distance(p.x, p.y, b)));
    for (let n = 0; n < spread.betweenCaches; n++) {
      const p = choose(p => between(p) && low(p), score) ?? choose(between, score);
      if (p) put(bag[i++ % bag.length]!, p);
    }
  }
  // spread-out start weapons (#95): apart from each other, the spawns and the caches, across the map's areas
  for (let n = 0; n < spread.startWeapons && bag.length; n++) {
    const p = weaponSpot(sim, sim.rng, spawns, placed);
    if (p) put(bag[i++ % bag.length]!, p);
  }
  if (sim.ruleset.pickups.enabled.includes("jetpack")) {
    const p = choose(p => away(p, spread.minSpawnDistance), p => Math.abs(p.x - z.center - armory.jetpackOffset) + Math.abs(p.y));
    if (p) put("jetpack", p);
  }
}
