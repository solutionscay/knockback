/** Seconds into the entrance beat: the bot waits, the agent drops, lands, shouts, kicks, the bot twinkles out, the agent steps into its seat. */
export const ENTRANCE_AT = { drop: 0.45, land: 0.9, shout: 1.0, kick: 1.55, twinkle: 2.75, step: 2.9 } as const;
export type EntranceStep = keyof typeof ENTRANCE_AT;

/** The steps passed going from `from` to `to` seconds into the beat (from < step time <= to). */
export function stepsBetween(from: number, to: number): EntranceStep[] {
  return (Object.keys(ENTRANCE_AT) as EntranceStep[]).filter((k) => from < ENTRANCE_AT[k] && ENTRANCE_AT[k] <= to);
}
