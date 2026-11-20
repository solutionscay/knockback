/** Untrusted input (record files, the live stream) -> safe decisions and souls. Pure: no DOM, no Pixi. */
import type { MatchRecord } from "../sim/match";
import type { Strategy } from "../sim/sim";
import { SEAT_COLORS, type LineTemplate, type Soul } from "../sim/soul";
import type { Decision } from "../sim/voice";

const SAFE_WEAPONS = ["rocket", "shotgun", "bat", "grenade", "grapple"];
const SAFE_STANCES = ["rush", "distance", "cover", "item"];
const SAFE_TARGETS = ["nearest", "weakest", "strongest", "leader", "rocket", "shotgun", "grudge"];
const SAFE_RETALIATE = ["attacker", "turn", "ignore"];
const SAFE_TEMPER = ["cocky", "confident", "calm", "nervous"];
const SAFE_VOICE = ["brash", "smug", "nervous", "sly", "plain"];
const SAFE_MARK = ["headband", "antenna", "ears", "crown", "none"];
const SAFE_STATES = ["cocky", "confident", "rattled", "furious", "desperate"];

const str = (v: unknown, max: number, def = "") => (typeof v === "string" ? v.slice(0, max) : def);
const oneOf = <T extends string>(v: unknown, list: string[], def: T): T => (list.includes(v as string) ? (v as T) : def);

/**
 * Decisions from a record file or the live stream are untrusted input: keep
 * only known values (anything else becomes a plain default) and plain-string
 * lines. Everything shown is escaped as well.
 */
export function sanitizeDecision(d: unknown, fighter: number): Decision {
  const o = (d && typeof d === "object" ? d : {}) as { line?: unknown; strategy?: Record<string, unknown> };
  const s = (o.strategy && typeof o.strategy === "object" ? o.strategy : {}) as Record<string, unknown>;
  const raw = Array.isArray(s.weapons) ? s.weapons : [];
  const weapons = raw.filter((w, i) => SAFE_WEAPONS.includes(w as string) && raw.indexOf(w) === i).slice(0, 3) as Strategy["weapons"];
  const target = oneOf<Strategy["target"]>(s.target, SAFE_TARGETS, "nearest");
  const grudge = Number.isInteger(s.grudge) && (s.grudge as number) >= 0 && (s.grudge as number) < 4 && s.grudge !== fighter ? (s.grudge as number) : undefined;
  const strategy: Strategy = {
    target: target === "grudge" && grudge === undefined ? "nearest" : target,
    ...(target === "grudge" && grudge !== undefined ? { grudge } : {}),
    stance: oneOf<Strategy["stance"]>(s.stance, SAFE_STANCES, "rush"),
    weapons: weapons.length ? weapons : ["shotgun", "rocket"],
    retaliate: oneOf<NonNullable<Strategy["retaliate"]>>(s.retaliate, SAFE_RETALIATE, "turn"),
    line: "",
  };
  const line = str(o.line, 200);
  return { line, strategy: { ...strategy, line } };
}

/** A soul from a record or the stream: known values only, strings clipped. */
export function sanitizeSoul(v: unknown, seat: number): Soul {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const color = Number.isInteger(o.color) && (o.color as number) >= 0 && (o.color as number) <= 0xffffff ? (o.color as number) : SEAT_COLORS[seat % 4]!;
  const lines: LineTemplate[] = (Array.isArray(o.lines) ? o.lines : []).slice(0, 120).flatMap((l): LineTemplate[] => {
    if (!Array.isArray(l) || typeof l[0] !== "string" || typeof l[2] !== "string") return [];
    const st = l[1] === "*" ? "*" : Array.isArray(l[1]) ? (l[1].filter((x) => SAFE_STATES.includes(x)) as LineTemplate[1]) : "*";
    return [[l[0].slice(0, 20), st === "*" || st.length ? st : "*", l[2].slice(0, 200)]];
  });
  const ws = (Array.isArray(o.weapons) ? o.weapons : []).filter((w) => SAFE_WEAPONS.includes(w as string)).slice(0, 3) as Soul["weapons"];
  return {
    name: str(o.name, 16).trim() || `Fighter ${seat + 1}`,
    title: str(o.title, 32),
    color,
    temperament: oneOf(o.temperament, SAFE_TEMPER, "confident"),
    voice: oneOf(o.voice, SAFE_VOICE, "plain"),
    values: (Array.isArray(o.values) ? o.values : []).filter((x) => typeof x === "string").slice(0, 8).map((x) => (x as string).slice(0, 80)),
    weapons: ws.length ? ws : ["shotgun", "rocket"],
    stance: oneOf(o.stance, SAFE_STANCES, "rush"),
    target: oneOf(o.target, SAFE_TARGETS.filter((t) => t !== "grudge"), "nearest"),
    retaliate: oneOf(o.retaliate, SAFE_RETALIATE, "turn"),
    catchphrase: str(o.catchphrase, 80),
    mark: oneOf(o.mark, SAFE_MARK, "none"),
    body: str(o.body, 4000),
    lines,
  };
}

export function sanitizeSouls(v: unknown): Soul[] | undefined {
  return Array.isArray(v) && v.length === 4 ? v.map((s, i) => sanitizeSoul(s, i)) : undefined;
}

/** Sanitize a whole match record (replay files are untrusted). */
export function sanitizeRecord(rec: unknown): MatchRecord | null {
  const r = rec as MatchRecord;
  if (!r || typeof r !== "object" || !Number.isFinite(r.seed) || !Array.isArray(r.rounds) || r.rounds.length > 3) return null;
  const souls = sanitizeSouls(r.souls);
  if (!souls) return null;
  return {
    ...r,
    version: 2,
    seed: Number(r.seed) >>> 0,
    souls,
    rounds: r.rounds.map((rd) => {
      const ds = [0, 1, 2, 3].map((i) => sanitizeDecision({ line: rd.lines?.[i], strategy: rd.strategies?.[i] }, i));
      const meta = Array.isArray(rd.meta) ? rd.meta.slice(0, 4).map((m) => ({ provider: String(m?.provider ?? "?").slice(0, 40), ms: Number(m?.ms) || 0, outcome: ["ok", "fallback-timeout", "fallback-invalid", "fallback-error", "house"].includes(m?.outcome) ? m.outcome : "house", ...(typeof m?.aiLine === "string" ? { aiLine: m.aiLine.slice(0, 200) } : {}), ...(Array.isArray(m?.factWarnings) ? { factWarnings: m.factWarnings.slice(0, 4).map((w: unknown) => String(w).slice(0, 200)) } : {}) })) : undefined;
      return { ...rd, strategies: ds.map((d) => d.strategy), lines: ds.map((d) => d.line), ...(meta ? { meta } : {}) };
    }),
  };
}
