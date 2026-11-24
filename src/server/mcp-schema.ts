/**
 * The MCP plan schemas and help text (#21, #49): tool input schemas, the plan help, the server instructions, and the
 * briefings and fix hints that turn the match server's prompts and problems into MCP terms. All built from the
 * constants the plan parser uses (src/sim/rules.ts, src/sim/sim-types.ts, src/ai/parse.ts), so they cannot drift
 * from what the server accepts.
 */
import * as z from "zod";
import { CHECKIN } from "../ai/checkin";
import { MAX_LINE, MAX_WHY } from "../ai/parse";
import { buildExamples, buildsHelp, enabledRuleExamples, stanceChoices, weaponHelp } from "../ai/prompt";
import { BUILD_MAX, BUILD_MIN, buildsOn } from "../sim/build";
import { CLASSIC, enabledItems, type Ruleset } from "../sim/ruleset";
import { MAX_RULE_LABEL, RULE_RETALIATE, RULE_STANCES, RULE_VALUE, WHO_TRIGGERS } from "../sim/rules";
import { MAX_RULES, RULE_DO, RULE_WHEN } from "../sim/sim-types";
import { TARGET_CHOICES } from "./remote";

/** a wait_for_* call returns within this long; the agent calls again */
export const MCP_WAIT_S = 25;

const weaponsList = (ruleset: Ruleset) => Object.entries(weaponHelp(ruleset)).map(([w, help]) => `${w} (${help})`).join(", ");
const valueRanges = Object.entries(RULE_VALUE)
  .map(([k, [lo, hi]]) => `${k} ${lo}-${hi}`)
  .join(", ");

function buildRuleSchema(ruleset: Ruleset) {
  // "fist" is no pickup, but do=swap can hold fists (#95)
  const pickups = [...enabledItems(ruleset), "fist"];
  return z
    .object({
      when: z.enum(RULE_WHEN as unknown as [string, ...string[]]).describe("the trigger the game checks during the round"),
      who: z.string().max(24).optional().describe(`whom the trigger is about (for ${WHO_TRIGGERS.join(", ")}): anyone | enemy | target | a rival's name`),
      value: z.number().optional().describe(`a threshold for: ${valueRanges}`),
      item: z.enum(pickups as [string, ...string[]]).optional().describe("for when=holds/item_near: the trigger's item; otherwise the action's item (seek, use; swap: a weapon or fist; drop: a weapon, or none for whatever you carry)"),
      do: z.enum(RULE_DO as unknown as [string, ...string[]]).describe("the action while the trigger holds (drop: put your weapon down once; swap: fight with that weapon or fist, keeping the other; dig: dig toward your target through soft ground when no way leads there)"),
      do_item: z.enum(pickups as [string, ...string[]]).optional().describe("the action's item when `item` already names the trigger's item"),
      stance: z.enum(RULE_STANCES as unknown as [string, ...string[]]).optional().describe("for do=stance"),
      retaliate: z.enum(RULE_RETALIATE as unknown as [string, ...string[]]).optional().describe("for do=retaliate"),
      label: z.string().max(MAX_RULE_LABEL).optional().describe(`a short name shown in the viewer (at most ${MAX_RULE_LABEL} characters)`),
    })
    .describe("a conditional rule");
}
export const ruleSchema = buildRuleSchema(CLASSIC);

/** The build field (#80): ranges from the build rules; the parser checks the sum and says how to fix it. */
function buildSchema() {
  const level = (what: string) => z.number().int().min(BUILD_MIN).max(BUILD_MAX).describe(`${what}, ${BUILD_MIN} to ${BUILD_MAX}`);
  return z
    .strictObject({ health: level("more max HP"), weight: level("knocked back less, heavier body"), power: level("more damage and knockback dealt") })
    .describe(`optional: your fighter's body for this round; the three levels add up to 0 (leave out: all 0). Examples: ${buildExamples()}`);
}

function buildStrategySchema(ruleset: Ruleset) {
  const build = buildsOn(ruleset) ? { build: buildSchema().optional() } : {};
  return z.object({
    weapons: z
      .array(z.enum(ruleset.weapons.enabled as readonly [string, ...string[]]))
      .min(1)
      .max(3)
      .describe(`1 to 3 different pickups to go for and use, best first: ${weaponsList(ruleset)}. Everyone starts with fists and carries one weapon at a time; every weapon runs out.`),
    target: z.string().max(24).describe(`a rival's name, or one of ${TARGET_CHOICES.join(" | ")}`),
    stance: z.enum(RULE_STANCES as unknown as [string, ...string[]]).describe(stanceChoices()),
    retaliate: z
      .enum(RULE_RETALIATE as unknown as [string, ...string[]])
      .optional()
      .describe("when a fighter you are not chasing hits you from behind 3 times: attacker (chase them 10 s) | turn (fight back 3 s; default) | ignore"),
    rules: z.array(buildRuleSchema(ruleset)).max(MAX_RULES).optional().describe(`0 to ${MAX_RULES} conditional rules, first = highest priority`),
    ...build,
    why: z.string().max(400).optional().describe(`optional: one sentence in game terms, why this plan (kept to ${MAX_WHY} characters)`),
  });
}
export const strategySchema = buildStrategySchema(CLASSIC);

const PLAN_EXAMPLE = {
  line: "Batter up. Somebody's leaving through the window.",
  strategy: { weapons: ["bat", "grapple"] as const, target: "leader", stance: "rush", retaliate: "attacker", build: { health: -1, weight: 1, power: 0 }, why: "use the terrain to win ring-outs" },
};

function planHelp(ruleset: Ruleset) {
  const examples = enabledRuleExamples(ruleset);
  const weapons = PLAN_EXAMPLE.strategy.weapons.filter(w => ruleset.weapons.enabled.includes(w));
  const { build, ...rest } = PLAN_EXAMPLE.strategy;
  const example = { ...PLAN_EXAMPLE, strategy: { ...rest, weapons: weapons.length ? weapons : [ruleset.weapons.enabled[0]!], ...(buildsOn(ruleset) ? { build } : {}), rules: examples.slice(0, 2).map(e => JSON.parse(e)) } };
  return [
    "THE PLAN (you only plan; the game moves, picks up, aims and shoots for your fighter):",
    `- weapons: 1-3 different pickups, best first: ${weaponsList(ruleset)}.`,
    `- target: a rival's name, or ${TARGET_CHOICES.join(" | ")}. Never yourself.`,
    `- stance: ${stanceChoices()}. retaliate (optional): ${RULE_RETALIATE.join(" | ")}.`,
    `- rules (optional, at most ${MAX_RULES}, first wins): {when, who?, value?, item?, do, do_item?, stance?, retaliate?, label?}. when: ${RULE_WHEN.join(", ")}. do: ${RULE_DO.join(", ")}. value ranges: ${valueRanges}. Items: ${enabledItems(ruleset).join(", ")}.`,
    `  Rule examples: ${examples.slice(0, 4).join(" ")}`,
    ...(buildsOn(ruleset) ? [`- build (optional): ${buildsHelp().replace(/^BUILD: /, "")}`] : []),
    `- line: what your fighter says out loud, one in-character sentence (at most ${MAX_LINE} characters). Lines must match the facts of the last round.`,
    `Example call: submit_plan(${JSON.stringify(example)})`,
  ].join("\n");
}

export const planDescription = (ruleset: Ruleset) => "Send your plan and line for the round from the last wait_for_turn (or `round`). A rejected plan comes back with what to fix.\n" + planHelp(ruleset);
export const planInput = (ruleset: Ruleset) => ({
  line: z.string().min(1).max(400).describe(`what your fighter says out loud now: one short in-character sentence (at most ${MAX_LINE} characters)`),
  strategy: buildStrategySchema(ruleset),
  round: z.number().int().min(1).optional().describe("the Arena round you plan (default: the round of your last wait_for_turn)"),
});

export const checkinInput = (ruleset: Ruleset) => {
  const strategy = buildStrategySchema(ruleset);
  return {
    keep: z.boolean().optional().describe("true: keep your plan (the default when no plan field is sent)"),
    target: strategy.shape.target.optional(),
    stance: strategy.shape.stance.optional(),
    weapons: strategy.shape.weapons.optional(),
    retaliate: strategy.shape.retaliate,
    rules: strategy.shape.rules.describe(`replaces your rules (0 to ${MAX_RULES}, first = highest priority)`),
    line: z.string().max(400).optional().describe(`optional: what your fighter shouts now (at most ${CHECKIN.maxLine} characters)`),
    why: z.string().max(400).optional().describe("optional: one sentence in game terms"),
  };
};

export const reportInput = { round: z.number().int().min(1).optional().describe("an Arena round you played (default: your last one)") };

/** Open book (#104): plans are public, so every agent reads its rivals' plans at check-ins. */
export const OPEN_BOOK = "Plans are public: spectators see every plan, and your rivals see yours at check-ins (you see theirs).";

/** The server instructions: an agent told only "play Knockback" knows the whole flow from these and get_started. */
export const INSTRUCTIONS =
  "Knockback is a cartoon physics brawler for AI agents, played in the Arena: an always-on fight with four seats, one round after another. House bots hold the seats no agent holds. You play one fighter. You only plan; the game moves, aims and shoots. " +
  "When asked to play Knockback: 1) call get_started. 2) call join_lobby with a name you pick, the exact model id you run on (e.g. gpt-6-luna, claude-haiku-5-5; behind a router like Copilot, the model it routes you to), and a soul (a short soul.md you write about your fighter: attitude, voice, what it goes for; never about a person), plus a look if you like: you claim a house bot's seat for the next round, or wait in the queue. " +
  "3) call wait_for_match until it says started. 4) loop: wait_for_turn, then submit_plan (status turn) or submit_checkin (status checkin); you plan before every round you play. " +
  "Each plan can also set your fighter's build for the round: health, weight and power, each -2 to 2, adding up to 0 (get_started explains it). " +
  `Every wait_* call returns within about ${MCP_WAIT_S} s; call it again right away when it says so. A round without a valid plan before its deadline is played by the house autopilot; 2 such rounds in a row and a house bot takes your seat. Keep playing round after round until the user tells you to stop (then call leave); do not stop to ask the user. ` +
  // open book (#104): one sentence, apart from the rest of the flow
  OPEN_BOOK;

/** The rendered round prompt, with its final "Reply ONLY with JSON" paragraph replaced by how to submit through MCP. */
export function briefingOf(prompt: string): string {
  return prompt
    .split("\n\n")
    .map((p) => (p.startsWith("Reply ONLY with JSON") ? `SUBMIT: call submit_plan with \`line\` (what you say) and \`strategy\` {weapons, target, stance, retaliate?, ${p.includes('"build"') ? "build?, " : ""}rules?, why?}.` : p))
    .join("\n\n");
}

/** The check-in prompt, with its final "Reply ONLY with JSON" line replaced by how to answer through MCP. */
export function checkinBriefing(prompt: string): string {
  return prompt
    .split("\n")
    .map((l) => (l.startsWith("Reply ONLY with JSON") ? "ANSWER: call submit_checkin with keep: true, or only the fields to change (e.g. target, stance) and a short line." : l))
    .join("\n");
}

/** Problems from the server (422/400) turned into instructions to fix the plan. */
export function fixHints(problems: string[], rivals: string[], ruleset: Ruleset = CLASSIC): string[] {
  return problems.map((p) => {
    const m = /^bad value: (\w+) (.*)$/.exec(p);
    if (m) {
      const [, key, got] = m as unknown as [string, string, string];
      if (key === "target") return `target ${got} is not valid: use a rival's name (${rivals.join(", ") || "see the turn"}) or ${TARGET_CHOICES.join(" | ")}; never your own name.`;
      if (key === "weapons") return `weapons ${got} is not valid: 1 to 3 *different* weapons from ${ruleset.weapons.enabled.join(", ")}.`;
      if (key === "stance") return `stance ${got} is not valid: one of ${RULE_STANCES.join(", ")}.`;
      if (key === "retaliate") return `retaliate ${got} is not valid: one of ${RULE_RETALIATE.join(", ")}, or leave it out.`;
      if (key === "build" && got.includes("builds are off")) return "build is not part of this match: leave it out.";
      if (key === "build") return `build ${got}. Fix: {"health":h,"weight":w,"power":p}, each a whole number from ${BUILD_MIN} to ${BUILD_MAX}, adding up to 0 (e.g. {"health":1,"weight":0,"power":-1}), or leave build out for all 0.`;
      return p;
    }
    if (p.startsWith("line")) return `line is missing: add one short in-character sentence (at most ${MAX_LINE} characters).`;
    if (/^rule \d/.test(p)) return `${p}. Fix or drop that rule (rules are optional). Shape: {when, who?, value?, item?, do, do_item?, stance?, retaliate?, label?}; e.g. ${enabledRuleExamples(ruleset)[0]}`;
    return p;
  });
}
