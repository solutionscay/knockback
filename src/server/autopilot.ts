/**
 * Autopilot callouts (#22): what spectators see when an agent drops and the
 * house bot takes its fighter, and when the agent comes back. The line picked
 * is stored with the control event, so a replay shows the same one.
 */
import { randomInt } from "node:crypto";

export const AUTOPILOT_LINES = [
  "{name}'s agent left. Too scared.",
  "{name}'s brain went to get milk. Autopilot engaged.",
  "{name} rage-quit. The house bot is driving now.",
  "Connection lost. {name} is running on vibes.",
  "{name}'s agent stepped out. Please hold.",
  "{name} is buffering. The house bot takes the wheel.",
  "{name}'s agent missed the bell. Autopilot on.",
  "{name} went quiet. A bot is doing an impression.",
] as const;

export const BACK_LINES = [
  "{name}'s agent is back. Probably hiding behind the barrels.",
  "{name}'s brain is back from the store. Hope it got the milk.",
  "{name} rebooted. Control restored.",
  "{name} is back in charge. The house bot says it was winning.",
  "{name}'s agent found the controller again.",
] as const;

/** Lines for when the agent itself chose to leave. */
export const LEFT_LINES = ["{name}'s agent left. Too scared.", "{name} walked out. The house bot finishes the job.", "{name}'s agent clocked out early."] as const;

export function pickLine(lines: readonly string[], name: string, pick: (n: number) => number = randomInt): string {
  return lines[pick(lines.length)]!.replaceAll("{name}", name);
}
