import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import { DT, G, WEAPONS, groups } from "./constants";
import type { Sim } from "./sim";
import { type Entity, type Fighter, type Rocket, type Weapon } from "./sim-types";
import { dcos, dsin } from "./dmath";
import { hitProp } from "./sim-objects";
import { chipTerrain } from "./sim-terrain";

export function fire(sim: Sim, f: Fighter, weapon: Weapon) {
  if (f.cooldown[weapon] > 0) return;
  const p = sim.pos(f);
  const ox = p.x;
  const oy = p.y + 0.25;
  const dx = f.aimX;
  const dy = f.aimY;
  sim.events.push({ type: "fire", tick: sim.tick, fighter: f.id, weapon, x: ox, y: oy, dx, dy });
  switch (weapon) {
    case "rocket": {
      f.cooldown.rocket = WEAPONS.rocket.cooldown;
      const muzzle = 0.95;
      const block = sim.raycast(ox, oy, dx, dy, muzzle, f.entity.collider);
      if (block) {
        sim.explode(ox + dx * block.dist, oy + dy * block.dist, WEAPONS.rocket, "rocket", f.id, 0, null);
        return;
      }
      const s = WEAPONS.rocket.speed;
      sim.rockets.push({ id: sim.entityStore.allocateId(), owner: f.id, x: ox + dx * muzzle, y: oy + dy * muzzle, vx: dx * s, vy: dy * s, age: 0 });
      break;
    }
    case "shotgun":
      f.cooldown.shotgun = WEAPONS.shotgun.cooldown;
      fireShotgun(sim, f, ox, oy, dx, dy);
      break;
    case "bat":
      f.cooldown.bat = WEAPONS.bat.cooldown;
      swingBat(sim, f, ox, oy, dx, dy);
      break;
    case "fist":
      f.cooldown.fist = WEAPONS.fist.cooldown;
      punch(sim, f, ox, oy, dx, dy);
      break;
    case "grenade":
      f.cooldown.grenade = WEAPONS.grenade.cooldown;
      throwGrenade(sim, f, ox, oy, dx, dy);
      break;
    case "grapple":
      f.cooldown.grapple = WEAPONS.grapple.cooldown;
      fireGrapple(sim, f, ox, oy, dx, dy);
      break;
  }
}

function fireShotgun(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const W = WEAPONS.shotgun;
  const px = -dy;
  const py = dx;
  for (let i = 0; i < W.pellets; i++) {
    const spread = ((i / (W.pellets - 1)) * 2 - 1) * 0.16 + sim.rng.gauss() * 0.03;
    let rx = dx + px * spread;
    let ry = dy + py * spread;
    const l = Math.sqrt(rx * rx + ry * ry);
    rx /= l;
    ry /= l;
    const hit = sim.raycast(ox, oy, rx, ry, W.range, f.entity.collider);
    const dist = hit ? hit.dist : W.range;
    const hx = ox + rx * dist;
    const hy = oy + ry * dist;
    sim.events.push({ type: "pellet", tick: sim.tick, fighter: f.id, x0: ox, y0: oy, x1: hx, y1: hy, hit: !!hit });
    if (!hit) continue;
    const fall = 1 - 0.45 * (dist / W.range);
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

function swingBat(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const B = WEAPONS.bat;
  const cx = ox + dx * B.reach;
  const cy = oy + dy * B.reach + 0.1;
  const found: Entity[] = [];
  sim.world.intersectionsWithShape({ x: cx, y: cy }, 0, new RAPIER.Ball(B.radius), (c) => {
    const e = sim.entityOf(c);
    if (e && !e.dead && e !== f.entity && !found.includes(e)) found.push(e);
    return true;
  });
  let lx = dx;
  let ly = dy + B.lift;
  const l = Math.sqrt(lx * lx + ly * ly);
  lx /= l;
  ly /= l;
  let hitAny = false;
  for (const e of found) {
    if (e.kind === "fighter" && e.fighter) {
      if (!e.fighter.alive) continue;
      const t = e.body.translation();
      sim.damageFighter(e.fighter, B.damage, f.id, lx * B.knockback, ly * B.knockback, "bat", t.x, t.y);
      hitAny = true;
    } else if (e.kind !== "item") {
      hitProp(sim, e, 15, f.id, "bat", cx, cy);
      if (!e.dead) {
        const m = e.body.mass();
        e.body.applyImpulse({ x: lx * B.propImpulse * Math.min(m, 4), y: ly * B.propImpulse * Math.min(m, 4) }, true);
      }
      hitAny = true;
    }
  }
  // the bat smashes through walls too
  const smashed = sim.terrain.carve(cx + dx * 0.3, cy + dy * 0.3, B.terrainRadius, B.terrainDamage);
  if (smashed.length) {
    sim.stats.cellsDestroyed += smashed.length;
    sim.events.push({ type: "carve", tick: sim.tick, cells: smashed });
    hitAny = true;
  }
  sim.events.push({ type: "swing", tick: sim.tick, fighter: f.id, x: cx, y: cy, dx, dy, hit: hitAny, weapon: "bat" });
}

/** Fists: a short jab, small shove, chips nothing. */
function punch(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const P = WEAPONS.fist;
  const cx = ox + dx * P.reach;
  const cy = oy + dy * P.reach;
  const found: Entity[] = [];
  sim.world.intersectionsWithShape({ x: cx, y: cy }, 0, new RAPIER.Ball(P.radius), (c) => {
    const e = sim.entityOf(c);
    if (e && !e.dead && e !== f.entity && !found.includes(e)) found.push(e);
    return true;
  });
  let lx = dx;
  let ly = dy + P.lift;
  const l = Math.sqrt(lx * lx + ly * ly);
  lx /= l;
  ly /= l;
  let hitAny = false;
  for (const e of found) {
    if (e.kind === "fighter" && e.fighter) {
      if (!e.fighter.alive) continue;
      const t = e.body.translation();
      sim.damageFighter(e.fighter, P.damage, f.id, lx * P.knockback, ly * P.knockback, "fist", t.x, t.y);
      hitAny = true;
    } else if (e.kind !== "item") {
      hitProp(sim, e, 4, f.id, "fist", cx, cy);
      if (!e.dead) {
        const m = e.body.mass();
        e.body.applyImpulse({ x: lx * P.propImpulse * Math.min(m, 3), y: ly * P.propImpulse * Math.min(m, 3) }, true);
      }
      hitAny = true;
    }
  }
  const chipped = sim.terrain.carve(cx + dx * 0.2, cy + dy * 0.2, P.terrainRadius, P.terrainDamage);
  if (chipped.length) {
    sim.stats.cellsDestroyed += chipped.length;
    sim.events.push({ type: "carve", tick: sim.tick, cells: chipped });
    hitAny = true;
  }
  sim.events.push({ type: "swing", tick: sim.tick, fighter: f.id, x: cx, y: cy, dx, dy, hit: hitAny, weapon: "fist" });
}

function throwGrenade(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const v = sim.vel(f);
  const body = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(ox + dx * 0.8, oy + dy * 0.8 + 0.2)
      .setLinvel(dx * WEAPONS.grenade.speed + v.x * 0.3, dy * WEAPONS.grenade.speed + v.y * 0.3)
      .setCcdEnabled(true)
      .setAngularDamping(0.5),
  );
  const collider = sim.world.createCollider(
    RAPIER.ColliderDesc.ball(0.22).setDensity(3).setRestitution(0.45).setFriction(0.6).setCollisionGroups(groups(G.GRENADE, G.TERRAIN | G.FIGHTER | G.PROP)),
    body,
  );
  sim.entityStore.register({ id: sim.entityStore.allocateId(), kind: "grenade", body, collider, hw: 0.22, hh: 0.22, hp: 1, maxHp: 1, dead: false, born: sim.tick, owner: f.id, ticksLeft: WEAPONS.grenade.fuse });
}

function fireGrapple(sim: Sim, f: Fighter, ox: number, oy: number, dx: number, dy: number) {
  const Gp = WEAPONS.grapple;
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
    const l = Math.sqrt(px * px + py * py) || 1;
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
  const W = WEAPONS.rocket;
  const keep: Rocket[] = [];
  for (const r of sim.rockets) {
    r.age++;
    r.vy -= W.gravity * DT;
    const sx = r.vx * DT;
    const sy = r.vy * DT;
    const len = Math.sqrt(sx * sx + sy * sy);
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
