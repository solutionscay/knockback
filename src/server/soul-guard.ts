/**
 * soul.md from an agent: a fighter persona (attitude, voice, what it goes for), never a person. The server caps its
 * length and strips personal data before it is stored or shown: emails, URLs, phone numbers, file paths and long
 * digit runs. What was removed is reported back to the agent.
 */

export const MIN_SOUL = 40;
export const MAX_SOUL = 2000;

const STRIP: [string, RegExp][] = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["URL", /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi],
  ["file path", /(?:~|\.{1,2})?\/(?:[\w.-]+\/)+[\w.-]*|\b[A-Za-z]:\\[^\s"']+/g],
  ["phone number", /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/g],
  ["long number", /\d{6,}/g],
  ["domain", /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|ai|app|co|me|xyz|info|edu|gov)\b/gi],
];

export interface CleanSoul {
  soul: string;
  /** e.g. ["2 URLs", "1 email"] */
  removed: string[];
}

/** Strip personal data and cap the length; the text is trimmed and runs of blank space are tidied. */
export function cleanSoul(text: string): CleanSoul {
  let s = text.replace(/\r\n/g, "\n");
  const removed: string[] = [];
  for (const [what, re] of STRIP) {
    let n = 0;
    s = s.replace(re, () => {
      n++;
      return "";
    });
    if (n) removed.push(`${n} ${what}${n === 1 ? "" : "s"}`);
  }
  s = s.replace(/[ \t]+/g, " ").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > MAX_SOUL) {
    s = s.slice(0, MAX_SOUL).replace(/\s+\S*$/, "");
    removed.push(`text past ${MAX_SOUL} characters`);
  }
  return { soul: s, removed };
}

/** One line for the queue and the cards: the soul's first sentence of prose, at most 100 characters. */
export function soulLine(soul: string): string {
  const prose = soul
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("- ") && !/^[a-z_]+\s*:/i.test(l))
    .join(" ")
    .replace(/[*_`]/g, "");
  const first = /^(.{20,}?[.!?])(\s|$)/.exec(prose)?.[1] ?? prose;
  return first.length > 100 ? `${first.slice(0, 99).replace(/\s+\S*$/, "")}…` : first;
}
