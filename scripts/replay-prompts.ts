/**
 * Rebuild the AI prompts of a saved match with the current prompt code:
 * replays the record exactly and builds every seat's prompt before every
 * round. For checking prompt changes against real matches.
 *   bun scripts/replay-prompts.ts <record.json> [--out prompts.json] [--print <seat> <round>]
 */
import { writeFileSync } from "node:fs";
import { buildPrompt } from "../src/ai/prompt";
import { initPhysics, Match, type MatchRecord } from "../src/sim";

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error("usage: bun scripts/replay-prompts.ts <record.json> [--out prompts.json] [--print <seat> <round>]");
  process.exit(1);
}
await initPhysics();
const rec = JSON.parse(await Bun.file(file).text()) as MatchRecord;
if (rec.version !== 2 || !Array.isArray(rec.souls)) {
  console.error(`${file}: not a version 2 match record (older records have no souls; they can't be rebuilt)`);
  process.exit(1);
}
const m = new Match(rec.seed, { recorded: rec });
const out: { round: number; prompts: string[] }[] = [];
while (!m.over) {
  const prev = m.record.rounds[m.record.rounds.length - 1];
  const extras = {
    level: m.level,
    lastLines: prev ? prev.lines : null,
    lastHealth: m.facts.length ? m.facts[m.facts.length - 1]!.fighters.map((f) => f.hpEnd) : null,
  };
  const round = m.round + 1;
  out.push({ round, prompts: m.souls.map((s, i) => buildPrompt(s, m.contextFor(i), { ...extras, myLines: m.record.rounds.map((r) => r.lines[i]!), lastPlans: m.record.rounds.length ? m.record.rounds[m.record.rounds.length - 1]!.strategies : null, seed: rec.seed })) });
  m.prepareRound();
  while (!m.step()) {
    /* replay */
  }
  m.finishRound();
  if (m.diverged >= 0) {
    console.error(`${file}: round ${m.diverged} ends in a different state than recorded: the record was made by an older engine version, so its prompts can't be rebuilt here. Run this script from the commit that made the record.`);
    process.exit(2);
  }
}
const oi = args.indexOf("--out");
if (oi >= 0) writeFileSync(args[oi + 1]!, JSON.stringify(out, null, 2));
const pi = args.indexOf("--print");
if (pi >= 0) console.log(out.find((r) => r.round === Number(args[pi + 2]))?.prompts[Number(args[pi + 1])] ?? "no such prompt");
else console.log(`${out.length} rounds x 4 prompts rebuilt${oi >= 0 ? ` -> ${args[oi + 1]}` : ""}; ${m.names.join(", ")}`);
