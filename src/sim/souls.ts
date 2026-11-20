/**
 * The four example souls shipped in souls/ (bundled as text so the browser
 * viewer and replays work without files). Swap a soul and the fighter changes.
 */
import brick from "../../souls/brick.md" with { type: "text" };
import goldie from "../../souls/goldie.md" with { type: "text" };
import pike from "../../souls/pike.md" with { type: "text" };
import squeaks from "../../souls/squeaks.md" with { type: "text" };
import { parseSoul, type Soul } from "./soul";

export const EXAMPLE_SOUL_FILES: Record<string, string> = { brick, pike, squeaks, goldie };
export const EXAMPLE_SOUL_ORDER = ["brick", "pike", "squeaks", "goldie"];

export function exampleSouls(): Soul[] {
  return EXAMPLE_SOUL_ORDER.map((k, i) => parseSoul(EXAMPLE_SOUL_FILES[k]!, i).soul);
}

/** Visual look of a seat (what the engine's Sim accepts). */
export function lookOf(s: Soul): { name: string; color: number; mark: string } {
  return { name: s.name, color: s.color, mark: s.mark };
}
