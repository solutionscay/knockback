/**
 * Breakable chains (#34). Each floating platform hangs from two chains, one
 * per anchor cell (F_ANCHOR). A chain has hit points (sim.ruleset.arena.chain.hp): explosions,
 * shotgun pellets, bat swings, fists with the heavy power-up and heavy flying
 * things damage it.
 *
 * - Both chains intact: the platform is static terrain, as before.
 * - One chain gone (or its anchor cell destroyed): the platform comes loose as
 *   a dynamic piece hung from the other chain by a rope joint to a fixed pivot
 *   sim.ruleset.arena.chain.length above its anchor, so it swings.
 * - All chains gone: it falls and crushes what is below (checkCrush), credited
 *   to whoever broke the last chain.
 *
 * Chains are data on the Sim (no colliders): hits are segment tests, so shots
 * pass through them. Deterministic: chains are kept in grid scan order.
 */
import RAPIER from "@dimforge/rapier2d-deterministic-compat";

import { dcos, dsin } from "./dmath";
import { CELL, F_ANCHOR } from "./grid";
import type { Sim } from "./sim";
import type { Entity } from "./sim-types";
import type { PieceCell } from "./terrain";

export interface Chain {
  id: number;
  /** anchor cell while the platform is static terrain */
  cx: number;
  cy: number;
  /** pivot: the fixed top of the chain's physical length (the chain is drawn on up to the view's top) */
  px: number;
  py: number;
  hp: number;
  broken: boolean;
  brokenTick: number;
  /** world point where it snapped (the upper part hangs down to here) */
  breakX: number;
  breakY: number;
  cause: string;
  /** who damaged it last (-1 nobody): credit for what the platform crushes */
  lastHitBy: number;
  /** entity id of the swinging piece it holds, or -1 while the platform is static */
  piece: number;
  joint: RAPIER.ImpulseJoint | null;
}

/** One chain per anchor cell, in grid scan order. */
export function buildChains(sim: Sim): Chain[] {
  const g = sim.grid;
  const out: Chain[] = [];
  for (let cy = 0; cy < g.rows; cy++)
    for (let cx = 0; cx < g.cols; cx++) {
      if (!(g.flags[g.idx(cx, cy)]! & F_ANCHOR)) continue;
      const x = g.wx(cx) + CELL / 2;
      const y = g.wy(cy) + CELL;
      out.push({ id: out.length, cx, cy, px: x, py: y + sim.ruleset.arena.chain.length, hp: sim.ruleset.arena.chain.hp, broken: false, brokenTick: -1, breakX: x, breakY: y, cause: "", lastHitBy: -1, piece: -1, joint: null });
    }
  return out;
}

/** The chain whose (static) anchor is this cell, if any. */
export function chainAtCell(sim: Sim, cx: number, cy: number): Chain | undefined {
  return sim.chainByCell.get(sim.grid.idx(cx, cy));
}

/** Local point of a piece cell's top middle (where a chain holds it). */
function cellTop(c: PieceCell): { x: number; y: number } {
  return { x: (c.lx + 0.5) * CELL, y: (c.ly + 1) * CELL };
}

/** Where the chain meets the platform now (world). */
export function chainAttach(sim: Sim, ch: Chain): { x: number; y: number } {
  if (ch.piece >= 0) {
    const e = sim.entities.get(ch.piece);
    const c = e?.cells?.find((k) => k.chain === ch.id);
    if (e && c) {
      const t = e.body.translation();
      const a = e.body.rotation();
      const l = cellTop(c);
      const co = dcos(a);
      const si = dsin(a);
      return { x: t.x + l.x * co - l.y * si, y: t.y + l.x * si + l.y * co };
    }
  }
  return { x: ch.px, y: ch.py - sim.ruleset.arena.chain.length };
}

/** Hang a freshly made piece from the intact chains its cells carry. */
export function hangPiece(sim: Sim, e: Entity) {
  for (const c of e.cells!) {
    if (c.chain === undefined) continue;
    const ch = sim.chains[c.chain]!;
    if (ch.broken) {
      c.chain = undefined;
      continue;
    }
    const l = cellTop(c);
    ch.piece = e.id;
    ch.joint = sim.world.createImpulseJoint(RAPIER.JointData.rope(sim.ruleset.arena.chain.length, { x: ch.px, y: ch.py }, l), sim.terrain.body, e.body, true);
  }
}

/** Segments that can be hit: attach to pivot, then straight up (the part drawn above the pivot). */
function segments(sim: Sim, ch: Chain): [number, number, number, number][] {
  const a = chainAttach(sim, ch);
  return [
    [a.x, a.y, ch.px, ch.py],
    [ch.px, ch.py, ch.px, ch.py + sim.ruleset.arena.chain.reachAbove],
  ];
}

function closestOnSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): { x: number; y: number; d: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  const x = ax + dx * t;
  const y = ay + dy * t;
  return { x, y, d: Math.sqrt((px - x) * (px - x) + (py - y) * (py - y)) };
}

/** Closest point on the chain to (x, y), and its distance. */
function nearest(sim: Sim, ch: Chain, x: number, y: number): { x: number; y: number; d: number } {
  let best = { x: 0, y: 0, d: Infinity };
  for (const s of segments(sim, ch)) {
    const c = closestOnSeg(x, y, s[0], s[1], s[2], s[3]);
    if (c.d < best.d) best = c;
  }
  return best;
}

/** Where segment p0-p1 crosses segment q0-q1 (or null). */
function crossing(p0x: number, p0y: number, p1x: number, p1y: number, q0x: number, q0y: number, q1x: number, q1y: number): { x: number; y: number } | null {
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = q1x - q0x;
  const sy = q1y - q0y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q0x - p0x) * sy - (q0y - p0y) * sx) / den;
  const u = ((q0x - p0x) * ry - (q0y - p0y) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p0x + rx * t, y: p0y + ry * t };
}

/** Does a shot from (x0, y0) to (x1, y1) pass through (or within sim.ruleset.arena.chain.hitRadius of) the chain? Returns the hit point. */
function shotHit(sim: Sim, ch: Chain, x0: number, y0: number, x1: number, y1: number): { x: number; y: number } | null {
  for (const s of segments(sim, ch)) {
    const c = crossing(x0, y0, x1, y1, s[0], s[1], s[2], s[3]);
    if (c) return c;
  }
  // grazing: the shot's end points near the chain, or the chain's ends near the shot
  const n0 = nearest(sim, ch, x1, y1);
  if (n0.d <= sim.ruleset.arena.chain.hitRadius) return n0;
  for (const s of segments(sim, ch)) {
    const c = closestOnSeg(s[0], s[1], x0, y0, x1, y1);
    if (c.d <= sim.ruleset.arena.chain.hitRadius) return { x: s[0], y: s[1] };
  }
  return null;
}

export function damageChain(sim: Sim, ch: Chain, dmg: number, by: number, cause: string, x: number, y: number) {
  if (ch.broken || dmg <= 0) return;
  ch.hp -= dmg;
  if (by >= 0) ch.lastHitBy = by;
  if (ch.hp <= 0) breakChain(sim, ch, cause, x, y);
}

/** Explosion: damage falls off linearly with distance from the blast to the chain. */
export function blastChains(sim: Sim, x: number, y: number, radius: number, damage: number, owner: number, cause: string) {
  for (const ch of sim.chains) {
    if (ch.broken) continue;
    const n = nearest(sim, ch, x, y);
    if (n.d >= radius) continue;
    damageChain(sim, ch, damage * (1 - n.d / radius), owner, cause, n.x, n.y);
  }
}

/** A shot (pellet) along a segment: it goes through the chains it crosses. */
export function shootChains(sim: Sim, x0: number, y0: number, x1: number, y1: number, damage: number, owner: number, cause: string) {
  for (const ch of sim.chains) {
    if (ch.broken) continue;
    const h = shotHit(sim, ch, x0, y0, x1, y1);
    if (h) damageChain(sim, ch, damage, owner, cause, h.x, h.y);
  }
}

/** A melee swing centered at (x, y) with radius r. */
export function swingChains(sim: Sim, x: number, y: number, r: number, damage: number, owner: number, cause: string): boolean {
  let hit = false;
  for (const ch of sim.chains) {
    if (ch.broken) continue;
    const n = nearest(sim, ch, x, y);
    if (n.d > r + sim.ruleset.arena.chain.hitRadius) continue;
    damageChain(sim, ch, damage, owner, cause, n.x, n.y);
    hit = true;
  }
  return hit;
}

export function breakChain(sim: Sim, ch: Chain, cause: string, x: number, y: number) {
  if (ch.broken) return;
  ch.broken = true;
  ch.hp = 0;
  ch.brokenTick = sim.tick;
  ch.breakX = x;
  ch.breakY = Math.max(y, Math.min(ch.py, chainAttach(sim, ch).y));
  ch.cause = cause;
  sim.stats.chainsBroken++;
  sim.events.push({ type: "chainBreak", tick: sim.tick, chain: ch.id, x, y, cause, by: ch.lastHitBy });
  const g = sim.grid;
  if (ch.piece < 0) {
    // static platform: it no longer holds; the support check decides if it swings or falls
    if (g.solid(ch.cx, ch.cy)) g.flags[g.idx(ch.cx, ch.cy)]! &= ~F_ANCHOR;
    sim.terrain.supportDirty = true;
    return;
  }
  const e = sim.entities.get(ch.piece);
  if (e && !e.dead) {
    if (ch.joint) sim.world.removeImpulseJoint(ch.joint, true);
    for (const c of e.cells!)
      if (c.chain === ch.id) {
        c.chain = undefined;
        c.stub = ch.id;
      }
    e.triggeredBy = ch.lastHitBy;
    e.body.wakeUp();
    sim.stats.platformsDropped++;
    const t = e.body.translation();
    sim.events.push({ type: "platformFall", tick: sim.tick, entity: e.id, x: t.x, y: t.y, by: ch.lastHitBy });
  }
  ch.joint = null;
}

/** Each tick: anchors that vanished, and heavy things flying into chains. */
export function updateChains(sim: Sim) {
  for (const ch of sim.chains) {
    if (ch.broken) continue;
    if (ch.piece < 0) {
      if (!sim.grid.solid(ch.cx, ch.cy)) {
        const a = chainAttach(sim, ch);
        breakChain(sim, ch, "anchor", a.x, a.y);
        continue;
      }
    } else {
      const e = sim.entities.get(ch.piece);
      if (!e || e.dead || !e.cells!.some((c) => c.chain === ch.id)) {
        // the cell it held was destroyed, or the piece is gone: removing the body removed the joint
        ch.joint = null;
        breakChain(sim, ch, "anchor", ch.px, ch.py - sim.ruleset.arena.chain.length);
        continue;
      }
    }
    heavyHits(sim, ch);
  }
}

/** Middle of a body's box (a terrain piece's origin is its corner cell). */
function center(o: Entity): { x: number; y: number } {
  const t = o.body.translation();
  if (o.kind !== "chunk") return { x: t.x, y: t.y };
  const a = o.body.rotation();
  const co = dcos(a);
  const si = dsin(a);
  return { x: t.x + o.hw * co - o.hh * si, y: t.y + o.hw * si + o.hh * co };
}

/** Fast heavy props and pieces crossing the chain (not fighters, not the piece it holds). */
function heavyHits(sim: Sim, ch: Chain) {
  const a = chainAttach(sim, ch);
  // an axis-aligned box around the attach-to-pivot part (no atan2: not exact across JS engines), then a distance test
  const hx0 = Math.abs(ch.px - a.x) / 2 + sim.ruleset.arena.chain.hitRadius;
  const hy0 = Math.abs(ch.py - a.y) / 2 + sim.ruleset.arena.chain.hitRadius;
  let dmg = 0;
  let by = -1;
  let hx = 0;
  let hy = 0;
  sim.world.intersectionsWithShape({ x: (a.x + ch.px) / 2, y: (a.y + ch.py) / 2 }, 0, new RAPIER.Cuboid(hx0, hy0), (c) => {
    const o = sim.entityOf(c);
    if (!o || o.dead || o.id === ch.piece || o.kind === "fighter" || o.kind === "item" || o.kind === "grenade") return true;
    const p = center(o);
    if (closestOnSeg(p.x, p.y, a.x, a.y, ch.px, ch.py).d > Math.min(o.hw, o.hh) + sim.ruleset.arena.chain.hitRadius) return true;
    const m = o.body.mass();
    if (m < sim.ruleset.arena.chain.heavyMinMass) return true;
    const v = o.body.linvel();
    const s = Math.sqrt(v.x * v.x + v.y * v.y);
    if (s < sim.ruleset.arena.chain.heavyMinSpeed) return true;
    const d = (s - sim.ruleset.arena.chain.heavyMinSpeed + 1) * Math.sqrt(m) * sim.ruleset.arena.chain.heavyPerUnit;
    if (d > dmg) {
      dmg = d;
      by = o.triggeredBy ?? -1;
      const n = nearest(sim, ch, p.x, p.y);
      hx = n.x;
      hy = n.y;
    }
    return true;
  });
  if (dmg > 0) damageChain(sim, ch, dmg, by, "heavy", hx, hy);
}
