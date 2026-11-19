/**
 * The decision slot: one function per fighter, called before each round
 * (the intro for round 1, the between-round dialogue after that). Given the
 * match state it returns what the fighter says and its strategy for the next
 * round. This is exactly where AI agents plug in: pass your own `Brain` per
 * fighter to `new Match(seed, { brains })`.
 *
 * houseBrain is the built-in version: lines from the character's template bank
 * (characters.ts) chosen by what actually happened, never repeated within a
 * session; strategy from the character's signature and current morale.
 */
import { CHARACTERS, type LineTemplate } from "./characters";
import type { Morale, MoraleState, RoundFacts } from "./morale";
import type { Rng } from "./rng";
import type { Strategy, Weapon } from "./sim";

export interface DecideContext {
  /** "intro" before round 1, "between" after a round */
  phase: "intro" | "between";
  /** the round about to be played (1..3) */
  round: number;
  me: number;
  names: string[];
  /** round wins so far, per fighter */
  wins: number[];
  morale: Morale[];
  /** facts of the round just played (null before round 1) */
  last: RoundFacts | null;
  history: RoundFacts[];
  /** session memory (avoid repeating lines across matches) */
  session: VoiceSession;
  /** randomness for line choice (the house brain keeps strategy choice separate) */
  lineRng: Rng;
  strategyRng: Rng;
}

export interface Decision {
  line: string;
  strategy: Strategy;
  /** which template was used (house brain), for no-repeat bookkeeping and tests */
  lineId?: string;
}

export type Brain = (ctx: DecideContext) => Decision;

export class VoiceSession {
  used = new Set<string>();
}

const WEAPON_PHRASE: Record<string, string> = {
  rocket: "a rocket",
  shotgun: "a shotgun blast",
  bat: "the bat",
  grenade: "a grenade",
  grapple: "the hook",
  barrel: "a barrel",
  tnt: "the TNT",
  gas: "a gas can",
  crush: "falling junk",
  impact: "a wall",
  fall: "gravity",
  zone: "the zone",
  unknown: "something",
};

/** Contexts that apply to this fighter now, most specific first. */
export function contextsFor(ctx: DecideContext): string[] {
  if (ctx.phase === "intro") return ["intro", "state"];
  const out: string[] = [];
  const f = ctx.last?.fighters[ctx.me];
  if (f) {
    const humMap: Record<string, string> = { "own-explosive": "hum:own", "bat-ringout": "hum:bat", "hook-ringout": "hum:hook", crushed: "hum:crush", barrel: "hum:barrel" };
    for (const h of f.humiliations) out.push(humMap[h.kind]!);
    if (f.won) {
      if (ctx.morale[ctx.me]!.comeback) out.push("win:comeback");
      if (f.kosDealt.length >= 2) out.push("win:multi");
      if (f.hpEnd >= 70) out.push("win:flawless");
      out.push("win");
    }
    if (f.koBy && f.koBy.by >= 0 && f.koBy.by !== ctx.me) out.push("kod");
    if (!f.won && f.kosDealt.length >= 2) out.push("multi");
    if (f.kosDealt.length) out.push("ko");
    if (!f.won && f.survived) out.push("survived");
  }
  const mine = ctx.wins[ctx.me]!;
  const best = Math.max(...ctx.wins.filter((_, i) => i !== ctx.me));
  if (ctx.round === 3) out.push("decider");
  if (mine === 1 && ctx.round <= 3) out.push("mp:for");
  if (best >= 1 && mine === 0) out.push("mp:against");
  out.push("state");
  return out;
}

function fill(text: string, ctx: DecideContext, strategy: Strategy): string | null {
  const f = ctx.last?.fighters[ctx.me];
  const name = (i: number | undefined) => (i !== undefined && i >= 0 ? ctx.names[i] : undefined);
  const leader = ctx.wins.indexOf(Math.max(...ctx.wins));
  const winner = ctx.last ? name(ctx.last.winner) : name(leader);
  const killer = f?.koBy ? name(f.koBy.by) : f?.humiliations.find((h) => h.by >= 0 && h.by !== ctx.me) ? name(f!.humiliations.find((h) => h.by >= 0 && h.by !== ctx.me)!.by) : undefined;
  const vals: Record<string, string | undefined> = {
    me: ctx.names[ctx.me],
    killer,
    victim: f?.kosDealt.length ? name(f.kosDealt[f.kosDealt.length - 1]!.victim) : undefined,
    weapon: f?.koBy ? WEAPON_PHRASE[f.koBy.weapon] ?? f.koBy.weapon : f?.kosDealt.length ? WEAPON_PHRASE[f.kosDealt[f.kosDealt.length - 1]!.weapon] : undefined,
    winner: ctx.wins.some((w) => w > 0) ? name(ctx.wins.indexOf(Math.max(...ctx.wins))) : winner,
    grudge: name(ctx.morale[ctx.me]!.grudge),
    target: strategy.target === "grudge" ? name(strategy.grudge) : undefined,
    score: ctx.wins.join("-"),
    round: String(ctx.round),
  };
  let missing = false;
  const out = text.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vals[k];
    if (v === undefined) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

/** Pick a line: first context with an unused template that fits morale and the facts. */
export function pickLine(ctx: DecideContext, strategy: Strategy): { line: string; id: string } {
  const ch = CHARACTERS[ctx.me]!;
  const state: MoraleState = ctx.morale[ctx.me]!.state;
  const all = ch.lines.map((t, i) => ({ t, id: `${ch.name}:${i}` }));
  const fits = (t: LineTemplate) => t[1] === "*" || t[1].includes(state);
  const tryCtx = (c: string, allowUsed: boolean) => {
    const cands = all.filter(({ t, id }) => t[0] === c && fits(t) && (allowUsed || !ctx.session.used.has(id)));
    const filled = cands.map((x) => ({ ...x, text: fill(x.t[2], ctx, strategy) })).filter((x) => x.text !== null);
    if (!filled.length) return null;
    // state-specific templates first, then any; random among the best
    const specific = filled.filter((x) => x.t[1] !== "*");
    const pool = specific.length && ctx.lineRng.chance(0.6) ? specific : filled;
    return pool[ctx.lineRng.u32() % pool.length]!;
  };
  const ctxs = contextsFor(ctx);
  for (const c of ctxs) {
    const got = tryCtx(c, false);
    if (got) return { line: got.text!, id: got.id };
  }
  // everything relevant already used this session: allow repeats, best context first
  for (const c of ctxs) {
    const got = tryCtx(c, true);
    if (got) return { line: got.text!, id: got.id };
  }
  return { line: ch.catchphrase, id: `${ch.name}:catchphrase` };
}

/** The house strategy: signature play, bent by morale. */
export function houseStrategy(ctx: DecideContext): Strategy {
  const ch = CHARACTERS[ctx.me]!;
  const m = ctx.morale[ctx.me]!;
  const sig = ch.signature;
  let loadout: [Weapon, Weapon] = [sig.loadout[0], sig.loadout[1]];
  let stance = sig.stance;
  let target = sig.target;
  let grudge: number | undefined;
  const leader = ctx.wins.indexOf(Math.max(...ctx.wins));
  const someoneLeads = Math.max(...ctx.wins) > 0 && leader !== ctx.me;
  switch (m.state) {
    case "furious":
      if (m.grudge >= 0 && m.grudge !== ctx.me) {
        target = "grudge";
        grudge = m.grudge;
      }
      if (stance === "distance" || stance === "cover") stance = ctx.strategyRng.chance(0.5) ? "rush" : stance;
      break;
    case "desperate":
      if (someoneLeads) {
        target = "grudge";
        grudge = leader;
      }
      if (ch.personality === "coward" || ch.personality === "opportunist") stance = "item";
      break;
    case "rattled":
      if (stance === "distance") stance = "cover";
      if (ch.personality === "aggressive") target = "weakest";
      break;
    case "cocky":
      if (ch.personality === "coward") stance = "rush"; // what could go wrong
      else if (someoneLeads) {
        target = "grudge";
        grudge = leader;
      } else target = "strongest";
      break;
    case "confident":
      break;
  }
  if (ch.personality === "sniper" && m.state === "furious") loadout = ["rocket", "grapple"];
  return { target, grudge, stance, loadout, line: "" };
}

export const houseBrain: Brain = (ctx) => {
  const strategy = houseStrategy(ctx);
  const { line, id } = pickLine(ctx, strategy);
  ctx.session.used.add(id);
  return { line, strategy: { ...strategy, line }, lineId: id };
};
