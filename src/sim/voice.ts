/**
 * The decision slot: one function per fighter, called before each round
 * (the intro for round 1, the between-round dialogue after that). Given the
 * match state it returns what the fighter says and its strategy for the next
 * round. This is exactly where AI agents plug in: pass your own `Brain` per
 * fighter to `new Match(seed, { brains })`.
 *
 * houseBrain is the built-in version, driven by the fighter's soul: lines
 * from the soul's own `## Lines` (or, where it has none, template lines in
 * its voice), chosen by what actually happened and never repeated within a
 * session; strategy from the soul's fields, bent by morale and last round.
 */
import { buildsOn, NEUTRAL_BUILD } from "./build";
import type { Morale, MoraleState, RoundFacts } from "./morale";
import { allowedWeapon, CLASSIC, type Ruleset } from "./ruleset";
import type { Rng } from "./rng";
import { isPickupWeapon, type Rule, type Strategy, type Weapon } from "./sim-types";
import { availableRule } from "./rules";
import type { LineTemplate, Soul, Voice } from "./soul";

export interface DecideContext {
  ruleset?: Ruleset;
  /** "intro" before round 1, "between" after a round */
  phase: "intro" | "between";
  /** the round about to be played (1..3) */
  round: number;
  me: number;
  names: string[];
  /** every fighter's soul (identity, attitude, voice, what it values) */
  souls: Soul[];
  /** round wins so far, per fighter */
  wins: number[];
  morale: Morale[];
  /** facts of the round just played (null before round 1) */
  last: RoundFacts | null;
  history: RoundFacts[];
  /** session memory (avoid repeating lines across matches) */
  session: VoiceSession;
  /** randomness for line choice (the house brain keeps strategy choice separate) */
  lineRng: Rng;
  strategyRng: Rng;
  /** house bots add 0-2 plan rules from their soul (#6; on by default, off for A/B batches) */
  houseRules?: boolean;
}

export interface Decision {
  line: string;
  strategy: Strategy;
  /** which template was used (house brain), for no-repeat bookkeeping and tests */
  lineId?: string;
}

export type Brain = (ctx: DecideContext) => Decision;

export class VoiceSession {
  used = new Set<string>();
}

const WEAPON_PHRASE: Record<string, string> = {
  rocket: "a rocket",
  shotgun: "a shotgun blast",
  bat: "the bat",
  grenade: "a grenade",
  grapple: "the hook",
  flamethrower: "the flamethrower",
  fire: "the flames",
  fist: "a punch",
  barrel: "a barrel",
  tnt: "the TNT",
  gas: "a gas can",
  crush: "falling junk",
  impact: "a wall",
  fall: "gravity",
  zone: "the zone",
  unknown: "something",
};

/** Contexts that apply to this fighter now, most specific first. */
export function contextsFor(ctx: DecideContext): string[] {
  if (ctx.phase === "intro") return ["intro", "state"];
  const out: string[] = [];
  const f = ctx.last?.fighters[ctx.me];
  if (f) {
    const humMap: Record<string, string> = { "own-explosive": "hum:own", "bat-ringout": "hum:bat", "hook-ringout": "hum:hook", crushed: "hum:crush", barrel: "hum:barrel" };
    for (const h of f.humiliations) out.push(humMap[h.kind]!);
    if (f.won) {
      if (ctx.morale[ctx.me]!.comeback) out.push("win:comeback");
      if (f.kosDealt.length >= 2) out.push("win:multi");
      if (f.hpEnd >= 70) out.push("win:flawless");
      out.push("win");
    }
    if (f.koBy && f.koBy.by >= 0 && f.koBy.by !== ctx.me) out.push("kod");
    if (!f.won && f.kosDealt.length >= 2) out.push("multi");
    if (f.kosDealt.length) out.push("ko");
    if (!f.won && f.survived) out.push("survived");
  }
  const mine = ctx.wins[ctx.me]!;
  const best = Math.max(...ctx.wins.filter((_, i) => i !== ctx.me));
  if (ctx.round === 3) out.push("decider");
  if (mine === 1 && ctx.round <= 3) out.push("mp:for");
  if (best >= 1 && mine === 0) out.push("mp:against");
  out.push("state");
  return out;
}

function fill(text: string, ctx: DecideContext, strategy: Strategy): string | null {
  const f = ctx.last?.fighters[ctx.me];
  const name = (i: number | undefined) => (i !== undefined && i >= 0 ? ctx.names[i] : undefined);
  const leader = ctx.wins.indexOf(Math.max(...ctx.wins));
  const winner = ctx.last ? name(ctx.last.winner) : name(leader);
  const killer = f?.koBy ? name(f.koBy.by) : f?.humiliations.find((h) => h.by >= 0 && h.by !== ctx.me) ? name(f!.humiliations.find((h) => h.by >= 0 && h.by !== ctx.me)!.by) : undefined;
  const vals: Record<string, string | undefined> = {
    me: ctx.names[ctx.me],
    ME: ctx.names[ctx.me]?.toUpperCase(),
    killer,
    victim: f?.kosDealt.length ? name(f.kosDealt[f.kosDealt.length - 1]!.victim) : undefined,
    weapon: f?.koBy ? WEAPON_PHRASE[f.koBy.weapon] ?? f.koBy.weapon : f?.kosDealt.length ? WEAPON_PHRASE[f.kosDealt[f.kosDealt.length - 1]!.weapon] : undefined,
    winner: ctx.wins.some((w) => w > 0) ? name(ctx.wins.indexOf(Math.max(...ctx.wins))) : winner,
    grudge: name(ctx.morale[ctx.me]!.grudge),
    target: strategy.target === "grudge" ? name(strategy.grudge) : undefined,
    score: ctx.wins.join("-"),
    round: String(ctx.round),
  };
  let missing = false;
  const out = text.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vals[k];
    if (v === undefined) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

/**
 * Template lines by voice, for souls without their own lines (or without one
 * for this moment). Same contexts and placeholders as a soul's `## Lines`.
 */
export const VOICE_LINES: Record<Voice, LineTemplate[]> = {
  brash: [
    ["intro", "*", "Line up. I'll take you one at a time or all at once."],
    ["intro", "*", "I came here to win and I'm all out of patience."],
    ["win", "*", "THAT'S how it's done. Somebody write it down."],
    ["win", "*", "Round's mine. Next!"],
    ["kod", "*", "{killer}, that was luck. Next round you get the real thing."],
    ["kod", "*", "{killer} with {weapon}? Cheap shot. I'm coming."],
    ["ko", "*", "{victim} went flying. Did you see that? EVERYBODY saw that."],
    ["survived", "*", "Still standing. Still angry."],
    ["mp:for", "*", "One more round and I'm done here."],
    ["mp:against", "*", "{winner} thinks it's over. It's not over."],
    ["decider", "*", "Last round. Everything I've got."],
    ["state", "*", "Ring the bell already."],
    ["state", ["furious"], "{grudge}. You. Me. Now."],
  ],
  smug: [
    ["intro", "*", "I've done the arithmetic. It favors me."],
    ["intro", "*", "Do try to make this interesting."],
    ["win", "*", "As expected. Shall we go again?"],
    ["win", "*", "Precisely as planned."],
    ["kod", "*", "A fortunate {weapon}, {killer}. It won't repeat."],
    ["kod", "*", "{killer}. Noted. Corrected next round."],
    ["ko", "*", "{victim}, you were standing in a very poor spot."],
    ["survived", "*", "Survival is a skill. I have several."],
    ["mp:for", "*", "One more and I'll accept my trophy."],
    ["mp:against", "*", "{winner} leads. Briefly."],
    ["decider", "*", "The decider. How dramatic. I'll keep it brief."],
    ["state", "*", "Patience. The numbers come around."],
    ["state", ["furious"], "{grudge}, I've stopped being polite."],
  ],
  nervous: [
    ["intro", "*", "Hi. Hello. Please don't aim at me first."],
    ["intro", "*", "I'm fine. Totally fine. Why is everyone so big?"],
    ["win", "*", "I won? I WON? Is that allowed?"],
    ["win", "*", "Did everyone else just fall over? Thank you, luck."],
    ["kod", "*", "{killer} got me with {weapon}. Ow. Big ow."],
    ["kod", "*", "That was {killer}! I saw it! I felt it, mostly."],
    ["ko", "*", "Sorry, {victim}! Was that me? That was me."],
    ["survived", "*", "Still here! Nobody noticed me, which was the plan."],
    ["mp:for", "*", "One more win? Me? Don't jinx it. Don't jinx it."],
    ["mp:against", "*", "{winner} is winning. Should I be worried? I'm worried."],
    ["decider", "*", "Last round. Deep breaths. Tiny deep breaths."],
    ["state", "*", "Okay. Okay okay okay."],
    ["state", ["desperate"], "Nothing to lose now. Except everything. Here goes!"],
  ],
  sly: [
    ["intro", "*", "Go on, all of you. Wear each other out for me."],
    ["intro", "*", "I'll be around. Waiting."],
    ["win", "*", "Thanks for doing the hard work, everyone."],
    ["win", "*", "Patience pays. It always does."],
    ["kod", "*", "{killer} took a bite out of me. Rude."],
    ["kod", "*", "Well played, {killer}. I'll remember that taste."],
    ["ko", "*", "{victim} was looking a little tender."],
    ["survived", "*", "The last one standing usually gets the scraps. I like scraps."],
    ["mp:for", "*", "One more and the whole table is mine."],
    ["mp:against", "*", "{winner} is getting fat on wins. Good. More to take."],
    ["decider", "*", "Last round. Someone's going to be dinner."],
    ["state", "*", "I can wait. Can you?"],
    ["state", ["furious"], "{grudge}, you've made this personal."],
  ],
  plain: [
    ["intro", "*", "Let's fight."],
    ["intro", "*", "Ready when you are."],
    ["win", "*", "Round to me."],
    ["win", "*", "Good round. Again."],
    ["kod", "*", "{killer} got me with {weapon}. Next time."],
    ["ko", "*", "Got {victim}."],
    ["survived", "*", "Made it to the end."],
    ["mp:for", "*", "One more round."],
    ["mp:against", "*", "{winner} is ahead. Not for long."],
    ["decider", "*", "Last round. Let's go."],
    ["state", "*", "Let's go."],
  ],
};

/** Pick a line: first context with an unused template that fits morale and the facts. */
export function pickLine(ctx: DecideContext, strategy: Strategy): { line: string; id: string } {
  const soul = ctx.souls[ctx.me]!;
  const sid = soul.id || `seat${ctx.me}`;
  const state: MoraleState = ctx.morale[ctx.me]!.state;
  // the soul's own lines first; template lines in its voice fill the gaps
  const all = [...soul.lines.map((t, i) => ({ t, id: `${sid}:${i}` })), ...VOICE_LINES[soul.voice].map((t, i) => ({ t, id: `voice:${soul.voice}:${sid}:${i}` }))];
  const own = new Set(soul.lines.map((t) => t[0]));
  const fits = (t: LineTemplate) => t[1] === "*" || t[1].includes(state);
  const tryCtx = (c: string, allowUsed: boolean) => {
    const cands = all.filter(({ t, id }) => t[0] === c && fits(t) && (allowUsed || !ctx.session.used.has(id)) && (!own.has(c) || !id.startsWith("voice:")));
    const filled = cands.map((x) => ({ ...x, text: fill(x.t[2], ctx, strategy) })).filter((x) => x.text !== null);
    if (!filled.length) return null;
    // state-specific templates first, then any; random among the best
    const specific = filled.filter((x) => x.t[1] !== "*");
    const pool = specific.length && ctx.lineRng.chance(0.6) ? specific : filled;
    return pool[ctx.lineRng.u32() % pool.length]!;
  };
  const ctxs = contextsFor(ctx);
  for (const c of ctxs) {
    const got = tryCtx(c, false);
    if (got) return { line: got.text!, id: got.id };
  }
  // everything relevant already used this session: allow repeats, best context first
  for (const c of ctxs) {
    const got = tryCtx(c, true);
    if (got) return { line: got.text!, id: got.id };
  }
  return { line: soul.catchphrase || "...", id: `${sid}:catchphrase` };
}

/**
 * The house strategy: the soul's own play (its target, stance, weapons and
 * retaliate fields, or what its text implies), bent by morale and by what
 * happened last round. Temperament decides how morale bends it.
 */
export function houseStrategy(ctx: DecideContext): Strategy {
  const soul = ctx.souls[ctx.me]!;
  const m = ctx.morale[ctx.me]!;
  let weapons: Weapon[] = soul.weapons.slice();
  let stance = soul.stance;
  let target = soul.target;
  let grudge: number | undefined;
  const leader = ctx.wins.indexOf(Math.max(...ctx.wins));
  const someoneLeads = Math.max(...ctx.wins) > 0 && leader !== ctx.me;
  const hothead = soul.temperament === "cocky" || soul.values.some((v) => /never backs down|grudge/.test(v));
  const timid = soul.temperament === "nervous" || soul.stance === "cover";
  switch (m.state) {
    case "furious":
      if (m.grudge >= 0 && m.grudge !== ctx.me) {
        target = "grudge";
        grudge = m.grudge;
      }
      if (stance === "distance" || stance === "cover") stance = ctx.strategyRng.chance(0.5) ? "rush" : stance;
      break;
    case "desperate":
      if (someoneLeads) {
        target = "grudge";
        grudge = leader;
      }
      if (timid || stance === "item") stance = "item";
      else stance = "rush";
      break;
    case "rattled":
      if (stance === "distance") stance = "cover";
      if (hothead) target = "weakest";
      break;
    case "cocky":
      if (timid) stance = "rush"; // what could go wrong
      else if (hothead && !someoneLeads) target = soul.target;
      else if (someoneLeads) {
        target = "grudge";
        grudge = leader;
      } else target = "strongest";
      break;
    case "confident":
      break;
  }
  // whatever killed me last round goes up my wish list
  const killedBy = ctx.last?.fighters[ctx.me]?.koBy?.weapon as Weapon | undefined;
  if (killedBy && soul.weapons.length && isPickupWeapon(killedBy) && !weapons.includes(killedBy) && m.state !== "rattled") weapons = [weapons[0]!, killedBy, ...weapons.slice(1)].slice(0, 3);
  let retaliate: Strategy["retaliate"] = soul.retaliate;
  const st = ctx.last?.stats;
  if (st && retaliate !== "ignore") {
    // learned from last round: someone I ignored hurt me badly
    for (let a = 0; a < 4; a++) {
      if (a === ctx.me) continue;
      const dealt = st.damage[a]![ctx.me]!.damage;
      const chased = st.targetSeconds[ctx.me]![a]!;
      const total = st.targetSeconds[ctx.me]!.reduce((x, y) => x + y, 0);
      if (dealt >= 35 && (total === 0 || chased / total < 0.2)) retaliate = "attacker";
    }
  }
  const ruleset = ctx.ruleset ?? CLASSIC;
  weapons = weapons.filter(w => allowedWeapon(ruleset, w));
  if (!weapons.length) weapons = [ruleset.weapons.enabled[0]!];
  const rules = ctx.houseRules === false ? [] : houseRulesFor(soul).filter(r => availableRule(r, ruleset));
  // the soul's build (#80); with builds off in the ruleset, neutral
  const build = buildsOn(ruleset) ? { ...soul.build } : { ...NEUTRAL_BUILD };
  return { target, grudge, stance, weapons, retaliate, ...(rules.length ? { rules } : {}), build, line: "" };
}

/**
 * House-bot plan rules from a soul (#6): 0-2 rules, picked from its values,
 * stance and favorite weapon, highest priority first. Keeps house bots and
 * AIs on the same footing.
 */
export function houseRulesFor(soul: Soul): Rule[] {
  const text = `${soul.values.join(" ")} ${soul.body}`.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => text.includes(w));
  const out: Rule[] = [];
  if (soul.target === "weakest" || has("weakest", "finish off", "wounded")) out.push({ when: "health_below", who: "enemy", value: 30, do: "target", label: "finish the wounded" });
  if (has("grudge", "never forgets", "revenge")) out.push({ when: "chasing_me", who: "enemy", do: "target", label: "turn on the chaser" });
  if (soul.stance === "cover" || has("hides", "scared", "plays it safe")) out.push({ when: "my_health_below", value: 40, do: "seek", doItem: "health", label: "patch up" });
  const fav = soul.weapons[0];
  if (fav === "grapple" || fav === "bat") out.push({ when: "near_ledge", who: "enemy", do: "use", doItem: fav, label: fav === "grapple" ? "hook them off" : "bat them off" });
  else if (fav === "rocket" || fav === "grenade") out.push({ when: "near_barrel", who: "enemy", do: "use", doItem: fav, label: "light the barrel" });
  return out.slice(0, 2);
}

export const houseBrain: Brain = (ctx) => {
  const strategy = houseStrategy(ctx);
  const { line, id } = pickLine(ctx, strategy);
  ctx.session.used.add(id);
  return { line, strategy: { ...strategy, line }, lineId: id };
};

/**
 * The house autopilot (#80): plays an agent's seat when the agent misses its turn. The house bot's plan and line,
 * with a neutral build: the agent's body is never chosen for it.
 */
export const autopilotBrain: Brain = (ctx) => {
  const d = houseBrain(ctx);
  return { ...d, strategy: { ...d.strategy, build: { ...NEUTRAL_BUILD } } };
};
