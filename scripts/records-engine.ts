/**
 * Which engine each record was played on (#88). Records from an older engine are never shown on the site; they stay
 * on disk and in the database as training data. This lists them all and tells them apart.
 *
 *   bun scripts/records-engine.ts <file|dir>...           record files (a stamp answers at once; a record from before
 *                                                          stamps is replayed: current if it reaches its hashes)
 *   bun scripts/records-engine.ts --db records/match-server.db   the server's index: every round, every tier, with
 *                                                          the engine its match was stamped with (null: not checked yet)
 *   add --json for one JSON line per record: { path, engine: "current" | "older" | "unchecked", ... }
 *
 * The #88 detector reads the same records: bun scripts/stuck.ts records <dir> [--replay-plans] (older-engine rounds
 * are counted as "diverged" and left out unless --replay-plans plays their recorded plans on this engine).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { initPhysics } from "../src/sim";
import { engineStamp, recordEngine, type StampedRecord } from "../src/sim/engine";
import { SqliteStore } from "../src/server/store";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dbAt = args.indexOf("--db");
await initPhysics();
const current = engineStamp();
const out: { path: string; engine: "current" | "older" | "unchecked"; stamp?: string | null; tier?: string; match?: string }[] = [];

function files(paths: string[]): string[] {
  const all: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) all.push(...files(readdirSync(p).map((f) => join(p, f))));
    else if (/\.json$/.test(p) && !/\.(prompts|checkins)\.json$/.test(p)) all.push(p);
  }
  return all.sort();
}

if (dbAt >= 0) {
  const store = new SqliteStore(args[dbAt + 1]!, current);
  for (const r of await store.allRecords()) out.push({ path: r.path, match: r.matchId, tier: r.tier, stamp: r.engine ?? null, engine: r.engine === current ? "current" : r.engine == null ? "unchecked" : "older" });
  await store.close();
} else {
  for (const f of files(args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--db"))) {
    let rec: StampedRecord;
    try {
      rec = JSON.parse(readFileSync(f, "utf8")) as StampedRecord;
      if (!Array.isArray(rec.rounds)) continue;
    } catch {
      continue;
    }
    out.push({ path: f, stamp: rec.engine ?? null, engine: recordEngine(rec) });
  }
}

if (asJson) for (const r of out) console.log(JSON.stringify(r));
else {
  for (const r of out) console.log(`${r.engine.padEnd(9)} ${r.tier ? r.tier.padEnd(9) + " " : ""}${r.path}`);
  const n = (k: string) => out.filter((r) => r.engine === k).length;
  console.log(`\nengine ${current}: ${out.length} records, ${n("current")} on this engine, ${n("older")} older${n("unchecked") ? `, ${n("unchecked")} not checked yet` : ""}`);
}
