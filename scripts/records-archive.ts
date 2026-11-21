/**
 * Move records of other engine versions out of the records folder (#59): the app lists and replays only records of
 * the current engine, so older ones go to an archive next to it, never deleted. A record moves with its companion
 * files (.log.txt, .prompts.json, .checkins.json).
 *
 *   bun run records:archive              # <out> (--out, KB_OUT, default records) -> <out>/../records-archive/engine-v<N>/
 *   bun run records:archive --dry-run    # list what would move
 *   bun run records:archive --to <dir>   # another archive folder
 *
 * In the container: docker compose run --rm server bun run records:archive
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ENGINE_VERSION } from "../src/sim/engine-version";
import { parseFlags } from "./flags";

const flags = parseFlags(process.argv.slice(2));
const out = resolve(flags.out ?? process.env.KB_OUT ?? "records");
const to = resolve(flags.to ?? join(dirname(out), "records-archive"));
const dry = flags["dry-run"] !== undefined;

const COMPANION = /\.(log\.txt|prompts\.json|checkins\.json)$/;
const files = existsSync(out) ? readdirSync(out) : [];
const records = files.filter((f) => f.endsWith(".json") && !COMPANION.test(f));
let moved = 0;
let kept = 0;
for (const rec of records) {
  let engine: unknown;
  try {
    engine = (JSON.parse(readFileSync(join(out, rec), "utf8")) as { engine?: unknown }).engine;
  } catch {
    console.warn(`skip ${rec}: not readable JSON`);
    continue;
  }
  if (engine === ENGINE_VERSION) {
    kept++;
    continue;
  }
  const dir = join(to, `engine-v${typeof engine === "number" ? engine : 0}`);
  const base = rec.slice(0, -".json".length);
  const group = files.filter((f) => f === rec || (f.startsWith(`${base}.`) && COMPANION.test(f)));
  if (!dry) mkdirSync(dir, { recursive: true });
  for (const f of group) {
    const dest = join(dir, f);
    if (existsSync(dest)) throw new Error(`${dest} exists: not overwriting an archived file`);
    if (!dry) renameSync(join(out, f), dest);
  }
  moved++;
  console.log(`${dry ? "would move" : "moved"} ${group.join(", ")} -> ${dir}`);
}
console.log(`${out}: ${moved} record(s) of other engines ${dry ? "would move" : "moved"} to ${to}; ${kept} of engine v${ENGINE_VERSION} stay`);
