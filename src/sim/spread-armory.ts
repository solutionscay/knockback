import { arenaQuarter, quarterCenter } from "./level-spawns";
import { isPickupWeapon, type Weapon } from "./sim-types";
import type { Sim } from "./sim";
import type { SpawnPoint } from "./level-spawns";

type PickupWeapon = Exclude<Weapon, "fist">;

/** Ordinary crates and drops use the same weapon pool as the quarter caches. */
export function ordinaryWeapons(sim: Sim): readonly PickupWeapon[] {
  const enabled = sim.ruleset.weapons.enabled.filter(isPickupWeapon);
  const spread = sim.ruleset.pickups.armory.spread;
  if (!spread.enabled) return enabled;
  const eligible = enabled.filter(w => !spread.powerWeapons.includes(w));
  return eligible.length ? eligible : enabled;
}

export function stockSpreadArmory(sim: Sim, spawns: readonly SpawnPoint[]) {
  const { minX, width } = sim.level;
  const armory = sim.ruleset.pickups.armory;
  const { spread } = armory;
  const z = sim.zone;
  const lo = Math.max(minX + 1, z.center - z.half + 1);
  const hi = Math.min(sim.level.maxX - 1, z.center + z.half - 1);
  const quarter = (x: number) => arenaQuarter(minX, width, x);
  const distance = (x: number, y: number, p: SpawnPoint) => (x - p.x) ** 2 + (y - p.y) ** 2;
  const floor = sim.nav.surfaceAt(spawns[0]!.x, spawns[0]!.y + 0.05);
  const reachable = new Set<number>();
  if (floor) {
    const queue = [floor.id];
    reachable.add(floor.id);
    for (const from of queue) for (const { to } of sim.nav.out[from]!) {
      if (reachable.has(to)) continue;
      queue.push(to);
      reachable.add(to);
    }
  }
  // Reserve safe landing points with clear space for the pickup collider.
  const candidates = sim.nav.points.filter(p => p.x >= lo && p.x <= hi && reachable.has(p.surface)
    && !sim.nav.surfaces[p.surface]!.fragile
    && !sim.grid.solidAt(p.x, p.y + sim.ruleset.pickups.item.size));
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
  for (const w of rare) {
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
  const cache = (p: SpawnPoint | null) => {
    if (p && bag.length) put(bag[i++ % bag.length]!, p);
  };
  for (const sp of spawns.slice().sort((a, b) => a.x - b.x)) {
    const side = sp.x < 0 ? -1 : 1;
    const q = quarter(sp.x);
    const aim = sp.x + side * armory.spawnOffset;
    for (let n = 0; n < armory.nearSpawn; n++) {
      const inQuarter = (p: SpawnPoint) => quarter(p.x) === q;
      const score = (p: SpawnPoint) => Math.abs(p.x - aim) + Math.abs(p.y - sp.y - spread.starterRise) * 1.5;
      cache(choose(p => inQuarter(p) && away(p, spread.minSpawnDistance), score)
        ?? choose(inQuarter, p => score(p) - closestSpawn2(p)));
    }
  }
  for (let q = 0; q < 4; q++) {
    const aim = quarterCenter(minX, width, q);
    for (let n = 0; n < spread.zoneCaches; n++) {
      cache(choose(p => quarter(p.x) === q && away(p, spread.minSpawnDistance),
        p => Math.abs(p.x - aim) - p.y * 0.5));
    }
  }
  if (sim.ruleset.pickups.enabled.includes("jetpack")) {
    const p = choose(p => away(p, spread.minSpawnDistance), p => Math.abs(p.x - z.center - armory.jetpackOffset) + Math.abs(p.y));
    if (p) put("jetpack", p);
  }
}
