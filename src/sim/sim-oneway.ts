/**
 * Jump-through platforms (#100). Their cells are solid in the grid (they are surfaces to stand on) and have their own
 * collider group (G.ONEWAY), with a contact filter (Rapier's physics hooks, `oneWayHooks`, run every step): props, items,
 * grenades, loose pieces and bodies always land on them; a fighter touches them only while it may land: not rising (vy
 * at most `RISE`), not dropping through (Fighter.dropTicks, set by holding down on one), and not already inside one (a
 * jump that stops halfway through falls back down through it). Shots and rockets pass through them (they are no cover);
 * blasts and swings break them like any cell.
 *
 * `updateOneWay` decides once a tick before the physics step, in seat order (the filter only reads the answer).
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { G } from "./constants";
import type { Sim } from "./sim";
import type { Fighter } from "./sim-types";

/** rising faster than this (m/s): passes up through */
const RISE = 0.5;
export const FIGHTER_FILTER = G.TERRAIN | G.ONEWAY | G.FIGHTER | G.PROP | G.GRENADE;

function insideOneWay(sim: Sim, f: Fighter): boolean {
  const g = sim.grid;
  const p = f.entity.body.translation();
  const feet = sim.feetY(f);
  const r = sim.ruleset.combat.fighter.radius - 0.02;
  const top = feet + 2 * (sim.ruleset.combat.fighter.halfHeight + sim.ruleset.combat.fighter.radius) - 0.05;
  // from 0.3 m above the feet: a landing sinks into the top a little before the contact pushes it out
  for (let cy = g.cy(feet + 0.3); cy <= g.cy(top); cy++) for (let cx = g.cx(p.x - r); cx <= g.cx(p.x + r); cx++) if (g.oneway(cx, cy)) return true;
  return false;
}

export function updateOneWay(sim: Sim) {
  for (const f of sim.fighters) {
    if (f.removed || !f.alive) continue;
    if (f.dropTicks > 0) f.dropTicks--;
    sim.oneWayLand[f.id] = f.dropTicks === 0 && f.entity.body.linvel().y <= RISE && !insideOneWay(sim, f);
  }
}

/** The contact filter for the physics step: a jump-through collider against a fighter that may not land is no contact. */
export function oneWayHooks(sim: Sim): RAPIER.PhysicsHooks {
  return {
    filterContactPair(c1, c2) {
      const ow = sim.terrain.onewayHandles;
      const other = ow.has(c1) ? c2 : ow.has(c2) ? c1 : -1;
      if (other < 0) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      for (const f of sim.fighters) if (!f.removed && f.alive && f.entity.collider.handle === other) return sim.oneWayLand[f.id] ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null;
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair() {
      return true;
    },
  };
}
