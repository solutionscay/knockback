/**
 * Default orders for a fight started without strategies (sandbox, tests,
 * benchmarks). Seat-neutral: every seat draws from the same plans, so no
 * seat has an identity. Matches use souls instead (voice.ts houseStrategy).
 */
import type { Rng } from "./rng";
import type { Strategy } from "./sim-types";

type Plan = Omit<Strategy, "line">;

export const NEUTRAL_PLANS: Plan[] = [
  { target: "nearest", stance: "rush", weapons: ["bat", "shotgun", "grapple"], retaliate: "turn" },
  { target: "strongest", stance: "distance", weapons: ["rocket", "grenade", "shotgun"], retaliate: "turn" },
  { target: "nearest", stance: "cover", weapons: ["grenade", "rocket", "shotgun"], retaliate: "turn" },
  { target: "weakest", stance: "rush", weapons: ["grapple", "bat", "shotgun"], retaliate: "turn" },
  { target: "leader", stance: "item", weapons: ["shotgun", "rocket", "grenade"], retaliate: "attacker" },
];

export function neutralStrategy(rng: Rng): Strategy {
  const p = NEUTRAL_PLANS[rng.int(0, NEUTRAL_PLANS.length - 1)]!;
  return { ...p, weapons: p.weapons.slice(), line: "" };
}
