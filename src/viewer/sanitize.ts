/** Untrusted input (record files, the live stream) -> safe decisions and souls. Pure: no DOM, no Pixi. */
import type { MatchRecord, PlanUpdate } from "../sim/match";
import { MORALE_STATES } from "../sim/morale";
import { checkRule, MAX_RULE_LABEL, RULE_RETALIATE, RULE_STANCES } from "../sim/rules";
import { isPickupWeapon, MAX_RULES, TARGET_PREFERENCES, type Rule, type Strategy } from "../sim/sim-types";
import { generateIdentities, sanitizeIdentity, type Identity } from "../sim/identity";
import type { LineTemplate, Soul } from "../sim/soul";
import type { Decision } from "../sim/voice";

const SAFE_TARGETS = [...TARGET_PREFERENCES, "grudge"];
const SAFE_TEMPER = ["cocky", "confident", "calm", "nervous"];
const SAFE_VOICE = ["brash", "smug", "nervous", "sly", "plain"];

const str = (v: unknown, max: number, def = "") => (typeof v === "string" ? v.slice(0, max) : def);
const oneOf = <T extends string>(v: unknown, list: readonly string[], def: T): T => (list.includes(v as string) ? (v as T) : def);

/**
 * Decisions from a record file or the live stream are untrusted input: keep
 * only known values (anything else becomes a plain default) and plain-string
 * lines. Everything shown is escaped as well.
 */
export function sanitizeDecision(d: unknown, fighter: number): Decision {
  const o = (d && typeof d === "object" ? d : {}) as { line?: unknown; strategy?: Record<string, unknown> };
  const s = (o.strategy && typeof o.strategy === "object" ? o.strategy : {}) as Record<string, unknown>;
  const raw = Array.isArray(s.weapons) ? s.weapons : [];
  const weapons = raw.filter((w, i) => isPickupWeapon(w) && raw.indexOf(w) === i).slice(0, 3) as Strategy["weapons"];
  const target = oneOf<Strategy["target"]>(s.target, SAFE_TARGETS, "nearest");
  const grudge = Number.isInteger(s.grudge) && (s.grudge as number) >= 0 && (s.grudge as number) < 4 && s.grudge !== fighter ? (s.grudge as number) : undefined;
  const strategy: Strategy = {
    target: target === "grudge" && grudge === undefined ? "nearest" : target,
    ...(target === "grudge" && grudge !== undefined ? { grudge } : {}),
    stance: oneOf<Strategy["stance"]>(s.stance, RULE_STANCES, "rush"),
    weapons: weapons.length ? weapons : ["shotgun", "rocket"],
    retaliate: oneOf<NonNullable<Strategy["retaliate"]>>(s.retaliate, RULE_RETALIATE, "turn"),
    line: "",
  };
  const rules = sanitizeRules(s.rules, fighter);
  if (rules.length) strategy.rules = rules;
  const line = str(o.line, 200);
  return { line, strategy: { ...strategy, line } };
}

/** Stored rules from a record or the stream: only rules that pass the same checks as the AI parser (#5). */
export function sanitizeRules(v: unknown, fighter: number): Rule[] {
  if (!Array.isArray(v)) return [];
  const out: Rule[] = [];
  for (const raw of v.slice(0, MAX_RULES)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const r = {
      when: o.when,
      do: o.do,
      ...(o.who !== undefined ? { who: o.who } : {}),
      ...(o.item !== undefined ? { item: o.item } : {}),
      ...(o.value !== undefined ? { value: o.value } : {}),
      ...(o.doItem !== undefined ? { doItem: o.doItem } : {}),
      ...(o.stance !== undefined ? { stance: o.stance } : {}),
      ...(o.retaliate !== undefined ? { retaliate: o.retaliate } : {}),
      label: typeof o.label === "string" ? o.label.slice(0, MAX_RULE_LABEL) : "",
    } as Rule;
    if (!checkRule(r, fighter)) out.push(r);
  }
  return out;
}

/**
 * A soul from a record or the stream: known values only, strings clipped.
 * Old (version 2 and 3) souls also carry a name, color and mark: those are
 * kept as `legacy` so the match can turn them into identities.
 */
export function sanitizeSoul(v: unknown, seat: number): Soul {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const lines: LineTemplate[] = (Array.isArray(o.lines) ? o.lines : []).slice(0, 120).flatMap((l): LineTemplate[] => {
    if (!Array.isArray(l) || typeof l[0] !== "string" || typeof l[2] !== "string") return [];
    const st = l[1] === "*" ? "*" : Array.isArray(l[1]) ? (l[1].filter((x) => MORALE_STATES.includes(x)) as LineTemplate[1]) : "*";
    return [[l[0].slice(0, 20), st === "*" || st.length ? st : "*", l[2].slice(0, 200)]];
  });
  const ws = (Array.isArray(o.weapons) ? o.weapons : []).filter((w) => isPickupWeapon(w)).slice(0, 3) as Soul["weapons"];
  const legacy = typeof o.name === "string" || Number.isInteger(o.color) || typeof o.mark === "string" ? { name: str(o.name, 16), color: o.color, mark: str(o.mark, 16) } : null;
  return {
    id: str(o.id, 24).replace(/[^a-z0-9_-]/g, "") || `soul${seat + 1}`,
    temperament: oneOf(o.temperament, SAFE_TEMPER, "confident"),
    voice: oneOf(o.voice, SAFE_VOICE, "plain"),
    values: (Array.isArray(o.values) ? o.values : []).filter((x) => typeof x === "string").slice(0, 8).map((x) => (x as string).slice(0, 80)),
    weapons: ws.length ? ws : ["shotgun", "rocket"],
    stance: oneOf(o.stance, RULE_STANCES, "rush"),
    target: oneOf(o.target, TARGET_PREFERENCES, "nearest"),
    retaliate: oneOf(o.retaliate, RULE_RETALIATE, "turn"),
    catchphrase: str(o.catchphrase, 80),
    body: str(o.body, 4000),
    lines,
    ...(legacy ? (legacy as object) : {}),
  };
}

/** Identities from the stream or a record: four valid ones, or undefined. */
export function sanitizeIdentities(v: unknown, seed = 0): Identity[] | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const gen = generateIdentities(seed);
  return v.map((x, i) => sanitizeIdentity(x, i, gen[i]!));
}

export function sanitizeSouls(v: unknown): Soul[] | undefined {
  return Array.isArray(v) && v.length === 4 ? v.map((s, i) => sanitizeSoul(s, i)) : undefined;
}

/** Mid-round plan updates from a record (#10): tick, fighter, a sanitized plan and line; at most 64, in tick order. */
export function sanitizePlanUpdates(v: unknown): PlanUpdate[] {
  if (!Array.isArray(v)) return [];
  const out: PlanUpdate[] = [];
  for (const u of v.slice(0, 64)) {
    if (!u || typeof u !== "object") continue;
    const o = u as Record<string, unknown>;
    const fighter = Number(o.fighter);
    const tick = Number(o.tick);
    if (!Number.isInteger(fighter) || fighter < 0 || fighter > 3 || !Number.isInteger(tick) || tick < 0 || tick > 100000) continue;
    const d = sanitizeDecision({ line: o.line, strategy: o.strategy }, fighter);
    out.push({ tick, fighter, strategy: d.strategy, ...(d.line ? { line: d.line.slice(0, 120) } : {}) });
  }
  return out.sort((a, b) => a.tick - b.tick || a.fighter - b.fighter);
}

/** Sanitize a whole match record (replay files are untrusted). */
export function sanitizeRecord(rec: unknown): MatchRecord | null {
  const r = rec as MatchRecord;
  if (!r || typeof r !== "object" || !Number.isFinite(r.seed) || !Array.isArray(r.rounds) || r.rounds.length > 3 || (r.version !== 2 && r.version !== 3 && r.version !== 4)) return null;
  const souls = sanitizeSouls(r.souls);
  if (!souls) return null;
  const identities = r.version === 4 ? sanitizeIdentities(r.identities, Number(r.seed) >>> 0) : undefined;
  if (r.version === 4 && !identities) return null;
  return {
    ...r,
    version: r.version,
    seed: Number(r.seed) >>> 0,
    souls,
    identities,
    rounds: r.rounds.map((rd) => {
      const ds = [0, 1, 2, 3].map((i) => sanitizeDecision({ line: rd.lines?.[i], strategy: rd.strategies?.[i] }, i));
      const meta = Array.isArray(rd.meta) ? rd.meta.slice(0, 4).map((m) => ({ provider: String(m?.provider ?? "?").slice(0, 40), ms: Number(m?.ms) || 0, outcome: ["ok", "fallback-timeout", "fallback-invalid", "fallback-error", "house"].includes(m?.outcome) ? m.outcome : "house", ...(typeof m?.aiLine === "string" ? { aiLine: m.aiLine.slice(0, 200) } : {}), ...(typeof m?.why === "string" ? { why: m.why.slice(0, 100) } : {}), ...(Array.isArray(m?.factWarnings) ? { factWarnings: m.factWarnings.slice(0, 4).map((w: unknown) => String(w).slice(0, 200)) } : {}), ...(m?.hedged === true ? { hedged: true } : {}), ...(Array.isArray(m?.ruleProblems) ? { ruleProblems: m.ruleProblems.slice(0, 8).map((w: unknown) => String(w).slice(0, 200)) } : {}) })) : undefined;
      const planUpdates = sanitizePlanUpdates((rd as { planUpdates?: unknown }).planUpdates);
      return { ...rd, strategies: ds.map((d) => d.strategy), lines: ds.map((d) => d.line), ...(meta ? { meta } : {}), ...(planUpdates.length ? { planUpdates } : { planUpdates: undefined }) };
    }),
  };
}
