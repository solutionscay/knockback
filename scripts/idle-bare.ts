/**
 * Bare-handed and standing still (src/stats/idle-bare.ts): list the spells in match records or in sims.
 *
 *   bun scripts/idle-bare.ts records <file|dir>...      replay records on the current sim (hash-checked)
 *     [--replay-plans]                                  play the recorded plans even where the hash moved (an after run)
 *   bun scripts/idle-bare.ts sims [count=50] [first=1]  Arena-style house-bot rounds on Classic
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { exampleSouls, initPhysics, Match, type MatchRecord } from "../src/sim";
import { resolveRuleset } from "../src/sim/ruleset";
import { IDLE_MIN_TICKS, IdleBareTracker, type IdleSpell } from "../src/stats/idle-bare";

function files(paths: string[]): string[] {
  return paths.flatMap((p) => statSync(p).isDirectory() ? files(readdirSync(p).map((f) => join(p, f))) : /\.json$/.test(p) && !/\.(prompts|checkins)\.json$/.test(p) ? [p] : []).sort();
}

function play(m: Match): IdleSpell[] {
  m.prepareRound();
  const t = new IdleBareTracker(m.fight!);
  const prev = m.onEvent;
  m.onEvent = (e) => {
    t.event(e);
    prev?.(e);
  };
  while (!m.step()) t.tick();
  t.finish();
  m.onEvent = prev;
  return t.spells;
}

await initPhysics();
const [mode, ...pos] = process.argv.slice(2);
const out: (IdleSpell & { src: string })[] = [];
let rounds = 0, diverged = 0;
if (mode === "records") {
  for (const file of files(pos.filter((p) => !p.startsWith("--")))) {
    const rec = JSON.parse(readFileSync(file, "utf8")) as MatchRecord;
    const m = new Match(rec.seed, { recorded: rec });
    const spells = play(m);
    const want = rec.rounds[0]?.fight.finalHash;
    if (want && want !== m.fight!.record.finalHash && !process.argv.includes("--replay-plans")) {
      diverged++;
      console.error(`diverged: ${file}`);
      continue;
    }
    rounds++;
    out.push(...spells.map((s) => ({ ...s, src: file.split("/").pop()! })));
  }
} else {
  const souls = exampleSouls();
  const ruleset = resolveRuleset({ round: { maxRounds: 1, winsToTake: 1 } });
  const count = Number(pos[0] ?? 50), first = Number(pos[1] ?? 1);
  for (let k = 0; k < count; k++) {
    const seed = first + k;
    const order = [0, 1, 2, 3].map((i) => (i + seed) % 4);
    out.push(...play(new Match(seed, { souls: order.map((i) => souls[i]!), ruleset })).map((s) => ({ ...s, src: `seed ${seed}` })));
    rounds++;
  }
}
const total = out.reduce((a, s) => a + s.end - s.start, 0);
console.log(`rounds ${rounds} (diverged ${diverged}); bare-handed and still (>= ${IDLE_MIN_TICKS / 60} s): ${out.length} spells, ${(total / 60).toFixed(1)} s in all`);
for (const s of out.sort((a, b) => b.end - b.start - (a.end - a.start)))
  console.log(`${s.src}  f${s.fighter}  ${(s.start / 60).toFixed(1)}-${(s.end / 60).toFixed(1)} s (${((s.end - s.start) / 60).toFixed(1)} s)  plan ${s.plan} played ${s.played}  at (${s.x}, ${s.y})  loose ${s.loose}  goalItem ${s.goalItem}  target f${s.target} ${s.targetDist} m`);
