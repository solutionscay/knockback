/** Regenerates docs/characters.md from src/sim/characters.ts: bun scripts/bible.ts */
import { CHARACTERS } from "../src/sim/characters";
import { MORALE_EFFECT } from "../src/sim/morale";

const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");
const start = (b: number) => (b >= 45 ? "cocky" : b >= 0 ? "confident" : "rattled");
let md = `# Knockback character bible

Four original fighters with cartoon-boxer swagger. The source of truth for code is \`src/sim/characters.ts\` (identity, signature loadout, morale baseline, line bank); this page is the human-readable version for writers and the art pass. Regenerate it with \`bun scripts/bible.ts\`.

**Morale** (\`src/sim/morale.ts\`): every fighter starts each match at their baseline and moves with what happens in each round: **cocky, confident, rattled, furious, desperate**. Morale changes their face and posture, slightly changes their aim, and decides what they say between rounds.

**Voice rules for all four:** one breath per line (under about 90 characters); always about something that just happened, or about themselves; slapstick, never cruel; no swearing.

`;
for (const c of CHARACTERS) {
  md += `## ${c.fullName}\n\n`;
  md += `- **Color:** ${hex(c.color)} · **Personality:** ${c.personality} · **Morale baseline:** ${c.moraleBaseline} (starts ${start(c.moraleBaseline)})\n`;
  md += `- **Signature:** ${c.signature.loadout.join(" + ")}, stance *${c.signature.stance}*, goes after *${c.signature.target}*\n`;
  md += `- **Catchphrase:** "${c.catchphrase}"\n\n`;
  md += `**Look (for the art pass)**\n\n${c.look.map((l) => `- ${l}`).join("\n")}\n\n`;
  md += `**Voice:** ${c.voice}\n\n**Sample lines**\n\n`;
  for (const ctx of ["intro", "win:flawless", "hum:bat", "hum:own", "kod", "mp:against"]) {
    const l = c.lines.find((x) => x[0] === ctx);
    if (l) md += `- *${ctx}*: "${l[2]}"\n`;
  }
  md += `\n(${c.lines.length} line templates in total.)\n\n`;
}
md += `## How morale bends each character (house brain)

| State | Brick | Pike | Squeaks | Goldie |
|---|---|---|---|---|
| cocky | keeps hunting his favorite target, or the leader | hunts the leader | rushes in (what could go wrong) | hunts the leader |
| confident | signature play | signature play | signature play | signature play |
| rattled | picks on the weakest | hides in cover | signature (already hiding) | signature |
| furious | goes after whoever humiliated him | may drop distance and rush his grudge; swaps to rocket + hook | goes after his grudge | goes after her grudge |
| desperate | goes after the leader | goes after the leader | grabs items, hunts the leader | grabs items, hunts the leader |

Aim noise multipliers: ${Object.entries(MORALE_EFFECT).map(([k, v]) => `${k} ×${v.aim}`).join(", ")}.
`;
await Bun.write("docs/characters.md", md);
console.log("docs/characters.md", md.length, "chars");
