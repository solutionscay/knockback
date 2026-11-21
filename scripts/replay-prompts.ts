/**
 * Rebuild the AI prompts of a saved match with the current prompt code:
 * replays the record exactly and builds every seat's prompt before every
 * round. For checking prompt changes against real matches.
 *   bun scripts/replay-prompts.ts <record.json> [--out prompts.json] [--print <seat> <round>]
 */
import { writeFileSync } from "node:fs";
import { buildRoundPrompts } from "../src/ai/prompt";
import { initPhysics, Match, type MatchRecord } from "../src/sim";

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error("usage: bun scripts/replay-prompts.ts <record.json> [--out prompts.json] [--print <seat> <round>]");
  process.exit(1);
}
await initPhysics();
const rec = JSON.parse(await Bun.file(file).text()) as MatchRecord;
let m: Match;
try {
  m = new Match(rec.seed, { recorded: rec }); // only records of the current engine load
} catch (e) {
  console.error(`${file}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const out: { round: number; prompts: string[] }[] = [];
while (!m.over) {
  const round = m.round + 1;
  const contexts = m.souls.map((_, i) => m.contextFor(i));
  out.push({ round, prompts: buildRoundPrompts(m, m.souls, contexts) });
  m.prepareRound();
  while (!m.step()) {
    /* replay */
  }
  m.finishRound();
  if (m.diverged >= 0) {
    console.error(`${file}: round ${m.diverged} ends in a different state than recorded, so its prompts can't be rebuilt.`);
    process.exit(2);
  }
}
const oi = args.indexOf("--out");
if (oi >= 0) writeFileSync(args[oi + 1]!, JSON.stringify(out, null, 2));
const pi = args.indexOf("--print");
if (pi >= 0) console.log(out.find((r) => r.round === Number(args[pi + 2]))?.prompts[Number(args[pi + 1])] ?? "no such prompt");
else console.log(`${out.length} rounds x 4 prompts rebuilt${oi >= 0 ? ` -> ${args[oi + 1]}` : ""}; ${m.names.join(", ")}`);
