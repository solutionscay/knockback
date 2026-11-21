/**
 * Contract 5: soul guard. soul.md is about a fighter, never a person: before a soul is stored or shown, the server
 * removes personal data (emails, URLs, phone numbers, long numbers) and file paths, says what it removed, and leaves
 * the fighter's own words alone.
 */
import { describe, expect, test } from "bun:test";
import { checkJoin } from "../src/server/match-input";
import { cleanSoul, MAX_SOUL } from "../src/server/soul-guard";

const PERSONA = "A cocky bruiser who loves the bat and a good ring-out. Talks in short, loud taunts and never backs down.\n\nGoes for whoever is winning, grabs the rocket when it can, and hates hiding behind cover. Best of 3, round 2 is where it wakes up.";

/** What must never survive, by kind. */
const LEAKS: [kind: string, text: string][] = [
  ["email", "jane.doe+kb@example.com"],
  ["URL", "https://evil.example/track?id=1"],
  ["URL", "www.my-blog.net/about"],
  ["phone number", "+1 (555) 123-4567"],
  ["long number", "4111111111111111"],
  ["file path", "/Users/jane/Documents/notes.txt"],
  ["file path", "~/.ssh/id_ed25519"],
  ["file path", "C:\\Users\\jane\\secrets.txt"],
];

describe("soul guard", () => {
  test("a clean persona passes unchanged", () => {
    expect(cleanSoul(PERSONA)).toEqual({ soul: PERSONA, removed: [] });
  });

  for (const [kind, leak] of LEAKS)
    test(`removes a ${kind}: ${leak}`, () => {
      const c = cleanSoul(`${PERSONA}\nReach me at ${leak} any time.`);
      expect(c.soul).not.toContain(leak);
      expect(c.soul).toContain("loves the bat"); // the persona stays
      expect(c.removed.join(" ")).toContain(kind);
    });

  test("removes relative file paths and files at the root: souls/brawler.md, /secret.txt", () => {
    for (const leak of ["souls/brawler.md", "/secret.txt"]) {
      const c = cleanSoul(`${PERSONA}\nMy notes live in ${leak} on my laptop.`);
      expect(c.soul).not.toContain(leak);
      expect(c.soul).toContain("loves the bat");
      expect(c.removed.join(" ")).toContain("file path");
    }
  });

  test("caps the length", () => {
    const c = cleanSoul(`${PERSONA} `.repeat(20));
    expect(c.soul.length).toBeLessThanOrEqual(MAX_SOUL);
    expect(c.removed).toContain(`text past ${MAX_SOUL} characters`);
  });

  test("a join stores the cleaned soul and tells the agent what was removed", () => {
    const j = checkJoin({ name: "Basher", model: "claude-opus-5-5", soul: `${PERSONA}\nMail jane.doe@example.com or see /Users/jane/plan.md.` });
    expect(j.soul).not.toContain("jane");
    expect(j.soul).toContain("loves the bat");
    expect(j.warnings.join(" ")).toMatch(/removed .*email.*file path|removed .*file path.*email/);
  });
});
