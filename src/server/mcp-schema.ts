/**
 * The MCP plan schemas and help text (#21, #49): tool input schemas, the plan help, the server instructions, and the
 * briefings and fix hints that turn the match server's prompts and problems into MCP terms. All built from the
 * constants the plan parser uses (src/sim/rules.ts, src/sim/sim-types.ts, src/ai/parse.ts), so they cannot drift
 * from what the server accepts.
 */
import * as z from "zod";
import { CHECKIN } from "../ai/checkin";
import { MAX_LINE, MAX_WHY } from "../ai/parse";
import { enabledRuleExamples, stanceChoices, weaponHelp } from "../ai/prompt";
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
  const pickups = enabledItems(ruleset);
  return z
    .object({
      when: z.enum(RULE_WHEN as unknown as [string, ...string[]]).describe("the trigger the game checks during the round"),
      who: z.string().max(24).optional().describe(`whom the trigger is about (for ${WHO_TRIGGERS.join(", ")}): anyone | enemy | target | a rival's name`),
      value: z.number().optional().describe(`a threshold for: ${valueRanges}`),
      item: z.enum(pickups as [string, ...string[]]).optional().describe("for when=holds/item_near: the trigger's item; otherwise the action's item (seek, use)"),
      do: z.enum(RULE_DO as unknown as [string, ...string[]]).describe("the action while the trigger holds"),
      do_item: z.enum(pickups as [string, ...string[]]).optional().describe("the action's item when `item` already names the trigger's item"),
      stance: z.enum(RULE_STANCES as unknown as [string, ...string[]]).optional().describe("for do=stance"),
      retaliate: z.enum(RULE_RETALIATE as unknown as [string, ...string[]]).optional().describe("for do=retaliate"),
      label: z.string().max(MAX_RULE_LABEL).optional().describe(`a short name shown in the viewer (at most ${MAX_RULE_LABEL} characters)`),
    })
    .describe("a conditional rule");
}
export const ruleSchema = buildRuleSchema(CLASSIC);

function buildStrategySchema(ruleset: Ruleset) {
  return z.object({
    weapons: z
      .array(z.enum(ruleset.weapons.enabled as readonly [string, ...string[]]))
      .min(1)
      .max(3)
      .describe(`1 to 3 different pickups to go for and use, best first: ${weaponsList(ruleset)}. Everyone starts with fists.`),
    target: z.string().max(24).describe(`a rival's name, or one of ${TARGET_CHOICES.join(" | ")}`),
    stance: z.enum(RULE_STANCES as unknown as [string, ...string[]]).describe(stanceChoices()),
    retaliate: z
      .enum(RULE_RETALIATE as unknown as [string, ...string[]])
      .optional()
      .describe("when a fighter you are not chasing hits you from behind 3 times: attacker (chase them 10 s) | turn (fight back 3 s; default) | ignore"),
    rules: z.array(buildRuleSchema(ruleset)).max(MAX_RULES).optional().describe(`0 to ${MAX_RULES} conditional rules, first = highest priority`),
    why: z.string().max(400).optional().describe(`optional: one sentence in game terms, why this plan (kept to ${MAX_WHY} characters)`),
  });
}
export const strategySchema = buildStrategySchema(CLASSIC);

const PLAN_EXAMPLE = {
  line: "Batter up. Somebody's leaving through the window.",
  strategy: { weapons: ["bat", "grapple"] as const, target: "leader", stance: "rush", retaliate: "attacker", why: "use the terrain to win ring-outs" },
};

function planHelp(ruleset: Ruleset) {
  const examples = enabledRuleExamples(ruleset);
  const weapons = PLAN_EXAMPLE.strategy.weapons.filter(w => ruleset.weapons.enabled.includes(w));
  const example = { ...PLAN_EXAMPLE, strategy: { ...PLAN_EXAMPLE.strategy, weapons: weapons.length ? weapons : [ruleset.weapons.enabled[0]!], rules: examples.slice(0, 2).map(e => JSON.parse(e)) } };
  return [
    "THE PLAN (you only plan; the game moves, picks up, aims and shoots for your fighter):",
    `- weapons: 1-3 different pickups, best first: ${weaponsList(ruleset)}.`,
    `- target: a rival's name, or ${TARGET_CHOICES.join(" | ")}. Never yourself.`,
    `- stance: ${stanceChoices()}. retaliate (optional): ${RULE_RETALIATE.join(" | ")}.`,
    `- rules (optional, at most ${MAX_RULES}, first wins): {when, who?, value?, item?, do, do_item?, stance?, retaliate?, label?}. when: ${RULE_WHEN.join(", ")}. do: ${RULE_DO.join(", ")}. value ranges: ${valueRanges}. Items: ${enabledItems(ruleset).join(", ")}.`,
    `  Rule examples: ${examples.slice(0, 4).join(" ")}`,
    `- line: what your fighter says out loud, one in-character sentence (at most ${MAX_LINE} characters). Lines must match the facts of the last round.`,
    `Example call: submit_plan(${JSON.stringify(example)})`,
  ].join("\n");
}

export const planDescription = (ruleset: Ruleset) => "Send your plan and line for the round from the last wait_for_turn (or `round`). A rejected plan comes back with what to fix.\n" + planHelp(ruleset);
export const planInput = (ruleset: Ruleset) => ({
  line: z.string().min(1).max(400).describe(`what your fighter says out loud now: one short in-character sentence (at most ${MAX_LINE} characters)`),
  strategy: buildStrategySchema(ruleset),
  round: z.number().int().min(1).max(ruleset.round.maxRounds).optional().describe("the round you plan (default: the round of your last wait_for_turn)"),
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

export const reportInput = (ruleset: Ruleset) => ({ round: z.number().int().min(1).max(ruleset.round.maxRounds).optional().describe("the round (default: all played so far)") });

/** The server instructions: an agent told only "play Knockback" knows the whole flow from these and get_started. */
export const INSTRUCTIONS =
  "Knockback is a cartoon physics brawler for AI agents: four fighters, best of 3 rounds. You play one fighter. You only plan; the game moves, aims and shoots. " +
  "When asked to play Knockback: 1) call get_started. 2) call join_lobby with a name you pick, the model you run, and a soul (a short soul.md you write about your fighter: attitude, voice, what it goes for; never about a person), plus a look if you like. " +
  "3) call wait_for_match until it says started. 4) loop: wait_for_turn, then submit_plan (status turn) or submit_checkin (status checkin), until wait_for_turn says over. " +
  `Every wait_* call returns within about ${MCP_WAIT_S} s; call it again right away when it says so. A round without a valid plan before its deadline is played by the house bot. Keep going until the match is over; do not stop to ask the user.`;

/** The rendered round prompt, with its final "Reply ONLY with JSON" paragraph replaced by how to submit through MCP. */
export function briefingOf(prompt: string): string {
  return prompt
    .split("\n\n")
    .map((p) => (p.startsWith("Reply ONLY with JSON") ? "SUBMIT: call submit_plan with `line` (what you say) and `strategy` {weapons, target, stance, retaliate?, rules?, why?}." : p))
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
      return p;
    }
    if (p.startsWith("line")) return `line is missing: add one short in-character sentence (at most ${MAX_LINE} characters).`;
    if (/^rule \d/.test(p)) return `${p}. Fix or drop that rule (rules are optional). Shape: {when, who?, value?, item?, do, do_item?, stance?, retaliate?, label?}; e.g. ${enabledRuleExamples(ruleset)[0]}`;
    return p;
  });
}
