/**
 * The Arena entrance (#66): an agent that takes a seat drops in at the intro of the round it enters, shouts its
 * entrance line and kicks out the house bot that held the seat. The entrance is an intro beat in the viewer: the sim
 * starts the round with the agent's fighter in its seat, so the fight stays deterministic.
 *
 * The entry boost: in that round the agent's fighter starts with a shield and a damage boost, if the round has at
 * least one house bot (an agent that enters a round of 4 agents gets none). The boost is part of the fight record
 * (start powers per seat), so a replay is exact.
 */
import { TICK_RATE } from "./constants";
import type { Identity } from "./identity";
import type { Soul } from "./soul";
import type { PowerUp } from "./sim-types";

/** What an entering agent shouts when its soul has no `entrance` line. */
export const ENTRANCE_SHOUT = "GET OUT OF HERE!";
/** An entrance line is a shout: at most this many characters. */
export const ENTRANCE_LINE_MAX = 60;
/** The entry boost: these power-ups, for this long, from the first tick. */
export const ENTRY_BOOST = { powers: ["shield", "damage"] as const, ticks: 10 * TICK_RATE };

/** Power-ups that run on a timer (a start power is one of them). */
export const TIMED_POWERS = ["shield", "speed", "heavy", "damage", "jump"] as const satisfies readonly PowerUp[];
export type TimedPower = (typeof TIMED_POWERS)[number];

/** A power-up a fighter has from the first tick of a fight, for `ticks` ticks (the timer of a picked-up one). */
export interface StartPower {
  fighter: number;
  power: TimedPower;
  ticks: number;
}

/** One agent's entrance in the round it enters. */
export interface Entrance {
  seat: number;
  /** what it shouts as it lands */
  line: string;
  /** the house bot it kicks out: as the viewers last saw it in that seat. Absent: the seat was another agent's */
  evicted?: Identity;
}

/** The entry boost of a round: shield and damage for each entering seat, if any seat is a house bot's. */
export function entryBoost(entering: readonly number[], kinds: readonly ("remote" | "house")[]): StartPower[] {
  if (!kinds.includes("house")) return [];
  return [...new Set(entering)].sort((a, b) => a - b).flatMap((fighter) => ENTRY_BOOST.powers.map((power) => ({ fighter, power, ticks: ENTRY_BOOST.ticks })));
}

/**
 * The entrance line: one of the soul's `entrance` lines (picked by the seed, `{me}` filled in), else ENTRANCE_SHOUT.
 * Capped at ENTRANCE_LINE_MAX characters.
 */
export function entranceLine(soul: Pick<Soul, "lines">, name: string, seed: number): string {
  const own = soul.lines.filter((l) => l[0] === "entrance").map((l) => l[2].replaceAll("{me}", name).replaceAll("{ME}", name.toUpperCase()).trim()).filter(Boolean);
  const line = own.length ? own[(seed >>> 0) % own.length]! : ENTRANCE_SHOUT;
  return line.length > ENTRANCE_LINE_MAX ? `${line.slice(0, ENTRANCE_LINE_MAX - 1).trimEnd()}…` : line;
}
