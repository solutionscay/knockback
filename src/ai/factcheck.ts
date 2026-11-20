/**
 * Heuristic fact check of an AI line against the round it talks about (#4).
 * Not a judge: it only looks at lines that name a rival together with a
 * claim, and pins each claim on the rival named closest before it ("Goldie
 * shot me") or, with none before, closest after it ("you knocked me out,
 * Goldie"). Used by the harness (facts metric) and by decideRound (a warning
 * in the decision meta; the line is never rejected).
 */

/** What the check needs to know about a round. */
export interface CheckFacts {
  kos: { victim: number; by: number; weapon: string }[];
  /** damage[attacker][victim] */
  damage: number[][];
  /** hits from behind: behind[attacker][victim] */
  behind: number[][];
  /** weapons that did damage: weapons[attacker][victim] (optional: older eval inputs lack it) */
  weapons?: string[][][];
}

export type ClaimKind = "knockout" | "back" | "hit" | "weapon";

export const CLAIMS: { kind: ClaimKind; re: RegExp }[] = [
  { kind: "knockout", re: /\b(knock(?:ed)? me (?:out|off)|took me out|finished me|ko'?d me|killed me|r[au]ng me out|threw me off|sent me (?:flying|off))\b/i },
  { kind: "back", re: /\b(in the back|from behind|back-?(?:shot|stab|hook)s?|my back|behind my back|sneak(?:ed|ing)? up on me)\b/i },
  { kind: "hit", re: /\b((?:shot|hit|blasted|hooked|batted|smacked|whacked|nailed|bonked|grenaded|rocketed|peppered|pelted|stung) (?:me|my)|owes? me)\b/i },
  { kind: "weapon", re: /\b(?:that|'s) (hook|grapple|bat|rockets?|shotgun|grenades?)\b/i },
];

const WEAPON_WORD: Record<string, string> = { hook: "grapple", grapple: "grapple", bat: "bat", rocket: "rocket", rockets: "rocket", shotgun: "shotgun", grenade: "grenade", grenades: "grenade" };

export interface Mismatch {
  claim: string;
  facts: string;
}

/** Check one line spoken by `me`. checked = the line names a rival with a claim. */
export function checkLine(line: string, me: number, names: string[], f: CheckFacts): { checked: boolean; mismatches: Mismatch[] } {
  const mentions: { at: number; who: number }[] = [];
  names.forEach((n, i) => {
    if (i === me) return;
    const re = new RegExp(`\\b${n.replace(/[^\w]/g, "")}\\b`, "gi");
    for (let x = re.exec(line); x; x = re.exec(line)) mentions.push({ at: x.index, who: i });
  });
  if (!mentions.length) return { checked: false, mismatches: [] };
  const claims: { kind: ClaimKind; at: number; weapon?: string }[] = [];
  for (const c of CLAIMS) {
    const re = new RegExp(c.re.source, "gi");
    for (let x = re.exec(line); x; x = re.exec(line)) claims.push({ kind: c.kind, at: x.index, ...(c.kind === "weapon" ? { weapon: WEAPON_WORD[x[1]!.toLowerCase()] } : {}) });
  }
  if (!claims.length) return { checked: false, mismatches: [] };
  const out: Mismatch[] = [];
  for (const c of claims) {
    if (c.kind === "weapon" && !f.weapons) continue;
    // a possessive ("Pike's rocket") belongs to the name right before it; otherwise the nearest name before, else after
    const before = mentions.filter((x) => x.at < c.at).sort((a, b) => b.at - a.at)[0];
    const after = mentions.filter((x) => x.at > c.at).sort((a, b) => a.at - b.at)[0];
    const who = (before ?? after)!.who;
    const fits =
      c.kind === "knockout"
        ? f.kos.some((k) => k.victim === me && k.by === who)
        : c.kind === "back"
          ? (f.behind[who]?.[me] ?? 0) > 0
          : c.kind === "hit"
            ? (f.damage[who]?.[me] ?? 0) > 0
            : (f.weapons![who]?.[me] ?? []).includes(c.weapon!);
    if (fits) continue;
    const ko = f.kos.find((k) => k.victim === me);
    const used = f.weapons ? ` with ${(f.weapons[who]?.[me] ?? []).join(", ") || "nothing"}` : "";
    out.push({
      claim: `${c.kind}${c.weapon ? ` (${c.weapon})` : ""} by ${names[who]}`,
      facts: `${names[who]} dealt ${Math.round(f.damage[who]?.[me] ?? 0)}${used} (${f.behind[who]?.[me] ?? 0} hits from behind); ${ko ? `knocked out by ${ko.by >= 0 ? names[ko.by] : "the level"} (${ko.weapon})` : "not knocked out"}`,
    });
  }
  return { checked: true, mismatches: out };
}

/** CheckFacts from a round's stats (RoundStats-shaped). */
export function checkFactsFromStats(st: { kos: CheckFacts["kos"]; damage: { damage: number; fromBehind: number; byWeapon: Record<string, { damage: number }> }[][] }): CheckFacts {
  return {
    kos: st.kos,
    damage: st.damage.map((row) => row.map((h) => h.damage)),
    behind: st.damage.map((row) => row.map((h) => h.fromBehind)),
    weapons: st.damage.map((row) => row.map((h) => Object.entries(h.byWeapon).filter(([, v]) => v.damage > 0).map(([k]) => k))),
  };
}
