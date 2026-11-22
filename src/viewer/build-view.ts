/**
 * How viewers show a fighter's build (#81): the chip on the dialogue card, the tag on the HUD chip, the health bar's
 * length and the body cue. Pure: no DOM, no Pixi. Names and labels come from src/sim/build.ts.
 */
import { BUILD_ATTRIBUTES, BUILD_SHORT, buildShape, buildUp, signed, type Build, type BuildAttribute } from "../sim/build";

/** One color per attribute: the chip's labels and the body cue use the same ones, so the chip is the cue's legend. */
export const BUILD_COLOR: Readonly<Record<BuildAttribute, number>> = { health: 0x7dffa0, weight: 0xa99cff, power: 0xff9a3d };

const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** The dialogue card's chip: the shape name, then each level ("TANK HP +2 · WGT 0 · PWR −2"); neutral is "BALANCED". */
export function buildChipHtml(b: Build): string {
  const shape = buildShape(b);
  if (buildUp(b).length === 0) return `<b class="bld"><em>${shape}</em></b>`;
  const levels = BUILD_ATTRIBUTES.map((a) => `<span style="--a:${css(BUILD_COLOR[a])}">${BUILD_SHORT[a]} ${signed(b[a])}</span>`).join("<i>·</i>");
  return `<b class="bld"><em>${shape}</em>${levels}</b>`;
}

/** The HUD chip's tag: the shape name only, in the color of the attribute it raises most. */
export function buildTagHtml(b: Build): string {
  const top = buildTop(b);
  return `<em class="bld"${top ? ` style="--a:${css(BUILD_COLOR[top])}"` : ""}>${buildShape(b)}</em>`;
}

/** The attribute a build raises most (the first on a tie), or null for neutral. */
export function buildTop(b: Build): BuildAttribute | null {
  return buildUp(b).reduce<BuildAttribute | null>((best, a) => (best === null || b[a] > b[best] ? a : best), null);
}

/** A health bar's length: base length for the ruleset's base max HP, in proportion to the fighter's max HP. */
export const hpBarWidth = (maxHp: number, baseMaxHp: number, baseWidth: number): number => (baseWidth * maxHp) / baseMaxHp;

/** HP between the bar's tick marks: a tick every 25 HP, so a bigger bar has more of them. */
export const HP_TICK = 25;

/**
 * The body cue: a halo the shape of the bot behind its body, one layer per raised attribute (inner first), stronger
 * at +2. It is drawn only: the hitbox does not change. Neutral has none.
 */
export function buildGlow(b: Build): { color: number; alpha: number }[] {
  return buildUp(b).map((a) => ({ color: BUILD_COLOR[a], alpha: b[a] >= 2 ? 0.55 : 0.38 }));
}
