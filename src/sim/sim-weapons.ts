import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT, G, groups } from "./constants";
import type { Sim } from "./sim";
import { type Entity, type Fighter, type Rocket, type Weapon, usesAmmo } from "./sim-types";
import { length2D } from "./dmath";
import { hitProp } from "./sim-objects";
import { chipTerrain } from "./sim-terrain";

import { shootChains, swingChains } from "./sim-chains";
import { fireFlamethrower } from "./sim-fire";
import { throwMine } from "./sim-mines";
import { fireRailgun, slamHammer } from "./sim-impact-weapons";
import { firePrecision } from "./sim-precision";

export function fire(sim: Sim, f: Fighter, weapon: Weapon) {
  if (f.cooldown[weapon] > 0 || (weapon !== "fist" && !sim.ruleset.weapons.enabled.includes(weapon))) return;
  if (usesAmmo(weapon) && f.ammo[weapon] <= 0) return;
  if (weapon === "hammer" && !f.grounded) return;
  const p = sim.pos(f);
  const ox = p.x;
  const tactics = sim.ruleset.tactics.weapons;
  const oy = p.y + (tactics.enabled ? tactics.aimHeight : 0.25);
  const dx = f.aimX;
  const dy = f.aimY;
  sim.events.push({ type: "fire", tick: sim.tick, fighter: f.id, weapon, x: ox, y: oy, dx, dy });
  switch (weapon) {
    case "mine":
      f.cooldown.mine = sim.ruleset.weapons.table.mine.cooldown;
      throwMine(sim, f, ox, oy, dx, dy);
      break;
    case "railgun":
      f.cooldown.railgun = sim.ruleset.weapons.table.railgun.cooldown;
      fireRailgun(sim, f, ox, oy, dx, dy);
      break;
    case "hammer":
      f.cooldown.hammer = sim.ruleset.weapons.table.hammer.cooldown;
      slamHammer(sim, f, ox, dx);
      break;
    case "rocket": {
      f.cooldown.rocket = sim.ruleset.weapons.table.rocket.cooldown;
      const muzzle = 0.95;
      const block = sim.raycast(ox, oy, dx, dy, muzzle, f.entity.collider);
      if (block) {
        sim.explode(ox + dx * block.dist, oy + dy * block.dist, sim.ruleset.weapons.table.rocket, "rocket", f.id, 0, null);
        return;
      }
      const s = sim.ruleset.weapons.table.rocket.speed;
      sim.rockets.push({ id: sim.entityStore.allocateId(), owner: f.id, x: ox + dx * muzzle, y: oy + dy * muzzle, vx: dx * s, vy: dy * s, age: 0 });
      break;
    }
    case "shotgun":
      f.cooldown.shotgun = sim.ruleset.weapons.table.shotgun.cooldown;
      fireShotgun(sim, f, ox, oy, dx, dy);
      break;
    case "bat":
      f.cooldown.bat = sim.ruleset.weapons.table.bat.cooldown;
      swingMelee(sim, f, "bat", ox, oy, dx, dy);
      break;
    case "fist":
      f.cooldown.fist = sim.ruleset.weapons.table.fist.cooldown;
      swingMelee(sim, f, "fist", ox, oy, dx, dy);
      break;
    case "grenade":
      f.cooldown.grenade = sim.ruleset.weapons.table.grenade.cooldown;
      throwGrenade(sim, f, ox, oy, dx, dy);
      break;
    case "grapple":
      f.cooldown.grapple = sim.ruleset.weapons.table.grapple.cooldown;
      fireGrapple(sim, f, ox, oy, dx, dy);
      break;
    case "flamethrower":
      f.cooldown.flamethrower = sim.ruleset.weapons.table.flamethrower.cooldown;
      fireFlamethrower(sim, f, ox, oy, dx, dy);
      break;
    case "rifle":
    case "sniper":
    case "crossbow":
      f.cooldown[weapon] = sim.ruleset.weapons.table[weapon].cooldown;
      firePrecision(sim, f, weapon, ox, oy, dx, dy);
      break;
  }
  if (usesAmmo(weapon) && --f.ammo[weapon] === 0 && f.weapons[f.slot] === weapon) {
    f.weapons[f.slot] = "fist";
    sim.events.push({ type: "swap", tick: sim.tick, fighter: f.id, weapon: "fist" });
  }
}

function fireShotgun(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const W = sim.ruleset.weapons.table.shotgun;
  const px = -dy;
  const py = dx;
  for (let i = 0; i < W.pellets; i++) {
    const spread = ((i / (W.pellets - 1)) * 2 - 1) * W.spread + sim.rng.gauss() * W.jitter;
    let rx = dx + px * spread;
    let ry = dy + py * spread;
    const l = length2D(rx, ry);
    rx /= l;
    ry /= l;
    const hit = sim.raycast(ox, oy, rx, ry, W.range, f.entity.collider);
    const dist = hit ? hit.dist : W.range;
    const hx = ox + rx * dist;
    const hy = oy + ry * dist;
    sim.events.push({ type: "pellet", tick: sim.tick, fighter: f.id, x0: ox, y0: oy, x1: hx, y1: hy, hit: !!hit });
    const fall = 1 - 0.45 * (dist / W.range);
    // pellets go through chains, chipping them (#34)
    shootChains(sim, ox, oy, hx, hy, W.pelletBlockDamage * fall, f.id, "shotgun");
    if (!hit) continue;
    if (hit.terrain) {
      chipTerrain(sim, hx, hy, rx, ry, W.pelletTerrainDamage * fall);
      continue;
    }
    const e = hit.entity!;
    if (e.kind === "fighter" && e.fighter) {
      if (!e.fighter.alive) continue;
      const kb = W.pelletKnock * fall;
      sim.damageFighter(e.fighter, W.pelletDamage * fall, f.id, rx * kb, ry * kb + 0.35 * kb, "shotgun", hx, hy);
    } else {
      hitProp(sim, e, W.pelletBlockDamage * fall, f.id, "shotgun", hx, hy);
      if (!e.dead) e.body.applyImpulseAtPoint({ x: rx * W.pelletImpulse, y: ry * W.pelletImpulse }, { x: hx, y: hy }, true);
    }
  }
}

function swingMelee(sim: Sim, f: Fighter, weapon: "bat" | "fist", ox: number, oy: number, dx: number, dy: number) {
  const spec = sim.ruleset.weapons.table[weapon];
  const tuning = sim.ruleset.weapons.melee[weapon];
  const cx = ox + dx * spec.reach;
  const height = oy + dy * spec.reach;
  const cy = weapon === "bat" ? height + 0.1 : height;
  const found: Entity[] = [];
  sim.world.intersectionsWithShape({ x: cx, y: cy }, 0, new RAPIER.Ball(spec.radius), (c) => {
    const e = sim.entityOf(c);
    if (e && !e.dead && e !== f.entity && !found.includes(e)) found.push(e);
    return true;
  });
  let lx = dx;
  let ly = dy + spec.lift;
  const l = length2D(lx, ly);
  lx /= l;
  ly /= l;
  let hitAny = false;
  for (const e of found) {
    if (e.kind === "fighter" && e.fighter) {
      if (!e.fighter.alive) continue;
      const t = e.body.translation();
      sim.damageFighter(e.fighter, spec.damage, f.id, lx * spec.knockback, ly * spec.knockback, weapon, t.x, t.y);
      hitAny = true;
    } else if (e.kind !== "item") {
      hitProp(sim, e, tuning.propDamage, f.id, weapon, cx, cy);
      if (!e.dead) {
        const m = e.body.mass();
        e.body.applyImpulse({ x: lx * spec.propImpulse * Math.min(m, tuning.propMassCap), y: ly * spec.propImpulse * Math.min(m, tuning.propMassCap) }, true);
      }
      hitAny = true;
    }
  }
  // bats, and fists with the heavy power-up, hit chains (#34)
  const chainDamage = weapon === "bat" ? sim.ruleset.arena.chain.batDamage : f.power.heavy > 0 ? sim.ruleset.arena.chain.heavyFistDamage : 0;
  if (chainDamage > 0 && swingChains(sim, cx, cy, spec.radius, chainDamage, f.id, weapon)) hitAny = true;
  // The swing also damages static terrain just past its hit center.
  const smashed = sim.terrain.carve(cx + dx * tuning.terrainOffset, cy + dy * tuning.terrainOffset, spec.terrainRadius, spec.terrainDamage);
  if (smashed.length) {
    sim.stats.cellsDestroyed += smashed.length;
    sim.events.push({ type: "carve", tick: sim.tick, cells: smashed });
    hitAny = true;
  }
  sim.events.push({ type: "swing", tick: sim.tick, fighter: f.id, x: cx, y: cy, dx, dy, hit: hitAny, weapon });
}

function throwGrenade(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const v = sim.vel(f);
  const body = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(ox + dx * 0.8, oy + dy * 0.8 + 0.2)
      .setLinvel(dx * sim.ruleset.weapons.table.grenade.speed + v.x * 0.3, dy * sim.ruleset.weapons.table.grenade.speed + v.y * 0.3)
      .setCcdEnabled(true)
      .setAngularDamping(0.5),
  );
  const collider = sim.world.createCollider(
    RAPIER.ColliderDesc.ball(0.22).setDensity(3).setRestitution(0.45).setFriction(0.6).setCollisionGroups(groups(G.GRENADE, G.TERRAIN | G.FIGHTER | G.PROP)),
    body,
  );
  sim.entityStore.register({ id: sim.entityStore.allocateId(), kind: "grenade", body, collider, hw: 0.22, hh: 0.22, hp: 1, maxHp: 1, dead: false, born: sim.tick, owner: f.id, ticksLeft: sim.ruleset.weapons.table.grenade.fuse });
}

function fireGrapple(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const Gp = sim.ruleset.weapons.table.grapple;
  const hit = sim.raycast(ox, oy, dx, dy, Gp.range, f.entity.collider);
  const dist = hit ? hit.dist : Gp.range;
  const hx = ox + dx * dist;
  const hy = oy + dy * dist;
  let kind: "fighter" | "prop" | "terrain" | "none" = hit ? (hit.terrain ? "terrain" : "prop") : "none";
  let target = -1;
  if (hit?.entity) {
    const e = hit.entity;
    const t = e.body.translation();
    let px = ox - t.x;
    let py = oy - t.y;
    const l = length2D(px, py) || 1;
    px /= l;
    py /= l;
    if (e.kind === "fighter" && e.fighter) {
      kind = "fighter";
      target = e.fighter.id;
      const fi = e.fighter;
      if (fi.alive) {
        // yank toward the shooter: off ledges, into bat range
        sim.damageFighter(fi, Gp.damage, f.id, 0, 0, "grapple", t.x, t.y);
        if (fi.alive) {
          const k = fi.power.heavy > 0 ? 0.5 : fi.power.shield > 0 ? 0.6 : 1;
          e.body.setLinvel({ x: px * Gp.pull * k, y: (py * Gp.pull + Gp.lift) * k }, true);
          fi.stun = Math.max(fi.stun, Gp.stun);
          fi.grounded = false;
        }
      }
    } else if (e.kind !== "item") {
      const m = Math.min(e.body.mass(), 12);
      e.body.applyImpulse({ x: px * Gp.pull * m * 0.8, y: (py * Gp.pull + Gp.lift) * m * 0.8 }, true);
      if (e.kind === "glass") hitProp(sim, e, 5, f.id, "grapple", hx, hy);
    }
  }
  sim.events.push({ type: "grapple", tick: sim.tick, fighter: f.id, x0: ox, y0: oy, x1: hx, y1: hy, hit: kind, target });
}

export function updateRockets(sim: Sim) {
  const W = sim.ruleset.weapons.table.rocket;
  const keep: Rocket[] = [];
  for (const r of sim.rockets) {
    r.age++;
    r.vy -= W.gravity * DT;
    const sx = r.vx * DT;
    const sy = r.vy * DT;
    const len = length2D(sx, sy);
    const owner = sim.fighters[r.owner]!;
    const exclude = r.age < 30 && !owner.removed ? owner.entity.collider : undefined;
    const hit = sim.raycast(r.x, r.y, sx / len, sy / len, len, exclude);
    if (hit) {
      sim.explode(r.x + (sx / len) * hit.dist, r.y + (sy / len) * hit.dist, W, "rocket", r.owner, 0, null);
      continue;
    }
    r.x += sx;
    r.y += sy;
    if (r.age > W.maxLife) {
      sim.explode(r.x, r.y, W, "rocket", r.owner, 0, null);
      continue;
    }
    if (r.y < -20 || r.x < -70 || r.x > 70) continue;
    keep.push(r);
  }
  sim.rockets = keep;
}
