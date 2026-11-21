/**
 * The crown (#65): the winner of an Arena round holds it and defends it in the next round. Pure rules, no storage.
 *
 * - Every played round's winner takes the crown. If the winner already held it, its streak goes up by one; else the
 *   streak starts again at 1. A round that failed changes nothing.
 * - A house bot can hold the crown (it is the one in that seat), but its reign is not recorded.
 * - `ranked` is the part of an agent's streak won in featured rounds (2 or more agents): streak records count only
 *   those. A house holder's is always 0.
 *   A warm-up win (one agent) keeps the crown and the streak, and adds nothing to `ranked`.
 * - The holder starts the next round with the crown mark (the seat it plays) and its streak. A holder that is not in
 *   the next round (it left, or an agent took the house bot's seat) defends nothing: the round's winner takes it.
 */
import type { RoundTier } from "./store";

export type CrownHolder = { kind: "agent"; name: string; owner: string } | { kind: "house"; seat: number };

export interface Crown {
  holder: CrownHolder;
  /** rounds won in a row */
  streak: number;
  /** of those, rounds with 2 or more agents (what streak records count) */
  ranked: number;
  /** the Arena round it last won */
  wonRound: number;
}

/** A played round as the crown needs it: who won it. */
export interface PlayedRound {
  arenaRound: number;
  tier: RoundTier;
  /** the winning seat */
  winner: number;
  /** the agent in the winning seat, null for a house bot */
  winnerName: string | null;
  winnerOwner: string | null;
}

/** Is `b` the same holder as `a`? Agents by name (names are bound to owners), house bots by seat. */
export function sameHolder(a: CrownHolder, b: CrownHolder): boolean {
  if (a.kind === "agent" && b.kind === "agent") return a.name.toLowerCase() === b.name.toLowerCase();
  return a.kind === "house" && b.kind === "house" && a.seat === b.seat;
}

/** The crown after a played round. */
export function nextCrown(prev: Crown | null, r: PlayedRound): Crown {
  const holder: CrownHolder = r.winnerName ? { kind: "agent", name: r.winnerName, owner: r.winnerOwner ?? "" } : { kind: "house", seat: r.winner };
  const kept = prev !== null && sameHolder(prev.holder, holder);
  return { holder: kept ? prev.holder : holder, streak: kept ? prev.streak + 1 : 1, ranked: (kept ? prev.ranked : 0) + (r.tier === "featured" && holder.kind === "agent" ? 1 : 0), wonRound: r.arenaRound };
}

/**
 * The seat the crown holder plays in a line-up (agent names per seat, null = house bot), or null: an agent holder
 * by its name, a house holder only while its seat is still a house bot's.
 */
export function crownSeat(c: Crown | null, lineup: readonly (string | null)[]): number | null {
  if (!c) return null;
  const h = c.holder;
  if (h.kind === "house") return lineup[h.seat] === null ? h.seat : null;
  const i = lineup.findIndex((n) => n !== null && n.toLowerCase() === h.name.toLowerCase());
  return i >= 0 ? i : null;
}
