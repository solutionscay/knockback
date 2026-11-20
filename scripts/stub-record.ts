/**
 * A stub match record for viewer work on plan updates and rule firings
 * (#10, #11): a house-bot match (house bots carry rules) with many mid-round
 * plan updates injected into round 1 (the engine does not apply them yet;
 * check-ins come with #8/#9). Writes records/stub-plan-updates.json.
 *   bun scripts/stub-record.ts [seed=5] [updates=14]
 *   then: bun run dev, open /?record=/records/stub-plan-updates.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { initPhysics, Match, type PlanUpdate, type Strategy } from "../src/sim";

const seed = Number(process.argv[2] ?? 5);
const n = Number(process.argv[3] ?? 14);
await initPhysics();
const m = new Match(seed);
m.playToEnd();
const rec = JSON.parse(JSON.stringify(m.record));
const r1 = rec.rounds[0];
const len = r1.fight.ticks as number;
const targets: Strategy["target"][] = ["weakest", "strongest", "leader", "nearest"];
const stances: Strategy["stance"][] = ["rush", "distance", "cover", "item"];
const lines = ["Change of plan!", "Now you're mine.", "Time to hide.", "Grab that rocket!", ""];
const updates: PlanUpdate[] = [];
for (let k = 0; k < n; k++) {
  const fighter = k % 4;
  const base: Strategy = r1.strategies[fighter];
  // bursts: several updates land close together, to test the clutter limits
  const tick = Math.min(len - 30, 240 + Math.floor(k / 4) * 420 + (k % 4) * 20);
  const strategy: Strategy = k % 3 === 0 ? { ...base, target: "grudge", grudge: (fighter + 1 + (k % 3)) % 4 } : k % 3 === 1 ? { ...base, stance: stances[k % 4]! } : { ...base, target: targets[k % 4]! };
  if (strategy.target === "grudge" && strategy.grudge === fighter) strategy.grudge = (fighter + 1) % 4;
  updates.push({ tick, fighter, strategy, ...(lines[k % lines.length] ? { line: lines[k % lines.length] } : {}) });
}
r1.planUpdates = updates;
mkdirSync("records", { recursive: true });
writeFileSync("records/stub-plan-updates.json", JSON.stringify({ ...rec, labels: ["house", "house", "house", "house"] }, null, 2));
const rules = rec.rounds.map((r: { strategies: Strategy[] }) => r.strategies.map((s) => s.rules?.length ?? 0).join("/"));
console.log(`records/stub-plan-updates.json: seed ${seed}, ${updates.length} plan updates in round 1 (ticks ${updates[0]!.tick}-${updates[updates.length - 1]!.tick} of ${len}); rules per fighter by round: ${rules.join(" | ")}`);
