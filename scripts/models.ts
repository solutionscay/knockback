/**
 * Which model is best: the model leaderboard over match records.
 *
 *   bun run models records/                       # every record in the folder(s), all labels
 *   bun run models records/ evals/ --real         # only matches with a real AI seat (no stub/test, not all house)
 *   bun run models records/ --min 5 --h2h         # rank models with at least 5 matches; head-to-head matrix
 *   bun run models records/ --json > board.json   # the leaderboard as JSON (same shape as GET /api/models)
 *
 * Copies of the same match (same engine, seed and total time) count once. Results are split by engine version.
 * Knockouts, ring-outs, damage and survival come from the record's fightStats (new records) or, for records of the
 * current engine, from a replay (checked against the recorded hashes); older records count wins and fallbacks only.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_VERSION, recordEngine } from "../src/sim/engine-version";
import { Match, type MatchRecord } from "../src/sim/match";
import { dedupe, fightStatsOf, headToHead, isRealAi, leaderboard, leaderboardText, seatEntries, type FightStats, type SeatEntry } from "../src/stats/models";

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dirs = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] === "--min"));
if (!dirs.length || flag("help")) {
  console.log("usage: bun run models <records dir or file...> [--real] [--min N] [--h2h] [--json] [--no-replay]");
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

/** Fight stats from a replay, when the record is from this engine and replays to its recorded hashes. */
function replayStats(raw: MatchRecord): FightStats | null {
  try {
    const m = new Match(raw.seed, { recorded: raw });
    while (!m.over) m.playRound();
    return m.diverged >= 0 ? null : fightStatsOf(m.facts);
  } catch {
    return null;
  }
}

const sets: SeatEntry[][] = [];
let skipped = 0;
let replayed = 0;
let notReplayed = 0;
for (const f of dirs.flatMap(files)) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    skipped++;
    continue;
  }
  let es = seatEntries(raw);
  if (!es.length) {
    skipped++;
    continue;
  }
  if (!es[0]!.fight && recordEngine(raw) === ENGINE_VERSION && !flag("no-replay")) {
    const fs = replayStats(raw as MatchRecord);
    if (fs) {
      es = seatEntries(raw, fs);
      replayed++;
    } else notReplayed++;
  }
  if (flag("real") && !isRealAi(es)) {
    skipped++;
    continue;
  }
  sets.push(es);
}
const { kept, dropped } = dedupe(sets);
const min = opt("min") !== undefined ? Math.max(1, Number(opt("min")) | 0) : undefined;
const lb = leaderboard(kept, min !== undefined ? { minMatches: min } : {});

if (flag("json")) {
  const h = (engine: number | "all") => headToHead(engine === "all" ? kept : kept.filter((s) => s[0]!.engine === engine));
  console.log(JSON.stringify({ ...lb, headToHead: Object.fromEntries([...lb.engines.map((e) => [String(e.engine), h(e.engine)]), ["all", h("all")]]) }, null, 2));
} else {
  console.log(`${kept.length} match${kept.length === 1 ? "" : "es"} (${dropped} duplicate${dropped === 1 ? "" : "s"} dropped, ${skipped} file${skipped === 1 ? "" : "s"} skipped${flag("real") ? " incl. non-AI matches" : ""}; ${replayed} replayed for fight stats${notReplayed ? `, ${notReplayed} didn't replay` : ""})\n`);
  const order = lb.all.rows.map((r) => r.key);
  console.log(leaderboardText(lb, flag("h2h") ? (engine) => headToHead(engine === "all" ? kept : kept.filter((s) => s[0]!.engine === engine), order) : undefined));
}
