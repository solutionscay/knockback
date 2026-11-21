/**
 * The Arena entrance (#66): an agent that takes a seat drops in at the intro of the round it enters, shouts its
 * entrance line and kicks out the house bot that held the seat. The entrance is an intro beat in the viewer: the sim
 * starts the round with the agent's fighter in its seat, so the fight stays deterministic.
 */
import type { Identity } from "./identity";
import type { Soul } from "./soul";

/** What an entering agent shouts when its soul has no `entrance` line. */
export const ENTRANCE_SHOUT = "GET OUT OF HERE!";
/** An entrance line is a shout: at most this many characters. */
export const ENTRANCE_LINE_MAX = 60;

/** One agent's entrance in the round it enters. */
export interface Entrance {
  seat: number;
  /** what it shouts as it lands */
  line: string;
  /** the house bot it kicks out: as the viewers last saw it in that seat. Absent: the seat was another agent's */
  evicted?: Identity;
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
