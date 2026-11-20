/**
 * Fighter portraits for dialogue cards, plan chips and the celebrate screen:
 * the same bot as in the game (bot.ts), recorded to inline SVG (#18).
 */
import type { Identity } from "../sim/identity";
import type { MoraleState } from "../sim/morale";
import type { Weapon } from "../sim/sim";
import { drawArm, drawBody, drawHand, drawVisor, faceFor, hash, WEAPON_SCALE, type FaceMood, type Lod } from "./bot";
import { drawWeapon } from "./props";
import { SvgPen } from "./svgPen";

export type Mood = "fight" | "win" | MoraleState | "hit" | "stun" | "ko";

export const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** A whole bot with its weapon; the bust is the head only (for small HUD chips). */
const VIEW_FULL = "-0.95 -1.32 2.15 2.3";
const VIEW_HEAD = "-0.66 -1.16 1.32 1.2";

/**
 * The portrait of a fighter's identity. `lod` "tiny" is for small chips: the
 * head only, square dots. `t` picks the moment (blink, spinner, KO frame).
 */
export function portraitSvg(id: Identity, weapon: Weapon, mood: Mood = "fight", lod: Lod = "full", t = 0.3): string {
  const pen = new SvgPen();
  const face: FaceMood = mood === "fight" ? "confident" : mood;
  const bust = lod === "tiny";
  drawBody(pen, id, { t, aiming: true });
  drawVisor(pen, id, faceFor(face, t, hash(id.name), id.eyes, { lookX: bust ? 0 : 1, koT: 1.2 }), lod);
  if (!bust && mood !== "ko") {
    const a = weapon === "bat" ? -0.55 : -0.25;
    drawArm(pen, id, 0, -0.05, a);
    pen.save();
    pen.translate(0, -0.05);
    pen.rotate(a);
    pen.scale(WEAPON_SCALE);
    drawWeapon(pen, weapon, id.color);
    if (weapon !== "fist") drawHand(pen, id);
    pen.restore();
  }
  const shadow = bust ? "" : `<ellipse cx="0" cy="0.86" rx="0.5" ry="0.06" fill="rgba(0,0,0,.4)"/>`;
  return `<svg viewBox="${bust ? VIEW_HEAD : VIEW_FULL}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${shadow}${pen.toSvg()}</svg>`;
}
