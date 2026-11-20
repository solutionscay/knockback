/**
 * The four example souls shipped in souls/ (bundled as text so the browser
 * viewer and replays work without files). Swap a soul and the fighter's
 * personality changes; its name and look come from the match (identity.ts).
 */
import brawler from "../../souls/brawler.md" with { type: "text" };
import rat from "../../souls/rat.md" with { type: "text" };
import sniper from "../../souls/sniper.md" with { type: "text" };
import vulture from "../../souls/vulture.md" with { type: "text" };
import { parseSoul, type Soul } from "./soul";

export const EXAMPLE_SOUL_FILES: Record<string, string> = { brawler, sniper, rat, vulture };
export const EXAMPLE_SOUL_ORDER = ["brawler", "sniper", "rat", "vulture"];

export function exampleSouls(): Soul[] {
  return EXAMPLE_SOUL_ORDER.map((k, i) => parseSoul(EXAMPLE_SOUL_FILES[k]!, i, k).soul);
}
