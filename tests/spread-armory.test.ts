import { beforeAll, expect, test } from "bun:test";
import { CLASSIC, initPhysics, Sim } from "../src/sim";
import { arenaQuarter } from "../src/sim/level-spawns";
import { supplyDrop } from "../src/sim/sim-items";
import { isPickupWeapon } from "../src/sim/sim-types";

beforeAll(initPhysics);

test("Classic stocks every arena quarter and keeps the railgun on a risky site", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const sim = new Sim(seed);
    const weapons = sim.items().filter(i => isPickupWeapon(i.itemType));
    const quarters = new Set(weapons.map(i => arenaQuarter(sim.level.minX, sim.level.width, i.body.translation().x)));
    expect(quarters.size).toBe(4);
    const rails = weapons.filter(i => i.itemType === "railgun");
    expect(rails).toHaveLength(1);
    const p = rails[0]!.body.translation();
    const y = Math.round((p.y - 0.4) * 2) / 2;
    const g = sim.grid;
    const exposed = g.emptyRect(g.cx(p.x), g.cy(y + 0.5), g.cx(p.x), g.rows - 1);
    expect(y >= CLASSIC.pickups.armory.spread.powerMinHeight || exposed).toBe(true);
  }
});

test("a supply drop uses a clear landing column, or the least crowded if space is tight", () => {
  const sim = new Sim(23);
  const obstacles = [...sim.fighters.map(f => sim.pos(f).x), ...sim.items().map(i => i.body.translation().x)];
  const nearest = (x: number) => Math.min(...obstacles.map(other => Math.abs(x - other)));
  const lo = Math.max(sim.level.minX + 3, sim.zone.center - sim.zone.half + 1.5);
  const hi = Math.min(sim.level.maxX - 3, sim.zone.center + sim.zone.half - 1.5);
  const best = Math.max(...sim.nav.points.filter(p => p.x >= lo && p.x <= hi).map(p => nearest(p.x)));
  supplyDrop(sim, 1);
  const drop = sim.events.at(-1)!;
  expect(drop.type).toBe("itemSpawn");
  if (drop.type === "itemSpawn") {
    expect(nearest(drop.x)).toBeGreaterThanOrEqual(Math.min(best, CLASSIC.pickups.supply.avoidDistance));
    expect(drop.item).not.toBe("railgun");
  }
});
