/** Placeholder drawings for props, items and weapons (y-down Graphics, meters). */
import type { Graphics } from "pixi.js";
import { TNT } from "../sim/constants";
import type { Entity } from "../sim/sim-types";
import { POWER_COLOR, shade } from "./palette";


const INK = 0x15171d;
/** The pickup badge: drawn bigger than the 0.5 m physics box so the icon reads in View all at 720p (the body is unchanged). */
export const PICKUP_R = 0.56;

/**
 * A pickup's frame: a soft glow and a round badge (crates and barrels are square, so the circle reads as "pickup").
 * Weapons get a cream badge with a thick amber rim and a pulsing ring; power-ups a badge tinted their color. The icon
 * on it is a plush sprite (pickupFrame, world-art.ts).
 */
export function drawPickup(g: Graphics, it: string, time: number) {
  const pulse = 0.5 + 0.5 * Math.sin(time * 5);
  const power = it in POWER_COLOR;
  const col = power ? POWER_COLOR[it]! : 0xffb347;
  const r = PICKUP_R;
  g.circle(0, 0, r + 0.16 + pulse * 0.08).fill({ color: col, alpha: 0.14 + pulse * 0.12 });
  if (!power) g.circle(0, 0, r + 0.12 + pulse * 0.1).stroke({ width: 0.06, color: 0xffd27a, alpha: 0.35 + pulse * 0.4 });
  g.circle(0, 0, r + 0.03).fill(INK);
  g.circle(0, 0, r - 0.04).fill(power ? col : 0xfff3d6).stroke({ width: 0.08, color: power ? shade(col, 0.75) : 0xffa21f });
  if (power) g.circle(0, 0, r - 0.13).fill({ color: 0xffffff, alpha: 0.55 });
}

/** The plush sprite on a pickup's badge: w-<weapon> or p-<power>. */
export const pickupFrame = (it: string) => (it in POWER_COLOR ? "p-" : "w-") + it;

/** The plush sprite of a prop and its damage state (crate-0, crate-1, crate-2, steel), or null: drawn in code. */
export function propFrame(e: Entity): string | null {
  switch (e.kind) {
    case "steel":
      return "steel";
    case "block":
    case "crate":
    case "barrel":
    case "tnt":
    case "gas": {
      const dmg = isFinite(e.maxHp) && e.maxHp > 0 ? 1 - Math.max(0, e.hp) / e.maxHp : 0;
      return `${e.kind}-${dmg > 0.6 ? 2 : dmg > 0.25 ? 1 : 0}`;
    }
  }
  return null;
}

/**
 * Draw a prop/item/grenade into g (local frame, centered): the code parts. A prop with a plush sprite (propFrame)
 * gets only what moves on it here (a fuse, a flame); `blink` says when the sprite flashes white. Returns true if it
 * needs redrawing every frame.
 */
export function drawProp(g: Graphics, e: Entity, time: number, out: { blink: boolean } = { blink: false }): boolean {
  g.clear();
  const w = e.hw;
  const h = e.hh;
  out.blink = false;
  switch (e.kind) {
    case "block":
    case "crate":
    case "steel":
      return false;
    case "barrel": {
      const armed = e.fuse !== undefined;
      out.blink = armed && Math.floor(time * 30) % 2 === 0;
      return armed;
    }
    case "tnt": {
      const lit = e.fuse !== undefined;
      out.blink = lit && Math.floor(time * ((e.fuse ?? 99) < 40 ? 20 : 6)) % 2 === 0;
      // fuse wire shortens as it burns
      const len = lit ? 0.5 * Math.max(0, e.fuse!) / TNT.fuse : 0.5;
      g.moveTo(0, -h + 0.04).quadraticCurveTo(0.12, -h - len * 0.6, 0.05, -h - len).stroke({ width: 0.04, color: 0x222222 });
      if (lit) g.circle(0.05, -h - len, 0.08 + 0.04 * Math.sin(time * 40)).fill(0xffd23a);
      return true;
    }
    case "gas": {
      const on = e.thrust !== undefined;
      if (on) g.poly([-0.14, h - 0.05, 0.14, h - 0.05, 0, h + 0.5 + 0.2 * Math.sin(time * 50)]).fill(0xffb347);
      return on;
    }
    case "glass":
      g.rect(-w, -h, w * 2, h * 2).fill({ color: 0x9fe8ff, alpha: 0.35 }).stroke({ width: 0.04, color: 0xd8f6ff, alpha: 0.9 });
      g.moveTo(-w * 0.4, -h * 0.6).lineTo(w * 0.5, -h * 0.75).stroke({ width: 0.025, color: 0xffffff, alpha: 0.8 });
      g.moveTo(-w * 0.5, -h * 0.2).lineTo(w * 0.3, -h * 0.32).stroke({ width: 0.02, color: 0xffffff, alpha: 0.6 });
      return false;
    case "pad":
      g.rect(-w, -h * 0.2, w * 2, h * 1.2).fill(0x1a1a1a);
      for (let i = 0; i < 5; i++) g.poly([-w + i * 0.26, h, -w + i * 0.26 + 0.13, h, -w + i * 0.26 + 0.26, -h * 0.2, -w + i * 0.26 + 0.13, -h * 0.2]).fill(0xffd23a);
      g.roundRect(-w, -h, w * 2, h * 0.5, 0.05).fill(0x44d06a).stroke({ width: 0.03, color: 0x1a6a30 });
      return false;
    case "weight":
      g.poly([-w * 0.75, -h, w * 0.75, -h, w, h, -w, h]).fill(0x3a3e48).stroke({ width: 0.06, color: 0x15171d });
      g.circle(0, -h - 0.08, 0.13).stroke({ width: 0.06, color: 0x8a8a96 });
      g.rect(-0.22, -0.05, 0.44, 0.22).fill(0xe8c44a);
      g.rect(-0.03, 0.0, 0.06, 0.12).fill(0x15171d);
      return false;
    case "item":
      drawPickup(g, e.itemType ?? "health", time);
      return true;
    case "grenade": {
      const blink = Math.floor(time * ((e.ticksLeft ?? 60) < 40 ? 16 : 6)) % 2 === 0;
      g.circle(0, 0, w).fill(0x4b5a2a).stroke({ width: 0.04, color: 0x1d2410 });
      g.circle(0, -w * 0.4, 0.07).fill(blink ? 0xff3030 : 0x551010);
      return true;
    }
  }
  return false;
}
