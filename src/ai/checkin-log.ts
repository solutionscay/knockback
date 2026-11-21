/**
 * Check-in reporting (#9): one line per plan change, and per-provider
 * numbers for the end of a match and the eval harness (answers, updates,
 * misses, latency, prompt size and an estimated token count).
 */
import type { CheckinMeta, MatchRecord } from "../sim/match";
import type { Strategy } from "../sim/sim-types";

const tgt = (s: Strategy, names: string[]) => (s.target === "grudge" && s.grudge !== undefined ? names[s.grudge]! : s.target);

/** "target Zapko->weakest, stance rush->cover" (only what changed). */
export function planChangeSummary(prev: Strategy, next: Strategy, names: string[]): string {
  const out: string[] = [];
  if (tgt(prev, names) !== tgt(next, names)) out.push(`target ${tgt(prev, names)}->${tgt(next, names)}`);
  if (prev.stance !== next.stance) out.push(`stance ${prev.stance}->${next.stance}`);
  if (prev.weapons.join(">") !== next.weapons.join(">")) out.push(`weapons ${prev.weapons.join(">")}->${next.weapons.join(">")}`);
  if ((prev.retaliate ?? "turn") !== (next.retaliate ?? "turn")) out.push(`retaliate ${prev.retaliate ?? "turn"}->${next.retaliate ?? "turn"}`);
  const pr = (prev.rules ?? []).map((r) => r.label).join("; ");
  const nr = (next.rules ?? []).map((r) => r.label).join("; ");
  if (pr !== nr) out.push(`rules [${nr || "none"}]`);
  return out.join(", ") || "no change";
}

/** Rough tokens from characters (about 4 characters a token for English and JSON). */
export const estTokens = (chars: number) => Math.round(chars / 4);

export interface CheckinStats {
  provider: string;
  asked: number;
  answered: number;
  updates: number;
  keeps: number;
  missed: number;
  invalid: number;
  errors: number;
  autopilot: number;
  /** answered check-ins: wall-clock answer time */
  avgMs: number;
  p50Ms: number;
  maxMs: number;
  /** answers that came in, of those asked */
  missRate: number;
  avgPromptChars: number;
  /** estimated tokens in and out, all check-ins */
  tokensIn: number;
  tokensOut: number;
}

/** Per-provider check-in numbers over one or more records. */
export function checkinStats(records: Pick<MatchRecord, "rounds">[], labelOf: (m: CheckinMeta) => string = (m) => m.provider): CheckinStats[] {
  const by = new Map<string, CheckinMeta[]>();
  for (const r of records) for (const rd of r.rounds) for (const c of rd.checkins ?? []) by.set(labelOf(c), [...(by.get(labelOf(c)) ?? []), c]);
  return [...by]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([provider, cs]) => {
      const answered = cs.filter((c) => c.outcome === "update" || c.outcome === "keep" || c.outcome === "invalid" || c.outcome === "late");
      const ms = answered.map((c) => c.ms).sort((a, b) => a - b);
      const n = (o: CheckinMeta["outcome"]) => cs.filter((c) => c.outcome === o).length;
      return {
        provider,
        asked: cs.length,
        answered: answered.length,
        updates: n("update"),
        keeps: n("keep"),
        missed: n("missed"),
        invalid: n("invalid"),
        errors: n("error"),
        autopilot: n("autopilot"),
        avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
        p50Ms: ms.length ? ms[Math.floor((ms.length - 1) / 2)]! : 0,
        maxMs: ms.length ? ms[ms.length - 1]! : 0,
        missRate: cs.length ? (cs.length - answered.length) / cs.length : 0,
        avgPromptChars: cs.length ? Math.round(cs.reduce((a, c) => a + (c.promptChars ?? 0), 0) / cs.length) : 0,
        tokensIn: estTokens(cs.reduce((a, c) => a + (c.promptChars ?? 0), 0)),
        tokensOut: estTokens(cs.reduce((a, c) => a + (c.answerChars ?? 0), 0)),
      };
    });
}

/** The match log's check-in summary. */
export function checkinSummaryLines(rec: Pick<MatchRecord, "rounds">, _labels?: string[]): string[] {
  const stats = checkinStats([rec]);
  const total = stats.reduce((a, s) => a + s.asked, 0);
  const ups = rec.rounds.map((r) => (r.planUpdates ?? []).length);
  const out = [`\nCheck-ins: ${total} extra calls, ${ups.reduce((a, b) => a + b, 0)} plan updates (by round: ${ups.join(", ")})`];
  for (const s of stats)
    out.push(
      `  ${s.provider.padEnd(18)} asked ${s.asked}, answered ${s.answered} (miss rate ${Math.round(s.missRate * 100)}%), updates ${s.updates}, keeps ${s.keeps}, invalid ${s.invalid}, errors ${s.errors}${s.autopilot ? `, autopilot ${s.autopilot}` : ""}; latency avg ${(s.avgMs / 1000).toFixed(1)} s, median ${(s.p50Ms / 1000).toFixed(1)} s, max ${(s.maxMs / 1000).toFixed(1)} s; prompt ${s.avgPromptChars} chars; ~${s.tokensIn} tokens in, ~${s.tokensOut} out`,
    );
  return out;
}
