/** Big fighter portraits for intro cards and the celebrate screen (inline SVG, same look as in game). */
import type { Personality, Weapon } from "../sim/sim";

export const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

function shade(color: number, k: number): string {
  const r = Math.min(255, ((color >> 16) & 255) * k) | 0;
  const g = Math.min(255, ((color >> 8) & 255) * k) | 0;
  const b = Math.min(255, (color & 255) * k) | 0;
  return `rgb(${r},${g},${b})`;
}

export function portraitSvg(color: number, personality: Personality, weapon: Weapon, mood: "fight" | "win" = "fight"): string {
  const c = hex(color);
  const dark = shade(color, 0.45);
  const mark =
    personality === "aggressive"
      ? `<rect x="30" y="58" width="80" height="11" fill="#2a0d0d"/><path d="M110 60 l22 -8 l-4 12 z" fill="#2a0d0d"/>`
      : personality === "sniper"
        ? `<rect x="64" y="6" width="7" height="22" rx="3" fill="${dark}"/><circle cx="67.5" cy="6" r="6" fill="${c}" stroke="${dark}" stroke-width="3"/>`
        : personality === "opportunist"
          ? `<path d="M46 26 L52 6 L62 22 L70 2 L78 22 L88 6 L94 26 Z" fill="#fff1a6" stroke="#b08a1e" stroke-width="2"/>`
          : `<path d="M40 30 q-14 -18 -6 -26 q8 6 14 22z M100 30 q14 -18 6 -26 q-8 6 -14 22z" fill="${c}" stroke="${dark}" stroke-width="4"/>`;
  const gun =
    weapon === "bat"
      ? `<g transform="translate(66 104) rotate(-40)"><path d="M0 -5 L96 -12 L104 -6 L104 6 L96 12 L0 5 Z" fill="#d8a868" stroke="#6b4a2c" stroke-width="3"/><rect x="-6" y="-6" width="26" height="12" fill="#2a2d35"/></g>`
      : weapon === "grapple"
        ? `<g transform="translate(64 110) rotate(-6)"><rect x="-8" y="-9" width="62" height="18" rx="5" fill="#3a3f4a" stroke="#15171d" stroke-width="3"/><path d="M54 0 L76 -14 M54 0 L80 0 M54 0 L76 14" stroke="#c8ccd6" stroke-width="5" stroke-linecap="round"/></g>`
        : weapon === "shotgun"
      ? `<g transform="translate(70 110) rotate(-8)"><rect x="0" y="-7" width="92" height="14" rx="4" fill="#2a2d35"/><rect x="26" y="-9" width="30" height="20" fill="#6b4a2c"/><rect x="-14" y="-6" width="24" height="20" fill="#6b4a2c"/></g>`
      : weapon === "grenade"
        ? `<g transform="translate(108 112)"><circle r="17" fill="#4b5a2a" stroke="#1d2410" stroke-width="4"/><rect x="-5" y="-26" width="10" height="10" fill="#888"/></g>`
        : `<g transform="translate(60 108) rotate(-10)"><rect x="-12" y="-14" width="96" height="28" rx="7" fill="#3b4150" stroke="#15171d" stroke-width="4"/><rect x="70" y="-16" width="15" height="32" fill="${c}"/><rect x="12" y="10" width="9" height="16" fill="#15171d"/></g>`;
  const eye =
    mood === "win"
      ? `<path d="M74 56 q10 -12 20 0" fill="none" stroke="#101018" stroke-width="6" stroke-linecap="round"/>`
      : `<circle cx="84" cy="56" r="15" fill="#fff"/><circle cx="90" cy="57" r="7.5" fill="#101018"/>`;
  const mouth = mood === "win" ? `<path d="M72 78 q14 14 28 0 z" fill="#101018"/>` : "";
  return `<svg viewBox="0 0 160 190" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <ellipse cx="72" cy="182" rx="46" ry="6" fill="rgba(0,0,0,.35)"/>
  <rect x="30" y="20" width="84" height="158" rx="42" fill="${c}" stroke="${dark}" stroke-width="6"/>
  <rect x="40" y="34" width="22" height="84" rx="11" fill="#fff" opacity=".22"/>
  <rect x="28" y="168" width="34" height="14" rx="7" fill="${dark}"/><rect x="80" y="168" width="34" height="14" rx="7" fill="${dark}"/>
  ${mark}${eye}${mouth}${gun}
</svg>`;
}
