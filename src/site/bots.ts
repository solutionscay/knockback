/**
 * The bots on the site pages: the game's own portraits (src/viewer/portrait.ts), recorded to SVG, and their
 * colors as CSS variables (--c the identity color for bars and borders, --ci a readable ink for names).
 */
import { sanitizeIdentity, generateIdentities, type Identity } from "../sim/identity";
import { nameInk } from "../viewer/palette";
import { hex } from "../html";
import { portraitSvg, type Mood } from "../viewer/portrait";
import { html, raw, type Raw } from "./dom";

export type SiteMood = "fight" | "cocky" | "win" | "ko" | "sleepy";

const FALLBACK = generateIdentities(1);
/** Identities from the server, checked again (they go into SVG). */
export function cleanIdentity(v: unknown, seat: number): Identity {
  return sanitizeIdentity(v, seat, FALLBACK[seat % 4]!);
}

const cache = new Map<string, string>();

/** A bot portrait (full body, or "head" for small chips). "sleepy" is the autopilot face. */
export function bot(id: Identity, mood: SiteMood = "fight", head = false): Raw {
  const key = `${id.name}|${id.eyes}|${id.mark}|${id.minor}|${id.color}|${mood}|${head}`;
  let s = cache.get(key);
  if (!s) {
    s = portraitSvg(id, mood as Mood, head ? "tiny" : "full");
    cache.set(key, s);
  }
  return raw(s);
}

/** A small plush head (the portrait's bust) for the site's cards and lists. */
export function head(id: Identity, mood: SiteMood = "fight"): Raw {
  return html`<span class="bh">${bot(id, mood, true)}</span>`;
}

/** style="--c:...;--ci:..." for an identity color */
export function colorVars(c: number | undefined | null): string {
  if (c === undefined || c === null) return "--c:#9aa1b5;--ci:#f4f1ea";
  return `--c:${hex(c)};--ci:${hex(nameInk(c, "dark"))}`;
}

/** A grey stand-in for a seat whose bot is not drawn yet (open matches get their looks at the start). */
export const HOUSE_LOOK: Identity = { name: "House", shape: "squircle", eyes: "visor", mark: "headband", minor: "none", color: 0x9aa3b5 } as Identity;
