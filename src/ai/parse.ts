/**
 * Lenient parsing of an AI answer: find a balanced JSON object anywhere in the
 * text (models wrap JSON in Markdown or prose), then validate it against the
 * choices. The plan and the line are judged separately, so a good line can
 * survive a bad plan (and vice versa).
 */
import { autoLabel, checkRule, MAX_RULE_LABEL, PICKUPS, ruleKey, WHO_TRIGGERS } from "../sim/rules";
import { MAX_RULES, RULE_DO, RULE_WHEN, type ItemType, type Retaliate, type Rule, type RuleWho, type Stance, type Strategy, type TargetPref, type Weapon } from "../sim/sim";

const WEAPONS: readonly Weapon[] = ["rocket", "shotgun", "bat", "grenade", "grapple"];
const STANCES: readonly Stance[] = ["rush", "distance", "cover", "item"];
const PREFS: readonly TargetPref[] = ["nearest", "weakest", "strongest", "leader", "rocket", "shotgun"];
const RETALIATE: readonly Retaliate[] = ["attacker", "turn", "ignore"];
const WEAPON_ALIAS: Record<string, Weapon> = { hook: "grapple", grappling: "grapple", "grappling hook": "grapple", "baseball bat": "bat", rockets: "rocket", grenades: "grenade", launcher: "rocket" };

export const MAX_LINE = 120;
/** the optional "why" (#3): one sentence in game terms */
export const MAX_WHY = 100;

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

export function cleanWhy(v: unknown): string | null {
  const s = cleanLine(v);
  if (!s) return null;
  return s.length > MAX_WHY ? s.slice(0, MAX_WHY - 1).replace(/\s+\S*$/, "") + "…" : s;
}

const ITEM_ALIAS: Record<string, ItemType> = { ...WEAPON_ALIAS, heal: "health", medkit: "health", hp: "health" };
function itemOf(v: unknown): ItemType | undefined {
  if (typeof v !== "string") return undefined;
  const w = v.toLowerCase().trim();
  return (PICKUPS as readonly string[]).includes(w) ? (w as ItemType) : ITEM_ALIAS[w];
}

/**
 * The "rules" of an AI answer (#5). Each bad rule is dropped on its own,
 * with a problem; the plan stays valid. More than MAX_RULES: the first ones
 * are kept. In the AI's JSON, "item" belongs to the trigger for holds and
 * item_near, and to the action otherwise; "do_item" (or "weapon") names the
 * action's item when the trigger already uses "item".
 */
export function parseRules(raw: unknown, me: number, names: string[]): { rules: Rule[]; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { rules: [], problems };
  if (!Array.isArray(raw)) return { rules: [], problems: [`rules: expected a list, got ${typeof raw}`] };
  const rules: Rule[] = [];
  const seen = new Set<string>();
  raw.forEach((o: unknown, i) => {
    const tag = `rule ${i + 1}`;
    if (!o || typeof o !== "object" || Array.isArray(o)) return void problems.push(`${tag}: not an object`);
    if (rules.length >= MAX_RULES) return void problems.push(`${tag}: more than ${MAX_RULES} rules, dropped`);
    const x = o as Record<string, unknown>;
    const when = typeof x.when === "string" ? x.when.toLowerCase().trim() : x.when;
    const act = typeof x.do === "string" ? x.do.toLowerCase().trim() : x.do;
    if (!(RULE_WHEN as readonly unknown[]).includes(when)) return void problems.push(`${tag}: unknown trigger ${JSON.stringify(x.when)}`);
    if (!(RULE_DO as readonly unknown[]).includes(act)) return void problems.push(`${tag}: unknown action ${JSON.stringify(x.do)}`);
    const r: Omit<Rule, "label"> = { when: when as Rule["when"], do: act as Rule["do"] };
    if (WHO_TRIGGERS.includes(r.when)) {
      const w = typeof x.who === "string" ? x.who.toLowerCase().trim() : "";
      let who: RuleWho | undefined;
      if (w === "anyone" || w === "enemy" || w === "target") who = w;
      else if (w === "rival" || w === "anybody" || w === "any") who = w === "rival" ? "enemy" : "anyone";
      else if (w) {
        const id = names.findIndex((n) => n.toLowerCase() === w);
        if (id === me) return void problems.push(`${tag}: "who" can't be yourself`);
        if (id < 0) return void problems.push(`${tag}: no fighter named ${JSON.stringify(x.who)}`);
        who = id;
      }
      if (who !== undefined) r.who = who;
    }
    if (x.value !== undefined) r.value = typeof x.value === "number" ? Math.round(x.value) : typeof x.value === "string" && x.value.trim() !== "" && !Number.isNaN(Number(x.value)) ? Math.round(Number(x.value)) : (NaN as number);
    const triggerItem = r.when === "holds" || r.when === "item_near";
    if (triggerItem) {
      const ti = itemOf(x.item);
      if (ti) r.item = ti;
      else if (x.item !== undefined) return void problems.push(`${tag}: unknown item ${JSON.stringify(x.item)}`);
    }
    if (r.do === "seek" || r.do === "use") {
      const src = triggerItem ? (x.do_item ?? x.weapon ?? (r.do === "seek" && r.when === "item_near" ? x.item : undefined)) : (x.item ?? x.do_item ?? x.weapon);
      const di = itemOf(src);
      if (di) r.doItem = di;
      else if (src !== undefined) return void problems.push(`${tag}: unknown item ${JSON.stringify(src)}`);
    }
    // lenient: a stance or retaliate value given under another key ("do":"retaliate","item":"attacker")
    const valueOf = (key: unknown, allowed: readonly string[]) => [key, x.item, x.value, x.do_item].map((v) => (typeof v === "string" ? v.toLowerCase().trim() : "")).find((v) => allowed.includes(v));
    if (r.do === "stance") {
      const v = typeof x.stance === "string" ? x.stance.toLowerCase().trim() : valueOf(undefined, ["rush", "distance", "cover", "item"]);
      if (v) r.stance = v as Stance;
    }
    if (r.do === "retaliate") {
      const v = typeof x.retaliate === "string" ? x.retaliate.toLowerCase().trim() : valueOf(undefined, ["attacker", "turn", "ignore"]);
      if (v) r.retaliate = v as Retaliate;
    }
    const cl = cleanLine(x.label);
    const rule: Rule = { ...r, label: cl ? (cl.length > MAX_RULE_LABEL ? cl.slice(0, MAX_RULE_LABEL).trim() : cl) : autoLabel(r, names) };
    const bad = checkRule(rule, me);
    if (bad) return void problems.push(`${tag}${cl ? ` ("${rule.label}")` : ""}: ${bad}`);
    const key = ruleKey(rule);
    if (seen.has(key)) return void problems.push(`${tag} ("${rule.label}"): duplicate rule, dropped`);
    seen.add(key);
    rules.push(rule);
  });
  return { rules, problems };
}

export interface Parsed {
  strategy: Strategy | null;
  line: string | null;
  /** why the plan was rejected */
  problems: string[];
  /** the AI's reason for its plan (optional, never makes a plan invalid) */
  why?: string;
  /** rules dropped by validation (the plan stays valid) */
  ruleProblems?: string[];
}

/**
 * `names` are the fighters' names from their souls (targets can be named).
 * Weapons: 1 to 3 different pickups to go for, best first ("loadout" is
 * accepted as an old spelling).
 */
export function validatePlan(o: Record<string, unknown>, me: number, names: string[]): { strategy: Strategy | null; problems: string[] } {
  const problems: string[] = [];
  const weapon = (v: unknown): Weapon | null => {
    if (typeof v !== "string") return null;
    const w = v.toLowerCase().trim();
    return (WEAPONS as readonly string[]).includes(w) ? (w as Weapon) : (WEAPON_ALIAS[w] ?? null);
  };
  const rawW = o.weapons ?? o.loadout;
  const ws = Array.isArray(rawW) ? rawW.map(weapon) : typeof rawW === "string" ? [weapon(rawW)] : [];
  const weapons = ws.filter((w, i): w is Weapon => !!w && ws.indexOf(w) === i);
  if (!weapons.length || weapons.length !== ws.length || weapons.length > 3) problems.push(`weapons ${JSON.stringify(rawW)}`);
  const stance = typeof o.stance === "string" ? (o.stance.toLowerCase().trim() as Stance) : null;
  if (!stance || !STANCES.includes(stance)) problems.push(`stance ${JSON.stringify(o.stance)}`);
  let target: TargetPref | null = null;
  let grudge: number | undefined;
  if (typeof o.target === "string") {
    const t = o.target.toLowerCase().trim();
    const id = names.findIndex((n) => n.toLowerCase() === t);
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
  return { strategy: { target: target!, ...(grudge !== undefined ? { grudge } : {}), stance: stance!, weapons, retaliate, line: "" }, problems };
}

export function parseAnswer(text: string, me: number, names: string[]): Parsed {
  const objs = jsonObjects(text).filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o));
  if (!objs.length) return { strategy: null, line: null, problems: ["no JSON object"] };
  let best: Parsed | null = null;
  for (const o of objs) {
    const v = validatePlan(o, me, names);
    const why = cleanWhy(o.why ?? o.reason);
    const pr = parseRules(o.rules, me, names);
    if (v.strategy && pr.rules.length) v.strategy.rules = pr.rules;
    const p: Parsed = { strategy: v.strategy, line: cleanLine(o.line ?? o.say), problems: v.problems, ...(why ? { why } : {}), ...(pr.problems.length ? { ruleProblems: pr.problems } : {}) };
    if (p.strategy && p.line) return p;
    if (!best || (p.strategy && !best.strategy) || (p.line && !best.line)) best = p;
  }
  return best!;
}
