/**
 * "Suit up" (#19): before the match each AI fighter chooses its own name and look from the identity pools
 * (shape, eyes, color, major and minor mark) and gives an opening line. Remote agents choose the same way
 * with `look` (and `line`) at join; this module turns both into identity wishes and, once the identities
 * are settled, into the record's `suitUp` entries.
 *
 * - The providers are asked in parallel, each with its own deadline (capped by `deadlineMs`).
 * - Validation is assignIdentities' (src/sim/identity.ts): name rules, no near-duplicate names, no shared
 *   silhouette family or major mark, colors readable and OKLab-apart (a clash is nudged to the nearest free
 *   color). Unknown ids, and fields another seat took first (seat order), fall back to the seeded draw.
 * - A timeout, an error or an answer with nothing usable gives the seeded random identity, logged as a
 *   fallback. The settled identities and these entries go into the record: a replay needs no AI.
 */
import type { Soul } from "../sim/soul";
import { assignIdentitiesDetailed, type Identity, type IdentityWish, type WishNote } from "../sim/identity";
import type { SuitUpEntry } from "../sim/match";
import { CLASSIC, type Ruleset } from "../sim/ruleset";
import { lookOptionsText } from "./looks";
import { cleanLine, cleanWhy, jsonObjects } from "./parse";
import { soulText } from "./prompt";
import type { Provider } from "./providers";

/** Cap on a suit-up answer (the match waits for it). */
export const SUIT_UP_DEADLINE_MS = 30_000;
const FIELDS = ["name", "shape", "eyes", "color", "mark", "minor"] as const;

export interface SuitUpSeat {
  /** a built-in provider to ask (null: no AI suit-up for this seat) */
  provider: Provider | null;
  soul: Soul;
  /** a remote agent's look from its join (by: "agent") */
  agentLook?: IdentityWish | null;
  agentLine?: string | null;
}

/** One seat's answer before the identities are settled. */
export interface SuitUpAnswer {
  seat: number;
  by: "ai" | "agent";
  outcome: "answered" | "fallback-timeout" | "fallback-error" | "fallback-invalid";
  ms?: number;
  wish: IdentityWish;
  line?: string;
  why?: string;
  raw?: string;
}

export interface SuitUpResult {
  /** per seat (undefined: nothing asked) */
  wishes: (IdentityWish | undefined)[];
  /** the settled identities */
  identities: Identity[];
  /** the record's entries, one per seat that chose */
  entries: SuitUpEntry[];
  /** raw answers (logs) */
  answers: SuitUpAnswer[];
}

/** The suit-up prompt for one fighter. */
export function suitUpPrompt(soul: Soul, ruleset: Ruleset = CLASSIC): string {
  return [
    "Knockback suit-up. You are about to fight in Knockback, a cartoon physics brawler: four small robot fighters, best of 3 rounds. Before the match you choose your own fighter: its name and its look. Pick what fits who you are below: how you want rivals and the crowd to see you.",
    `WHO YOU ARE:\n${soulText(soul, ruleset)}`,
    `THE OPTIONS:\n${lookOptionsText()}`,
    'Reply ONLY with JSON: {"name": "...", "shape": "...", "eyes": "...", "color": "#rrggbb", "mark": "...", "minor": "...", "line": "your opening line, one in-character sentence the crowd sees before the match", "why": "a few words on why this look"}',
  ].join("\n\n");
}

/** A suit-up answer -> wish fields (strings and a color number), line and why. Pure. */
export function parseSuitUp(text: string): { wish: IdentityWish; line?: string; why?: string } | null {
  const objs = jsonObjects(text).filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o));
  const o = objs.find((x) => FIELDS.some((f) => f in x)) ?? null;
  if (!o) return null;
  const wish: IdentityWish = {};
  for (const f of FIELDS) {
    const v = o[f];
    if (v === undefined || v === null) continue;
    if (f === "color") {
      const c = typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? parseInt(v.trim().replace("#", ""), 16) : v;
      wish.color = c;
    } else wish[f] = typeof v === "string" ? v.trim().toLowerCase() : v;
  }
  if (typeof o.name === "string") wish.name = o.name.trim(); // keep the name's case
  const line = cleanLine(o.line) ?? undefined;
  const why = cleanWhy(o.why) ?? undefined;
  return { wish, ...(line ? { line } : {}), ...(why ? { why } : {}) };
}

/** Ask one provider, with a deadline. */
async function askOne(seat: number, s: SuitUpSeat, ruleset: Ruleset, capMs: number, signal?: AbortSignal): Promise<SuitUpAnswer> {
  const p = s.provider!;
  const ctl = new AbortController();
  const ms = Math.min(capMs, p.deadlineMs ?? capMs);
  const timer = setTimeout(() => ctl.abort(), ms);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const t0 = performance.now();
  try {
    const raw = await p.ask(suitUpPrompt(s.soul, ruleset), ctl.signal);
    const took = Math.round(performance.now() - t0);
    const parsed = parseSuitUp(raw);
    if (!parsed) return { seat, by: "ai", outcome: "fallback-invalid", ms: took, wish: {}, raw: raw.slice(0, 2000) };
    return { seat, by: "ai", outcome: "answered", ms: took, ...parsed, raw: raw.slice(0, 2000) };
  } catch {
    const took = Math.round(performance.now() - t0);
    return { seat, by: "ai", outcome: ctl.signal.aborted ? "fallback-timeout" : "fallback-error", ms: took, wish: {} };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Turn answers into the settled identities and the record's entries. Pure. */
export function settleSuitUp(seed: number, answers: SuitUpAnswer[], n = 4): SuitUpResult {
  const wishes: (IdentityWish | undefined)[] = Array.from({ length: n }, (_, i) => {
    const a = answers.find((x) => x.seat === i);
    return a && Object.keys(a.wish).length ? a.wish : undefined;
  });
  const { identities, notes } = assignIdentitiesDetailed(seed, wishes, n);
  const entries = answers
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((a): SuitUpEntry => {
      const note: WishNote = notes[a.seat] ?? { kept: [], dropped: [] };
      const outcome: SuitUpEntry["outcome"] = a.outcome !== "answered" ? a.outcome : !note.kept.length ? "fallback-invalid" : note.dropped.length ? "partial" : "ok";
      return {
        seat: a.seat,
        by: a.by,
        outcome,
        ...(a.ms !== undefined ? { ms: a.ms } : {}),
        kept: note.kept.slice(),
        dropped: note.dropped.map((d) => ({ ...d })),
        ...(note.nudged ? { nudged: { ...note.nudged } } : {}),
        ...(a.line ? { line: a.line } : {}),
        ...(a.why ? { why: a.why } : {}),
      };
    });
  return { wishes, identities, entries, answers };
}

/**
 * The suit-up step: ask every seat with a provider (in parallel), take the agents' join looks, settle the
 * identities. Seats with neither keep the seeded identity and get no entry.
 */
export async function suitUp(seed: number, seats: SuitUpSeat[], opts: { ruleset?: Ruleset; deadlineMs?: number; signal?: AbortSignal; log?: (s: string) => void } = {}): Promise<SuitUpResult> {
  const ruleset = opts.ruleset ?? CLASSIC;
  const cap = opts.deadlineMs ?? SUIT_UP_DEADLINE_MS;
  const answers = await Promise.all(
    seats.map(async (s, seat): Promise<SuitUpAnswer | null> => {
      // an agent chose at join: its look (a join without a look keeps the seeded identity and gets no entry)
      if (s.agentLook && Object.keys(s.agentLook).length) return { seat, by: "agent", outcome: "answered", wish: { ...s.agentLook }, ...(s.agentLine ? { line: s.agentLine } : {}) };
      if (s.provider) return askOne(seat, s, ruleset, cap, opts.signal);
      return null;
    }),
  );
  const r = settleSuitUp(seed, answers.filter((a): a is SuitUpAnswer => a !== null), seats.length);
  for (const e of r.entries) {
    const id = r.identities[e.seat]!;
    opts.log?.(
      `suit up: seat ${e.seat} (${e.by}${seats[e.seat]!.provider ? ` ${seats[e.seat]!.provider!.label}` : ""}) ${e.outcome}${e.ms !== undefined ? ` in ${e.ms} ms` : ""}: ${id.name}, ${id.shape}, ${id.eyes} eyes, ${id.mark}${id.minor && id.minor !== "none" ? ` + ${id.minor}` : ""}, #${id.color.toString(16).padStart(6, "0")}` +
        `${e.dropped.length ? `; replaced ${e.dropped.map((d) => `${d.field} (${d.why})`).join(", ")}` : ""}${e.nudged ? `; color nudged from #${e.nudged.from.toString(16).padStart(6, "0")}` : ""}${e.why ? `; "${e.why}"` : ""}`,
    );
  }
  return r;
}
