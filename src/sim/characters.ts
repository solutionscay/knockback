/**
 * The four fighters: identity, look notes (for the art pass), voice, signature
 * loadout, morale baseline, and their line bank. Original characters.
 *
 * Line templates: [context, morale states ("*" = any), text]. Placeholders:
 *   {me} {killer} {victim} {winner} {grudge} {target} {weapon} {score} {round}
 * Contexts (between rounds, most specific first):
 *   hum:own hum:bat hum:hook hum:crush hum:barrel   humiliations
 *   win:flawless win:comeback win:multi win          this fighter won the round
 *   kod        knocked out by {killer} with {weapon}
 *   multi      dealt 2+ knockouts without winning
 *   ko         knocked out {victim} with {weapon}
 *   survived   lasted to the end but did not win
 *   mp:for     I am on match point        mp:against   someone else is
 *   decider    round 3, it all comes down to this
 *   state      generic, by morale state   intro   before round 1
 */
import type { MoraleState } from "./morale";
import type { Personality, Stance, TargetPref, Weapon } from "./sim";

export type LineTemplate = [ctx: string, states: "*" | MoraleState[], text: string];

export interface Character {
  id: number;
  name: string;
  fullName: string;
  title: string;
  color: number;
  personality: Personality;
  /** walk speed multiplier */
  speed: number;
  moraleBaseline: number;
  signature: { loadout: [Weapon, Weapon]; stance: Stance; target: TargetPref };
  look: string[];
  voice: string;
  catchphrase: string;
  lines: LineTemplate[];
}

const C = (s: MoraleState[]) => s;

export const CHARACTERS: Character[] = [
  {
    id: 0,
    name: "Brick",
    fullName: "Brick \"The Brawler\" Ruckus",
    title: "The Brawler",
    color: 0xff4f4f,
    personality: "aggressive",
    speed: 1.08,
    moraleBaseline: 50,
    signature: { loadout: ["bat", "grapple"], stance: "rush", target: "nearest" },
    look: [
      "Barrel-chested red bean, a head shorter than he acts.",
      "Black headband with frayed tails, chipped-tooth grin, one cauliflower ear.",
      "Taped knuckles, boxing-trunk belt with a dented champion buckle.",
      "Bat over the shoulder like a lumberjack; the hook on his hip on a short chain.",
      "Posture: chin up, chest out, always bouncing on his toes.",
    ],
    voice: "Loud, short, punchy. Boxing talk, ALL-CAPS bursts, refers to himself as Brick when worked up. Never admits a mistake.",
    catchphrase: "Batter up.",
    lines: [
      ["intro", "*", "Brick's here. Somebody call a doctor. Not for me."],
      ["intro", C(["cocky"]), "Four of us walk in. One walks out. It's me. Saves time."],
      ["intro", C(["cocky"]), "I already wrote my victory speech. It's just the word BRICK."],
      ["intro", C(["confident"]), "Hook 'em, whack 'em, wave goodbye. Easy."],
      ["intro", C(["rattled", "desperate"]), "Nobody's laughing. I SAID nobody's laughing."],
      ["win:flawless", "*", "Not a scratch. Somebody check if I even broke a sweat. I didn't."],
      ["win:flawless", "*", "That's called a clean sheet, pal. Frame it."],
      ["win:comeback", "*", "Knock Brick down, Brick gets UP. Write that on my statue."],
      ["win:multi", "*", "Two for the price of one. Line 'em up, I got more swings."],
      ["win", "*", "ROUND TO BRICK! Ring the bell, ring it LOUDER."],
      ["win", C(["cocky"]), "That's one. Start warming up your excuses."],
      ["win", "*", "You see that? That's what a fist with a bat looks like."],
      ["hum:own", "*", "Who taught that rocket to turn around?! RIGGED."],
      ["hum:bat", "*", "Hit with a BAT? That's MY thing, {killer}! Get your own thing!"],
      ["hum:hook", "*", "Reeled me in like a fish. {killer}, you're on my LIST."],
      ["hum:crush", "*", "Something fell on me. Brick didn't fall. Something fell ON Brick."],
      ["hum:barrel", "*", "A barrel. {killer} set off a BARREL. Fight me like a person!"],
      ["kod", C(["furious"]), "{killer}. You. Me. Next round. Bring a helmet."],
      ["kod", C(["furious"]), "That was a lucky {weapon}, {killer}. Luck runs out. I DON'T."],
      ["kod", "*", "I slipped. Everybody saw me slip. That doesn't count."],
      ["kod", C(["rattled", "desperate"]), "Okay. Okay okay okay. Brick's just warming up. Shut up."],
      ["multi", "*", "Two knockouts and I DIDN'T win? Count again."],
      ["ko", "*", "Bye bye, {victim}! Send me a postcard from the pit."],
      ["ko", "*", "{victim} flew so far they need a passport."],
      ["survived", "*", "Still standing. Still mad. Still Brick."],
      ["mp:for", "*", "One more round and I'm buying a bigger belt."],
      ["mp:against", "*", "{winner} thinks it's over. It's over when Brick SAYS it's over."],
      ["mp:against", C(["desperate"]), "Okay, deep breaths. Brick doesn't need deep breaths. BRICK IS FINE."],
      ["decider", "*", "Round three. My favorite number is three. It's also one. It's whatever wins."],
      ["state", C(["cocky"]), "Honestly, I'm bored. Somebody try harder."],
      ["state", C(["confident"]), "Ring the bell, I'm hungry."],
      ["state", C(["rattled"]), "My ears are ringing and I like it. Mostly."],
      ["state", C(["furious"]), "No more Mister Nice Brick. There was never a Mister Nice Brick."],
      ["state", C(["furious"]), "{grudge}, I'm coming for you and I'm bringing the bat."],
      ["state", C(["desperate"]), "All in. All of it. Every swing I got."],
    ],
  },
  {
    id: 1,
    name: "Pike",
    fullName: "Percival \"The Sniper\" Pike",
    title: "The Sniper",
    color: 0x47a3ff,
    personality: "sniper",
    speed: 1.04,
    moraleBaseline: 30,
    signature: { loadout: ["rocket", "shotgun"], stance: "distance", target: "strongest" },
    look: [
      "Tall, lean blue bean with perfect posture and a tiny bow tie.",
      "A scope antenna on his head he adjusts like a monocle.",
      "Carries the rocket launcher like a pool cue; polishes it between rounds.",
      "Gloves, pressed collar, one eyebrow permanently raised.",
    ],
    voice: "Smug, precise, condescending. Long words, percentages, calls people 'darling' or 'amateur'. Blames physics when he misses.",
    catchphrase: "Geometry, darling.",
    lines: [
      ["intro", "*", "I've calculated my odds. You won't like them."],
      ["intro", C(["cocky", "confident"]), "Please stand very still. It's kinder for everyone."],
      ["intro", C(["confident"]), "Distance is a gentleman's weapon. I brought plenty."],
      ["intro", C(["rattled", "desperate"]), "Ahem. The wind is unusually hostile today."],
      ["win:flawless", "*", "Untouched. As the textbooks predicted."],
      ["win:flawless", "*", "I'd say good game, but I make it a rule never to lie."],
      ["win:comeback", "*", "A temporary statistical anomaly, now corrected."],
      ["win:multi", "*", "Two clean trajectories. Do try to keep up, darlings."],
      ["win", "*", "Round to Pike. I did warn you about the geometry."],
      ["win", C(["cocky"]), "Shall I explain what happened? Slowly?"],
      ["hum:own", "*", "My own rocket. The wind did that. Write that down: the wind."],
      ["hum:bat", "*", "Struck with a stick. By {killer}. How tragically primitive."],
      ["hum:hook", "*", "Dragged off a ledge by {killer}. Undignified. Unforgivable."],
      ["hum:crush", "*", "Flattened by architecture. I'll be filing a complaint."],
      ["hum:barrel", "*", "Undone by a barrel, of all things. {killer}, that was crude."],
      ["kod", "*", "A lucky {weapon} from {killer}. Even a broken clock, darling."],
      ["kod", C(["furious"]), "{killer}. I'm recalibrating. You won't enjoy round two."],
      ["kod", C(["rattled", "desperate"]), "I'm... adjusting my figures. That's all this is."],
      ["multi", "*", "Two knockouts and no trophy. Where is the justice."],
      ["ko", "*", "Nice bat, {victim}. Shame about your aim."],
      ["ko", "*", "{victim} never saw it coming. They rarely do."],
      ["survived", "*", "I simply chose not to be hit. You should all try it."],
      ["mp:for", "*", "One more round. I've already chosen my podium angle."],
      ["mp:against", "*", "{winner} is ahead? Enjoy the view from up there, briefly."],
      ["mp:against", C(["desperate"]), "Very well. No more elegance. Only results."],
      ["decider", "*", "The decider. How deliciously dramatic. I'll keep it brief."],
      ["state", C(["cocky"]), "I could do this blindfolded. Perhaps I will."],
      ["state", C(["confident"]), "Range finder on. Patience set to infinite."],
      ["state", C(["rattled"]), "Everyone is so... close. Why is everyone so close?"],
      ["state", C(["furious"]), "{grudge}, I've stopped being polite. I was being polite."],
      ["state", C(["desperate"]), "Fine. FINE. I'll get my gloves dirty."],
    ],
  },
  {
    id: 2,
    name: "Squeaks",
    fullName: "Squeaks Malone, \"The Rat\"",
    title: "The Rat",
    color: 0x4fdc6a,
    personality: "coward",
    speed: 1.05,
    moraleBaseline: -15,
    signature: { loadout: ["grenade", "shotgun"], stance: "cover", target: "nearest" },
    look: [
      "Small, hunched green bean with enormous ears and twitchy whiskers.",
      "A helmet two sizes too big that slides over his eyes.",
      "Grenade bandolier across the chest, a lucky rabbit's foot on a keychain.",
      "Always peeking around cover; the crowd's favorite and he knows it.",
    ],
    voice: "Nervous, rambling, apologetic, superstitious. Talks to the crowd, his lucky charms and himself. Surprised every time he wins.",
    catchphrase: "Sorry! Sorry. Not sorry.",
    lines: [
      ["intro", "*", "Hi! Hello! Please don't hit me first. Or at all. Thanks."],
      ["intro", C(["rattled"]), "I brought grenades. And snacks. Mostly grenades."],
      ["intro", C(["rattled", "desperate"]), "Lucky foot? Check. Helmet? Check. Will to live? ...Check-ish."],
      ["intro", C(["confident", "cocky"]), "The fans are chanting my name. I think. It sounds like 'SQUEAKS'."],
      ["win:flawless", "*", "I won? I WON? And nobody even touched me! Is that allowed?"],
      ["win:flawless", "*", "Mom, if you're watching: I hid behind a box the whole time and it WORKED."],
      ["win:comeback", "*", "The comeback rat! Somebody print shirts!"],
      ["win:multi", "*", "Two knockouts? Me? I'm so sorry. I'm so happy. I'm so sorry."],
      ["win", "*", "Did... did everyone else just fall over? Thank you, rabbit foot."],
      ["win", "*", "That's for every time somebody called me 'the green one'."],
      ["hum:own", "*", "I hit myself with my OWN grenade. Again. Don't tell the fans."],
      ["hum:bat", "*", "{killer} hit me with a bat and I went SO far. Is the ground still there?"],
      ["hum:hook", "*", "{killer} hooked me off a ledge! I was hiding! Hiding is SAFE!"],
      ["hum:crush", "*", "Something heavy fell on me. I'd like to go home now."],
      ["hum:barrel", "*", "A barrel. Of course it was a barrel. {killer}, why are you like this?"],
      ["kod", "*", "{killer} got me with {weapon}. I knew this would happen. I said so."],
      ["kod", C(["furious"]), "Okay, {killer}. The rat bites back now. Squeak."],
      ["kod", C(["rattled", "desperate"]), "I'm fine. I'm fine! That's my 'I'm fine' face. It looks like this."],
      ["multi", "*", "I knocked out two people and still lost? Is there a sad-trophy?"],
      ["ko", "*", "Sorry, {victim}! Sorry! ...That was kind of great, though."],
      ["ko", "*", "{victim} stepped on my grenade. Technically their fault."],
      ["survived", "*", "Still alive! That's basically a win for me. Right? RIGHT?"],
      ["mp:for", "*", "One more round and the rat takes the cheese. Oh no, I'm nervous."],
      ["mp:against", "*", "{winner} is so close to winning. Can I just... hide until it's over?"],
      ["mp:against", C(["desperate"]), "Okay, rabbit foot. This is the big one. Please work. PLEASE."],
      ["decider", "*", "Round three. I'm going to throw up. Or win. Maybe both."],
      ["state", C(["cocky"]), "Am I... good at this? The crowd thinks so. I think so!"],
      ["state", C(["confident"]), "Grenades armed. Courage... loading."],
      ["state", C(["rattled"]), "Everyone is so big and loud. I'll be behind that crate."],
      ["state", C(["furious"]), "{grudge} made the rat ANGRY. Nobody's ever seen an angry rat."],
      ["state", C(["desperate"]), "No more hiding. Okay, a little hiding. Then no more hiding."],
    ],
  },
  {
    id: 3,
    name: "Goldie",
    fullName: "Goldie \"The Vulture\" Vane",
    title: "The Vulture",
    color: 0xffc733,
    personality: "opportunist",
    speed: 1.0,
    moraleBaseline: 15,
    signature: { loadout: ["grapple", "shotgun"], stance: "rush", target: "weakest" },
    look: [
      "Gold bean with a paper crown worn at an angle and a ragged feather collar.",
      "A hooked visor like a beak, heavy rings on every finger.",
      "Grappling hook on a long gold chain she twirls while waiting.",
      "Hunched, patient, always circling; grins when someone is low on health.",
    ],
    voice: "Purring, patient, gloating. Bird and hunting talk, calls people 'snack' or 'leftovers'. Thanks the others for doing the hard work.",
    catchphrase: "Thanks for softening them up.",
    lines: [
      ["intro", "*", "Go on, fight each other. I'll be right here. Circling."],
      ["intro", C(["cocky", "confident"]), "I love a crowd. So many leftovers."],
      ["intro", C(["confident"]), "You do the hitting. I'll do the winning."],
      ["intro", C(["rattled", "desperate"]), "Hm. Everyone looks healthy. How inconvenient."],
      ["win:flawless", "*", "Barely lifted a talon. Thank you all for your hard work."],
      ["win:flawless", "*", "You softened each other up so nicely. I'm touched."],
      ["win:comeback", "*", "Vultures don't mind waiting. Patience, darlings, patience."],
      ["win:multi", "*", "Two little snacks, one after the other. Delicious."],
      ["win", "*", "The last one standing is the one who waited. Me."],
      ["win", C(["cocky"]), "Crown fits. Crown always fits."],
      ["hum:own", "*", "My own rocket. Embarrassing. Nobody saw that. Nobody."],
      ["hum:bat", "*", "Batted off the edge by {killer}. Brutish. I'll remember the brute."],
      ["hum:hook", "*", "Hooked off a ledge? By {killer}? That's MY move, you thief."],
      ["hum:crush", "*", "Crushed under a heap. Me. The scavenger, scavenged."],
      ["hum:barrel", "*", "Blown up by {killer}'s barrel. Cheap. I adore cheap, just not on me."],
      ["kod", "*", "{killer} got lucky with {weapon}. Lucky birds get eaten too."],
      ["kod", C(["furious"]), "{killer}. I'm done circling. I'm diving."],
      ["kod", C(["rattled", "desperate"]), "Fine. I'll pick at whatever's left. There's always something left."],
      ["multi", "*", "Two knockouts and still no crown. Someone stole my meal."],
      ["ko", "*", "Off the ledge you go, {victim}. Wave to the fishes."],
      ["ko", "*", "{victim} looked tired. I helped them lie down."],
      ["survived", "*", "Still here. Vultures outlive everything. Eventually."],
      ["mp:for", "*", "One more and the crown is mine. I can smell it."],
      ["mp:against", "*", "{winner} is ahead? Then {winner} is the biggest meal on the table."],
      ["mp:against", C(["desperate"]), "No more waiting. Even vultures get hungry."],
      ["decider", "*", "Round three. Everyone's tired. My favorite kind of everyone."],
      ["state", C(["cocky"]), "I could circle all day. I might."],
      ["state", C(["confident"]), "Find the weakest, hook them, keep the change."],
      ["state", C(["rattled"]), "Everyone's so... full of health. Disgusting."],
      ["state", C(["furious"]), "{grudge}, I'm skipping the circling. Straight to dessert."],
      ["state", C(["desperate"]), "Every scrap matters now. Every single scrap."],
    ],
  },
];
