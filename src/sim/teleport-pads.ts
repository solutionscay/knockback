import type { PropSpec } from "./levelgen";
import type { NavGraph } from "./nav";
import type { Ruleset } from "./ruleset";
import type { Sim } from "./sim";
import type { Fighter } from "./sim-types";

type Point = { x: number; y: number };
export type TeleportPair = [Point, Point];

/** Select dry, clear floor on opposite sides without consuming a layout random draw. */
export function placeTeleportPair(nav: NavGraph, props: PropSpec[], spawns: Point[], width: number, rules: Ruleset): TeleportPair | undefined {
  const t = rules.arena.teleport;
  const candidates = nav.points.filter(p => {
    const s = nav.surfaces[p.surface]!;
    return !s.fragile && !s.oneWay && p.x - s.x0 >= t.clearMargin && s.x1 - p.x >= t.clearMargin &&
      spawns.every(q => Math.abs(p.x - q.x) >= t.spawnGap || Math.abs(p.y - q.y) >= t.spawnGap) &&
      props.every(q => Math.abs(p.x - q.x) > t.clearMargin + rules.arena.propHalf[q.kind][0] ||
        q.y >= p.y + 2 * (rules.combat.fighter.halfHeight + rules.combat.fighter.radius) || q.y + 2 * rules.arena.propHalf[q.kind][1] <= p.y);
  });
  const target = width * (0.5 - t.insetShare);
  const pick = (sign: number, exclude?: number) => candidates.filter(p => sign * p.x >= target && p.surface !== exclude)
    .sort((a, b) => Math.abs(a.x - sign * target) - Math.abs(b.x - sign * target))[0];
  const a = pick(-1), b = pick(1, a?.surface);
  if (a && b) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
}

function supported(sim: Sim, p: Point) {
  return sim.grid.solidAt(p.x, p.y - sim.ruleset.arena.teleport.contactHeight);
}

export function addTeleportLinks(sim: Sim) {
  const pair = sim.level.teleportPads;
  if (!pair) return;
  const [a, b] = pair;
  if (!supported(sim, a) || !supported(sim, b)) return;
  const left = sim.nav.surfaceAt(a.x, a.y, 0), right = sim.nav.surfaceAt(b.x, b.y, 0);
  if (!left || !right || left.id === right.id || left.y !== a.y || right.y !== b.y) return;
  sim.nav.teleportSafe = link => {
    const [lo, hi] = sim.zoneAhead(0);
    return !sim.zoneEnabled || (link.landX >= lo && link.landX <= hi);
  };
  sim.nav.addTeleportLink(left.id, right.id, a.x, b.x);
  sim.nav.addTeleportLink(right.id, left.id, b.x, a.x);
}

/** Drive after contacts, in rotating seat order. Moving the body preserves both velocity components. */
export function useTeleportPad(sim: Sim, f: Fighter) {
  const pads = sim.level.teleportPads;
  if (!pads) return;
  const t = sim.ruleset.arena.teleport, body = f.entity.body, p = sim.pos(f);
  const feet = sim.feetY(f);
  const at = pads.findIndex(q => Math.abs(q.x - p.x) <= t.halfWidth && Math.abs(feet - q.y) <= t.contactHeight);
  // A fighter may leave vertically with its incoming velocity. Landing back on the exit must not return it.
  if (pads.every(q => Math.abs(q.x - p.x) > t.halfWidth)) f.teleportLocked = false;
  if (at < 0) return;
  if (sim.tick < f.teleportReadyAt || f.teleportLocked || !f.grounded || !supported(sim, pads[at]!)) return;
  const exit = pads[1 - at]!;
  if (!supported(sim, exit)) return;
  const F = sim.ruleset.combat.fighter;
  const dest = { x: exit.x, y: exit.y + F.radius + F.halfHeight + t.contactHeight };
  let blocked = false;
  sim.world.intersectionsWithShape(dest, 0, f.entity.collider.shape, c => {
    const e = sim.entityOf(c);
    if (e?.kind === "item" || e?.kind === "fighter") return true;
    blocked = true;
    return false;
  });
  // The broad phase updates next physics step. Check live fighter positions to reserve this exit now.
  if (blocked || sim.alive().some(o => o !== f && Math.abs(sim.pos(o).x - dest.x) < 2 * F.radius &&
      Math.abs(sim.pos(o).y - dest.y) < 2 * (F.radius + F.halfHeight))) return;
  body.setTranslation(dest, true);
  f.teleportLocked = true;
  f.teleportReadyAt = sim.tick + t.rearmTicks;
  f.surface = sim.nav.surfaceAt(exit.x, exit.y, 0)?.id ?? -1;
  sim.events.push({ type: "teleport", tick: sim.tick, fighter: f.id, x: p.x, y: feet, exitX: exit.x, exitY: exit.y });
}
