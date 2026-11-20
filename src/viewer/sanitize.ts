/** Untrusted input (record files, the live stream) -> safe decisions. Pure: no DOM, no Pixi. */
import { CHARACTERS } from "../sim/characters";
import type { MatchRecord } from "../sim/match";
import type { Strategy } from "../sim/sim";
import type { Decision } from "../sim/voice";

const SAFE_WEAPONS = ["rocket", "shotgun", "bat", "grenade", "grapple"];
const SAFE_STANCES = ["rush", "distance", "cover", "item"];
const SAFE_TARGETS = ["nearest", "weakest", "strongest", "leader", "rocket", "shotgun", "grudge"];
const SAFE_RETALIATE = ["attacker", "turn", "ignore"];

/**
 * Decisions from a record file or the live stream are untrusted input: keep
 * only known values (anything else becomes the fighter's signature play) and
 * plain-string lines. Everything shown is escaped as well.
 */
export function sanitizeDecision(d: unknown, fighter: number): Decision {
  const sig = CHARACTERS[fighter]!.signature;
  const o = (d && typeof d === "object" ? d : {}) as { line?: unknown; strategy?: Record<string, unknown> };
  const s = (o.strategy && typeof o.strategy === "object" ? o.strategy : {}) as Record<string, unknown>;
  const lo = Array.isArray(s.loadout) && s.loadout.length === 2 && s.loadout.every((w) => SAFE_WEAPONS.includes(w as string)) && s.loadout[0] !== s.loadout[1] ? (s.loadout as [Strategy["loadout"][0], Strategy["loadout"][1]]) : sig.loadout;
  const target = SAFE_TARGETS.includes(s.target as string) ? (s.target as Strategy["target"]) : sig.target;
  const grudge = Number.isInteger(s.grudge) && (s.grudge as number) >= 0 && (s.grudge as number) < 4 && s.grudge !== fighter ? (s.grudge as number) : undefined;
  const strategy: Strategy = {
    target: target === "grudge" && grudge === undefined ? sig.target : target,
    ...(target === "grudge" && grudge !== undefined ? { grudge } : {}),
    stance: SAFE_STANCES.includes(s.stance as string) ? (s.stance as Strategy["stance"]) : sig.stance,
    loadout: [lo[0], lo[1]],
    retaliate: SAFE_RETALIATE.includes(s.retaliate as string) ? (s.retaliate as Strategy["retaliate"]) : "turn",
    line: "",
  };
  const line = typeof o.line === "string" ? o.line.slice(0, 200) : "";
  return { line, strategy: { ...strategy, line } };
}

/** Sanitize a whole match record (replay files are untrusted). */
export function sanitizeRecord(rec: unknown): MatchRecord | null {
  const r = rec as MatchRecord;
  if (!r || typeof r !== "object" || !Number.isFinite(r.seed) || !Array.isArray(r.rounds) || r.rounds.length > 3) return null;
  return {
    ...r,
    seed: Number(r.seed) >>> 0,
    rounds: r.rounds.map((rd) => {
      const ds = [0, 1, 2, 3].map((i) => sanitizeDecision({ line: rd.lines?.[i], strategy: rd.strategies?.[i] }, i));
      const meta = Array.isArray(rd.meta) ? rd.meta.slice(0, 4).map((m) => ({ provider: String(m?.provider ?? "?").slice(0, 40), ms: Number(m?.ms) || 0, outcome: ["ok", "fallback-timeout", "fallback-invalid", "fallback-error", "house"].includes(m?.outcome) ? m.outcome : "house", ...(typeof m?.aiLine === "string" ? { aiLine: m.aiLine.slice(0, 200) } : {}) })) : undefined;
      return { ...rd, strategies: ds.map((d) => d.strategy), lines: ds.map((d) => d.line), ...(meta ? { meta } : {}) };
    }),
  };
}

