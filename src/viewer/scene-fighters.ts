import { Container, Graphics } from "pixi.js";
import type { Sim } from "../sim/sim";
import type { Entity, Fighter } from "../sim/sim-types";
import type { CameraFrame, SceneCamera } from "./scene-camera";
import type { Fx } from "./fx";
import { dcos, dsin } from "../sim/dmath";
import { CELL } from "../sim/grid";
import { drawArm, drawBody, drawFeet, drawHand, FEET_OVERLAP_PX, FEET_Y, FOOT_X, headTopAt, K, drawSilhouette, drawVisor, faceFor, faceKey, flapStep, lodFor, WEAPON_SCALE, type FaceMood } from "./bot";
import { hash } from "./hash";
import { POWER_COLOR, WEAPON_ACCENT } from "./palette";
import { pixiPen } from "./pixiPen";
import { drawWeapon } from "./props";
import type { XformAt } from "./scene";
import { buildGlow, hpBarWidth, hpTickStep } from "./build-view";

interface FighterView {
  f: Fighter;
  root: Container;
  /** torso, feet, head and marks (redrawn only when bodyKey changes) */
  body: Graphics;
  bodyKey: string;
  /** the LED visor (redrawn only when faceKey changes) */
  face: Graphics;
  faceKey: string;
  /** the mood shown last frame (sound: a robot beep when it changes) */
  mood: string;
  arm: Graphics;
  /** the feet, in their own layer: each foot stands on the ground under it */
  feet: Graphics;
  feetKey: string;
  /** where each standing foot's sole is (world x of its middle), for the capture-mode check; null while not standing */
  soles: [number, number] | null;
  /** the identity's hash: its blink rhythm */
  h: number;
  /** the "> <" face after a hit */
  hitT: number;
  lastFlash: number;
  gun: Graphics;
  flash: Graphics;
  aura: Graphics;
  over: Graphics;
  /** the build's body cue (#81): halos behind the bot, drawn once (the build is fixed for the round) */
  glow: Container;
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
  /** fighters on autopilot (#22): the sleepy "..." face instead of their mood */
  autopilot: boolean[] = [];
  celebrateId = -1;
  /** a dot face changed mood (sound): fighter, mood, where */
  onMood: ((id: number, mood: FaceMood, x: number, y: number) => void) | null = null;
  /**
   * The entrance (#66, view only): a fighter drawn away from its sim position (dx, dy meters; dy > 0 is in the air),
   * with a face of its own while it drops in and kicks the house bot out.
   */
  readonly offsets = new Map<number, { dx: number; dy: number; mood?: FaceMood }>();

  clear() {
    for (const v of this.fighters) {
      v.root.destroy({ children: true });
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
    const gun = new Graphics();
    const flash = new Graphics();
    const aura = new Graphics();
    const over = new Graphics();
    drawSilhouette(pixiPen(flash), f.look);
    flash.alpha = 0;
    // the build's body cue (#81): one halo the shape of the bot per raised attribute, the first innermost; view only
    const glow = new Container();
    buildGlow(f.build).forEach((g, i) => {
      // a soft edge: a wide faint layer, then a tighter stronger one; a second attribute sits outside the first
      for (const [k, a] of [[1.5, 0.45], [1.28, 1]] as const) {
        const halo = new Graphics();
        drawSilhouette(pixiPen(halo), f.look);
        halo.tint = g.color;
        halo.alpha = g.alpha * a;
        halo.scale.set(k + 0.22 * i);
        halo.position.set(0, 0.06);
        glow.addChildAt(halo, glow.children.length - 2 * i); // the second attribute's layers go behind the first's
      }
    });
    root.addChild(glow, aura, feet, body, face, arm, gun, flash, over);
    this.layer.addChild(root);
    return { f, root, body, bodyKey: "", face, faceKey: "", mood: "", arm, feet, feetKey: "", soles: null, h: hash(f.look.name), hitT: 0, lastFlash: 0, gun, flash, aura, over, glow, gunKind: "", swingT: 0, swapT: 0, wingT: 0, sx: 1, sy: 1, spin: 0, flashT: 0, recoil: 0, ghostHp: f.hp, trailT: 0 };
  }

  private drawGun(v: FighterView, kind: string) {
    if (v.gunKind === kind) return;
    v.gunKind = kind;
    v.gun.clear();
    drawWeapon(v.gun, kind, v.f.color);
    if (kind !== "fist") drawHand(v.gun, v.f.look); // the fist's glove is the hand
  }

  /** For the capture-mode feet check: show only the feet (no body, no weapon); returns a function that restores everything. */
  feetOnly(): () => void {
    const saved: [{ visible: boolean }, boolean][] = [];
    for (const v of this.fighters) {
      for (const c of v.root.children) {
        saved.push([c, c.visible]);
        c.visible = c === v.feet;
      }
    }
    return () => {
      for (const [c, vis] of saved) c.visible = vis;
    };
  }

  /** For the capture-mode feet check: show the other bots' bodies (no feet), hide fighter `except`; returns a restore function. */
  bodiesOnly(except: number): () => void {
    const saved: [{ visible: boolean }, boolean][] = [];
    for (const v of this.fighters) {
      saved.push([v.root, v.root.visible]);
      if (v.f.id === except) v.root.visible = false;
      saved.push([v.feet, v.feet.visible]);
      v.feet.visible = false;
      saved.push([v.glow, v.glow.visible]);
      v.glow.visible = false; // the halo is not the body
    }
    return () => {
      for (const [c, vis] of saved) c.visible = vis;
    };
  }

  /** Each fighter's standing soles (world x), or null (capture-mode check). */
  soles(): ([number, number] | null)[] {
    return this.fighters.map((v) => v.soles);
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
      else if (f.alive && f.grounded) v.spin = 0; // a bot that touches down lands upright (a leftover tumble would tip a foot off the ground)
      else if (f.alive) v.spin *= Math.max(0, 1 - dt * 14);
      if (Math.abs(v.spin) < 0.01 && f.alive) v.spin = 0;
      const rot = f.alive ? v.spin : -p.a;
      const hop = this.celebrateId === f.id ? Math.abs(Math.sin(time * 5.5)) * 0.9 : 0;
      const off = this.offsets.get(f.id);
      const air = (!f.grounded && f.alive) || (!!off && off.dy > 0.05);
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
      const bodyKey = `${air ? 1 : 0}${flapStep(f.look, time)}${f.look.mark === "antenna" && aiming ? 1 : 0}`;
      if (bodyKey !== v.bodyKey) {
        v.bodyKey = bodyKey;
        v.body.clear();
        drawBody(pixiPen(v.body), f.look, { t: time, air, aiming, feet: false });
      }
      if (v.flashT > v.lastFlash) v.hitT = 0.42;
      v.lastFlash = v.flashT;
      v.hitT = Math.max(0, v.hitT - dt);
      const mood: FaceMood = off?.mood
        ? off.mood
        : !f.alive
        ? "ko"
        : v.hitT > 0.35
          ? "white"
          : v.hitT > 0
            ? "hit"
            : f.stun > 0
              ? "stun"
              : this.celebrateId === f.id
                ? "win"
                : this.autopilot[f.id]
                  ? "sleepy"
                  : ((this.morale[f.id] ?? "confident") as FaceMood);
      const look = { lookX: aimLocalX > 0.3 ? 1 : aimLocalX < -0.3 ? -1 : 0, lookY: aimLocalY < -0.5 ? -1 : aimLocalY > 0.5 ? 1 : 0, koT: (sim.tick - f.koTick) / 60 };
      const lod = lodFor(s);
      if (mood !== v.mood) {
        if (v.mood) this.onMood?.(f.id, mood, p.x, p.y);
        v.mood = mood;
      }
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
        if (f.railCharge > 0) {
          const charge = f.railCharge / sim.ruleset.weapons.table.railgun.chargeTicks;
          ov.circle(v.gun.position.x + dcos(v.gun.rotation) * 0.9, v.gun.position.y + dsin(v.gun.rotation) * 0.9, 0.09 + charge * 0.18)
            .fill({ color: WEAPON_ACCENT.railgun, alpha: 0.35 + charge * 0.6 });
        }
        if (pw.jetpack > 0 || f.jetting) drawJetpack(au, f.jetting, time);
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
      // feet on the ground (view only). While a bot stands:
      // - it is drawn on the surface it stands on, not at the interpolated capsule position (which lags up to a tick
      //   behind on landing), and squash, stretch and the heavy scale grow from its feet;
      // - each foot stands on the ground under it (a step edge, a tilted crate); a foot over air or a lower step slides
      //   in toward the body until it is over the ledge;
      // - the feet sink FEET_OVERLAP_PX screen pixels into the surface, so no background pixel shows between foot and
      //   ground at any zoom.
      // (a bot thrown upward, e.g. kicked by a tumbling crate, is not standing even while the sim's ground check still
      // touches something under it: it keeps its airborne feet)
      const standing = f.alive && f.grounded && !air && vel.y < 1.5 && Math.abs(rot) < 0.05 && this.celebrateId !== f.id;
      const ky = v.root.scale.y;
      let dl = 0, dr = 0, xl = 0, xr = 0, al = 0, ar = 0;
      v.soles = null;
      if (standing) {
        const kx = v.root.scale.x;
        // the sim's current position, where the capsule really touches the ground (the interpolated one lags on landing)
        const now = f.entity.body.translation();
        const pose = (e: Entity) => xform(e, alpha); // props and other bots as drawn this frame
        let base = now.y - FEET_Y; // the capsule's bottom
        // standing on another bot: its drawn head can be up to ~0.3 m lower than its capsule's top, so the bot comes down onto it
        const under = [FOOT_X[0], 0, FOOT_X[1]].map((lx) => groundTop(sim, now.x + lx * kx, base, pose, f.id)).filter((t): t is number => t !== null);
        if (under.length && Math.max(...under) < base - 0.02 && Math.max(...under) >= base - 0.35) base = Math.max(...under);
        v.root.position.set(now.x, -(base + FEET_Y) + FEET_Y * (1 - ky));
        // on another bot's head the feet sink 2 px more: its squash and heavy scale move its drawn head by up to ~2 px
        const onBot = [FOOT_X[0], 0, FOOT_X[1]].some((lx) => {
          const h = groundTop(sim, now.x + lx * kx, base, pose, f.id, () => null);
          const any = groundTop(sim, now.x + lx * kx, base, pose, f.id);
          return any !== null && (h === null || any > h + 0.01);
        });
        const sink = (FEET_OVERLAP_PX + (onBot ? 2 : 0)) / s; // meters
        const top = (lx: number) => groundTop(sim, now.x + lx * kx, base, pose, f.id);
        // the sole's middle stays close to the body (drops at most 0.08 m, steps up at most 0.2 m); its ends need ground
        // under them too (checked at +-0.09 m, a margin past the sole's flat middle), and the foot tilts to lie along it
        // (up to 1.1 rad: a tilted crate, a steep corner)
        const near = (t: number | null) => t !== null && t - base >= -0.08 && t - base <= 0.2;
        const underEnd = (t: number | null) => t !== null && t - base >= -0.3 && t - base <= 0.35;
        const feet = FOOT_X.map((lx0) => {
          // slide in (toward the middle and on past the other foot), then a little outward, until it stands
          const tries = [...Array.from({ length: 29 }, (_, k) => -k * 0.02), 0.02, 0.04, 0.06, 0.08, 0.1, 0.12];
          for (const step of tries) {
            const lx = lx0 + Math.sign(lx0) * step;
            const [t0, tm, t1] = [top(lx - 0.09), top(lx), top(lx + 0.09)];
            if (!underEnd(t0) || !near(tm) || !underEnd(t1)) continue;
            const rise = (t1! - t0!) / 0.18; // world rise per meter along x
            const slope = Math.atan2(rise * Math.sign(kx), 1); // -> local angle (y down, x mirrored)
            if (Math.abs(slope) > 1.1) continue;
            // the sole's line never sits above the ground across its middle: at a peak (a crate's corner) it sinks in
            // a little instead of bridging over the falling side
            const xs = [-0.06, -0.03, 0, 0.03, 0.06];
            const ts = xs.map((dx) => top(lx + dx));
            if (ts.some((t) => t === null)) continue;
            const mid = Math.min(...ts.map((t, i) => t! - rise * xs[i]! * Math.sign(kx)));
            if (!near(mid)) continue;
            return { dx: lx - lx0, d: Math.min(mid - base, 0.2), a: -slope };
          }
          return { dx: 0, d: 0, a: 0 }; // nothing to stand on (another fighter, a ledge too narrow): at the capsule's bottom
        });
        [xl, xr] = feet.map((q) => q.dx) as [number, number];
        v.soles = [now.x + (FOOT_X[0] + xl) * kx, now.x + (FOOT_X[1] + xr) * kx];
        [dl, dr] = feet.map((q) => (sink - q.d) / ky) as [number, number]; // local y grows downward
        [al, ar] = feet.map((q) => q.a) as [number, number];
      }
      if (off) v.root.position.set(v.root.position.x + off.dx, v.root.position.y - off.dy);
      const feetKey = `${air ? 1 : 0}|${dl.toFixed(3)}|${dr.toFixed(3)}|${xl.toFixed(2)}|${xr.toFixed(2)}|${al.toFixed(2)}|${ar.toFixed(2)}`;
      if (feetKey !== v.feetKey) {
        v.feetKey = feetKey;
        v.feet.clear();
        drawFeet(pixiPen(v.feet), f.look, { air, dl, dr, xl, xr, al, ar });
      }
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
        const sx0 = W / 2 + (p.x + (off?.dx ?? 0) - cx - shx) * s;
        const sy0 = H / 2 - (p.y + (off?.dy ?? 0) - cy - shy) * s;
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
          bars.rect(ex - r * 0.7, ey + r * 0.15, (r * 1.4 * f.hp) / f.maxHp, r * 0.3).fill(f.color);
          bars.circle(ex, ey - r * 0.25, r * 0.32).fill(f.color);
        }
      }
      // health bar (screen space)
      if (f.alive) {
        v.ghostHp += (f.hp - v.ghostHp) * Math.min(1, dt * 3);
        if (v.ghostHp < f.hp) v.ghostHp = f.hp;
        const sx = W / 2 + (p.x + (off?.dx ?? 0) - cx - shx) * s;
        const sy = H / 2 - (p.y + (off?.dy ?? 0) - cy - shy) * s;
        const top = sy - (sim.ruleset.combat.fighter.halfHeight + sim.ruleset.combat.fighter.radius + 0.45) * s;
        // the bar's length shows max HP (#81): a tank's bar is longer, a glass cannon's shorter
        const bw = hpBarWidth(f.maxHp, sim.ruleset.combat.fighter.maxHp, 92 * ui);
        const bh = 12 * ui;
        const bx = sx - bw / 2;
        const by = top - bh;
        const low = f.hp < 0.3 * f.maxHp;
        bars.roundRect(bx - 3 * ui, by - 3 * ui, bw + 6 * ui, bh + 6 * ui, 5 * ui).fill({ color: 0x07080d, alpha: 0.8 });
        if (camera.camMode.kind === "follow" && camera.camMode.id === f.id && !camera.focus && this.celebrateId < 0) {
          // followed: a bobbing marker above the bar
          const mx = sx;
          const my = by - 12 * ui - Math.abs(Math.sin(time * 4)) * 5 * ui;
          bars.poly([mx - 14 * ui, my - 16 * ui, mx + 14 * ui, my - 16 * ui, mx, my]).fill(f.color).stroke({ width: 3 * ui, color: 0x07080d });
          bars.roundRect(bx - 6 * ui, by - 6 * ui, bw + 12 * ui, bh + 12 * ui, 7 * ui).stroke({ width: 2.5 * ui, color: f.color });
        }
        bars.rect(bx, by, (bw * Math.max(0, v.ghostHp)) / f.maxHp, bh).fill({ color: 0xffffff, alpha: 0.85 });
        bars.rect(bx, by, (bw * Math.max(0, f.hp)) / f.maxHp, bh).fill(low && Math.floor(time * 6) % 2 === 0 ? 0xffffff : f.color);
        bars.rect(bx, by, (bw * Math.max(0, f.hp)) / f.maxHp, bh * 0.35).fill({ color: 0xffffff, alpha: 0.25 });
        for (let hp = hpTickStep(f.maxHp); hp < f.maxHp; hp += hpTickStep(f.maxHp)) bars.rect(bx + (bw * hp) / f.maxHp - 0.5 * ui, by, 1 * ui, bh).fill({ color: 0x07080d, alpha: 0.5 });
        if (f.power.jetpack > 0 || f.jetting) {
          const fuel = f.power.jetpack / sim.ruleset.pickups.power.jetpack.fuelTicks;
          const fy = by + bh + 4 * ui;
          bars.roundRect(bx - 2 * ui, fy - 1 * ui, bw + 4 * ui, 6 * ui, 2 * ui).fill(0x07080d);
          bars.rect(bx, fy, bw, 4 * ui).fill(0x183a3b);
          if (fuel > 0) bars.rect(bx, fy, bw * fuel, 4 * ui).fill(f.jetting ? 0xffae4f : POWER_COLOR.jetpack!);
        }
        let pi = 0;
        for (const k of ["shield", "speed", "heavy", "damage", "jump"] as const) {
          if (f.power[k] <= 0) continue;
          bars.circle(bx + 6 * ui + pi * 13 * ui, by + bh + (f.power.jetpack > 0 || f.jetting ? 16 : 10) * ui, 5 * ui).fill(POWER_COLOR[k]!).stroke({ width: 1.5 * ui, color: 0x07080d });
          pi++;
        }
      }
    }
  }
}

function drawJetpack(g: Graphics, burning: boolean, time: number) {
  for (const [x, y] of [[-0.83, -0.31], [-0.58, -0.22]] as const) {
    if (burning) {
      const length = 0.92 + 0.15 * Math.sin(time * 45 + x * 7);
      g.poly([x, y + 0.47, x + 0.24, y + 0.47, x + 0.11, y + 0.49 + length]).fill(0xff802b);
      g.poly([x + 0.05, y + 0.47, x + 0.19, y + 0.47, x + 0.11, y + 0.47 + length * 0.67]).fill(0xffefae);
    }
    g.roundRect(x, y, 0.25, 0.51, 0.08).fill(0x187d77).stroke({ color: 0x093331, width: 0.05 });
    g.rect(x + 0.04, y + 0.15, 0.17, 0.08).fill(POWER_COLOR.jetpack!);
  }
}

const physicsPose = (e: Entity) => {
  const q = e.body.translation();
  return { x: q.x, y: q.y, a: e.body.rotation() };
};

/** The top edge of a convex polygon (world points, y up) at x, or null when x is outside it. */
function polyTopAt(x: number, pts: readonly (readonly [number, number])[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]!, [bx, by] = pts[(i + 1) % pts.length]!;
    if (x < Math.min(ax, bx) || x > Math.max(ax, bx)) continue;
    const y = bx === ax ? Math.max(ay, by) : ay + ((by - ay) * (x - ax)) / (bx - ax);
    if (best === null || y > best) best = y;
  }
  return best;
}

/**
 * The top of the ground under a foot at world x, near the capsule's bottom
 * (within 0.3 m up or down): a terrain cell, a prop at any angle (its box),
 * a cell of a loose terrain chunk, or another bot's head (not `self`),
 * whichever is highest. Null when there
 * is none (a foot over a gap). `pose` gives where a prop is drawn (the
 * scene's interpolated transform); by default its physics pose. Reads the
 * sim only (no physics queries).
 */
export function groundTop(sim: Sim, x: number, bottom: number, pose: (e: Entity) => { x: number; y: number; a: number } = physicsPose, self = -1, heads?: (x: number) => number | null): number | null {
  let best: number | null = null;
  const take = (top: number | null) => {
    if (top !== null && Math.abs(top - bottom) <= 0.3 && (best === null || top > best)) best = top;
  };
  const grid = sim.grid;
  const cx = grid.cx(x);
  for (let cy = grid.cy(bottom + 0.3); cy >= grid.cy(bottom - 0.3); cy--) {
    if (!grid.solid(cx, cy)) continue;
    take(grid.wy(cy) + CELL);
    break;
  }
  // another bot's head: its drawn top (head shapes sit lower or higher in the 32-unit grid; grid y 3.5 is the capsule top).
  // The scene passes `heads`, which reads the other bots' drawn transforms; without it, their physics poses are used.
  if (heads) take(heads(x));
  else for (const g of sim.fighters) {
    if (g.id === self || !g.alive || g.removed) continue;
    // a standing bot is drawn at its current position, others where the scene interpolates them
    const q = g.grounded ? { ...g.entity.body.translation(), a: 0 } : pose(g.entity);
    if (Math.abs(q.a) > 0.15) continue;
    const u = 16 + (x - q.x) / (K * g.facing); // the head's grid column under x (the bot is mirrored when facing left)
    const yg = headTopAt(g.look.shape, u);
    if (yg !== null) take(q.y + FEET_Y + (3.5 - yg) * K); // grid y 3.5 is the capsule's top
  }
  for (const e of sim.entities.values()) {
    if (e.kind === "fighter" || e.kind === "item" || e.kind === "grenade" || e.dead) continue; // destroyed props leave sim.entities
    const q = pose(e), a = q.a, c = Math.cos(a), s = Math.sin(a);
    const world = (lx: number, ly: number) => [q.x + lx * c - ly * s, q.y + lx * s + ly * c] as const;
    if (e.kind === "chunk" && e.cells) {
      // a loose piece: its body sits at the piece's bottom-left corner, cells at (lx, ly) * CELL, y up
      if (Math.abs(x - q.x) > Math.hypot(e.hw * 2, e.hh * 2) + CELL) continue;
      for (const cell of e.cells) {
        if (cell.hp <= 0) continue;
        const x0 = cell.lx * CELL, y0 = cell.ly * CELL;
        take(polyTopAt(x, [world(x0, y0), world(x0 + CELL, y0), world(x0 + CELL, y0 + CELL), world(x0, y0 + CELL)]));
      }
      continue;
    }
    if (Math.abs(x - q.x) > Math.hypot(e.hw, e.hh)) continue;
    take(polyTopAt(x, [world(-e.hw, -e.hh), world(e.hw, -e.hh), world(e.hw, e.hh), world(-e.hw, e.hh)]));
  }
  return best;
}
