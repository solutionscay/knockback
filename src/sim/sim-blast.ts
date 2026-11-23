import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { igniteOilNear } from "./sim-liquid";
import { type Blast } from "./constants";
import type { Sim } from "./sim";
import { type Entity, type ExplosionKind } from "./sim-types";
import { clamp, length2D } from "./dmath";
import { hitProp } from "./sim-objects";
import { damagePiece } from "./sim-terrain";
import { blastChains } from "./sim-chains";
import { blastIgnite } from "./sim-ignite";

export function explode(sim: Sim, x: number, y: number, spec: Blast, kind: ExplosionKind, owner: number, depth: number, chainFrom: string | null) {
  sim.stats.explosions++;
  sim.events.push({ type: "explosion", tick: sim.tick, kind, x, y, radius: spec.radius, owner, depth, chainFrom });
  const carveRadius = spec.radius * sim.ruleset.combat.blastCarveScale;
  const carved = sim.terrain.carve(x, y, carveRadius, spec.terrainDamage);
  if (carved.length) {
    sim.stats.cellsDestroyed += carved.length;
    sim.events.push({ type: "carve", tick: sim.tick, cells: carved.slice(0, 60) });
  }
  blastChains(sim, x, y, spec.radius, spec.blockDamage, owner, kind);
  const found: Entity[] = [];
  const seen = new Set<number>();
  sim.world.intersectionsWithShape({ x, y }, 0, new RAPIER.Ball(spec.radius), (c) => {
    const e = sim.entityOf(c);
    if (e && !e.dead && !seen.has(e.id)) {
      seen.add(e.id);
      found.push(e);
    }
    return true;
  });
  for (const e of found) {
    if (e.dead) continue;
    const t = e.body.translation();
    const dx = t.x - x;
    const dy = t.y - y;
    const d = length2D(dx, dy);
    const edge = Math.max(0, d - Math.min(e.hw, e.hh));
    const f = clamp(1 - edge / spec.radius, 0, 1);
    if (f <= 0 && e.kind !== "chunk") continue;
    let nx = d > 0.01 ? dx / d : 0;
    let ny = d > 0.01 ? dy / d : 1;
    if (e.kind === "fighter" && e.fighter) {
      const fi = e.fighter;
      if (!fi.alive) continue;
      ny += 0.55;
      const l = length2D(nx, ny);
      nx /= l;
      ny /= l;
      const kb = spec.knockback * (0.45 + 0.55 * f);
      sim.damageFighter(fi, spec.damage * (0.35 + 0.65 * f), owner, nx * kb, ny * kb, kind, t.x, t.y);
      continue;
    }
    if (e.kind === "chunk") {
      damagePiece(sim, e, x, y, carveRadius, spec.terrainDamage);
      if (e.dead) continue;
    } else if (e.kind !== "item" && e.kind !== "grenade") {
      // blocks only break near the center; further out they get shoved, so cover collapses
      hitProp(sim, e, spec.blockDamage * f * f, owner, kind, t.x, t.y, depth);
      if (e.dead) continue;
    }
    const m = Math.min(e.body.mass(), 30);
    const imp = spec.knockback * f * m * (e.kind === "item" || e.kind === "grenade" ? 0.7 : 0.55);
    e.body.applyImpulse({ x: nx * imp, y: (ny + 0.3) * imp }, true);
    e.body.applyTorqueImpulse((nx >= 0 ? -1 : 1) * imp * 0.08, true);
  }
  // what is left standing near the blast may catch fire (#33)
  blastIgnite(sim, x, y, spec.radius, owner);
  igniteOilNear(sim, x, y, spec.radius * sim.ruleset.fire.blastReach, owner);
}
