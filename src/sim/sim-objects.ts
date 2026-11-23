import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT, G, groups } from "./constants";
import type { Sim } from "./sim";
import { type Entity } from "./sim-types";
import { dcos, dsin } from "./dmath";
import { type PropKind } from "./level-config";
import { randomDrop, roomForWeapon } from "./sim-items";
import { damagePiece } from "./sim-terrain";

const PROP_FILTER = G.TERRAIN | G.FIGHTER | G.PROP | G.ITEM | G.GRENADE;

export function addProp(sim: Sim, kind: PropKind, x: number, yBottom: number, spec?: { ax?: number; ay?: number; len?: number }): Entity {
  const [hw, hh] = sim.ruleset.arena.propHalf[kind];
  const density =
    kind === "steel" || kind === "weight" ? sim.ruleset.arena.props.steel.density : kind === "pad" ? sim.ruleset.arena.props.pad.density : kind === "block" ? sim.ruleset.arena.props.block.density : kind === "crate" ? sim.ruleset.arena.props.crate.density : kind === "glass" ? 1.2 : 0.9;
  const hp =
    kind === "block"
      ? sim.ruleset.arena.props.block.hp
      : kind === "crate"
        ? sim.ruleset.arena.props.crate.hp
        : kind === "barrel"
          ? sim.ruleset.arena.props.barrel.hp
          : kind === "tnt"
            ? sim.ruleset.arena.props.tnt.hp
            : kind === "gas"
              ? sim.ruleset.arena.props.gas.hp
              : kind === "glass"
                ? sim.ruleset.arena.props.glass.hp
                : kind === "weight"
                  ? sim.ruleset.arena.props.weight.ropeHp
                  : Infinity;
  const body = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, yBottom + hh)
      .setLinearDamping(0.05)
      .setAngularDamping(kind === "pad" ? 4 : 0.3)
      .setCcdEnabled(kind === "steel" || kind === "weight"),
  );
  const collider = sim.world.createCollider(
    RAPIER.ColliderDesc.cuboid(hw, hh)
      .setDensity(density)
      .setFriction(0.8)
      .setRestitution(0.05)
      .setCollisionGroups(groups(G.PROP, PROP_FILTER)),
    body,
  );
  const e: Entity = { id: sim.entityStore.allocateId(), kind, body, collider, hw, hh, hp, maxHp: hp, dead: false, born: sim.tick };
  if (kind === "weight" && spec?.ax !== undefined) {
    e.ax = spec.ax;
    e.ay = spec.ay!;
    e.anchorCx = sim.grid.cx(spec.ax);
    e.anchorCy = sim.grid.cy(spec.ay! + 0.01);
    e.joint = sim.world.createImpulseJoint(
      RAPIER.JointData.rope(spec.len!, { x: spec.ax, y: spec.ay! }, { x: 0, y: hh }),
      sim.terrain.body,
      body,
      true,
    );
  }
  sim.entityStore.register(e);
  return e;
}

/** Lit sim.ruleset.arena.props.tnt, armed barrels and flying gas canisters: things to run from. */
export function dangers(sim: Sim): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = [];
  for (const e of sim.entities.values()) {
    if (e.dead) continue;
    if ((e.kind === "tnt" || e.kind === "barrel") && e.fuse !== undefined) {
      const t = e.body.translation();
      out.push({ x: t.x, y: t.y, r: e.kind === "tnt" ? sim.ruleset.arena.props.tnt.radius + 0.8 : sim.ruleset.arena.props.barrel.radius });
    }
  }
  for (const mine of sim.mines) {
    if (mine.mount && mine.armedAt >= 0 && sim.tick >= mine.armedAt - 10) out.push({ x: mine.x, y: mine.y, r: sim.ruleset.weapons.table.mine.radius });
  }
  return out;
}

export function updateObjects(sim: Sim) {
  for (const e of [...sim.entities.values()]) {
    if (e.dead) continue;
    switch (e.kind) {
      case "grenade":
        if (--e.ticksLeft! <= 0) {
          const t = e.body.translation();
          sim.entityStore.remove(e);
          sim.explode(t.x, t.y, sim.ruleset.weapons.table.grenade, "grenade", e.owner!, 0, null);
        }
        break;
      case "barrel":
      case "tnt":
        if (e.fuse !== undefined && --e.fuse <= 0) {
          const t = e.body.translation();
          sim.entityStore.remove(e);
          if (e.kind === "barrel") sim.stats.barrelsExploded++;
          else sim.stats.tntExploded++;
          if (e.chainFrom === "rocket" || e.chainFrom === "barrel" || e.chainFrom === "grenade" || e.chainFrom === "tnt" || e.chainFrom === "gas") sim.stats.chainBarrels++;
          if (e.chainFrom === "barrel" || e.chainFrom === "tnt") sim.stats.barrelToBarrel++;
          sim.explode(t.x, t.y, e.kind === "tnt" ? sim.ruleset.arena.props.tnt : sim.ruleset.arena.props.barrel, e.kind, e.triggeredBy ?? -1, e.chainDepth ?? 0, e.chainFrom ?? null);
        }
        break;
      case "gas":
        if (e.thrust !== undefined) updateGas(sim, e);
        break;
      case "weight":
        if (e.joint && (!sim.grid.solid(e.anchorCx!, e.anchorCy!) || e.hp <= 0)) {
          sim.world.removeImpulseJoint(e.joint, true);
          e.joint = null;
          sim.stats.weightsDropped++;
          sim.events.push({ type: "snap", tick: sim.tick, entity: e.id });
        }
        break;
      case "pad":
        updatePad(sim, e);
        break;
      case "glass":
        checkGlass(sim, e);
        break;
    }
    if ((e.kind === "steel" || e.kind === "weight" || e.kind === "chunk") && !e.dead) checkCrush(sim, e);
  }
}

function updateGas(sim: Sim, e: Entity) {
  const a = e.body.rotation();
  const ux = -dsin(a);
  const uy = dcos(a);
  const m = e.body.mass();
  e.body.applyImpulse({ x: ux * sim.ruleset.arena.props.gas.thrust * m * DT, y: uy * sim.ruleset.arena.props.gas.thrust * m * DT }, true);
  e.body.applyTorqueImpulse((sim.rng.next() - 0.5) * 0.5 * m, true);
  const v = e.body.linvel();
  const dv = e.pvx === undefined ? 0 : Math.sqrt((v.x - e.pvx) * (v.x - e.pvx) + (v.y - e.pvy!) * (v.y - e.pvy!));
  e.pvx = v.x;
  e.pvy = v.y;
  e.thrust!--;
  if (e.thrust! <= 0 || (e.thrust! < sim.ruleset.arena.props.gas.thrustTicks - 15 && dv > 7)) {
    const t = e.body.translation();
    sim.entityStore.remove(e);
    sim.explode(t.x, t.y, sim.ruleset.arena.props.gas, "gas", e.triggeredBy ?? -1, e.chainDepth ?? 0, e.chainFrom ?? null);
  }
}

function updatePad(sim: Sim, e: Entity) {
  const t = e.body.translation();
  const top = t.y + e.hh;
  for (const f of sim.fighters) {
    if (!f.alive || f.padCd > 0) continue;
    const p = sim.pos(f);
    const feet = sim.feetY(f);
    if (Math.abs(p.x - t.x) < e.hw + 0.15 && feet > top - 0.15 && feet < top + 0.35 && f.entity.body.linvel().y <= 2) {
      f.entity.body.setLinvel({ x: f.entity.body.linvel().x, y: sim.ruleset.arena.props.pad.launch }, true);
      f.padCd = sim.ruleset.arena.props.pad.cooldown;
      f.grounded = false;
      sim.stats.bounces++;
      sim.events.push({ type: "bounce", tick: sim.tick, fighter: f.id, x: t.x, y: top });
    }
  }
}

/** Heavy things falling on fighters hurt (a pinned fighter cannot show it as a velocity change). */
function checkCrush(sim: Sim, e: Entity) {
  const v = e.body.linvel();
  if (v.y > -sim.ruleset.arena.props.crush.minSpeed) return;
  const m = e.body.mass();
  if (m < sim.ruleset.arena.props.crush.minMass) return;
  const t = e.body.translation();
  sim.world.intersectionsWithShape({ x: t.x, y: t.y - 0.15 }, e.body.rotation(), new RAPIER.Ball(Math.max(e.hw, e.hh) + 0.1), (c) => {
    const o = sim.entityOf(c);
    const f = o?.fighter;
    if (!f || !f.alive || f.crushCd > 0) return true;
    const p = sim.pos(f);
    if (p.y > t.y) return true; // only from above
    const dmg = Math.min(sim.ruleset.arena.props.crush.max, (-v.y - sim.ruleset.arena.props.crush.minSpeed + 2) * Math.sqrt(m) * sim.ruleset.arena.props.crush.perUnit);
    f.crushCd = 30;
    sim.damageFighter(f, dmg, e.triggeredBy ?? -1, 0, 0, "crush", p.x, p.y);
    return true;
  });
}

function checkGlass(sim: Sim, e: Entity) {
  const t = e.body.translation();
  let smash = false;
  // look ahead: a fast body is caught before the contact stops it
  sim.world.intersectionsWithShape({ x: t.x, y: t.y }, e.body.rotation(), new RAPIER.Cuboid(e.hw + 0.6, e.hh + 0.3), (c) => {
    const o = sim.entityOf(c);
    if (!o || o === e || o.kind === "item") return true;
    const v = o.body.linvel();
    if (v.x * v.x + v.y * v.y > sim.ruleset.arena.props.glass.shatterSpeed * sim.ruleset.arena.props.glass.shatterSpeed) smash = true;
    return !smash;
  });
  if (smash) shatter(sim, e);
}

function shatter(sim: Sim, e: Entity) {
  const t = e.body.translation();
  sim.stats.glassShattered++;
  sim.events.push({ type: "shatter", tick: sim.tick, entity: e.id, x: t.x, y: t.y });
  sim.entityStore.remove(e);
}

/** Light a barrel or sim.ruleset.arena.props.tnt fuse, or launch a gas can (cause: what set it off). */
export function light(sim: Sim, e: Entity, owner: number, depth: number, cause: string) {
  if (e.dead) return;
  if (e.kind === "tnt") {
    const fuse = cause === "shotgun" || cause === "bat" || cause === "grapple" ? sim.ruleset.arena.props.tnt.fuse : sim.ruleset.arena.props.tnt.chainFuse;
    if (e.fuse === undefined) {
      e.fuse = fuse;
      e.chainDepth = depth + 1;
      e.chainFrom = cause;
      e.triggeredBy = owner;
      sim.events.push({ type: "lit", tick: sim.tick, entity: e.id, kind: "tnt" });
    } else e.fuse = Math.min(e.fuse, fuse);
  } else if (e.kind === "barrel" && e.fuse === undefined) {
    e.fuse = sim.rng.int(sim.ruleset.arena.props.barrel.fuseMin, sim.ruleset.arena.props.barrel.fuseMax);
    e.chainDepth = cause === "shotgun" || cause === "bat" ? 0 : depth + 1;
    e.chainFrom = cause;
    e.triggeredBy = owner;
    sim.events.push({ type: "lit", tick: sim.tick, entity: e.id, kind: "barrel" });
  } else if (e.kind === "gas" && e.thrust === undefined) {
    e.thrust = sim.ruleset.arena.props.gas.thrustTicks;
    e.chainDepth = depth + 1;
    e.chainFrom = cause;
    e.triggeredBy = owner;
    e.body.setAngularDamping(0.2);
    sim.stats.gasLaunched++;
    sim.events.push({ type: "lit", tick: sim.tick, entity: e.id, kind: "gas" });
  }
}

/** Damage any non-fighter thing; reacts by kind. */
export function hitProp(sim: Sim, e: Entity, dmg: number, owner: number, cause: string, hx: number, hy: number, depth = 0) {
  if (e.dead || dmg <= 0) return;
  switch (e.kind) {
    case "glass":
      shatter(sim, e);
      return;
    case "barrel":
    case "tnt":
    case "gas":
      e.hp -= dmg;
      if (e.hp <= 0) light(sim, e, owner, depth, cause);
      return;
    case "weight":
      e.hp -= dmg;
      return;
    case "steel":
    case "pad":
    case "item":
    case "grenade":
    case "fighter":
      return;
    case "chunk":
      damagePiece(sim, e, hx, hy, 0.7, dmg * 1.5);
      return;
    default: {
      e.hp -= dmg;
      if (e.hp > 0) return;
      const t = e.body.translation();
      sim.events.push({ type: "break", tick: sim.tick, entity: e.id, kind: e.kind, x: t.x, y: t.y, hw: e.hw, hh: e.hh });
      if (e.kind === "block") sim.stats.blocksDestroyed++;
      sim.entityStore.remove(e);
      if (e.kind === "crate") {
        sim.stats.cratesDestroyed++;
        if (sim.rng.chance(sim.ruleset.arena.props.crate.dropChance)) sim.spawnItem(randomDrop(sim, roomForWeapon(sim) ? sim.ruleset.pickups.armory.crateWeaponChance : 0), t.x, t.y + 0.2, 0, 3);
      }
    }
  }
}
