/**
 * Ask all four fighters for { weapons, target, stance, retaliate, line } in
 * parallel, each with a deadline. A timeout, an error or junk falls back to
 * the house bot for that fighter (and is logged in the decision meta).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DecisionMeta, Match } from "../sim/match";
import { parseSoul, type Soul } from "../sim/soul";
import { EXAMPLE_SOUL_ORDER } from "../sim/souls";
import { houseBrain, type Decision } from "../sim/voice";
import { checkFactsFromStats, checkLine } from "./factcheck";
import { parseAnswer } from "./parse";
import { buildRoundPrompts } from "./prompt";
import { askHedged, PROVIDERS, type Provider } from "./providers";

export const DEFAULT_LINEUP = ["claude", "codex", "grok", "claude"];
export const DEFAULT_DEADLINE_MS = 20_000;

export interface Seat {
  providerName: string;
  provider: Provider | null; // null = house bot
  soul: Soul;
}

export interface LoadedSoul {
  file: string;
  soul: Soul;
  warnings: string[];
}

/**
 * Four souls from a folder (the example names first, then any other .md files
 * alphabetically) or from a comma-separated list of files. Invalid souls
 * (errors) stop the match with a clear message; warnings are reported.
 */
export function loadSouls(spec = "souls"): LoadedSoul[] {
  let files: string[];
  if (spec.includes(",") || spec.endsWith(".md")) files = spec.split(",").map((f) => f.trim()).filter(Boolean);
  else {
    if (!existsSync(spec) || !statSync(spec).isDirectory()) throw new Error(`souls folder not found: ${spec}`);
    const all = readdirSync(spec).filter((f) => f.endsWith(".md") && !f.startsWith("_") && f.toLowerCase() !== "readme.md");
    const ordered = [...EXAMPLE_SOUL_ORDER.map((n) => `${n}.md`).filter((f) => all.includes(f)), ...all.filter((f) => !EXAMPLE_SOUL_ORDER.includes(f.replace(/\.md$/, ""))).sort()];
    files = ordered.slice(0, 4).map((f) => join(spec, f));
  }
  if (files.length !== 4) throw new Error(`need 4 soul files, got ${files.length} from ${spec}`);
  const out = files.map((file, seat) => {
    const p = parseSoul(readFileSync(file, "utf8"), seat);
    if (p.errors.length) throw new Error(`soul ${basename(file)}: ${p.errors.join("; ")}`);
    return { file, soul: p.soul, warnings: p.warnings };
  });
  const names = out.map((o) => o.soul.name.toLowerCase());
  if (new Set(names).size !== 4) throw new Error(`soul names must be different: ${out.map((o) => o.soul.name).join(", ")}`);
  return out;
}

/**
 * "claude,codex,grok,claude" (by seat) or "pike=codex,goldie=house" (by soul
 * name or seat number 0-3) -> provider name per seat.
 */
export function parseLineup(spec: string | undefined, names: string[] = ["brick", "pike", "squeaks", "goldie"]): string[] {
  if (!spec) return DEFAULT_LINEUP.slice();
  const out = DEFAULT_LINEUP.slice();
  const parts = spec.split(",").map((s) => s.trim()).filter(Boolean);
  parts.forEach((p, i) => {
    const [k, v] = p.includes("=") ? (p.split("=") as [string, string]) : [String(i), p];
    const idx = /^\d$/.test(k) ? Number(k) : names.findIndex((n) => n.toLowerCase() === k.toLowerCase());
    if (idx < 0 || idx > 3) throw new Error(`unknown fighter "${k}" in --lineup`);
    out[idx] = v.toLowerCase();
  });
  for (const n of out) if (n !== "house" && !PROVIDERS[n]) throw new Error(`unknown provider "${n}" (known: ${Object.keys(PROVIDERS).join(", ")}, house)`);
  return out;
}

export function seatsFor(lineup: string[], souls: Soul[]): Seat[] {
  return lineup.map((name, i) => ({ providerName: name, provider: name === "house" ? null : PROVIDERS[name]!, soul: souls[i]! }));
}

export interface RoundAsk {
  decisions: Decision[];
  meta: DecisionMeta[];
  prompts: string[];
  raw: (string | null)[];
}

/** Ask every seat for the next round of `match`, in parallel. */
/**
 * `deadlineMs` overrides every provider's own deadline (the --deadline flag);
 * without it each provider uses its `deadlineMs` (or DEFAULT_DEADLINE_MS).
 */
export async function decideRound(match: Match, seats: Seat[], deadlineMs?: number): Promise<RoundAsk> {
  const ctxs = seats.map((_, me) => match.contextFor(me));
  const prompts = buildRoundPrompts(match, seats.map((s) => s.soul), ctxs, true);
  const results = await Promise.all(
    seats.map(async (seat, me) => {
      const started = performance.now();
      if (!seat.provider) return { raw: null, ms: 0, outcome: "house" as const, detail: undefined as string | undefined, hedged: false };
      const limit = deadlineMs ?? seat.provider.deadlineMs ?? DEFAULT_DEADLINE_MS;
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          ctl.abort();
          resolve("timeout");
        }, limit);
      });
      try {
        const got = await Promise.race([askHedged(seat.provider, prompts[me]!, ctl.signal), timeout]);
        const ms = Math.round(performance.now() - started);
        if (got === "timeout") return { raw: null, ms, outcome: "fallback-timeout" as const, detail: `no answer in ${limit / 1000} s`, hedged: !!seat.provider.hedgeAfterMs && ms >= seat.provider.hedgeAfterMs };
        return { raw: got.text, ms, outcome: "ok" as const, detail: undefined, hedged: got.hedged };
      } catch (e) {
        return { raw: null, ms: Math.round(performance.now() - started), outcome: "fallback-error" as const, detail: e instanceof Error ? e.message : String(e), hedged: false };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  // Fallbacks run in fighter order after all answers are in (house brain consumes shared rngs: keep order fixed).
  const decisions: Decision[] = [];
  const meta: DecisionMeta[] = [];
  results.forEach((r, me) => {
    const seat = seats[me]!;
    const label = seat.provider?.label ?? "house";
    if (r.outcome === "house") {
      decisions.push(houseBrain(ctxs[me]!));
      meta.push({ provider: "house", ms: 0, outcome: "house" });
      return;
    }
    if (r.outcome === "ok") {
      const p = parseAnswer(r.raw!, me, match.names);
      // post-check (#4): an accusation the last round's facts don't support is logged, never rejected
      const lastStats = match.facts[match.facts.length - 1]?.stats;
      const warn = p.line && lastStats ? checkLine(p.line, me, match.names, checkFactsFromStats(lastStats)).mismatches.map((x) => `${x.claim}; facts: ${x.facts}`) : [];
      const extra = { ...(r.hedged ? { hedged: true } : {}), ...(p.why ? { why: p.why } : {}), ...(warn.length ? { factWarnings: warn } : {}), ...(p.ruleProblems ? { ruleProblems: p.ruleProblems } : {}) };
      if (p.strategy && p.line) {
        decisions.push({ line: p.line, strategy: { ...p.strategy, line: p.line } });
        meta.push({ provider: label, ms: r.ms, outcome: "ok", ...extra });
        return;
      }
      const bot = houseBrain(ctxs[me]!);
      const line = p.line ?? bot.line;
      decisions.push({ line, strategy: { ...(p.strategy ?? bot.strategy), line } });
      meta.push({
        provider: label,
        ms: r.ms,
        outcome: "fallback-invalid",
        detail: p.strategy ? "no usable line" : `bad plan: ${p.problems.join(", ")}`,
        ...(p.line ? { aiLine: p.line } : {}),
        ...extra,
      });
      return;
    }
    const bot = houseBrain(ctxs[me]!);
    decisions.push(bot);
    meta.push({ provider: label, ms: r.ms, outcome: r.outcome, detail: r.detail, ...(r.hedged ? { hedged: true } : {}) });
  });
  return { decisions, meta, prompts, raw: results.map((r) => r.raw) };
}
