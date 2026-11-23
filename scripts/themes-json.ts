/**
 * Write tools/art/themes.json from src/sim/themes.ts (#94): the looks Blender renders the terrain with
 * (tools/art/plush_level.py reads it). tests/themes.test.ts checks the file is current.
 *   bun scripts/themes-json.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { themesJson } from "../src/sim/themes";

const path = join(import.meta.dir, "..", "tools", "art", "themes.json");
const text = themesJson();
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== text) {
    console.error("tools/art/themes.json is stale: run bun scripts/themes-json.ts");
    process.exit(1);
  }
} else writeFileSync(path, text);
