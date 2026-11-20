# Knockback character bible

Four original fighters with cartoon-boxer swagger. The source of truth for code is `src/sim/characters.ts` (identity, signature loadout, morale baseline, line bank); this page is the human-readable version for writers and the art pass. Regenerate it with `bun scripts/bible.ts`.

**Morale** (`src/sim/morale.ts`): every fighter starts each match at their baseline and moves with what happens in each round: **cocky, confident, rattled, furious, desperate**. Morale changes their face and posture, slightly changes their aim, and decides what they say between rounds.

**Voice rules for all four:** one breath per line (under about 90 characters); always about something that just happened, or about themselves; slapstick, never cruel; no swearing.

## Brick "The Brawler" Ruckus

- **Color:** #ff4f4f · **Personality:** aggressive · **Morale baseline:** 44 (starts confident)
- **Signature:** bat + grapple, stance *rush*, goes after *strongest*
- **Catchphrase:** "Batter up."

**Look (for the art pass)**

- Barrel-chested red bean, a head shorter than he acts.
- Black headband with frayed tails, chipped-tooth grin, one cauliflower ear.
- Taped knuckles, boxing-trunk belt with a dented champion buckle.
- Bat over the shoulder like a lumberjack; the hook on his hip on a short chain.
- Posture: chin up, chest out, always bouncing on his toes.

**Voice:** Loud, short, punchy. Boxing talk, ALL-CAPS bursts, refers to himself as Brick when worked up. Never admits a mistake.

**Sample lines**

- *intro*: "Brick's here. Somebody call a doctor. Not for me."
- *win:flawless*: "Not a scratch. Somebody check if I even broke a sweat. I didn't."
- *hum:bat*: "Hit with a BAT? That's MY thing, {killer}! Get your own thing!"
- *hum:own*: "Who taught that rocket to turn around?! RIGGED."
- *kod*: "{killer}. You. Me. Next round. Bring a helmet."
- *mp:against*: "{winner} thinks it's over. It's over when Brick SAYS it's over."

(35 line templates in total.)

## Percival "The Sniper" Pike

- **Color:** #47a3ff · **Personality:** sniper · **Morale baseline:** 30 (starts confident)
- **Signature:** rocket + shotgun, stance *distance*, goes after *strongest*
- **Catchphrase:** "Geometry, darling."

**Look (for the art pass)**

- Tall, lean blue bean with perfect posture and a tiny bow tie.
- A scope antenna on his head he adjusts like a monocle.
- Carries the rocket launcher like a pool cue; polishes it between rounds.
- Gloves, pressed collar, one eyebrow permanently raised.

**Voice:** Smug, precise, condescending. Long words, percentages, calls people 'darling' or 'amateur'. Blames physics when he misses.

**Sample lines**

- *intro*: "I've calculated my odds. You won't like them."
- *win:flawless*: "Untouched. As the textbooks predicted."
- *hum:bat*: "Struck with a stick. By {killer}. How tragically primitive."
- *hum:own*: "My own rocket. The wind did that. Write that down: the wind."
- *kod*: "A lucky {weapon} from {killer}. Even a broken clock, darling."
- *mp:against*: "{winner} is ahead? Enjoy the view from up there, briefly."

(31 line templates in total.)

## Squeaks Malone, "The Rat"

- **Color:** #4fdc6a · **Personality:** coward · **Morale baseline:** -15 (starts rattled)
- **Signature:** grenade + shotgun, stance *cover*, goes after *nearest*
- **Catchphrase:** "Sorry! Sorry. Not sorry."

**Look (for the art pass)**

- Small, hunched green bean with enormous ears and twitchy whiskers.
- A helmet two sizes too big that slides over his eyes.
- Grenade bandolier across the chest, a lucky rabbit's foot on a keychain.
- Always peeking around cover; the crowd's favorite and he knows it.

**Voice:** Nervous, rambling, apologetic, superstitious. Talks to the crowd, his lucky charms and himself. Surprised every time he wins.

**Sample lines**

- *intro*: "Hi! Hello! Please don't hit me first. Or at all. Thanks."
- *win:flawless*: "I won? I WON? And nobody even touched me! Is that allowed?"
- *hum:bat*: "{killer} hit me with a bat and I went SO far. Is the ground still there?"
- *hum:own*: "I hit myself with my OWN grenade. Again. Don't tell the fans."
- *kod*: "{killer} got me with {weapon}. I knew this would happen. I said so."
- *mp:against*: "{winner} is so close to winning. Can I just... hide until it's over?"

(31 line templates in total.)

## Goldie "The Vulture" Vane

- **Color:** #ffc733 · **Personality:** opportunist · **Morale baseline:** 15 (starts confident)
- **Signature:** grapple + shotgun, stance *rush*, goes after *weakest*
- **Catchphrase:** "Thanks for softening them up."

**Look (for the art pass)**

- Gold bean with a paper crown worn at an angle and a ragged feather collar.
- A hooked visor like a beak, heavy rings on every finger.
- Grappling hook on a long gold chain she twirls while waiting.
- Hunched, patient, always circling; grins when someone is low on health.

**Voice:** Purring, patient, gloating. Bird and hunting talk, calls people 'snack' or 'leftovers'. Thanks the others for doing the hard work.

**Sample lines**

- *intro*: "Go on, fight each other. I'll be right here. Circling."
- *win:flawless*: "Barely lifted a talon. Thank you all for your hard work."
- *hum:bat*: "Batted off the edge by {killer}. Brutish. I'll remember the brute."
- *hum:own*: "My own rocket. Embarrassing. Nobody saw that. Nobody."
- *kod*: "{killer} got lucky with {weapon}. Lucky birds get eaten too."
- *mp:against*: "{winner} is ahead? Then {winner} is the biggest meal on the table."

(31 line templates in total.)

## How morale bends each character (house brain)

| State | Brick | Pike | Squeaks | Goldie |
|---|---|---|---|---|
| cocky | keeps hunting his favorite target, or the leader | hunts the leader | rushes in (what could go wrong) | hunts the leader |
| confident | signature play | signature play | signature play | signature play |
| rattled | picks on the weakest | hides in cover | signature (already hiding) | signature |
| furious | goes after whoever humiliated him | may drop distance and rush his grudge; swaps to rocket + hook | goes after his grudge | goes after her grudge |
| desperate | goes after the leader | goes after the leader | grabs items, hunts the leader | grabs items, hunts the leader |

Aim noise multipliers: cocky ×1.12, confident ×0.94, rattled ×1.3, furious ×1.15, desperate ×0.92.
