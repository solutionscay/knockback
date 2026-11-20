/** Placeholder drawings for props, items and weapons (y-down Graphics, meters). */
import type { Graphics } from "pixi.js";
import { TNT } from "../sim/constants";
import type { Entity } from "../sim/sim";
import { POWER_COLOR, shade } from "./palette";

const C = {
  block: 0xc8a06a,
  blockDark: 0x8d6a3f,
  blockLight: 0xe2c08c,
  crate: 0xa86d3a,
  crateDark: 0x6b4221,
  barrel: 0xd9342b,
  barrelDark: 0x8e1d17,
};

export function drawWeapon(g: Graphics, kind: string, color: number, scale = 1) {
  const s = scale;
  switch (kind) {
    case "rocket":
      g.roundRect(-0.15 * s, -0.15 * s, 1.0 * s, 0.3 * s, 0.08 * s).fill(0x3b4150).stroke({ width: 0.04 * s, color: 0x15171d });
      g.rect(0.72 * s, -0.17 * s, 0.16 * s, 0.34 * s).fill(color);
      g.rect(0.15 * s, 0.1 * s, 0.1 * s, 0.18 * s).fill(0x15171d);
      break;
    case "shotgun":
      g.roundRect(-0.1 * s, -0.08 * s, 0.95 * s, 0.14 * s, 0.04 * s).fill(0x2a2d35);
      g.rect(0.25 * s, -0.09 * s, 0.3 * s, 0.2 * s).fill(0x6b4a2c);
      g.rect(-0.2 * s, -0.06 * s, 0.25 * s, 0.2 * s).fill(0x6b4a2c);
      break;
    case "bat":
      g.poly([0, -0.05 * s, 1.05 * s, -0.12 * s, 1.12 * s, -0.06 * s, 1.12 * s, 0.06 * s, 1.05 * s, 0.12 * s, 0, 0.05 * s]).fill(0xd8a868).stroke({ width: 0.035 * s, color: 0x6b4a2c });
      g.rect(-0.05 * s, -0.06 * s, 0.3 * s, 0.12 * s).fill(0x2a2d35);
      g.rect(0.85 * s, -0.11 * s, 0.05 * s, 0.22 * s).fill(color);
      break;
    case "grenade":
      g.circle(0.35 * s, 0, 0.2 * s).fill(0x4b5a2a).stroke({ width: 0.04 * s, color: 0x1d2410 });
      g.rect(0.3 * s, -0.27 * s, 0.1 * s, 0.1 * s).fill(0x888888);
      break;
    case "fist":
      // a boxing glove in the fighter's color
      g.roundRect(0.12 * s, -0.14 * s, 0.3 * s, 0.28 * s, 0.12 * s).fill(color).stroke({ width: 0.04 * s, color: 0x15171d });
      g.rect(0.04 * s, -0.08 * s, 0.1 * s, 0.16 * s).fill(0xeeeeee).stroke({ width: 0.03 * s, color: 0x15171d });
      break;
    case "grapple":
      g.roundRect(-0.1 * s, -0.1 * s, 0.7 * s, 0.2 * s, 0.05 * s).fill(0x3a3f4a).stroke({ width: 0.035 * s, color: 0x15171d });
      g.moveTo(0.6 * s, 0)
        .lineTo(0.85 * s, -0.16 * s)
        .moveTo(0.6 * s, 0)
        .lineTo(0.88 * s, 0)
        .moveTo(0.6 * s, 0)
        .lineTo(0.85 * s, 0.16 * s)
        .stroke({ width: 0.06 * s, color: 0xc8ccd6, cap: "round" });
      g.rect(0.1 * s, 0.08 * s, 0.1 * s, 0.16 * s).fill(color);
      break;
  }
}

/** Icon for a power-up or weapon item, centered at 0,0, ~0.5 m. */
function itemIcon(g: Graphics, it: string) {
  switch (it) {
    case "health":
      g.rect(-0.07, -0.18, 0.14, 0.36).fill(0xe23b3b);
      g.rect(-0.18, -0.07, 0.36, 0.14).fill(0xe23b3b);
      break;
    case "shield":
      g.circle(0, 0, 0.17).stroke({ width: 0.06, color: 0x2a8fb0 });
      g.circle(-0.05, -0.06, 0.04).fill(0xffffff);
      break;
    case "speed":
      g.poly([0.04, -0.2, -0.12, 0.03, 0.0, 0.03, -0.05, 0.2, 0.13, -0.04, 0.01, -0.04]).fill(0x9a6a00);
      break;
    case "heavy":
      g.poly([-0.17, 0.16, 0.17, 0.16, 0.11, -0.04, -0.11, -0.04]).fill(0x3a3e48);
      g.circle(0, -0.1, 0.07).stroke({ width: 0.045, color: 0x3a3e48 });
      break;
    case "damage":
      g.poly([-0.16, 0.12, -0.02, -0.15, 0.04, -0.15, -0.1, 0.12]).fill(0x8a0a18);
      g.poly([0.0, 0.12, 0.14, -0.15, 0.2, -0.15, 0.06, 0.12]).fill(0x8a0a18);
      break;
    case "jump":
      g.poly([0, -0.2, 0.16, 0, 0.06, 0, 0.06, 0.18, -0.06, 0.18, -0.06, 0, -0.16, 0]).fill(0x5a6a8a);
      break;
    default:
      // a weapon
      drawWeapon(g, it, 0xffb347, 0.36);
      break;
  }
}

/** Draw a prop/item/grenade into g (local frame, centered). Returns true if it needs redrawing every frame. */
export function drawProp(g: Graphics, e: Entity, time: number): boolean {
  g.clear();
  const w = e.hw;
  const h = e.hh;
  const dmg = isFinite(e.maxHp) && e.maxHp > 0 ? 1 - Math.max(0, e.hp) / e.maxHp : 0;
  switch (e.kind) {
    case "block":
      g.rect(-w, -h, w * 2, h * 2).fill(C.block);
      g.rect(-w, -h, w * 2, 0.1).fill(C.blockLight);
      g.rect(-w, h - 0.1, w * 2, 0.1).fill(C.blockDark);
      g.rect(-w, -h, w * 2, h * 2).stroke({ width: 0.05, color: 0x4e3a22 });
      if (dmg > 0.25) g.moveTo(-w * 0.6, -h * 0.9).lineTo(-w * 0.1, -h * 0.2).lineTo(-w * 0.35, h * 0.4).stroke({ width: 0.05, color: 0x4e3a22 });
      if (dmg > 0.6) g.moveTo(w * 0.7, -h * 0.5).lineTo(w * 0.1, h * 0.1).lineTo(w * 0.4, h * 0.85).stroke({ width: 0.05, color: 0x4e3a22 });
      return false;
    case "crate":
      g.rect(-w, -h, w * 2, h * 2).fill(C.crate).stroke({ width: 0.06, color: C.crateDark });
      g.moveTo(-w, -h).lineTo(w, h).moveTo(w, -h).lineTo(-w, h).stroke({ width: 0.09, color: C.crateDark });
      g.rect(-w * 0.35, -h * 0.35, w * 0.7, h * 0.7).fill({ color: 0xffde4a, alpha: 0.85 });
      g.rect(-0.04, -0.13, 0.08, 0.17).fill(0x3a2a10);
      g.circle(0, 0.1, 0.04).fill(0x3a2a10);
      return false;
    case "barrel": {
      const armed = e.fuse !== undefined;
      const blink = armed && Math.floor(time * 30) % 2 === 0;
      g.roundRect(-w, -h, w * 2, h * 2, 0.1).fill(blink ? 0xffffff : C.barrel).stroke({ width: 0.05, color: C.barrelDark });
      g.rect(-w, -h * 0.55, w * 2, 0.1).fill(C.barrelDark);
      g.rect(-w, h * 0.45, w * 2, 0.1).fill(C.barrelDark);
      g.poly([0, -0.18, 0.17, 0.13, -0.17, 0.13]).fill(0xffd23a);
      g.rect(-0.02, -0.08, 0.04, 0.12).fill(0x1a1a1a);
      return armed;
    }
    case "tnt": {
      const lit = e.fuse !== undefined;
      const blink = lit && Math.floor(time * ((e.fuse ?? 99) < 40 ? 20 : 6)) % 2 === 0;
      for (let i = -1; i <= 1; i++) g.roundRect(i * 0.26 - 0.12, -h, 0.24, h * 2, 0.06).fill(blink ? 0xffffff : 0xc81e1e).stroke({ width: 0.03, color: 0x5a0a0a });
      g.rect(-w, -0.07, w * 2, 0.14).fill(0x2a1a10);
      // fuse wire shortens as it burns
      const len = lit ? 0.5 * Math.max(0, e.fuse!) / TNT.fuse : 0.5;
      g.moveTo(0, -h).quadraticCurveTo(0.12, -h - len * 0.6, 0.05, -h - len).stroke({ width: 0.04, color: 0x222222 });
      if (lit) g.circle(0.05, -h - len, 0.08 + 0.04 * Math.sin(time * 40)).fill(0xffd23a);
      return true;
    }
    case "gas": {
      const on = e.thrust !== undefined;
      g.roundRect(-w, -h, w * 2, h * 2, 0.18).fill(0x5fb7e5).stroke({ width: 0.04, color: 0x2a5a78 });
      g.rect(-w, -h * 0.25, w * 2, 0.16).fill(0xffffff);
      g.rect(-0.07, -h - 0.12, 0.14, 0.14).fill(0x30343c);
      g.rect(-0.12, -h - 0.16, 0.24, 0.05).fill(0x30343c);
      if (on) g.poly([-0.14, h, 0.14, h, 0, h + 0.5 + 0.2 * Math.sin(time * 50)]).fill(0xffb347);
      return on;
    }
    case "steel":
      g.rect(-w, -h, w * 2, h * 2).fill(0x5a606c).stroke({ width: 0.07, color: 0x2a2e36 });
      g.moveTo(-w, -h).lineTo(w, h).moveTo(w, -h).lineTo(-w, h).stroke({ width: 0.08, color: 0x3f444e });
      for (const [x, y] of [
        [-w + 0.1, -h + 0.1],
        [w - 0.1, -h + 0.1],
        [-w + 0.1, h - 0.1],
        [w - 0.1, h - 0.1],
      ] as const)
        g.circle(x, y, 0.045).fill(0xa8b0bc);
      return false;
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
    case "item": {
      const pulse = 0.5 + 0.5 * Math.sin(time * 6);
      const it = e.itemType ?? "health";
      const power = it in POWER_COLOR;
      const col = power ? POWER_COLOR[it]! : 0xffb347;
      g.circle(0, 0, 0.55 + pulse * 0.12).fill({ color: col, alpha: 0.16 + pulse * 0.12 });
      // weapons are what everyone is fighting over: a bright beacon ring
      if (!power) g.circle(0, 0, 0.7 + pulse * 0.2).stroke({ width: 0.07, color: 0xffd27a, alpha: 0.5 + pulse * 0.4 });
      g.roundRect(-w, -h, w * 2, h * 2, 0.1).fill(power ? 0xf4f4f4 : 0x2a2d35).stroke({ width: 0.05, color: shade(col, 0.7) });
      itemIcon(g, it);
      return true;
    }
    case "grenade": {
      const blink = Math.floor(time * ((e.ticksLeft ?? 60) < 40 ? 16 : 6)) % 2 === 0;
      g.circle(0, 0, w).fill(0x4b5a2a).stroke({ width: 0.04, color: 0x1d2410 });
      g.circle(0, -w * 0.4, 0.07).fill(blink ? 0xff3030 : 0x551010);
      return true;
    }
  }
  return false;
}
