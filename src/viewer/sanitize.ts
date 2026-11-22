import { resolveRuleset, type Ruleset } from "../sim/ruleset";
/** Untrusted input (record files, the live stream) -> safe decisions and souls. Pure: no DOM, no Pixi. */
import type { MatchRecord, SuitUpEntry } from "../sim/match";
import type { PlanUpdate } from "../sim/fight";
import { MORALE_STATES } from "../sim/morale";
import { checkRule, MAX_RULE_LABEL, RULE_RETALIATE, RULE_STANCES } from "../sim/rules";
import { isPickupWeapon, MAX_RULES, TARGET_PREFERENCES, type Rule, type Strategy } from "../sim/sim-types";
import { generateIdentities, sanitizeIdentity, type Identity } from "../sim/identity";
import type { LineTemplate, Soul } from "../sim/soul";
import type { Decision } from "../sim/voice";
import { ENTRANCE_LINE_MAX, type Entrance } from "../sim/entrance";
import { buildProblem, NEUTRAL_BUILD, strategyBuild, type Build } from "../sim/build";

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
  // a legal build replays as recorded (#79); anything else is no build (neutral), and the replay check refuses the record
  if (s.build !== undefined && buildProblem(s.build) === null) strategy.build = strategyBuild(s.build as Build);
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

/** A soul from a record or the stream: known values only, strings clipped. */
export function sanitizeSoul(v: unknown, seat: number): Soul {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const lines: LineTemplate[] = (Array.isArray(o.lines) ? o.lines : []).slice(0, 120).flatMap((l): LineTemplate[] => {
    if (!Array.isArray(l) || typeof l[0] !== "string" || typeof l[2] !== "string") return [];
    const st = l[1] === "*" ? "*" : Array.isArray(l[1]) ? (l[1].filter((x) => MORALE_STATES.includes(x)) as LineTemplate[1]) : "*";
    return [[l[0].slice(0, 20), st === "*" || st.length ? st : "*", l[2].slice(0, 200)]];
  });
  const ws = (Array.isArray(o.weapons) ? o.weapons : []).filter((w) => isPickupWeapon(w)).slice(0, 3) as Soul["weapons"];
  return {
    id: str(o.id, 24).replace(/[^a-z0-9_-]/g, "") || `soul${seat + 1}`,
    temperament: oneOf(o.temperament, SAFE_TEMPER, "confident"),
    voice: oneOf(o.voice, SAFE_VOICE, "plain"),
    values: (Array.isArray(o.values) ? o.values : []).filter((x) => typeof x === "string").slice(0, 8).map((x) => (x as string).slice(0, 80)),
    weapons: ws.length ? ws : ["shotgun", "rocket"],
    stance: oneOf(o.stance, RULE_STANCES, "rush"),
    target: oneOf(o.target, TARGET_PREFERENCES, "nearest"),
    retaliate: oneOf(o.retaliate, RULE_RETALIATE, "turn"),
    build: o.build !== undefined && buildProblem(o.build) === null ? strategyBuild(o.build as Build) : { ...NEUTRAL_BUILD },
    catchphrase: str(o.catchphrase, 80),
    body: str(o.body, 4000),
    lines,
  };
}

/** Identities from the stream or a record: four valid ones, or undefined. */
export function sanitizeIdentities(v: unknown, seed = 0): Identity[] | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const gen = generateIdentities(seed);
  return v.map((x, i) => sanitizeIdentity(x, i, gen[i]!));
}

const SUIT_OUTCOMES = ["ok", "partial", "fallback-timeout", "fallback-error", "fallback-invalid"];
const LOOK_FIELDS = ["name", "shape", "eyes", "color", "mark", "minor"];

/** Entrances (#66) from a record or the live stream: one per seat at most, a short line, a valid identity for the bot kicked out. */
export function sanitizeEntrances(v: unknown, seed = 0): Entrance[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const gen = generateIdentities(seed);
  const out: Entrance[] = [];
  for (const raw of v.slice(0, 4)) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const seat = o.seat;
    if (!Number.isInteger(seat) || (seat as number) < 0 || (seat as number) > 3 || out.some((e) => e.seat === seat)) continue;
    out.push({ seat: seat as number, line: str(o.line, ENTRANCE_LINE_MAX), ...(o.evicted && typeof o.evicted === "object" ? { evicted: sanitizeIdentity(o.evicted, seat as number, gen[seat as number]!) } : {}) });
  }
  return out.length ? out.sort((a, b) => a.seat - b.seat) : undefined;
}

/** The suit-up entries (#19) from a record or the live stream: known values, short strings. */
export function sanitizeSuitUp(v: unknown): SuitUpEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SuitUpEntry[] = [];
  for (const x of v.slice(0, 4)) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const seat = Number.isInteger(o.seat) && (o.seat as number) >= 0 && (o.seat as number) <= 3 ? (o.seat as number) : -1;
    if (seat < 0 || out.some((e) => e.seat === seat) || (o.by !== "ai" && o.by !== "agent") || !SUIT_OUTCOMES.includes(o.outcome as string)) continue;
    const fields = (a: unknown) => (Array.isArray(a) ? a.filter((f): f is string => LOOK_FIELDS.includes(f as string)) : []);
    const dropped = Array.isArray(o.dropped) ? o.dropped.slice(0, 6).map((d) => ({ field: String((d as { field?: unknown })?.field ?? "").slice(0, 8), why: String((d as { why?: unknown })?.why ?? "").slice(0, 20) })).filter((d) => LOOK_FIELDS.includes(d.field)) : [];
    const nudged = o.nudged && typeof o.nudged === "object" ? (o.nudged as Record<string, unknown>) : null;
    const color = (c: unknown) => (Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 0xffffff ? (c as number) : null);
    out.push({
      seat,
      by: o.by,
      outcome: o.outcome as SuitUpEntry["outcome"],
      ...(Number.isFinite(o.ms) ? { ms: Math.max(0, Number(o.ms)) } : {}),
      kept: fields(o.kept),
      dropped,
      ...(nudged && color(nudged.from) !== null && color(nudged.to) !== null ? { nudged: { from: color(nudged.from)!, to: color(nudged.to)! } } : {}),
      ...(typeof o.line === "string" ? { line: o.line.slice(0, 140) } : {}),
      ...(typeof o.why === "string" ? { why: o.why.slice(0, 100) } : {}),
    });
  }
  return out.length ? out : undefined;
}

export function sanitizeSouls(v: unknown): Soul[] | undefined {
  return Array.isArray(v) && v.length === 4 ? v.map((s, i) => sanitizeSoul(s, i)) : undefined;
}

/** Mid-round plan updates from a record or the live stream (#8, #10): tick, fighter, a sanitized plan, line and why; at most 64, in tick order. */
export function sanitizePlanUpdate(v: unknown): PlanUpdate | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const fighter = Number(o.fighter);
  const tick = Number(o.tick);
  if (!Number.isInteger(fighter) || fighter < 0 || fighter > 3 || !Number.isInteger(tick) || tick < 0 || tick > 100000) return null;
  return sanitizeOneUpdate(o, tick, fighter);
}

function sanitizeOneUpdate(o: Record<string, unknown>, tick: number, fighter: number): PlanUpdate {
  const d = sanitizeDecision({ line: o.line, strategy: o.strategy }, fighter);
  return {
    tick,
    fighter,
    strategy: d.strategy,
    ...(typeof o.line === "string" && d.line ? { line: d.line.slice(0, 120) } : {}),
    ...(typeof o.why === "string" && o.why.trim() ? { why: o.why.trim().slice(0, 100) } : {}),
    ...(o.source === "checkin" ? { source: "checkin" as const } : {}),
  };
}

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
    out.push(sanitizeOneUpdate(o, tick, fighter));
  }
  return out.sort((a, b) => a.tick - b.tick || a.fighter - b.fighter);
}

/** Rules are part of untrusted record and live-stream data. */
export function sanitizeRuleset(raw: unknown): Ruleset | null {
  try { return resolveRuleset(raw); } catch { return null; }
}

/** Sanitize a whole match record (replay files are untrusted). null unless it is a match record. */
export function sanitizeRecord(rec: unknown): MatchRecord | null {
  const r = rec as MatchRecord;
  if (!r || typeof r !== "object" || !Number.isFinite(r.seed) || !Array.isArray(r.rounds)) return null;
  const ruleset = sanitizeRuleset(r.ruleset);
  if (!ruleset || r.rounds.length > ruleset.round.maxRounds) return null;
  const souls = sanitizeSouls(r.souls);
  if (!souls) return null;
  const identities = sanitizeIdentities(r.identities, Number(r.seed) >>> 0);
  if (!identities) return null;
  return {
    ...r,
    ruleset,
    preset: typeof r.preset === "string" ? r.preset.slice(0, 64) : undefined,
    presetVersion: Number.isInteger(r.presetVersion) && (r.presetVersion ?? 0) > 0 ? r.presetVersion : undefined,
    seed: Number(r.seed) >>> 0,
    souls,
    identities,
    suitUp: sanitizeSuitUp(r.suitUp),
    entrances: sanitizeEntrances(r.entrances, Number(r.seed) >>> 0),
    rounds: r.rounds.map((rd) => {
      const ds = [0, 1, 2, 3].map((i) => sanitizeDecision({ line: rd.lines?.[i], strategy: rd.strategies?.[i] }, i));
      const meta = Array.isArray(rd.meta) ? rd.meta.slice(0, 4).map((m) => ({ provider: String(m?.provider ?? "?").slice(0, 40), ms: Number(m?.ms) || 0, outcome: ["ok", "fallback-timeout", "fallback-invalid", "fallback-error", "house"].includes(m?.outcome) ? m.outcome : "house", ...(typeof m?.aiLine === "string" ? { aiLine: m.aiLine.slice(0, 200) } : {}), ...(typeof m?.why === "string" ? { why: m.why.slice(0, 100) } : {}), ...(Array.isArray(m?.factWarnings) ? { factWarnings: m.factWarnings.slice(0, 4).map((w: unknown) => String(w).slice(0, 200)) } : {}), ...(m?.hedged === true ? { hedged: true } : {}), ...(Array.isArray(m?.ruleProblems) ? { ruleProblems: m.ruleProblems.slice(0, 8).map((w: unknown) => String(w).slice(0, 200)) } : {}) })) : undefined;
      const planUpdates = sanitizePlanUpdates((rd as { planUpdates?: unknown }).planUpdates);
      // the sim replays planUpdates; the fight's own copy of them is not trusted (and not needed)
      const fight = rd.fight && typeof rd.fight === "object" ? { ...rd.fight, updates: [] } : rd.fight;
      return { ...rd, fight, strategies: ds.map((d) => d.strategy), lines: ds.map((d) => d.line), ...(meta ? { meta } : {}), ...(planUpdates.length ? { planUpdates } : { planUpdates: undefined }) };
    }),
  };
}
