/**
 * A stub match record for viewer work on plan updates and rule firings
 * (#10, #11) and for checking mid-round updates (#8): a house-bot match
 * (house bots carry rules) with many plan updates added to round 1 while it
 * is played, so the sim applies them and the record replays exactly.
 * Writes records/stub-plan-updates.json.
 *   bun scripts/stub-record.ts [seed=5] [updates=14]
 *   then: bun run dev, open /?record=/records/stub-plan-updates.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { initPhysics, Match, type PlanUpdate, type Strategy } from "../src/sim";

const seed = Number(process.argv[2] ?? 5);
const n = Number(process.argv[3] ?? 14);
await initPhysics();
const m = new Match(seed);
const targets: Strategy["target"][] = ["weakest", "strongest", "leader", "nearest"];
const stances: Strategy["stance"][] = ["rush", "distance", "cover", "item"];
const lines = ["Change of plan!", "Now you're mine.", "Time to hide.", "Grab that rocket!", ""];
const base = m.prepareRound().map((d) => d.strategy);
const updates: PlanUpdate[] = [];
for (let k = 0; k < n; k++) {
  const fighter = k % 4;
  // bursts: several updates land close together, to test the clutter limits
  const tick = 240 + Math.floor(k / 4) * 420 + (k % 4) * 20;
  const b = base[fighter]!;
  const strategy: Strategy = k % 3 === 0 ? { ...b, target: "grudge", grudge: (fighter + 1 + (k % 3)) % 4 } : k % 3 === 1 ? { ...b, stance: stances[k % 4]! } : { ...b, target: targets[k % 4]! };
  if (strategy.target === "grudge" && strategy.grudge === fighter) strategy.grudge = (fighter + 1) % 4;
  updates.push({ tick, fighter, strategy, ...(lines[k % lines.length] ? { line: lines[k % lines.length] } : {}), source: "checkin" });
}
let added = 0;
for (const u of updates) {
  if (m.stepUntil(u.tick)) break;
  m.addUpdate(u);
  added++;
}
while (!m.step()) {
  /* rest of round 1 */
}
m.finishRound();
m.playToEnd();
const rec = JSON.parse(JSON.stringify(m.record));
mkdirSync("records", { recursive: true });
writeFileSync("records/stub-plan-updates.json", JSON.stringify({ ...rec, labels: ["house", "house", "house", "house"] }, null, 2));
const rules = rec.rounds.map((r: { strategies: Strategy[] }) => r.strategies.map((s) => s.rules?.length ?? 0).join("/"));
console.log(`records/stub-plan-updates.json: seed ${seed}, ${added} plan updates in round 1 (ticks ${updates[0]!.tick}-${updates[added - 1]!.tick} of ${rec.rounds[0].fight.ticks}); rules per fighter by round: ${rules.join(" | ")}`);
