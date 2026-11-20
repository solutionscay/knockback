/**
 * Souls: a fighter's identity lives in a soul file, not in the engine.
 * All fighters are physically equal; the soul gives a name, a color, an
 * attitude, how it talks and what it values in a fight. AI fighters read the
 * whole file; house bots map its fields (or, failing that, keywords in its
 * text) to a strategy, and speak its lines.
 *
 * Format (see docs/souls.md): a Markdown file with an optional front matter
 * block of `key: value` lines between `---` fences, a free-text body, and an
 * optional `## Lines` section of `- context [states]: text` entries.
 */
import type { MoraleState } from "./morale";
import type { Retaliate, Stance, TargetPref, Weapon } from "./sim";

export type Temperament = "cocky" | "confident" | "calm" | "nervous";
export type Voice = "brash" | "smug" | "nervous" | "sly" | "plain";
export type Mark = "headband" | "antenna" | "ears" | "crown" | "none";
export type LineTemplate = [ctx: string, states: "*" | MoraleState[], text: string];

export interface Soul {
  name: string;
  title: string;
  color: number;
  temperament: Temperament;
  voice: Voice;
  /** what it values in a fight, in plain words ("goes for the weakest", "holds grudges") */
  values: string[];
  /** weapon pickups it goes for, best first */
  weapons: Weapon[];
  stance: Stance;
  target: TargetPref;
  retaliate: Retaliate;
  catchphrase: string;
  mark: Mark;
  /** the free text: attitude and how it talks (what AI fighters read) */
  body: string;
  /** its own lines for the house bot, by context and morale */
  lines: LineTemplate[];
}

export const PICKUP_WEAPONS: readonly Weapon[] = ["rocket", "shotgun", "bat", "grenade", "grapple"];
const STANCES: readonly Stance[] = ["rush", "distance", "cover", "item"];
const TARGETS: readonly TargetPref[] = ["nearest", "weakest", "strongest", "leader", "rocket", "shotgun"];
const RETALIATE: readonly Retaliate[] = ["attacker", "turn", "ignore"];
const TEMPERAMENTS: readonly Temperament[] = ["cocky", "confident", "calm", "nervous"];
const VOICES: readonly Voice[] = ["brash", "smug", "nervous", "sly", "plain"];
const MARKS: readonly Mark[] = ["headband", "antenna", "ears", "crown", "none"];
const STATES: readonly MoraleState[] = ["cocky", "confident", "rattled", "furious", "desperate"];
const WEAPON_ALIAS: Record<string, Weapon> = { hook: "grapple", "grappling hook": "grapple", grenades: "grenade", rockets: "rocket", launcher: "rocket" };

/** Morale baseline from temperament (morale itself still comes from match events). */
export const TEMPERAMENT_MORALE: Record<Temperament, number> = { cocky: 45, confident: 25, calm: 8, nervous: -15 };

/** Seat colors used when a soul gives none (or an invalid one). */
export const SEAT_COLORS = [0xff4f4f, 0x47a3ff, 0x4fdc6a, 0xffc733];

export interface SoulParse {
  soul: Soul;
  errors: string[];
  warnings: string[];
}

function weaponOf(s: string): Weapon | null {
  const w = s.toLowerCase().trim();
  return (PICKUP_WEAPONS as readonly string[]).includes(w) ? (w as Weapon) : (WEAPON_ALIAS[w] ?? null);
}

function list(v: string): string[] {
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * House-bot keyword mapping: when a field is missing, guess it from the
 * soul's values and text. Word order in the rules below is priority order.
 */
export function inferFromText(text: string): { stance?: Stance; target?: TargetPref; retaliate?: Retaliate; weapons: Weapon[]; temperament?: Temperament; voice?: Voice } {
  const t = text.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => t.includes(w));
  const out: ReturnType<typeof inferFromText> = { weapons: [] };
  if (has("weakest", "picks off the wounded", "finish off", "scavenge")) out.target = "weakest";
  else if (has("strongest", "biggest threat", "the champ")) out.target = "strongest";
  else if (has("leader", "whoever is winning", "top dog")) out.target = "leader";
  else if (has("nearest", "whoever is close", "anyone close")) out.target = "nearest";
  if (has("hides", "hide", "scared", "cover", "cautious", "plays it safe")) out.stance = "cover";
  else if (has("distance", "snipe", "long range", "far away", "keeps away")) out.stance = "distance";
  else if (has("loot", "collect", "grabs everything", "power-up", "pickups")) out.stance = "item";
  else if (has("never backs down", "charge", "rush", "in your face", "close up", "brawl")) out.stance = "rush";
  if (has("grudge", "never forgets", "revenge", "gets even")) out.retaliate = "attacker";
  else if (has("ignores", "single-minded", "never distracted")) out.retaliate = "ignore";
  for (const w of PICKUP_WEAPONS) if (t.includes(w === "grapple" ? "hook" : w) || t.includes(w)) out.weapons.push(w);
  if (has("cocky", "arrogant", "swagger", "talks big")) out.temperament = "cocky";
  else if (has("nervous", "anxious", "jittery", "scared")) out.temperament = "nervous";
  else if (has("calm", "patient", "cool-headed")) out.temperament = "calm";
  if (has("loud", "shouts", "trash talk", "all caps")) out.voice = "brash";
  else if (has("smug", "condescending", "posh")) out.voice = "smug";
  else if (has("nervous", "stammer", "apolog")) out.voice = "nervous";
  else if (has("sly", "purr", "gloat")) out.voice = "sly";
  return out;
}

/** Parse a soul file. Never throws: problems are reported, defaults fill the gaps. */
export function parseSoul(text: string, seat = 0): SoulParse {
  const errors: string[] = [];
  const warnings: string[] = [];
  let front: Record<string, string> = {};
  let rest = text.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(rest);
  if (fm) {
    rest = rest.slice(fm[0].length);
    for (const line of fm[1]!.split("\n")) {
      const m = /^\s*([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line);
      if (m) front[m[1]!.toLowerCase()] = m[2]!.trim().replace(/^["']|["']$/g, "");
    }
  } else warnings.push("no front matter: everything is guessed from the text");
  // lines section
  const lines: LineTemplate[] = [];
  const li = rest.search(/^##\s*Lines\s*$/m);
  let body = rest;
  if (li >= 0) {
    body = rest.slice(0, li);
    for (const l of rest.slice(li).split("\n").slice(1)) {
      if (/^##\s/.test(l)) break;
      const m = /^\s*-\s*([a-z:]+)\s*(?:\[([a-z, ]+)\])?\s*:\s*(.+)$/.exec(l);
      if (!m) continue;
      const states = m[2] ? (list(m[2]).filter((s) => (STATES as readonly string[]).includes(s)) as MoraleState[]) : "*";
      lines.push([m[1]!, states && (states === "*" || states.length) ? states : "*", m[3]!.trim()]);
    }
  }
  body = body.trim();
  const guess = inferFromText(`${front.values ?? ""} ${body}`);
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T, guessed?: T): T => {
    const v = front[key]?.toLowerCase();
    if (v !== undefined && v !== "") {
      if ((allowed as readonly string[]).includes(v)) return v as T;
      errors.push(`${key}: "${front[key]}" is not one of ${allowed.join(", ")}`);
    }
    return guessed ?? fallback;
  };
  const headline = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  let name = (front.name ?? headline?.split(/["“(,]/)[0] ?? "").trim();
  if (!name) {
    errors.push("name is missing");
    name = `Fighter ${seat + 1}`;
  }
  if (name.length > 16) {
    warnings.push(`name "${name}" is long; shortened`);
    name = name.slice(0, 16).trim();
  }
  let color = SEAT_COLORS[seat % 4]!;
  if (front.color) {
    const c = /^#?([0-9a-fA-F]{6})$/.exec(front.color);
    if (c) color = parseInt(c[1]!, 16);
    else errors.push(`color: "${front.color}" is not a #rrggbb color`);
  }
  let weapons: Weapon[] = [];
  if (front.weapons) {
    for (const w of list(front.weapons)) {
      const ww = weaponOf(w);
      if (ww && !weapons.includes(ww)) weapons.push(ww);
      else if (!ww) errors.push(`weapons: unknown weapon "${w}"`);
    }
  } else weapons = guess.weapons.slice(0, 3);
  if (!weapons.length) {
    weapons = ["shotgun", "rocket"];
    warnings.push("no weapon preferences: defaulting to shotgun, rocket");
  }
  const soul: Soul = {
    name,
    title: (front.title ?? "").slice(0, 32),
    color,
    temperament: pick("temperament", TEMPERAMENTS, "confident", guess.temperament),
    voice: pick("voice", VOICES, "plain", guess.voice),
    values: front.values ? list(front.values).slice(0, 8) : [],
    weapons: weapons.slice(0, 3),
    stance: pick("stance", STANCES, "rush", guess.stance),
    target: pick("target", TARGETS, "nearest", guess.target),
    retaliate: pick("retaliate", RETALIATE, "turn", guess.retaliate),
    catchphrase: (front.catchphrase ?? "").slice(0, 80),
    mark: pick("mark", MARKS, "none"),
    body,
    lines,
  };
  return { soul, errors, warnings };
}

/** Soul as compact data for records (a replay needs no files). */
export function soulRecord(s: Soul): Soul {
  return { ...s, values: s.values.slice(), weapons: s.weapons.slice(), lines: s.lines.map((l) => [l[0], l[1] === "*" ? "*" : l[1].slice(), l[2]] as LineTemplate) };
}
