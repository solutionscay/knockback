/**
 * #161: the built-in presets (Classic, Close Quarters) follow the code. `syncBuiltinPresets` (bun run presets sync)
 * writes the code's body to a stored built-in that differs, with version + 1; equal ones and every operator preset stay
 * as they are; a dry run writes nothing. `putRulesetPreset` refuses the built-in names.
 */
import { describe, expect, test } from "bun:test";
import { CLASSIC, CLOSE_QUARTERS } from "../src/sim/ruleset";
import { BUILTIN_PRESETS, SqliteStore } from "../src/server/store";

/** A fresh store whose built-ins hold an older body (endHalf 2.5, as before #158) at version 6, like the LAN before 17f90be. */
function staleStore(): SqliteStore {
  const s = new SqliteStore(":memory:", "test");
  for (const [name, code] of Object.entries(BUILTIN_PRESETS)) {
    const old = structuredClone(code) as any;
    old.zone.suddenDeath.endHalf = 2.5;
    s.db.query("UPDATE ruleset_presets SET body = ?, version = 6 WHERE name = ?").run(JSON.stringify(old), name);
  }
  return s;
}
const rows = (s: SqliteStore) => s.db.query("SELECT * FROM ruleset_presets ORDER BY name").all();

describe("built-in presets", () => {
  test("a fresh database already holds the code's bodies: sync changes nothing", async () => {
    const s = new SqliteStore(":memory:", "test");
    const before = rows(s);
    const r = await s.syncBuiltinPresets();
    expect(r.map((x) => [x.name, x.from, x.to, x.changes.length])).toEqual([["Classic", 1, 1, 0], ["Close Quarters", 1, 1, 0]]);
    expect(rows(s)).toEqual(before);
    await s.close();
  });

  test("a changed built-in takes the code's body at version + 1, stays the default, and a second run is a no-op", async () => {
    const s = staleStore();
    const dry = await s.syncBuiltinPresets(true);
    expect(dry.map((x) => [x.name, x.from, x.to, x.changes])).toEqual([
      ["Classic", 6, 7, ["zone.suddenDeath.endHalf: 2.5 -> 0.5"]],
      ["Close Quarters", 6, 7, ["zone.suddenDeath.endHalf: 2.5 -> 0.5"]],
    ]);
    expect((await s.getRulesetPreset("Classic"))!.version).toBe(6); // the dry run wrote nothing

    await s.syncBuiltinPresets();
    const classic = (await s.getRulesetPreset("Classic"))!;
    const cq = (await s.getRulesetPreset("Close Quarters"))!;
    expect([classic.version, classic.isDefault, cq.version]).toEqual([7, true, 7]);
    expect(classic.ruleset).toEqual(CLASSIC);
    expect(cq.ruleset).toEqual(CLOSE_QUARTERS);
    const stored = s.db.query("SELECT name, body FROM ruleset_presets WHERE body IS NOT NULL ORDER BY name").all() as { name: string; body: string }[];
    expect(stored).toEqual([{ name: "Classic", body: JSON.stringify(CLASSIC) }, { name: "Close Quarters", body: JSON.stringify(CLOSE_QUARTERS) }]);

    const after = rows(s);
    expect((await s.syncBuiltinPresets()).every((x) => x.changes.length === 0 && x.from === 7 && x.to === 7)).toBe(true);
    expect(rows(s)).toEqual(after);
    await s.close();
  });

  test("operator presets (new ones and filled placeholders) are left as they are", async () => {
    const s = staleStore();
    await s.putRulesetPreset("Bats", { weapons: { enabled: ["bat", "rocket"] } });
    await s.putRulesetPreset("Bats", { weapons: { enabled: ["bat"] } }); // v2
    await s.putRulesetPreset("Chaos", { round: { maxRounds: 5 } });
    const operators = () => s.db.query("SELECT * FROM ruleset_presets WHERE name NOT IN ('Classic', 'Close Quarters') ORDER BY name").all();
    const before = operators();
    await s.syncBuiltinPresets();
    expect(operators()).toEqual(before);
    expect((await s.getRulesetPreset("Bats"))!.version).toBe(2);
    await s.close();
  });

  test("putRulesetPreset refuses the built-in names, in any case", async () => {
    const s = new SqliteStore(":memory:", "test");
    for (const name of ["Classic", "close quarters", " CLOSE QUARTERS "]) await expect(s.putRulesetPreset(name, {})).rejects.toThrow("built-in preset");
    await s.close();
  });
});
