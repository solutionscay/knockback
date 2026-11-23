import { Container, Graphics, Text } from "pixi.js";
import { type Sim } from "../sim/sim";
import { clamp } from "../sim/dmath";
import { type SimEvent } from "../sim/sim-types";
import { Fx } from "./fx";
import { LIQUID_COLOR, POWER_COLOR, WEAPON_ACCENT, type Palette } from "./palette";
import type { CameraFrame, SceneCamera } from "./scene-camera";
import type { FighterViews } from "./scene-fighters";
import type { ProjectileViews } from "./scene-projectiles";
import type { PropViews } from "./scene-props";

interface FloatText {
  t: Text;
  x: number;
  y: number;
  life: number;
  max: number;
  vy: number;
  scale: number;
}

export class SceneEffects {
  readonly fx = new Fx();
  readonly back = new Graphics();
  readonly front = new Graphics();
  readonly textLayer = new Container();
  readonly flashScreen = new Graphics();
  private floats: FloatText[] = [];
  private screenFlash = 0;
  private tickHits = new Map<number, { dmg: number; x: number; y: number; kb: number }>();

  clearText() {
    for (const f of this.floats) f.t.destroy();
    this.floats = [];
  }

  clearHits() {
    this.tickHits.clear();
  }

  onEvent(e: SimEvent, sim: Sim, pal: Palette, camera: SceneCamera, fighters: FighterViews, props: PropViews, projectiles: ProjectileViews) {
    switch (e.type) {
      case "explosion": {
        const big = e.kind === "barrel" || e.kind === "tnt";
        camera.hotspot(e.x, e.y, big ? 2.5 : 1.2);
        this.fx.explosion(e.x, e.y, e.radius, big);
        camera.addShake(e.kind === "tnt" ? 1.0 : big ? 0.75 : e.kind === "grenade" ? 0.5 : 0.38);
        if (e.kind === "mine") {
          this.fx.add({ x: e.x, y: e.y, kind: "ring", life: 0.5, size: 0.45, size1: e.radius, color: WEAPON_ACCENT.mine, alpha: 0.9, aux: 0.18 });
          this.float("MINE BLAST!", e.x, e.y + 0.9, WEAPON_ACCENT.mine, 0.8);
        }
        if (big) this.screenFlash = Math.max(this.screenFlash, 0.22);
        break;
      }
      case "break": {
        const color = e.kind === "block" ? 0xc8a06a : e.kind === "crate" ? 0xa86d3a : 0x8a7a66;
        this.fx.debris(e.x, e.y, e.hw, e.hh, color, e.kind === "chunk" ? 4 : 8);
        break;
      }
      case "carve": {
        const n = e.cells.length;
        for (let i = 0; i < n; i++) {
          const c = e.cells[i]!;
          const col = pal.mat[c.mat] ?? 0x888888;
          if (i % (n > 30 ? 3 : 1) === 0) this.fx.debris(c.x, c.y, 0.2, 0.2, col, n > 30 ? 1 : 2);
        }
        break;
      }
      case "splash": {
        // #94: a fighter went into a liquid: drops of it thrown up
        const col = LIQUID_COLOR[e.liquid] ?? 0x3d93dc;
        for (let i = 0; i < 9; i++) this.fx.add({ x: e.x + (Math.random() - 0.5) * 0.6, y: e.y - 0.3, vx: (Math.random() - 0.5) * 4, vy: 3 + Math.random() * 3, gravity: 14, life: 0.5 + Math.random() * 0.3, size: 0.07 + Math.random() * 0.05, color: col, alpha: 0.9 });
        break;
      }
      case "douse": {
        this.fx.dust(e.x, e.y + 0.6, 5);
        this.float("DOUSED", e.x, e.y + 1.1, 0xbfe6ff, 0.7);
        break;
      }
      case "detach": {
        camera.addShake(Math.min(0.5, 0.12 + e.cells * 0.02));
        this.fx.dust(e.x, e.y, 8);
        camera.hotspot(e.x, e.y, 1);
        break;
      }
      case "swing": {
        const v = fighters.get(e.fighter);
        v.swingT = 0.2;
        projectiles.swings.push({ x: e.x, y: e.y, dx: e.dx, dy: e.dy, life: e.weapon === "fist" ? 0.08 : 0.14, color: e.weapon === "lightning" ? WEAPON_ACCENT.lightning : e.hit ? 0xffffff : 0xd8d8d8 });
        if (e.weapon === "lightning") this.fx.sparks(e.x, e.y, e.dx, e.dy, WEAPON_ACCENT.lightning, e.hit ? 8 : 3);
        if (e.hit) camera.addShake(e.weapon === "fist" ? 0.06 : 0.15);
        break;
      }
      case "grapple": {
        projectiles.ropes.push({ from: e.fighter, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, target: e.hit === "fighter" ? e.target : -1, life: e.hit === "fighter" ? 0.4 : 0.22, max: e.hit === "fighter" ? 0.4 : 0.22 });
        if (e.hit !== "none") this.fx.sparks(e.x1, e.y1, 0, 0, 0xd8dce6, 6);
        break;
      }
      case "swap": {
        const v = fighters.get(e.fighter);
        v.swapT = 0.22;
        break;
      }
      case "shatter": {
        for (let i = 0; i < 22; i++)
          this.fx.add({ x: e.x + (Math.random() - 0.5) * 0.2, y: e.y + (Math.random() - 0.5) * 1.6, vx: (Math.random() - 0.5) * 10, vy: Math.random() * 6, life: 0.8 + Math.random() * 0.5, size: 0.06 + Math.random() * 0.08, color: Math.random() < 0.5 ? 0xd8f6ff : 0x9fe8ff, kind: "square", gravity: 20, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 20 });
        this.fx.add({ x: e.x, y: e.y, kind: "flash", life: 0.08, size: 0.5, size1: 1.0, color: 0xe8fbff, alpha: 0.7 });
        break;
      }
      case "bounce": {
        props.bounce(e.x);
        this.fx.dust(e.x, e.y, 4);
        this.fx.add({ x: e.x, y: e.y, kind: "ring", life: 0.3, size: 0.3, size1: 1.4, color: 0x44d06a, alpha: 0.9, aux: 0.12 });
        const v = fighters.get(e.fighter);
        v.sx = 0.75;
        v.sy = 1.3;
        break;
      }
      case "lit": {
        const ent = sim.entities.get(e.entity);
        if (ent) {
          const t = ent.body.translation();
          this.fx.sparks(t.x, t.y + ent.hh, 0, 1, 0xffd23a, 8);
        }
        break;
      }
      case "snap":
        camera.addShake(0.12);
        break;
      case "zap": {
        const z = sim.zone;
        const ex = e.dir > 0 ? z.center - z.half : z.center + z.half;
        projectiles.zaps.push({ x0: ex, y0: e.y + 6, x1: e.x, y1: e.y, life: 0.25 });
        fighters.get(e.fighter).flashT = 0.15;
        this.fx.sparks(e.x, e.y, 0, 0, 0xff6a7d, 12);
        camera.addShake(0.2);
        break;
      }
      case "shieldPop": {
        this.fx.add({ x: e.x, y: e.y, kind: "ring", life: 0.4, size: 1.1, size1: 2.4, color: POWER_COLOR.shield!, alpha: 1, aux: 0.18 });
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2;
          this.fx.add({ x: e.x + Math.cos(a) * 1.1, y: e.y + Math.sin(a) * 1.1, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, life: 0.5, size: 0.1, color: POWER_COLOR.shield!, kind: "square", gravity: 8, vr: 10 });
        }
        this.float("SHIELD POP", e.x, e.y + 2, POWER_COLOR.shield!, 0.9);
        break;
      }
      case "power": {
        if (!e.on) break;
        const f = sim.fighters[e.fighter]!;
        const p = sim.pos(f);
        const col = POWER_COLOR[e.power] ?? 0xffffff;
        this.fx.add({ x: p.x, y: p.y, kind: "ring", life: 0.45, size: 0.4, size1: 2.2, color: col, alpha: 1, aux: 0.16 });
        break;
      }
      case "fire": {
        const v = fighters.get(e.fighter);
        v.recoil = e.weapon === "shotgun" ? 0.35 : 0.25;
        // the plush bot's rendered muzzle, when it holds a rendered weapon
        const mz = fighters.muzzle(e.fighter);
        const mx = mz ? mz.x : e.x + e.dx * 1.0;
        const my = mz ? mz.y : e.y + e.dy * 1.0;
        if (e.weapon === "flamethrower") {
          v.recoil = 0.06;
          this.fx.flameJet(mz ? mz.x : e.x + e.dx * 0.9, mz ? mz.y : e.y + e.dy * 0.9, e.dx, e.dy, 7); // from the plush nozzle
        } else if (e.weapon !== "grenade" && e.weapon !== "mine" && e.weapon !== "railgun" && e.weapon !== "hammer" && e.weapon !== "lightning") {
          this.fx.add({ x: mx, y: my, kind: "flash", life: 0.07, size: 0.35, size1: 0.55, color: 0xffe9a0 });
          this.fx.sparks(mx, my, e.dx, e.dy, 0xffd27a, e.weapon === "shotgun" ? 8 : 4);
          this.fx.add({ x: mx, y: my, vx: e.dx * 2, vy: e.dy * 2 + 0.5, kind: "smoke", life: 0.6, size: 0.2, size1: 0.6, color: 0x8a8790, alpha: 0.5, drag: 3, back: true });
        }
        if (e.weapon === "shotgun") camera.addShake(0.08);
        break;
      }
      case "mineStick":
      case "mineArm":
        this.fx.add({ x: e.x, y: e.y, kind: "ring", life: 0.28, size: 0.24, size1: 0.9, color: WEAPON_ACCENT.mine, alpha: 0.9, aux: 0.09 });
        break;
      case "rail": {
        const rm = fighters.muzzle(e.fighter); // the rail leaves the plush muzzle
        projectiles.rails.push({ x0: rm ? rm.x : e.x0, y0: rm ? rm.y : e.y0, x1: e.x1, y1: e.y1, life: 0.25 });
        this.fx.sparks(e.x1, e.y1, 0, 0, WEAPON_ACCENT.railgun, 12);
        this.float("RAIL SHOT!", e.x0, e.y0 + 0.9, WEAPON_ACCENT.railgun, 0.72);
        camera.addShake(0.22);
        break;
      }
      case "shockwave":
        fighters.get(e.fighter).swingT = 0.2;
        projectiles.waves.push({ paths: e.paths, life: 0.36 });
        this.fx.dust(e.x, e.y, 10);
        this.float("SHOCKWAVE!", e.x, e.y + 1.9, WEAPON_ACCENT.hammer, 0.72);
        camera.addShake(0.32);
        break;
      case "shot": {
        // precision shots (#38)
        const sm = fighters.muzzle(e.fighter); // the tracer leaves the plush muzzle
        projectiles.shots.push({ x0: sm ? sm.x : e.x0, y0: sm ? sm.y : e.y0, x1: e.x1, y1: e.y1, weapon: e.weapon, life: e.weapon === "sniper" ? 0.3 : 0.12 });
        const len = Math.hypot(e.x1 - e.x0, e.y1 - e.y0) || 1;
        const dx = (e.x1 - e.x0) / len, dy = (e.y1 - e.y0) / len;
        if (e.hit !== "none") this.fx.sparks(e.x1, e.y1, -dx, -dy, WEAPON_ACCENT[e.weapon], e.weapon === "sniper" ? 12 : 4);
        // the crossbow bolt flies the shot's line (view only: the sim's shot is instant), and sticks if it hit a wall
        if (e.weapon === "crossbow") projectiles.flyBolt(sm ? sm.x : e.x0, sm ? sm.y : e.y0, e.x1, e.y1, e.hit !== "none" && e.hit !== "fighter");
        if (e.weapon === "sniper") {
          if (e.hit === "fighter") this.float("SNIPED!", e.x1, e.y1 + 1.2, WEAPON_ACCENT.sniper, 0.8);
          camera.addShake(0.18);
        }
        break;
      }
      case "bolt": {
        // a lightning bolt (#72)
        fighters.get(e.fighter).recoil = 0.2;
        const bm = fighters.muzzle(e.fighter); // the bolt leaves the plush sword's tip
        projectiles.lightning.push({ x0: bm ? bm.x : e.x0, y0: bm ? bm.y : e.y0, x1: e.x1, y1: e.y1, life: 0.22 });
        this.fx.add({ x: e.x1, y: e.y1, kind: "flash", life: 0.1, size: 0.5, size1: 1.1, color: 0xe9e2ff });
        if (e.hit !== "none") this.fx.sparks(e.x1, e.y1, 0, 1, WEAPON_ACCENT.lightning, 14);
        if (e.hit === "fighter") this.float("ZAP!", e.x1, e.y1 + 1.2, WEAPON_ACCENT.lightning, 0.7);
        camera.addShake(0.2);
        break;
      }
      case "shock":
        // live ground shocks a fighter (#72)
        this.fx.sparks(e.x, e.y - 0.6, 0, 1, WEAPON_ACCENT.lightning, e.stun ? 10 : 4);
        if (e.stun) this.float("SHOCKED!", e.x, e.y + 1.3, WEAPON_ACCENT.lightning, 0.6);
        break;
      case "pin":
        this.float("PINNED!", e.x, e.y + 1.4, WEAPON_ACCENT.crossbow, 0.75);
        this.fx.add({ x: e.x, y: e.y, kind: "ring", life: 0.3, size: 0.3, size1: 1.1, color: WEAPON_ACCENT.crossbow, alpha: 0.9, aux: 0.1 });
        break;
      case "pellet": {
        const pm = fighters.muzzle(e.fighter); // pellets leave the plush muzzle
        projectiles.tracer(pm ? pm.x : e.x0, pm ? pm.y : e.y0, e.x1, e.y1);
        if (e.hit) this.fx.sparks(e.x1, e.y1, -(e.x1 - e.x0) * 0.1, -(e.y1 - e.y0) * 0.1, 0xffe0a0, 3);
        break;
      }
      case "hit": {
        const v = fighters.get(e.target);
        v.flashT = 0.12;
        camera.hit(e.target, e.damage * 0.15);
        if (e.source >= 0) camera.hit(e.source, e.damage * 0.08);
        const h = this.tickHits.get(e.target) ?? { dmg: 0, x: e.x, y: e.y, kb: 0 };
        h.dmg += e.damage;
        h.kb = Math.max(h.kb, e.kb);
        this.tickHits.set(e.target, h);
        if (e.cause === "shotgun") this.fx.sparks(e.x, e.y, 0, 0, sim.fighters[e.target]!.color, 2);
        break;
      }
      case "impact": {
        const f = sim.fighters[e.fighter]!;
        this.fx.dust(e.x, e.y - 0.8, 10);
        this.fx.sparks(e.x, e.y, 0, 0, 0xffffff, 8);
        camera.addShake(0.25);
        fighters.get(f.id).flashT = 0.1;
        if (e.damage >= 4) this.float(`${Math.round(e.damage)}`, e.x, e.y + 1, 0xffffff, 0.9);
        break;
      }
      case "ko": {
        const f = sim.fighters[e.fighter]!;
        if (e.cause === "ringout") {
          const dx = -Math.sign(e.x) * 0.3;
          this.fx.beam(clamp(e.x, -36, 36), Math.max(e.y, -8), e.y < -9 ? dx : -Math.sign(e.x), e.y < -9 ? 1 : 0.25, f.color);
          this.float("RING OUT!", clamp(e.x, -30, 30), Math.max(e.y, -4) + 4, f.color, 1.8);
        } else {
          this.fx.burst(e.x, e.y, f.color);
          this.float("K.O.", e.x, e.y + 2, f.color, 1.8);
        }
        camera.addShake(0.9);
        this.screenFlash = Math.max(this.screenFlash, 0.3);
        break;
      }
      case "jump": {
        const f = sim.fighters[e.fighter]!;
        const v = fighters.get(f.id);
        if (e.air) {
          v.wingT = 0.35;
          this.fx.add({ x: sim.pos(f).x, y: sim.feetY(f), kind: "ring", life: 0.3, size: 0.2, size1: 1.2, color: 0xffffff, alpha: 0.8, aux: 0.1 });
        }
        v.sx = 0.8;
        v.sy = 1.22;
        const p = sim.pos(f);
        this.fx.dust(p.x, sim.feetY(f), 1);
        break;
      }
      case "land": {
        const f = sim.fighters[e.fighter]!;
        const v = fighters.get(f.id);
        const k = Math.min(1, e.speed / 16);
        v.sx = 1 + 0.35 * k;
        v.sy = 1 - 0.3 * k;
        const p = sim.pos(f);
        this.fx.dust(p.x, sim.feetY(f), e.speed * 0.4);
        break;
      }
      case "propDrop":
        props.markDrop(e.entity, e.kind === "tnt" ? 0xff3030 : 0xff6a3d);
        break;
      case "itemSpawn":
        if (e.y > 8) props.markDrop(e.entity, POWER_COLOR[e.item] ?? 0xffb347);
        break;
      case "pickup": {
        const col = POWER_COLOR[e.item] ?? 0xffb347;
        this.fx.burst(e.x, e.y, col);
        const label: Record<string, string> = { health: "+HP", shield: "SHIELD!", speed: "SPEED!", heavy: "HEAVY!", damage: "2x DAMAGE!", jump: "DOUBLE JUMP!", mine: "STICKY MINE!", hammer: "SHOCKWAVE HAMMER!", lightning: "LIGHTNING SWORD!", sniper: "SNIPER!", rifle: "RIFLE!", crossbow: "CROSSBOW!" };
        this.float(label[e.item] ?? e.item.toUpperCase() + "!", e.x, e.y + 1.4, col, 1.0);
        break;
      }
    }
  }

  /** End of a sim tick: emit grouped damage numbers. */
  afterTick(sim: Sim, camera: SceneCamera): { bigHit: number } {
    let bigHit = 0;
    for (const [id, h] of this.tickHits) {
      const f = sim.fighters[id]!;
      if (h.dmg >= 5 || h.kb >= 14) this.float(`${Math.round(h.dmg)}`, h.x, h.y + 1.2, h.kb >= 14 ? 0xffe14d : 0xffffff, h.kb >= 14 ? 1.25 : 0.85);
      if (h.kb >= 14) {
        bigHit = Math.max(bigHit, h.kb);
        camera.addShake(Math.min(0.5, h.kb / 50));
        this.fx.sparks(h.x, h.y, 0, 0, f.color, 10);
        this.fx.add({ x: h.x, y: h.y, kind: "ring", life: 0.25, size: 0.3, size1: 1.8, color: 0xffffff, alpha: 0.9, aux: 0.12 });
      }
    }
    this.tickHits.clear();
    return { bigHit };
  }

  float(text: string, x: number, y: number, color: number, scale: number) {
    const t = new Text({
      text,
      style: {
        fontFamily: "Rubik, 'Arial Black', system-ui, sans-serif",
        fontWeight: "900",
        fontSize: 34,
        fill: color,
        stroke: { color: 0x0a0b12, width: 7, join: "round" },
      },
    });
    t.anchor.set(0.5);
    this.textLayer.addChild(t);
    this.floats.push({ t, x, y, life: scale > 1.5 ? 1.6 : 0.9, max: scale > 1.5 ? 1.6 : 0.9, vy: scale > 1.5 ? 0.8 : 2.2, scale });
  }

  /** Intro / countdown punctuation. */
  blam(id: number, sim: Sim, camera: SceneCamera, fighters: FighterViews) {
    camera.addShake(0.45);
    const f = sim.fighters[id];
    if (!f || f.removed) return;
    const p = sim.pos(f);
    this.fx.add({ x: p.x, y: p.y, kind: "ring", life: 0.45, size: 0.6, size1: 3.2, color: f.color, alpha: 1, aux: 0.22 });
    this.fx.sparks(p.x, p.y, 0, 0, f.color, 14);
    fighters.get(id).flashT = 0.12;
    fighters.get(id).sx = 1.3;
    fighters.get(id).sy = 0.75;
  }

  render(frame: CameraFrame, W: number, H: number, dt: number, ui: number) {
    const { cx, cy, s } = frame;
    this.fx.draw(this.back, this.front);

    // ------------------------------------------------ floating text
    const keep: FloatText[] = [];
    for (const ft of this.floats) {
      ft.life -= dt;
      if (ft.life <= 0) {
        ft.t.destroy();
        continue;
      }
      ft.y += ft.vy * dt;
      const t = 1 - ft.life / ft.max;
      const pop = t < 0.12 ? 0.6 + (t / 0.12) * 0.6 : 1.2 - Math.min(0.2, (t - 0.12) * 2);
      ft.t.scale.set(pop * ft.scale * ui);
      ft.t.alpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      ft.t.position.set(W / 2 + (ft.x - cx) * s, H / 2 - (ft.y - cy) * s);
      keep.push(ft);
    }
    this.floats = keep;

    // ------------------------------------------------ screen flash
    this.screenFlash = Math.max(0, this.screenFlash - dt * 1.8);
    this.flashScreen.clear();
    if (this.screenFlash > 0) this.flashScreen.rect(0, 0, W, H).fill({ color: 0xfff4e0, alpha: this.screenFlash });
  }

}
