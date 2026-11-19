/**
 * House bots: before the fight, each fighter picks one strategy for the whole
 * match { target preference, stance, two-weapon loadout } and says it out loud.
 * chooseStrategy() is the single slot an AI fills later; the controller stays.
 */
import type { Rng } from "./rng";
import type { Fighter, Stance, Strategy, TargetPref, Weapon } from "./sim";

type Plan = Omit<Strategy, "line">;

const PLANS: Record<Fighter["personality"], { plan: Plan; w: number }[]> = {
  aggressive: [
    { plan: { target: "nearest", stance: "rush", loadout: ["bat", "grapple"] }, w: 4 },
    { plan: { target: "rocket", stance: "rush", loadout: ["bat", "shotgun"] }, w: 3 },
    { plan: { target: "strongest", stance: "rush", loadout: ["shotgun", "grapple"] }, w: 2 },
    { plan: { target: "leader", stance: "rush", loadout: ["bat", "grenade"] }, w: 1 },
  ],
  sniper: [
    { plan: { target: "strongest", stance: "distance", loadout: ["rocket", "grapple"] }, w: 3 },
    { plan: { target: "shotgun", stance: "distance", loadout: ["rocket", "shotgun"] }, w: 2 },
    { plan: { target: "nearest", stance: "cover", loadout: ["rocket", "bat"] }, w: 2 },
    { plan: { target: "leader", stance: "distance", loadout: ["rocket", "grenade"] }, w: 1 },
  ],
  coward: [
    { plan: { target: "nearest", stance: "cover", loadout: ["grenade", "rocket"] }, w: 3 },
    { plan: { target: "weakest", stance: "item", loadout: ["rocket", "shotgun"] }, w: 2 },
    { plan: { target: "shotgun", stance: "cover", loadout: ["rocket", "grapple"] }, w: 2 },
    { plan: { target: "nearest", stance: "cover", loadout: ["shotgun", "grenade"] }, w: 1 },
  ],
  opportunist: [
    { plan: { target: "weakest", stance: "rush", loadout: ["grapple", "bat"] }, w: 3 },
    { plan: { target: "weakest", stance: "distance", loadout: ["rocket", "grapple"] }, w: 2 },
    { plan: { target: "leader", stance: "item", loadout: ["grenade", "shotgun"] }, w: 2 },
    { plan: { target: "weakest", stance: "item", loadout: ["rocket", "bat"] }, w: 1 },
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

const WPN: Record<Weapon, string> = { rocket: "rockets", shotgun: "my shotgun", bat: "the bat", grenade: "grenades", grapple: "the hook" };

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lineFor(p: Plan, rng: Rng): string {
  const t = rng.pick(TARGET_TEXT[p.target]);
  const [a, b] = p.loadout.map((w) => WPN[w]) as [string, string];
  const combo = p.loadout.includes("grapple") && p.loadout.includes("bat");
  const by: Record<Stance, string[]> = {
    rush: combo
      ? [`Hook ${t}, then the bat. Home run.`, `I reel in ${t} and swing for the fences.`, `Get over here, ${t}. Batter up.`]
      : [`I'm charging ${t} with ${a}.`, `Straight at ${t}. ${cap(a)} up close.`, `No plan. Find ${t}, then ${a}.`],
    distance: [`I'll hang back and send ${a} at ${t}.`, `Long range. ${cap(a)} for ${t}, ${b} if they get close.`, `Keep my distance, light up ${t}.`],
    cover: [`Behind cover, picking off ${t}.`, `I'll hide and pop ${t} with ${a}.`, `Walls first, then ${t}.`],
    item: [`Grab supplies, then hunt ${t}.`, `First the loot, then ${t}.`, `Every crate is mine. Then ${t}.`],
  };
  return rng.pick(by[p.stance]);
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
  return { ...plan, loadout: [plan.loadout[0], plan.loadout[1]], line: lineFor(plan, rng) };
}
