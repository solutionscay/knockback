/**
 * Contract: stored rulesets from before a rename still load (#95). Matches pin their ruleset body and presets keep
 * theirs; #99 renamed the flamethrower's `fuel` to `ammo`, and every body stored before it carries `fuel`. The
 * fixtures are the LAN database's Classic and Close Quarters preset bodies as they were before #99.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLASSIC, CLOSE_QUARTERS, resolveRuleset, RulesetError, validateRuleset } from "../src/sim/ruleset";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8")) as Record<string, any>;

describe("rulesets stored before #99", () => {
  test("the pre-#99 Classic body loads; its flamethrower fuel is the flamethrower's ammo", () => {
    const body = fixture("ruleset-classic-pre99.json");
    expect(body.weapons.table.flamethrower.fuel).toBe(60);
    const r = resolveRuleset(body);
    expect(r.weapons.table.flamethrower.ammo).toBe(60);
    expect("fuel" in r.weapons.table.flamethrower).toBe(false);
    // the settings it does carry are kept (the old supply), the ones it lacks come from today's defaults
    expect(r.pickups.supply.maxLooseWeapons).toBe(8);
    expect(r.pickups.spots).toEqual(CLASSIC.pickups.spots);
  });

  test("the pre-#99 Close Quarters body loads", () => {
    const body = fixture("ruleset-close-quarters-pre99.json");
    expect(body.weapons.table.flamethrower.fuel).toBe(60);
    const r = resolveRuleset(body);
    expect(r.weapons.table.flamethrower.ammo).toBe(60);
    expect(r.tactics.weapons.enabled).toBe(CLOSE_QUARTERS.tactics.weapons.enabled);
  });

  test("an old fuel goes to ammo; given both, ammo wins; other unknown settings are still refused", () => {
    expect(validateRuleset({ weapons: { table: { flamethrower: { fuel: 30 } } } }).weapons.table.flamethrower.ammo).toBe(30);
    expect(validateRuleset({ weapons: { table: { flamethrower: { fuel: 30, ammo: 45 } } } }).weapons.table.flamethrower.ammo).toBe(45);
    expect(() => validateRuleset({ weapons: { table: { flamethrower: { fuels: 30 } } } })).toThrow(RulesetError);
    expect(() => validateRuleset({ weapons: { table: { rocket: { fuel: 30 } } } })).toThrow(RulesetError);
  });
});
