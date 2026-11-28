import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MatchRunner } from "./runner";

export function writeMatchFiles(runner: MatchRunner, outDir: string, prefix: string): string {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `${prefix}-${runner.match.seed}-${stamp}.json`;
  writeFileSync(join(outDir, file), JSON.stringify(runner.savedRecord(), null, 2));
  writeFileSync(join(outDir, file.replace(/\.json$/, ".log.txt")), runner.log.join("\n") + "\n");
  writeFileSync(join(outDir, file.replace(/\.json$/, ".prompts.json")), JSON.stringify(runner.prompts, null, 2));
  if (runner.checkins.checkinPrompts.length) writeFileSync(join(outDir, file.replace(/\.json$/, ".checkins.json")), JSON.stringify(runner.checkins.checkinPrompts, null, 2));
  return file;
}
