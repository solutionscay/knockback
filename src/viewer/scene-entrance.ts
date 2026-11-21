/**
 * The entrance (#66), view only: an agent's fighter drops in at its seat, shouts its entrance line and kicks out the
 * house bot that held the seat; the bot flies off with a twinkle. The sim is frozen at tick 0 meanwhile (the round
 * starts with the agent's fighter in its seat): this draws the house bot as a figure of its own and moves the agent's
 * fighter away from its sim position until it stands in its seat again.
 *
 * Everything follows the beat's own clock (`u`, seconds into the beat), so a capture that steps frames sees the same
 * entrance every time. The moments of the beat are ENTRANCE_AT (also the sound cues and the HUD banner's steps).
 */
import { Container, Graphics } from "pixi.js";
import type { Identity } from "../sim/identity";
import type { Sim } from "../sim/sim";
import { drawArm, drawBody, drawFeet, drawVisor, faceFor, FEET_Y, WEAPON_SCALE, type FaceMood } from "./bot";
import type { Fx } from "./fx";
import { hash } from "./hash";
import { pixiPen } from "./pixiPen";
import { drawWeapon } from "./props";
import type { CameraFrame, SceneCamera } from "./scene-camera";
import { groundTop, type FighterViews } from "./scene-fighters";

/** Seconds into the entrance beat: the bot waits, the agent drops, lands, shouts, kicks, the bot twinkles out, the boost shows. */
export const ENTRANCE_AT = { drop: 0.45, land: 0.9, shout: 1.0, kick: 1.55, twinkle: 2.75, step: 2.9, boost: 3.0 } as const;
export type EntranceStep = keyof typeof ENTRANCE_AT;

/** How high above its landing spot the agent's fighter starts its drop (m). */
const DROP_FROM = 18;
/** The kicked bot's flight: launch speed (m/s), gravity (m/s²), spin (rad/s). */
const KICK = { vx: 11, vy: 21, g: 15, spin: 15 };

const easeIn = (t: number) => t * t * t;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** The steps passed going from `from` to `to` seconds into the beat (from < step time <= to). */
export function stepsBetween(from: number, to: number): EntranceStep[] {
  return (Object.keys(ENTRANCE_AT) as EntranceStep[]).filter((k) => from < ENTRANCE_AT[k] && ENTRANCE_AT[k] <= to);
}

interface Plan {
  seat: number;
  evicted: Identity | undefined;
  /** the agent's fighter in the sim (capsule center) */
  px: number;
  py: number;
  /** where it lands (capsule center) and where the house bot stands */
  lx: number;
  ly: number;
  bx: number;
  by: number;
  /** the side the bot is kicked to (1 right, -1 left) */
  dir: 1 | -1;
  /** no room beside the bot: the agent lands right on it (the landing is the kick) */
  stomp: boolean;
}

export class EntranceView {
  readonly layer = new Container();
  private readonly bot = new Container();
  private readonly botBody = new Graphics();
  private readonly botFace = new Graphics();
  private readonly botArm = new Graphics();
  private readonly botFist = new Graphics();
  private plan: Plan | null = null;
  private faceKey = "";
  private twinkled = false;

  constructor() {
    this.bot.addChild(this.botBody, this.botFace, this.botArm, this.botFist);
    this.layer.addChild(this.bot);
    this.bot.visible = false;
  }

  get active(): boolean {
    return this.plan !== null;
  }

  /** The kick happens at this step: at the landing when the agent lands on the bot. */
  kickStep(): EntranceStep {
    return this.plan?.stomp ? "land" : "kick";
  }

  /** Where the entrance happens (world meters): the agent's landing spot. */
  where(): { x: number; y: number } | null {
    return this.plan ? { x: this.plan.lx, y: this.plan.ly } : null;
  }

  /** Set up the entrance of `seat`: the house bot `evicted` (none: nobody to kick) stands in its seat. */
  start(sim: Sim, seat: number, evicted: Identity | undefined, fighters: FighterViews) {
    const f = sim.fighters[seat]!;
    const p = f.entity.body.translation();
    const feet = p.y - FEET_Y;
    const standAt = (x: number) => {
      const top = groundTop(sim, x, feet, undefined, seat, () => null);
      return top === null ? null : top + FEET_Y;
    };
    // the bot stands in the seat; the agent lands on the inner side and kicks it out over the edge (else the other side)
    const out: 1 | -1 = p.x >= 0 ? 1 : -1;
    const by = standAt(p.x) ?? p.y;
    let lx = p.x;
    let ly = by;
    let dir = out;
    let stomp = true;
    for (const side of [-out, out] as const) {
      const y = standAt(p.x + side * 1.05);
      if (y === null || !evicted) continue;
      lx = p.x + side * 1.05;
      ly = y;
      dir = side === -out ? out : (-out as 1 | -1);
      stomp = false;
      break;
    }
    if (!evicted) stomp = false;
    this.plan = { seat, evicted, px: p.x, py: p.y, lx, ly, bx: p.x, by, dir, stomp };
    this.twinkled = false;
    this.faceKey = "";
    this.botBody.clear();
    this.botArm.clear();
    this.botFist.clear();
    if (evicted) {
      const pen = pixiPen(this.botBody);
      drawBody(pen, evicted, { t: 0, air: false, feet: false });
      drawFeet(pen, evicted, {});
      drawWeapon(this.botFist, "fist", evicted.color);
      this.botFist.scale.set(WEAPON_SCALE);
      this.botFist.position.set(0, -0.05);
      drawArm(pixiPen(this.botArm), evicted, 0, -0.05, 0);
    }
    this.bot.visible = !!evicted;
    fighters.offsets.set(seat, { dx: lx - p.x, dy: DROP_FROM + ly - p.y });
  }

  /** The entrance is over: the agent's fighter stands in its seat, the bot is gone. */
  end(fighters: FighterViews) {
    if (this.plan) fighters.offsets.delete(this.plan.seat);
    this.plan = null;
    this.bot.visible = false;
  }

  /** Draw the entrance `u` seconds in (and its particles for the steps passed since `prev`). */
  update(u: number, prev: number, time: number, sim: Sim, fighters: FighterViews, fx: Fx, camera: SceneCamera, frame: CameraFrame | null, W: number, H: number) {
    const pl = this.plan;
    if (!pl) return;
    const A = ENTRANCE_AT;
    const f = sim.fighters[pl.seat]!;
    const crossed = stepsBetween(prev, u);
    const kickAt = pl.stomp ? A.land : A.kick;
    // the agent: hidden high up, drops, lands, (lunges into the kick), steps into its seat
    let dx = pl.lx - pl.px;
    let dy = pl.ly - pl.py;
    let mood: FaceMood | undefined = "furious";
    if (u < A.land) dy += DROP_FROM * (1 - easeIn(clamp01((u - A.drop) / (A.land - A.drop))));
    if (!pl.stomp && u >= A.kick - 0.12 && u < A.kick + 0.25) dx += pl.dir * 0.35 * Math.sin(Math.PI * clamp01((u - (A.kick - 0.12)) / 0.37));
    if (u >= A.step) {
      const k = easeOut(clamp01((u - A.step) / 0.3));
      dx *= 1 - k;
      dy = dy * (1 - k) + Math.sin(Math.PI * k) * 0.6;
      if (k >= 1) mood = undefined;
    }
    fighters.offsets.set(pl.seat, { dx, dy, mood });
    if (crossed.includes("drop")) {
      for (let i = 0; i < 3; i++) fx.add({ x: pl.lx, y: pl.ly + DROP_FROM - i * 2, kind: "trail", life: 0.5, size: 0.9, aux: 0.3, color: f.color, back: true });
    }
    if (u > A.drop && u < A.land) fx.add({ x: pl.lx + (Math.random() - 0.5) * 0.3, y: pl.py + dy + 0.4, kind: "trail", life: 0.25, size: 0.8, aux: 0.3, color: f.color, back: true });
    if (crossed.includes("land")) {
      camera.addShake(0.9);
      fx.dust(pl.lx, pl.ly - FEET_Y, 16);
      fx.add({ x: pl.lx, y: pl.ly - FEET_Y + 0.1, kind: "ring", life: 0.5, size: 0.4, size1: 3.4, color: 0xffffff, alpha: 0.9, aux: 0.2 });
      const v = fighters.get(pl.seat);
      v.sx = 1.4;
      v.sy = 0.65;
    }
    if (crossed.includes("shout")) {
      fx.add({ x: pl.lx, y: pl.ly + 0.2, kind: "ring", life: 0.45, size: 0.7, size1: 3.4, color: f.color, alpha: 1, aux: 0.22 });
      fx.sparks(pl.lx, pl.ly + 0.2, 0, 1, f.color, 12);
    }
    // the house bot: stands, looks up at the falling agent, gets kicked, flies off spinning, twinkles out
    if (!pl.evicted) return;
    let bx = pl.bx;
    let by = pl.by;
    let rot = 0;
    let botMood: FaceMood = u < A.drop ? "confident" : u < kickAt ? "stun" : "hit";
    const facing: 1 | -1 = pl.stomp ? (pl.dir === 1 ? -1 : 1) : pl.lx > pl.bx ? 1 : -1;
    if (u >= kickAt) {
      const t = u - kickAt;
      bx += pl.dir * KICK.vx * t;
      by += KICK.vy * t - 0.5 * KICK.g * t * t;
      rot = -pl.dir * KICK.spin * t;
      if (t > 0.35) botMood = "ko";
    }
    if (crossed.includes(pl.stomp ? "land" : "kick")) {
      camera.addShake(1);
      fx.add({ x: pl.bx, y: pl.by + 0.2, kind: "flash", life: 0.14, size: 1.1, color: 0xffffff, alpha: 0.85 });
      fx.add({ x: pl.bx, y: pl.by + 0.2, kind: "ring", life: 0.4, size: 0.5, size1: 2.8, color: 0xffe14d, alpha: 1, aux: 0.2 });
      fx.sparks(pl.bx, pl.by + 0.2, pl.dir, 0.7, 0xffe14d, 16);
    }
    if (u >= kickAt && u < A.twinkle) fx.add({ x: bx, y: by, kind: "trail", life: 0.3, size: 0.85, aux: 0.3, color: pl.evicted.color, back: true });
    const gone = u >= A.twinkle;
    if (gone && !this.twinkled) {
      this.twinkled = true;
      // the twinkle where the bot leaves the picture: its flight, held inside the camera's view
      let tx = bx;
      let ty = by;
      if (frame) {
        const hw = W / 2 / frame.s - 0.6;
        const hh = H / 2 / frame.s - 0.6;
        tx = Math.max(frame.cx - hw, Math.min(frame.cx + hw, tx));
        ty = Math.max(frame.cy - hh, Math.min(frame.cy + hh, ty));
      }
      fx.add({ x: tx, y: ty, kind: "flash", life: 0.35, size: 1.6, color: 0xffffff, alpha: 1 });
      fx.add({ x: tx, y: ty, kind: "ring", life: 0.45, size: 0.2, size1: 1.6, color: 0xffe14d, alpha: 1, aux: 0.12 });
      fx.sparks(tx, ty, 0, 0, 0xffffff, 10);
    }
    this.bot.visible = !gone;
    this.bot.position.set(bx, -by);
    this.bot.rotation = rot;
    this.bot.scale.set(facing, 1);
    const face = faceFor(botMood, time, hash(pl.evicted.name), pl.evicted.eyes, { lookY: botMood === "stun" ? -1 : 0, lookX: 0, koT: u - kickAt });
    const key = JSON.stringify(face);
    if (key !== this.faceKey) {
      this.faceKey = key;
      this.botFace.clear();
      drawVisor(pixiPen(this.botFace), pl.evicted, face, "full");
    }
  }
}
