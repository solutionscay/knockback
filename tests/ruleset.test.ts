import { beforeAll, expect, test } from "bun:test";
import { buildRoundPrompts } from "../src/ai/prompt";
import { CLASSIC, initPhysics, Match, replayMatch, resolveRuleset } from "../src/sim";
import { sanitizeRecord } from "../src/viewer/sanitize";

beforeAll(initPhysics);

test("rulesets resolve partial settings and canonicalize full snapshots", () => {
  const reordered = Object.fromEntries(Object.entries(CLASSIC).reverse());
  expect(JSON.stringify(resolveRuleset(reordered))).toBe(JSON.stringify(CLASSIC));
  const enabled = CLASSIC.weapons.enabled.filter(weapon => weapon !== "railgun");
  const custom = resolveRuleset({ weapons: { enabled: enabled.slice().reverse() }, fire: { spread: 0.18 } });
  expect(custom.weapons.enabled).toEqual(enabled);
  expect(custom.weapons.table).toEqual(CLASSIC.weapons.table);
  expect(custom.fire.spread).toBe(0.18);
  expect(Object.isFrozen(custom.weapons.enabled)).toBe(true);
});

test("invalid settings report their field and the constraint", () => {
  expect(() => resolveRuleset({ fire: { spred: 0.18 } })).toThrow("fire.spred: unknown setting");
  expect(() => resolveRuleset({ fire: { spread: 1.1 } })).toThrow("fire.spread: expected a value from 0 to 1");
  expect(() => resolveRuleset({ weapons: { enabled: ["unknown"] } })).toThrow("weapons.enabled: allowed values");
  expect(() => resolveRuleset({ pickups: { supply: { interval: 0 } } })).toThrow("pickups.supply.interval");
  expect(() => resolveRuleset({ round: { maxRounds: 1 } })).toThrow("win target no larger than maxRounds");
  expect(() => resolveRuleset({ schemaVersion: 2 })).toThrow("schemaVersion: expected version 1");
});

const checkpoints = (m: Match) => m.record.rounds.map(({ fight }) => [fight.checkpoints, fight.finalHash]);

test("the record owns the ruleset and replays a custom match through viewer sanitization", () => {
  const ruleset = resolveRuleset({
    weapons: { enabled: ["bat"] }, pickups: { enabled: [] }, fire: { spread: 0.18 },
    round: { maxRounds: 1, winsToTake: 1, fightTicks: 120 },
  });
  const match = new Match(42, { ruleset, preset: "Test arena", presetVersion: 3 });
  const prompt = buildRoundPrompts(match, match.souls, match.souls.map((_, seat) => match.contextFor(seat)))[0]!;
  expect(prompt).toContain("bat (");
  expect(prompt).not.toMatch(/railgun|jetpack/);
  match.playToEnd();
  expect(match.record.rounds).toHaveLength(1);
  expect(match.record.rounds[0]!.strategies.every(plan => plan.weapons.every(w => w === "bat"))).toBe(true);
  expect(match.record.rounds[0]!.fight.ticks).toBe(120);
  const record = sanitizeRecord(JSON.parse(JSON.stringify(match.record)));
  expect(record).toMatchObject({ ruleset, preset: "Test arena", presetVersion: 3 });
  expect(checkpoints(replayMatch(record!))).toEqual(checkpoints(match));
  expect(sanitizeRecord({ ...record, ruleset: { fire: { spread: "too much" } } })).toBeNull();
});
