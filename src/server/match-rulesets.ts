import { CLASSIC, resolveRuleset, RulesetError, type Ruleset } from "../sim/ruleset";
import { HttpError } from "./limits";
import type { MatchRow, MatchStore } from "./store";

export interface MatchRuleset {
  ruleset: Ruleset;
  preset?: string;
  presetVersion?: number;
}

/** Resolve a selection once. Persist the body so later preset edits cannot affect a match. */
export async function selectRuleset(store: MatchStore, selection?: unknown): Promise<MatchRuleset> {
  if (selection === undefined || typeof selection === "string") {
    if (typeof selection === "string" && (!selection.trim() || selection.length > 64)) throw new HttpError(400, "ruleset: preset name must be 1–64 characters");
    const preset = selection === undefined ? await store.defaultRulesetPreset() : await store.getRulesetPreset(selection.trim());
    if (!preset) {
      if (selection === undefined) return { ruleset: CLASSIC, preset: "Classic", presetVersion: 1 };
      throw new HttpError(400, `ruleset: unknown preset "${selection}"`);
    }
    if (!preset.ruleset) throw new HttpError(400, `ruleset: preset "${preset.name}" is a placeholder without settings`);
    return { ruleset: preset.ruleset, preset: preset.name, presetVersion: preset.version };
  }
  try {
    return { ruleset: resolveRuleset(selection) };
  } catch (e) {
    if (!(e instanceof RulesetError)) throw e;
    throw new HttpError(400, e.message);
  }
}

/** The ruleset pinned to a stored match. */
export function storedRuleset(row: MatchRow): MatchRuleset {
  return { ruleset: row.ruleset, preset: row.preset, presetVersion: row.presetVersion };
}
