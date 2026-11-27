/**
 * Ruleset presets, for the operator (#161). The built-in presets (Classic, Close Quarters) follow the code: `sync`
 * writes the code's body to each one that differs, with version + 1, and leaves the others and every operator preset
 * as they are. Matches keep the body and version they pinned. Works on the server's database while it runs (SQLite WAL).
 *
 *   bun run presets list                  presets, versions, the default
 *   bun run presets sync [--dry-run]      bring the built-in presets to the code's bodies (--dry-run: report only)
 *   --db <file> (or KB_DB; default <out>/match-server.db, out: --out, KB_OUT, records)
 */
import { join, resolve } from "node:path";
import { SqliteStore } from "../src/server/store";
import { parseFlags } from "./flags";

const argv = process.argv.slice(2);
const flags = parseFlags(argv);
const [cmd] = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const dryRun = argv.includes("--dry-run");
if (cmd !== "list" && cmd !== "sync") {
  console.error("usage: bun run presets list | sync [--dry-run] [--db <file>]");
  process.exit(1);
}
// the engine stamp is never needed here: skip working it out
const store = new SqliteStore(resolve(flags.db ?? process.env.KB_DB ?? join(flags.out ?? process.env.KB_OUT ?? "records", "match-server.db")), "unused");
try {
  if (cmd === "sync") {
    for (const r of await store.syncBuiltinPresets(dryRun)) {
      if (!r.changes.length) console.log(`${r.name} v${r.from}: same as the code`);
      else console.log(`${r.name} ${r.from === null ? "(missing)" : `v${r.from}`} -> v${r.to}${dryRun ? " (dry run: not written)" : ""}, ${r.changes.length} difference${r.changes.length === 1 ? "" : "s"}:\n${r.changes.map((c) => `  ${c}`).join("\n")}`);
    }
  }
  for (const p of await store.listRulesetPresets()) console.log(`${cmd === "sync" ? "stored: " : ""}${p.name} v${p.version}${p.isDefault ? " (default)" : ""}${p.ruleset ? "" : " (placeholder, no settings)"}`);
} finally {
  await store.close();
}
