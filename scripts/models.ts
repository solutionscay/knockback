/**
 * Which model is best: the model leaderboard over match records of the current engine.
 *
 *   bun run models records/                       # every record in the folder(s), all labels
 *   bun run models records/ evals/ --real         # only matches with a real AI seat (no stub/test, not all house)
 *   bun run models records/ --min 5 --h2h         # rank models with at least 5 matches; head-to-head matrix
 *   bun run models records/ --json > board.json   # the leaderboard as JSON (same shape as GET /api/models)
 *
 * Copies of the same match (same seed and total time) count once. Records of another engine version are skipped.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dedupe, headToHead, isRealAi, leaderboard, leaderboardText, seatEntries, type SeatEntry } from "../src/stats/models";

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dirs = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] === "--min"));
if (!dirs.length || flag("help")) {
  console.log("usage: bun run models <records dir or file...> [--real] [--min N] [--h2h] [--json]");
  process.exit(dirs.length ? 0 : 1);
}

function files(p: string): string[] {
  const st = statSync(p);
  if (st.isFile()) return [p];
  return readdirSync(p)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".prompts.json") && !f.endsWith(".report.json") && !f.endsWith(".checkins.json") && f !== "report.json")
    .sort()
    .map((f) => join(p, f));
}

const sets: SeatEntry[][] = [];
let skipped = 0;
for (const f of dirs.flatMap(files)) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    skipped++;
    continue;
  }
  const es = seatEntries(raw);
  if (!es.length || (flag("real") && !isRealAi(es))) {
    skipped++;
    continue;
  }
  sets.push(es);
}
const { kept, dropped } = dedupe(sets);
const min = opt("min") !== undefined ? Math.max(1, Number(opt("min")) | 0) : undefined;
const lb = leaderboard(kept, min !== undefined ? { minMatches: min } : {});
const h2h = headToHead(kept, lb.rows.map((r) => r.key));

if (flag("json")) console.log(JSON.stringify({ ...lb, headToHead: h2h }, null, 2));
else {
  console.log(`${kept.length} match${kept.length === 1 ? "" : "es"} (${dropped} duplicate${dropped === 1 ? "" : "s"} dropped, ${skipped} file${skipped === 1 ? "" : "s"} skipped: not a current-engine record${flag("real") ? " or no real AI seat" : ""})\n`);
  console.log(leaderboardText(lb, flag("h2h") ? h2h : undefined));
}
