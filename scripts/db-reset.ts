/**
 * Reset the match server's database (pre-alpha: there is no upgrade code). The old file (and its -wal/-shm) is moved
 * aside to <db>.reset-<time>, never deleted; a fresh database with the current schema takes its place.
 *
 *   bun run db:reset                      # <out>/match-server.db (out: --out, KB_OUT, default records)
 *   bun run db:reset --db path/to/file.db # or KB_DB
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SCHEMA_VERSION, SqliteStore } from "../src/server/store";
import { parseFlags } from "./flags";

const flags = parseFlags(process.argv.slice(2));
const db = resolve(flags.db ?? process.env.KB_DB ?? join(flags.out ?? process.env.KB_OUT ?? "records", "match-server.db"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const moved: string[] = [];
for (const suffix of ["", "-wal", "-shm"]) {
  const f = db + suffix;
  if (!existsSync(f)) continue;
  const to = `${db}.reset-${stamp}${suffix}`;
  renameSync(f, to);
  moved.push(to);
}
mkdirSync(dirname(db), { recursive: true });
await new SqliteStore(db).close();
console.log(`${db}: fresh database, schema v${SCHEMA_VERSION}${moved.length ? `; the old one moved to ${moved.join(", ")}` : ""}`);
