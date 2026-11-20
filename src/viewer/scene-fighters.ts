import { Container, Graphics } from "pixi.js";
import { FIGHTER } from "../sim/constants";
import type { Fighter, Sim } from "../sim/sim";
import type { CameraFrame, SceneCamera } from "./scene-camera";
import type { Fx } from "./fx";
import { CELL } from "../sim/grid";
import { drawArm, drawBody, drawFeet, drawHand, FEET_Y, FOOT_X, drawSilhouette, drawVisor, faceFor, faceKey, flapStep, hash, lodFor, WEAPON_SCALE, type FaceMood } from "./bot";
import { POWER_COLOR } from "./palette";
import { pixiPen } from "./pixiPen";
import { drawWeapon } from "./props";
import type { XformAt } from "./scene";

interface FighterView {
  f: Fighter;
  root: Container;
  /** torso, feet, head and marks (redrawn only when bodyKey changes) */
  body: Graphics;
  bodyKey: string;
  /** the LED visor (redrawn only when faceKey changes) */
  face: Graphics;
  faceKey: string;
  arm: Graphics;
  /** the feet, in their own layer: each foot stands on the ground under it */
  feet: Graphics;
  feetKey: string;
  /** a soft contact shadow on the ground while standing */
  shadow: Graphics;
  /** the identity's hash: its blink rhythm */
  h: number;
  /** the "> <" face after a hit */
  hitT: number;
  lastFlash: number;
  gun: Graphics;
  flash: Graphics;
  aura: Graphics;
  over: Graphics;
  gunKind: string;
  swingT: number;
  swapT: number;
  wingT: number;
  sx: number;
  sy: number;
  spin: number;
  flashT: number;
  recoil: number;
  ghostHp: number;
  trailT: number;
}

export class FighterViews {
  readonly layer = new Container();
  readonly barsG = new Graphics();
  private fighters: FighterView[] = [];
  morale: string[] = [];
  celebrateId = -1;

  clear() {
    for (const v of this.fighters) {
      v.root.destroy({ children: true });
      v.shadow.destroy();
    }
    this.fighters = [];
  }

  load(sim: Sim) {
    for (const f of sim.fighters) this.fighters.push(this.makeFighter(f));
  }

  private makeFighter(f: Fighter): FighterView {
    // a Skipper-style bot drawn from the fighter's generated identity (#18): body, visor, arm, weapon
    const root = new Container();
    const body = new Graphics();
    const face = new Graphics();
    const arm = new Graphics();
    const feet = new Graphics();
    const shadow = new Graphics();
    const gun = new Graphics();
    const flash = new Graphics();
    const aura = new Graphics();
    const over = new Graphics();
    drawSilhouette(pixiPen(flash), f.look);
    flash.alpha = 0;
    root.addChild(aura, feet, body, face, arm, gun, flash, over);
    this.layer.addChild(shadow, root);
    return { f, root, body, bodyKey: "", face, faceKey: "", arm, feet, feetKey: "", shadow, h: hash(f.look.name), hitT: 0, lastFlash: 0, gun, flash, aura, over, gunKind: "", swingT: 0, swapT: 0, wingT: 0, sx: 1, sy: 1, spin: 0, flashT: 0, recoil: 0, ghostHp: f.hp, trailT: 0 };
  }

  private drawGun(v: FighterView, kind: string) {
    if (v.gunKind === kind) return;
    v.gunKind = kind;
    v.gun.clear();
    drawWeapon(v.gun, kind, v.f.color);
    if (kind !== "fist") drawHand(v.gun, v.f.look); // the fist's glove is the hand
  }

  get(id: number) {
    return this.fighters[id]!;
  }

  render(sim: Sim, fx: Fx, camera: SceneCamera, frame: CameraFrame, W: number, H: number, time: number, dt: number, alpha: number, fxDt: number, xform: XformAt) {
    const { cx, cy, s, shx, shy } = frame;
    const ui = H / 1080;
    const bars = this.barsG;
    bars.clear();
    for (const v of this.fighters) {
      const f = v.f;
      if (f.removed) {
        v.root.visible = false;
        continue;
      }
      v.root.visible = true;
      const p = xform(f.entity, alpha);
      const vel = f.entity.body.linvel();
      const speed = Math.hypot(vel.x, vel.y);
      // squash & stretch relax
      v.sx += (1 - v.sx) * Math.min(1, dt * 12);
      v.sy += (1 - v.sy) * Math.min(1, dt * 12);
      v.recoil = Math.max(0, v.recoil - dt * 2.5);
      v.wingT = Math.max(0, v.wingT - dt);
      if (f.stun > 0 && !f.grounded && f.alive) v.spin += f.facing * -dt * Math.min(18, speed * 0.9);
      else if (f.alive) v.spin *= Math.max(0, 1 - dt * 14);
      if (Math.abs(v.spin) < 0.01 && f.alive) v.spin = 0;
      const rot = f.alive ? v.spin : -p.a;
      const hop = this.celebrateId === f.id ? Math.abs(Math.sin(time * 5.5)) * 0.9 : 0;
      v.root.position.set(p.x, -p.y - hop);
      v.root.rotation = rot;
      if (this.celebrateId === f.id) {
        if (hop < 0.08) {
          v.sx = 1.25;
          v.sy = 0.8;
        }
        if (Math.random() < 0.6) {
          const cols = [f.color, 0xffffff, 0xffe14d, 0xff7ab8, 0x7de0ff];
          fx.add({
            x: p.x + (Math.random() - 0.5) * 14,
            y: p.y + 7 + Math.random() * 2,
            vx: (Math.random() - 0.5) * 2,
            vy: -1 - Math.random() * 2,
            life: 2.5,
            size: 0.12 + Math.random() * 0.08,
            color: cols[(Math.random() * cols.length) | 0]!,
            kind: "square",
            gravity: 2,
            drag: 0.8,
            rot: Math.random() * 6,
            vr: (Math.random() - 0.5) * 12,
          });
        }
      }
      v.root.scale.set(v.sx * (f.facing < 0 ? -1 : 1), v.sy);
      if (this.celebrateId === f.id) v.root.scale.x = Math.abs(v.root.scale.x) * (Math.sin(time * 1.3) > 0 ? 1 : -1);
      v.root.alpha = f.alive ? 1 : Math.max(0, 1 - (sim.tick - f.koTick) / 120);
      // the bot: body (feet tuck in the air, marks flap), then the LED face
      const aimLocalX = f.aimX * f.facing;
      const aimLocalY = -f.aimY;
      const weapon = sim.weapon(f);
      const aiming = f.alive && weapon !== "fist" && weapon !== "bat";
      const bodyKey = `${!f.grounded && f.alive ? 1 : 0}${flapStep(f.look, time)}${f.look.mark === "antenna" && aiming ? 1 : 0}`;
      if (bodyKey !== v.bodyKey) {
        v.bodyKey = bodyKey;
        v.body.clear();
        drawBody(pixiPen(v.body), f.look, { t: time, air: !f.grounded && f.alive, aiming, feet: false });
      }
      if (v.flashT > v.lastFlash) v.hitT = 0.42;
      v.lastFlash = v.flashT;
      v.hitT = Math.max(0, v.hitT - dt);
      const mood: FaceMood = !f.alive
        ? "ko"
        : v.hitT > 0.35
          ? "white"
          : v.hitT > 0
            ? "hit"
            : f.stun > 0
              ? "stun"
              : this.celebrateId === f.id
                ? "win"
                : ((this.morale[f.id] ?? "confident") as FaceMood);
      const look = { lookX: aimLocalX > 0.3 ? 1 : aimLocalX < -0.3 ? -1 : 0, lookY: aimLocalY < -0.5 ? -1 : aimLocalY > 0.5 ? 1 : 0, koT: (sim.tick - f.koTick) / 60 };
      const lod = lodFor(s);
      const faceNow = faceFor(mood, time, v.h, f.look.eyes, look);
      const key = faceKey(faceNow, lod);
      if (key !== v.faceKey) {
        v.faceKey = key;
        v.face.clear();
        drawVisor(pixiPen(v.face), f.look, faceNow, lod);
      }
      if (mood === "furious" && Math.random() < 0.08) fx.add({ x: p.x + (Math.random() - 0.5) * 0.4, y: p.y + 0.95, vy: 1.5, kind: "smoke", life: 0.6, size: 0.08, size1: 0.25, color: 0xffffff, alpha: 0.6, back: false });
      // gun
      this.drawGun(v, weapon);
      v.gun.visible = f.alive;
      v.gun.position.set(-v.recoil * 0.5 * 1, -0.05);
      v.gun.rotation = Math.atan2(aimLocalY, aimLocalX);
      if (v.swingT > 0) {
        // bat swing: sweep from high to low
        v.swingT -= dt;
        v.gun.rotation += -1.3 + 2.6 * (v.swingT / 0.2);
      }
      v.swapT = Math.max(0, v.swapT - dt);
      v.gun.scale.set(WEAPON_SCALE * (1 + v.swapT * 2.2));
      // the front arm reaches from the shoulder to the grip
      v.arm.clear();
      v.arm.visible = f.alive;
      if (f.alive) drawArm(pixiPen(v.arm), f.look, v.gun.position.x, v.gun.position.y, v.gun.rotation);
      v.gun.tint = 0xffffff;
      v.gun.alpha = v.swapT > 0.14 ? 0.5 : 1;
      // power-up visuals, readable on the fighter
      const pw = f.power;
      const au = v.aura;
      const ov = v.over;
      au.clear();
      ov.clear();
      if (f.alive) {
        if (pw.damage > 0) {
          const pr = 0.85 + 0.12 * Math.sin(time * 10);
          au.circle(0, 0, pr).fill({ color: POWER_COLOR.damage!, alpha: 0.28 });
          au.circle(0, 0, pr * 0.8).fill({ color: POWER_COLOR.damage!, alpha: 0.2 });
        }
        if (pw.speed > 0) {
          for (let i = 0; i < 3; i++) au.moveTo(-0.55, -0.4 + i * 0.4).lineTo(-1.1 - Math.random() * 0.3, -0.4 + i * 0.4).stroke({ width: 0.06, color: POWER_COLOR.speed!, alpha: 0.8 });
        }
        if (pw.jump > 0) {
          const flap = v.wingT > 0 ? Math.sin(time * 40) * 0.2 : 0;
          au.poly([-0.3, -0.35, -0.95, -0.75 - flap, -0.75, -0.25, -0.95, -0.05 + flap]).fill({ color: 0xffffff, alpha: 0.85 });
        }
        if (pw.heavy > 0) {
          ov.roundRect(-0.46, -0.1, 0.92, 0.32, 0.08).fill(0x4a4e58).stroke({ width: 0.05, color: 0x22252c });
          ov.circle(-0.28, 0.06, 0.05).fill(0xa8b0bc);
          ov.circle(0.28, 0.06, 0.05).fill(0xa8b0bc);
        }
        if (pw.shield > 0) {
          const ending = pw.shield < 90 && Math.floor(time * 10) % 2 === 0;
          const wob = 1.12 + 0.04 * Math.sin(time * 7);
          ov.circle(0, 0, wob).fill({ color: POWER_COLOR.shield!, alpha: ending ? 0.06 : 0.16 }).stroke({ width: 0.06, color: POWER_COLOR.shield!, alpha: ending ? 0.3 : 0.85 });
          ov.circle(-0.45, -0.5, 0.12).fill({ color: 0xffffff, alpha: 0.5 });
        }
      }
      v.root.scale.x *= pw.heavy > 0 ? 1.12 : 1;
      v.root.scale.y *= pw.heavy > 0 ? 1.1 : 1;
      // feet on the ground (view only): while standing, squash, stretch and the heavy scale grow from the feet, not
      // from the capsule's middle, and each foot is set on the ground under it (a step edge, stairs of cells)
      const standing = f.alive && f.grounded && Math.abs(rot) < 0.05 && this.celebrateId !== f.id;
      const ky = v.root.scale.y;
      if (standing) v.root.position.y = -p.y + FEET_Y * (1 - ky);
      let dl = 0, dr = 0;
      if (standing) {
        const kx = v.root.scale.x;
        const bottom = p.y - FEET_Y;
        [dl, dr] = FOOT_X.map((lx) => {
          const top = groundTop(sim, p.x + lx * kx, bottom);
          return top === null ? 0 : -(top - bottom) / ky; // local y grows downward
        }) as [number, number];
      }
      const feetKey = `${!f.grounded && f.alive ? 1 : 0}|${dl.toFixed(3)}|${dr.toFixed(3)}`;
      if (feetKey !== v.feetKey) {
        v.feetKey = feetKey;
        v.feet.clear();
        drawFeet(pixiPen(v.feet), f.look, { air: !f.grounded && f.alive, dl, dr });
      }
      v.shadow.clear();
      if (standing) v.shadow.ellipse(p.x, -(p.y - FEET_Y) + 0.02, 0.44 * Math.abs(v.root.scale.x), 0.075).fill({ color: 0x000000, alpha: 0.3 });
      // hit flash
      v.flashT = Math.max(0, v.flashT - dt);
      v.flash.alpha = v.flashT > 0 ? 0.85 : f.outsideZone && Math.floor(time * 8) % 2 === 0 ? 0.25 : 0;
      v.flash.tint = f.outsideZone && v.flashT <= 0 ? 0xff3355 : 0xffffff;
      // motion trail when launched
      v.trailT -= fxDt;
      if (speed > 11 && v.trailT <= 0 && f.alive) {
        v.trailT = 0.025;
        fx.add({ x: p.x, y: p.y, kind: "trail", life: 0.22, size: 0.78, aux: 0.3, color: f.color, back: true });
      }
      if (f.outsideZone && Math.random() < 0.3) fx.add({ x: p.x + (Math.random() - 0.5) * 0.8, y: p.y + (Math.random() - 0.5) * 1.4, vy: 2, life: 0.4, size: 0.08, color: 0xff4060 });

      // off-screen marker
      if (f.alive) {
        const sx0 = W / 2 + (p.x - cx - shx) * s;
        const sy0 = H / 2 - (p.y - cy - shy) * s;
        const m = 26 * ui;
        if (sx0 < -10 || sx0 > W + 10 || sy0 < -10 || sy0 > H + 10) {
          const ex = Math.max(m, Math.min(W - m, sx0));
          const ey = Math.max(m + 60 * ui, Math.min(H - m, sy0));
          const ang = Math.atan2(sy0 - ey, sx0 - ex);
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const r = 20 * ui;
          bars.circle(ex, ey, r).fill({ color: 0x07080d, alpha: 0.75 }).stroke({ width: 3 * ui, color: f.color });
          bars.poly([ex + ca * r * 1.6, ey + sa * r * 1.6, ex + ca * r * 0.9 - sa * r * 0.6, ey + sa * r * 0.9 + ca * r * 0.6, ex + ca * r * 0.9 + sa * r * 0.6, ey + sa * r * 0.9 - ca * r * 0.6]).fill(f.color);
          bars.rect(ex - r * 0.7, ey + r * 0.15, (r * 1.4 * f.hp) / 100, r * 0.3).fill(f.color);
          bars.circle(ex, ey - r * 0.25, r * 0.32).fill(f.color);
        }
      }
      // health bar (screen space)
      if (f.alive) {
        v.ghostHp += (f.hp - v.ghostHp) * Math.min(1, dt * 3);
        if (v.ghostHp < f.hp) v.ghostHp = f.hp;
        const sx = W / 2 + (p.x - cx - shx) * s;
        const sy = H / 2 - (p.y - cy - shy) * s;
        const top = sy - (FIGHTER.halfHeight + FIGHTER.radius + 0.45) * s;
        const bw = 92 * ui;
        const bh = 12 * ui;
        const bx = sx - bw / 2;
        const by = top - bh;
        const low = f.hp < 30;
        bars.roundRect(bx - 3 * ui, by - 3 * ui, bw + 6 * ui, bh + 6 * ui, 5 * ui).fill({ color: 0x07080d, alpha: 0.8 });
        if (camera.camMode.kind === "follow" && camera.camMode.id === f.id && !camera.focus && this.celebrateId < 0) {
          // followed: a bobbing marker above the bar
          const mx = sx;
          const my = by - 12 * ui - Math.abs(Math.sin(time * 4)) * 5 * ui;
          bars.poly([mx - 14 * ui, my - 16 * ui, mx + 14 * ui, my - 16 * ui, mx, my]).fill(f.color).stroke({ width: 3 * ui, color: 0x07080d });
          bars.roundRect(bx - 6 * ui, by - 6 * ui, bw + 12 * ui, bh + 12 * ui, 7 * ui).stroke({ width: 2.5 * ui, color: f.color });
        }
        bars.rect(bx, by, (bw * Math.max(0, v.ghostHp)) / 100, bh).fill({ color: 0xffffff, alpha: 0.85 });
        bars.rect(bx, by, (bw * Math.max(0, f.hp)) / 100, bh).fill(low && Math.floor(time * 6) % 2 === 0 ? 0xffffff : f.color);
        bars.rect(bx, by, (bw * Math.max(0, f.hp)) / 100, bh * 0.35).fill({ color: 0xffffff, alpha: 0.25 });
        for (let i = 1; i < 4; i++) bars.rect(bx + (bw * i) / 4 - 0.5 * ui, by, 1 * ui, bh).fill({ color: 0x07080d, alpha: 0.5 });
        let pi = 0;
        for (const k of ["shield", "speed", "heavy", "damage", "jump"] as const) {
          if (f.power[k] <= 0) continue;
          bars.circle(bx + 6 * ui + pi * 13 * ui, by + bh + 10 * ui, 5 * ui).fill(POWER_COLOR[k]!).stroke({ width: 1.5 * ui, color: 0x07080d });
          pi++;
        }
      }
    }
  }
}

/**
 * The top of the ground under a foot at world x, near the capsule's bottom
 * (within 0.3 m up or down): a terrain cell or an upright prop (crate, steel,
 * barrel...), whichever is higher. Null when there is none (a foot over a
 * gap): then the foot stays at the capsule's bottom. Reads the sim only.
 */
export function groundTop(sim: Sim, x: number, bottom: number): number | null {
  let best: number | null = null;
  const take = (top: number) => {
    if (Math.abs(top - bottom) <= 0.3 && (best === null || top > best)) best = top;
  };
  const grid = sim.grid;
  const cx = grid.cx(x);
  for (let cy = grid.cy(bottom + 0.3); cy >= grid.cy(bottom - 0.3); cy--) {
    if (!grid.solid(cx, cy)) continue;
    take(grid.wy(cy) + CELL);
    break;
  }
  for (const e of sim.entities.values()) {
    // destroyed props leave sim.entities (sim-entities.ts); loose terrain chunks are not centered boxes, so they are left out
    if (e.kind === "fighter" || e.kind === "chunk" || e.kind === "item" || e.kind === "grenade" || e.dead) continue;
    // a box lying at any quarter turn (upside down, on its side) is still flat on top; a quarter turn swaps its extents
    const rot = e.body.rotation(), quarter = Math.round(rot / (Math.PI / 2));
    if (Math.abs(rot - quarter * (Math.PI / 2)) > 0.15) continue;
    const [hw, hh] = quarter % 2 ? [e.hh, e.hw] : [e.hw, e.hh];
    const q = e.body.translation();
    if (Math.abs(x - q.x) > hw) continue;
    take(q.y + hh);
  }
  return best;
}
