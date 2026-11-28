import { formatSeconds } from "../format";
import type { DecisionMeta } from "../sim/match";
import type { RoundFacts } from "../sim/morale";

export function decisionTag(meta: DecisionMeta, compact = false): string {
  const time = compact && meta.outcome === "house" ? "" : ` ${formatSeconds(meta.ms)}`;
  const outcome = compact ? meta.outcome : meta.outcome.toUpperCase();
  const showOutcome = meta.outcome !== "ok" && !(compact && meta.outcome === "house");
  return meta.provider + time + (showOutcome ? ` ${outcome}${meta.detail ? ` (${meta.detail})` : ""}` : "");
}

export function knockoutText(k: RoundFacts["stats"]["kos"][number], names: string[], knockout = "knocked out"): string {
  const cause = k.cause === "ringout" ? "rung out" : knockout;
  const by = k.by >= 0 && k.by !== k.victim ? ` by ${names[k.by]}` : "";
  return `${names[k.victim]} ${cause}${by} (${k.weapon})`;
}
