/**
 * Plan rules (#5): checks and labels on the stored form (seat numbers,
 * resolved items). Shared by the AI parser (src/ai/parse.ts), the viewer's
 * sanitizer (records, the live stream) and the house bots. Pure.
 */
import { isPickupWeapon, POWER_LIST, RULE_DO, RULE_WHEN, WEAPON_LIST, type ItemType, type Rule, type RuleWhen, type RuleWho } from "./sim-types";

export const RULE_STANCES = ["rush", "distance", "cover", "item"] as const;
export const RULE_RETALIATE = ["attacker", "turn", "ignore"] as const;
export const PICKUPS: readonly ItemType[] = [...WEAPON_LIST, ...POWER_LIST];
export const MAX_RULE_LABEL = 40;

/** Triggers about fighters (they have a subject: the fighter that makes them true). */
export const WHO_TRIGGERS: readonly RuleWhen[] = ["holds", "health_below", "near_ledge", "near_barrel", "on_streak", "chasing_me", "hit_me"];
/** Triggers that have a fighter subject for target/avoid (alone_with: the last rival). */
export const SUBJECT_TRIGGERS: readonly RuleWhen[] = [...WHO_TRIGGERS, "alone_with"];

/** Value ranges by trigger. */
export const RULE_VALUE: Partial<Record<RuleWhen, [number, number]>> = { my_health_below: [10, 90], health_below: [10, 90], on_streak: [1, 3] };

/** Problem with a stored rule (null = fine). `me` is the rule owner's seat. */
export function checkRule(r: Rule, me: number): string | null {
  if (!r || typeof r !== "object") return "not a rule";
  if (!(RULE_WHEN as readonly string[]).includes(r.when)) return `unknown trigger ${JSON.stringify(r.when)}`;
  if (!(RULE_DO as readonly string[]).includes(r.do)) return `unknown action ${JSON.stringify(r.do)}`;
  if (WHO_TRIGGERS.includes(r.when)) {
    if (r.who === undefined) return `"${r.when}" needs "who"`;
    if (typeof r.who === "number") {
      if (!Number.isInteger(r.who) || r.who < 0 || r.who > 3) return `no fighter ${r.who}`;
      if (r.who === me) return `"who" can't be yourself`;
    } else if (!["anyone", "enemy", "target"].includes(r.who)) return `unknown "who" ${JSON.stringify(r.who)}`;
  }
  const range = RULE_VALUE[r.when];
  if (range) {
    if (typeof r.value !== "number" || !Number.isInteger(r.value)) return `"${r.when}" needs a whole-number "value"`;
    if (r.value < range[0] || r.value > range[1]) return `"value" ${r.value} is out of range ${range[0]}-${range[1]}`;
  }
  if (r.when === "holds" && !isPickupWeapon(r.item)) return `"holds" needs a weapon, got ${JSON.stringify(r.item)}`;
  if (r.when === "item_near" && !PICKUPS.includes(r.item as never)) return `"item_near" needs a pickup, got ${JSON.stringify(r.item)}`;
  if ((r.do === "target" || r.do === "avoid") && !SUBJECT_TRIGGERS.includes(r.when)) return `"${r.do}" needs a trigger about a fighter, not "${r.when}"`;
  if (r.do === "seek" && !PICKUPS.includes(r.doItem as never)) return `"seek" needs a pickup, got ${JSON.stringify(r.doItem)}`;
  if (r.do === "use" && !isPickupWeapon(r.doItem)) return `"use" needs a weapon, got ${JSON.stringify(r.doItem)}`;
  if (r.do === "stance" && !(RULE_STANCES as readonly string[]).includes(r.stance as string)) return `"stance" needs one of ${RULE_STANCES.join(", ")}`;
  if (r.do === "retaliate" && !(RULE_RETALIATE as readonly string[]).includes(r.retaliate as string)) return `"retaliate" needs one of ${RULE_RETALIATE.join(", ")}`;
  if (typeof r.label !== "string" || !r.label || r.label.length > MAX_RULE_LABEL) return "bad label";
  return null;
}

const whoText = (w: RuleWho | undefined, names: string[]) => (w === undefined ? "" : typeof w === "number" ? names[w] ?? `seat ${w}` : w === "anyone" ? "anyone" : w === "enemy" ? "a rival" : "my target");
const ITEM_TEXT: Record<string, string> = { grapple: "hook" };
const it = (x?: string) => (x ? (ITEM_TEXT[x] ?? x) : "");

/** A short label made from the rule, when the AI gave none. */
export function autoLabel(r: Omit<Rule, "label">, names: string[]): string {
  const who = whoText(r.who, names);
  const cond: Record<RuleWhen, string> = {
    holds: `${who} has ${it(r.item)}`,
    my_health_below: `below ${r.value}%`,
    health_below: `${who} below ${r.value}%`,
    near_ledge: `${who} at a ledge`,
    near_barrel: `${who} by a barrel`,
    on_streak: `${who} on a streak`,
    chasing_me: `${who} chasing me`,
    hit_me: `${who} hit me`,
    item_near: `${it(r.item)} nearby`,
    alone_with: "last two",
  };
  const act: Record<Rule["do"], string> = { target: "go for them", avoid: "keep away", seek: `get ${it(r.doItem)}`, use: `use ${it(r.doItem)}`, stance: r.stance ?? "stance", retaliate: `retaliate ${r.retaliate ?? ""}`.trim() };
  return `${cond[r.when]}: ${act[r.do]}`.slice(0, MAX_RULE_LABEL);
}

/** Same rule ignoring the label (duplicates are dropped). */
export function ruleKey(r: Rule): string {
  return JSON.stringify([r.when, r.who ?? null, r.item ?? null, r.value ?? null, r.do, r.doItem ?? null, r.stance ?? null, r.retaliate ?? null]);
}
