/**
 * Ask all four fighters for { loadout, target, stance, retaliate, line } in
 * parallel, each with a deadline. A timeout, an error or junk falls back to
 * the house bot for that fighter (and is logged in the decision meta).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CHARACTERS } from "../sim/characters";
import type { DecisionMeta, Match } from "../sim/match";
import { houseBrain, type Decision } from "../sim/voice";
import { parseAnswer } from "./parse";
import { buildPrompt } from "./prompt";
import { PROVIDERS, type Provider } from "./providers";

export const DEFAULT_LINEUP = ["claude", "codex", "grok", "claude"];
export const DEFAULT_DEADLINE_MS = 20_000;

export interface Seat {
  providerName: string;
  provider: Provider | null; // null = house bot
  soul: string;
}

/** Souls live in souls/<name>.md (brick, pike, squeaks, goldie). */
export function loadSouls(dir: string): string[] {
  return CHARACTERS.map((c) => {
    const p = join(dir, `${c.name.toLowerCase()}.md`);
    return existsSync(p) ? readFileSync(p, "utf8") : `${c.voice}\nCatchphrase: "${c.catchphrase}"`;
  });
}

/** "claude,codex,grok,claude" or "brick=claude,pike=codex,..." -> provider name per fighter. */
export function parseLineup(spec: string | undefined): string[] {
  if (!spec) return DEFAULT_LINEUP.slice();
  const out = DEFAULT_LINEUP.slice();
  const parts = spec.split(",").map((s) => s.trim()).filter(Boolean);
  parts.forEach((p, i) => {
    const [k, v] = p.includes("=") ? (p.split("=") as [string, string]) : [String(i), p];
    const idx = /^\d$/.test(k) ? Number(k) : CHARACTERS.findIndex((c) => c.name.toLowerCase() === k.toLowerCase() || c.title.toLowerCase().endsWith(k.toLowerCase()));
    if (idx < 0 || idx > 3) throw new Error(`unknown fighter "${k}" in --lineup`);
    out[idx] = v.toLowerCase();
  });
  for (const n of out) if (n !== "house" && !PROVIDERS[n]) throw new Error(`unknown provider "${n}" (known: ${Object.keys(PROVIDERS).join(", ")}, house)`);
  return out;
}

export function seatsFor(lineup: string[], souls: string[]): Seat[] {
  return lineup.map((name, i) => ({ providerName: name, provider: name === "house" ? null : PROVIDERS[name]!, soul: souls[i]! }));
}

export interface RoundAsk {
  decisions: Decision[];
  meta: DecisionMeta[];
  prompts: string[];
  raw: (string | null)[];
}

/** Ask every seat for the next round of `match`, in parallel. */
export async function decideRound(match: Match, seats: Seat[], deadlineMs = DEFAULT_DEADLINE_MS): Promise<RoundAsk> {
  const prevRound = match.record.rounds[match.record.rounds.length - 1];
  const lastLines = prevRound ? prevRound.lines : null;
  const lastHealth = match.facts.length ? match.facts[match.facts.length - 1]!.fighters.map((f) => f.hpEnd) : null;
  const ctxs = seats.map((_, me) => match.contextFor(me));
  const prompts = seats.map((s, me) => buildPrompt(s.soul, ctxs[me]!, { level: match.level, lastLines, lastHealth }));
  const results = await Promise.all(
    seats.map(async (seat, me) => {
      const started = performance.now();
      if (!seat.provider) return { raw: null, ms: 0, outcome: "house" as const, detail: undefined as string | undefined };
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          ctl.abort();
          resolve("timeout");
        }, deadlineMs);
      });
      try {
        const got = await Promise.race([seat.provider.ask(prompts[me]!, ctl.signal), timeout]);
        const ms = Math.round(performance.now() - started);
        if (got === "timeout") return { raw: null, ms, outcome: "fallback-timeout" as const, detail: `no answer in ${deadlineMs / 1000} s` };
        return { raw: got, ms, outcome: "ok" as const, detail: undefined };
      } catch (e) {
        return { raw: null, ms: Math.round(performance.now() - started), outcome: "fallback-error" as const, detail: e instanceof Error ? e.message : String(e) };
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
      const p = parseAnswer(r.raw!, me);
      if (p.strategy && p.line) {
        decisions.push({ line: p.line, strategy: { ...p.strategy, line: p.line } });
        meta.push({ provider: label, ms: r.ms, outcome: "ok" });
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
      });
      return;
    }
    const bot = houseBrain(ctxs[me]!);
    decisions.push(bot);
    meta.push({ provider: label, ms: r.ms, outcome: r.outcome, detail: r.detail });
  });
  return { decisions, meta, prompts, raw: results.map((r) => r.raw) };
}
