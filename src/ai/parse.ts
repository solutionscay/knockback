/**
 * Lenient parsing of an AI answer: find a balanced JSON object anywhere in the
 * text (models wrap JSON in Markdown or prose), then validate it against the
 * choices. The plan and the line are judged separately, so a good line can
 * survive a bad plan (and vice versa).
 */
import { CHARACTERS } from "../sim/characters";
import type { Retaliate, Stance, Strategy, TargetPref, Weapon } from "../sim/sim";

const WEAPONS: readonly Weapon[] = ["rocket", "shotgun", "bat", "grenade", "grapple"];
const STANCES: readonly Stance[] = ["rush", "distance", "cover", "item"];
const PREFS: readonly TargetPref[] = ["nearest", "weakest", "strongest", "leader", "rocket", "shotgun"];
const RETALIATE: readonly Retaliate[] = ["attacker", "turn", "ignore"];
const WEAPON_ALIAS: Record<string, Weapon> = { hook: "grapple", grappling: "grapple", "grappling hook": "grapple", "baseball bat": "bat", rockets: "rocket", grenades: "grenade", launcher: "rocket" };
const COLOR_ALIAS: Record<string, number> = { red: 0, blue: 1, green: 2, gold: 3, yellow: 3 };

export const MAX_LINE = 120;

/** Every balanced {...} object in the text that parses as JSON, in order. */
export function jsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* not JSON: keep looking */
        }
        break;
      }
    }
  }
  return out;
}

export function cleanLine(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!s) return null;
  if (s.length > MAX_LINE) s = s.slice(0, MAX_LINE - 1).replace(/\s+\S*$/, "") + "…";
  return s;
}

export interface Parsed {
  strategy: Strategy | null;
  line: string | null;
  /** why the plan was rejected */
  problems: string[];
}

export function validatePlan(o: Record<string, unknown>, me: number): { strategy: Strategy | null; problems: string[] } {
  const problems: string[] = [];
  const weapon = (v: unknown): Weapon | null => {
    if (typeof v !== "string") return null;
    const w = v.toLowerCase().trim();
    return (WEAPONS as readonly string[]).includes(w) ? (w as Weapon) : (WEAPON_ALIAS[w] ?? null);
  };
  const lo = Array.isArray(o.loadout) ? o.loadout.map(weapon) : [];
  if (lo.length !== 2 || !lo[0] || !lo[1] || lo[0] === lo[1]) problems.push(`loadout ${JSON.stringify(o.loadout)}`);
  const stance = typeof o.stance === "string" ? (o.stance.toLowerCase().trim() as Stance) : null;
  if (!stance || !STANCES.includes(stance)) problems.push(`stance ${JSON.stringify(o.stance)}`);
  let target: TargetPref | null = null;
  let grudge: number | undefined;
  if (typeof o.target === "string") {
    const t = o.target.toLowerCase().trim();
    const byName = CHARACTERS.findIndex((c) => c.name.toLowerCase() === t || c.fullName.toLowerCase().includes(t) || c.title.toLowerCase() === t);
    const id = byName >= 0 ? byName : (COLOR_ALIAS[t] ?? -1);
    if (id >= 0 && id !== me) {
      target = "grudge";
      grudge = id;
    } else if ((PREFS as readonly string[]).includes(t)) target = t as TargetPref;
  }
  if (!target) problems.push(`target ${JSON.stringify(o.target)}`);
  let retaliate: Retaliate = "turn";
  if (o.retaliate !== undefined) {
    const r = typeof o.retaliate === "string" ? o.retaliate.toLowerCase().trim() : "";
    if ((RETALIATE as readonly string[]).includes(r)) retaliate = r as Retaliate;
    else problems.push(`retaliate ${JSON.stringify(o.retaliate)}`);
  }
  if (problems.length) return { strategy: null, problems };
  return { strategy: { target: target!, ...(grudge !== undefined ? { grudge } : {}), stance: stance!, loadout: [lo[0]!, lo[1]!], retaliate, line: "" }, problems };
}

export function parseAnswer(text: string, me: number): Parsed {
  const objs = jsonObjects(text).filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o));
  if (!objs.length) return { strategy: null, line: null, problems: ["no JSON object"] };
  let best: Parsed | null = null;
  for (const o of objs) {
    const v = validatePlan(o, me);
    const p: Parsed = { strategy: v.strategy, line: cleanLine(o.line ?? o.say), problems: v.problems };
    if (p.strategy && p.line) return p;
    if (!best || (p.strategy && !best.strategy) || (p.line && !best.line)) best = p;
  }
  return best!;
}
