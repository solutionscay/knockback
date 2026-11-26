/**
 * Pool exits (#152): every water, slime and coolant pool of a generated level has an exit a swimmer can reach (a ledge
 * within a stroke's reach over the liquid's top, with room to stand), on each theme with such pools. The level
 * validator enforces it (a level without one is the next attempt); this checks the levels the generator gives.
 *
 *   bun scripts/pool-exits.ts [seeds=1000] [first=1]      exits 1 if any pool has none
 */
import { CLASSIC, themedRuleset, validateRuleset } from "../src/sim/ruleset";
import { generateLevel } from "../src/sim/levelgen";
import { poolExits, strokeReach } from "../src/sim/level-validate";
import { Liquid } from "../src/sim/grid";
import { ALL_THEMES } from "../src/sim/themes";

const count = Number(process.argv[2] ?? 1000);
const first = Number(process.argv[3] ?? 1);
const H = (t: (typeof ALL_THEMES)[number]) => CLASSIC.arena.themes[t].hazards;
const themes = ALL_THEMES.filter((t) => H(t).pools[1] > 0 && H(t).water + H(t).slime + H(t).coolant > 0);
let failed = 0;
console.log(`seeds ${first}..${first + count - 1}`);
for (const theme of themes) {
  const ruleset = validateRuleset({ arena: { enabledThemes: [theme] } });
  const themed = themedRuleset(ruleset, theme);
  const reach = [Liquid.Water, Liquid.Slime, Liquid.Coolant].filter((l) => (l === Liquid.Water ? H(theme).water : l === Liquid.Slime ? H(theme).slime : H(theme).coolant) > 0).map((l) => strokeReach(themed, l).toFixed(2));
  let pools = 0, both = 0, one = 0, none = 0;
  const lips: Record<string, number> = {};
  const bad: string[] = [];
  for (let seed = first; seed < first + count; seed++) {
    const lv = generateLevel(seed, undefined, ruleset);
    for (const e of poolExits(lv, themed)) {
      pools++;
      for (const l of e.lips) lips[l.toFixed(1)] = (lips[l.toFixed(1)] ?? 0) + 1;
      const n = Number(e.ok[0]) + Number(e.ok[1]);
      if (n === 2) both++;
      else if (n === 1) one++;
      else {
        none++;
        if (bad.length < 10) bad.push(`seed ${seed} pool ${e.x0}..${e.x1} lips ${e.lips.join("/")}`);
      }
    }
  }
  failed += none;
  console.log(`${theme.padEnd(8)} stroke reach ${reach.join("/")} m  pools ${pools}: exits on both sides ${both}, one side ${one}, none ${none}  lips (m: sides) ${JSON.stringify(lips)}${bad.length ? `\n  ${bad.join("\n  ")}` : ""}`);
}
process.exit(failed ? 1 : 0);
