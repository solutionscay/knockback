/**
 * House bots: before the fight, each fighter picks one strategy for the whole
 * match { target preference, weapon, stance } and says it out loud.
 * Later an AI replaces chooseStrategy(); the controller stays the same.
 */
import type { Rng } from "./rng";
import type { Fighter, Stance, Strategy, TargetPref, Weapon } from "./sim";

type Plan = Omit<Strategy, "line">;

const PLANS: Record<Fighter["personality"], { plan: Plan; w: number }[]> = {
  aggressive: [
    { plan: { target: "nearest", weapon: "shotgun", stance: "rush" }, w: 4 },
    { plan: { target: "rocket", weapon: "shotgun", stance: "rush" }, w: 3 },
    { plan: { target: "strongest", weapon: "shotgun", stance: "rush" }, w: 2 },
    { plan: { target: "leader", weapon: "shotgun", stance: "rush" }, w: 1 },
  ],
  sniper: [
    { plan: { target: "strongest", weapon: "rocket", stance: "distance" }, w: 3 },
    { plan: { target: "shotgun", weapon: "rocket", stance: "distance" }, w: 2 },
    { plan: { target: "nearest", weapon: "rocket", stance: "cover" }, w: 2 },
    { plan: { target: "leader", weapon: "rocket", stance: "distance" }, w: 1 },
  ],
  coward: [
    { plan: { target: "nearest", weapon: "rocket", stance: "cover" }, w: 3 },
    { plan: { target: "weakest", weapon: "rocket", stance: "item" }, w: 2 },
    { plan: { target: "shotgun", weapon: "rocket", stance: "cover" }, w: 2 },
    { plan: { target: "nearest", weapon: "shotgun", stance: "cover" }, w: 1 },
  ],
  opportunist: [
    { plan: { target: "weakest", weapon: "shotgun", stance: "rush" }, w: 3 },
    { plan: { target: "weakest", weapon: "rocket", stance: "distance" }, w: 2 },
    { plan: { target: "leader", weapon: "rocket", stance: "item" }, w: 2 },
    { plan: { target: "weakest", weapon: "grenade", stance: "item" }, w: 1 },
  ],
};

const TARGET_TEXT: Record<TargetPref, string[]> = {
  nearest: ["whoever is closest", "the first face I see", "anyone in arm's reach"],
  weakest: ["whoever is bleeding", "the weakest one", "anyone who's limping"],
  strongest: ["the toughest one here", "whoever has full health", "the big threat"],
  rocket: ["whoever has the rocket", "the rocket crowd", "anyone with a launcher"],
  shotgun: ["the shotgun crowd", "anyone holding a shotgun", "the close-range guys"],
  leader: ["whoever is winning", "the leader", "the scoreboard king"],
};

function lineFor(p: Plan, rng: Rng): string {
  const t = rng.pick(TARGET_TEXT[p.target]);
  const wpn: Record<Weapon, string> = { rocket: "rockets", shotgun: "my shotgun", grenade: "grenades" };
  const by: Record<Stance, string[]> = {
    rush: [`I'm charging ${t} with ${wpn[p.weapon]}.`, `Straight at ${t}. ${cap(wpn[p.weapon])} up close.`, `No plan. Just ${t} and ${wpn[p.weapon]}.`],
    distance: [`I'll hang back and send ${wpn[p.weapon]} at ${t}.`, `Long range. ${cap(t)} gets ${wpn[p.weapon]}.`, `Keep my distance, light up ${t}.`],
    cover: [`Behind cover, picking off ${t}.`, `I'll hide and pop ${t} with ${wpn[p.weapon]}.`, `Walls first, then ${t}.`],
    item: [`Grab supplies, then hunt ${t}.`, `First the loot, then ${t}.`, `Every crate is mine. Then ${t}.`],
  };
  return rng.pick(by[p.stance]);
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function chooseStrategy(me: Fighter, rng: Rng): Strategy {
  const opts = PLANS[me.personality];
  const total = opts.reduce((a, o) => a + o.w, 0);
  let r = rng.next() * total;
  let plan = opts[0]!.plan;
  for (const o of opts) {
    r -= o.w;
    if (r < 0) {
      plan = o.plan;
      break;
    }
  }
  return { ...plan, line: lineFor(plan, rng) };
}
