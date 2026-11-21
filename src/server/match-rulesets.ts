import { CLASSIC, CLOSE_QUARTERS, resolveRuleset, RulesetError, type Ruleset } from "../sim/ruleset";
import { HttpError } from "./limits";
import type { MatchRow, MatchStore } from "./store";

export interface MatchRuleset {
  ruleset: Ruleset;
  preset?: string;
  presetVersion?: number;
}

/** The built-in Classic preset's version: store migration 10 (#41) made it 3. Bump it with every migration that changes Classic. */
export const CLASSIC_PRESET_VERSION = 3;

/** Resolve a selection once. Persist the body so later preset edits cannot affect a match. */
export async function selectRuleset(store: MatchStore, selection?: unknown): Promise<MatchRuleset> {
  if (selection === undefined || typeof selection === "string") {
    if (typeof selection === "string" && (!selection.trim() || selection.length > 64)) throw new HttpError(400, "ruleset: preset name must be 1–64 characters");
    const preset = selection === undefined ? await store.defaultRulesetPreset() : await store.getRulesetPreset(selection.trim());
    if (!preset) {
      if (selection === undefined) return { ruleset: CLASSIC, preset: "Classic", presetVersion: CLASSIC_PRESET_VERSION };
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

/** Legacy rows were created before matches had a stored ruleset. */
export function storedRuleset(row: MatchRow): MatchRuleset {
  if (!row.ruleset) return { ruleset: CLOSE_QUARTERS, preset: "Classic", presetVersion: 1 };
  return { ruleset: row.ruleset, preset: row.preset, presetVersion: row.presetVersion };
}
