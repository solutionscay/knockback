# Souls: how a fighter thinks and talks

Knockback has no character classes. All four fighters have the same body, speed, health and aim, and start every round with only their **fists**. Weapons (rocket, shotgun, bat, grenade, grappling hook) and power-ups are picked up in the arena.

A fighter's personality comes from its **soul file**: attitude, how it talks and what it values in a fight. Swap a soul and the fighter plays and talks differently. A soul has **no name and no look**: before each match every fighter gets a generated identity (name, head shape, eye style, mark and color) from the match seed. See "Identities" below.

- **AI fighters** read the soul (its text, values and catchphrase) and choose their own strategy and lines before every round.
- **House bots** (no AI attached) map the soul's fields to a strategy, or guess from keywords in its text when a field is missing. They speak the soul's own lines, falling back to template lines in the soul's voice.
- **Records** store the souls and the identities that played, so a replay needs no soul files.

Four example souls ship in `souls/`: `brawler.md`, `sniper.md`, `rat.md` and `vulture.md`. The file name is the soul's key (for `--lineup sniper=codex` and logs). It is never shown in the game.

## Format

A soul is a Markdown file with three parts:

1. A **front matter** block of `key: value` lines between `---` fences. All keys are optional.
2. A free-text **body**: attitude, how the fighter talks and what it values. AI fighters read this.
3. An optional **`## Lines`** section: what the house bot says. AI fighters never see it.

```markdown
---
temperament: cocky
voice: brash
values: never backs down, holds grudges, loves a ring-out
weapons: bat, grapple, shotgun
stance: rush
target: strongest
retaliate: attacker
catchphrase: Batter up.
---

# The brawler

Loud, hot-headed, never admits a mistake. Short punchy bursts, boxing talk.
Use the catchphrase sparingly: at most once a match.

## Lines

- intro: {me}'s here. Somebody call a doctor. Not for me.
- kod [furious]: {killer}. You. Me. Next round. Bring a helmet.
```

### Front matter keys

| Key | Values | Used for |
|---|---|---|
| `temperament` | `cocky`, `confident`, `calm`, `nervous` | starting morale (45, 25, 8, -15); how morale bends the house bot's plan |
| `voice` | `brash`, `smug`, `nervous`, `sly`, `plain` | which template lines the house bot falls back on |
| `values` | comma-separated phrases | shown to the AI ("what you value in a fight"); keywords feed the house bot |
| `weapons` | 1 to 3 of `rocket`, `shotgun`, `bat`, `grenade`, `grapple` (`hook` also works), best first | the house bot's weapon wishes; a habit the AI is told about |
| `stance` | `rush`, `distance`, `cover`, `item` | the house bot's stance |
| `target` | `nearest`, `weakest`, `strongest`, `leader` | the house bot's target preference |
| `retaliate` | `attacker`, `turn`, `ignore` | what the house bot does when hit from behind by someone it is not chasing |
| `catchphrase` | free text, up to 80 characters | shown to the AI (to use sparingly); the house bot's last-resort line |

A bad value (an unknown stance or weapon) is an **error**, and `bun run ai-match` refuses to start with a message naming the file and the key. A missing key is filled in instead: from keywords in `values` and the body, otherwise from a default. The old identity keys (`name`, `title`, `color`, `mark`) are ignored with a warning. The four soul files must have different names.

Write the body and lines without a name or a look: the fighter could be called anything and look like anything. Use `{me}` (or `{ME}` for capitals) where the fighter says its own name.

## Identities (#17)

Before each match, `assignIdentities(seed)` in `src/sim/identity.ts` gives each seat:

| Field | Pool |
|---|---|
| `name` | mostly two syllables ("Zap" + "ko"), sometimes (1 in 8) a machine word ("Rivet"); at most 12 characters; never a shape, eye or mark word |
| `shape` | 20 head shapes: Skiff's 8 Skipper bodies plus 12 new ones, in silhouette families |
| `eyes` | 12 resting eye styles on the dot visor |
| `mark` | one of 14 major marks: silhouettes that read at 720p (headband, antenna, crown, ears, horns, cape, ...) |
| `minor` | for half the fighters, one of 4 minor marks for close-ups (bolts, scratch, bandage, scarf) |
| `color` | a saturated color of any hue, bright enough for every arena; blues are drawn lighter (each hue has its own lightness floor) |

In a match:
- no two fighters share a major mark, or a shape from the same silhouette family (round: squircle, dome, pill, egg, barrel, octagon; capped: mushroom, acorn; trapezoid: keystone, bucket; peaked: bell, onion; every other shape is a family of its own);
- names do not start with the same three letters;
- the four colors are drawn together (evenly spread hues, then shuffled over the seats) and are at least 0.11 apart in OKLab.

The identity uses its own random stream from the match seed, so it never moves the level, the plans or the lines, and it is not part of the sim's state hash. Records (version 4) store the identities; version 2 and 3 records keep their souls' old names and colors. On a light page, write a fighter's name in `nameInk(color)` (`src/viewer/palette.ts`), not in the raw color.

A fighter may later choose its own identity (#19): pass `identityWishes` to `Match`. A valid wish that no earlier seat took is kept; the rest is generated. Wished colors are kept first, and the other colors are drawn around them.

### What the house bot reads from the text

When `stance`, `target`, `retaliate`, `temperament`, `voice` or `weapons` is missing, the house bot looks for these phrases (in this order) in `values` and the body:

| Field | Phrases |
|---|---|
| target | "weakest", "finish off" → weakest; "strongest", "biggest threat" → strongest; "leader", "whoever is winning" → leader; "nearest" → nearest |
| stance | "hide", "scared", "cover", "cautious" → cover; "distance", "snipe", "long range" → distance; "loot", "collect", "power-up", "pickups" → item; "never backs down", "charge", "rush", "brawl" → rush |
| retaliate | "grudge", "never forgets", "revenge" → attacker; "ignores", "single-minded" → ignore |
| weapons | any weapon named in the text ("hook" means the grapple) |
| temperament | "cocky", "arrogant", "talks big" → cocky; "nervous", "scared" → nervous; "calm", "patient" → calm |
| voice | "loud", "trash talk" → brash; "smug", "posh" → smug; "nervous", "apolog…" → nervous; "sly", "gloat" → sly |

The code is `inferFromText` in `src/sim/soul.ts`.

### The `## Lines` section

Each line is `- context [morale states]: text`. The states are optional (`cocky`, `confident`, `rattled`, `furious`, `desperate`); without them a line fits any morale.

**Contexts**, most specific first:

| Context | When |
|---|---|
| `intro` | before round 1 |
| `win:flawless`, `win:comeback`, `win:multi`, `win` | this fighter won the round |
| `hum:own`, `hum:bat`, `hum:hook`, `hum:crush`, `hum:barrel` | humiliations: own explosive, batted or hooked off the level, crushed, a barrel |
| `kod` | knocked out by {killer} with {weapon} |
| `multi` | dealt 2 or more knockouts without winning |
| `ko` | knocked out {victim} |
| `survived` | lasted to the end but did not win |
| `mp:for`, `mp:against` | match point for me, or for someone else |
| `decider` | round 3 |
| `state` | generic, by morale |

**Placeholders:** `{me}` `{ME}` `{killer}` `{victim}` `{winner}` `{grudge}` `{target}` `{weapon}` `{score}` `{round}`. A line whose placeholder has no value right now is skipped. Lines are not repeated within a session until the relevant ones run out. A soul with no lines of its own (or none for the moment) still talks, using template lines in its `voice` (`VOICE_LINES` in `src/sim/voice.ts`).

## What a strategy is now

Before every round each fighter (AI or house bot) picks:

- **`weapons`**: 1 to 3 pickups to go for and use, best first. Nobody is handed a loadout. Unarmed fighters go a long way for any weapon; armed ones detour only for one they rank higher than the one not in their hand (or for anything, with stance `item`).
- **`target`**: a fighter's name, or `nearest`, `weakest`, `strongest`, `leader`.
- **`stance`**: `rush`, `distance`, `cover`, or `item` (detour for every pickup and power-up).
- **`retaliate`**: what to do after 3 hits from behind by someone it isn't chasing:
  - `attacker`: abandon the plan and chase them for 10 s;
  - `turn`: fight back for 3 s, then resume the plan;
  - `ignore`: glance back and stay on the plan.
- **`line`**: what it says.

## Pickup rules (engine)

- Everyone starts with fists: a weak, short jab with a small shove (3.5 damage). It never runs out and can defend a pickup, but it won't win a round.
- A fighter carries 2 weapons. A pickup fills an empty (fists) slot first. Otherwise it replaces the weapon not in hand, and the replaced weapon drops into the arena for anyone to grab. Whoever dropped it can't re-grab it for 0.75 s.
- A fighter knocked out by damage drops its weapons where it fell.
- At the start of a round there is one weapon near each spawn (toward the middle), three in the middle and one up high, never stacked. Crates drop an item 90% of the time (55% of those are weapons). A supply drop comes every 6 s from 4 s on (65% weapons, fewer once 8 weapons are lying around).
- The numbers are in `ARMORY`, `SUPPLY`, `CRATE` and `WEAPONS.fist` in `src/sim/constants.ts`, and `PICKUP` in `src/sim/controller.ts`.
