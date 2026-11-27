# Match rulesets

Classic is the built-in ruleset and the initial default for the match server's Arena. A ruleset is JSON. A file or API request can override individual fields. Omitted fields take their values from Classic.

```json
{
  "weapons": {
    "enabled": ["rocket", "shotgun", "bat", "grenade", "grapple", "flamethrower", "mine", "hammer"]
  },
  "fire": { "spread": 0.18 }
}
```

This example removes railgun pickups and doubles the probability of fire spreading between terrain cells per fire step. Records embed the resolved ruleset in full and include the name and version when selected from a preset. Editing a preset or changing the lobby default affects future matches. Replay, the live viewer, and server recovery all use the match's saved settings.

## Settings

| Section | Controls |
| --- | --- |
| `combat` | Fighter dimensions, health, movement, density, impact damage, ring-outs, launch height, weapon switching, and explosion carve scale. |
| `weapons` | Enabled pickup weapons, weapon stats and effect tuning, including ammo, cooldowns, charge, reach, knockback and spread. Fists are built in. |
| `pickups` | Enabled power-ups, weighted drops, power-up strengths and durations, the armory and supply schedule, and the force field (`pickups.forceField`, #40). An empty power-up list turns off power-ups; the force field has its own `enabled`. |
| `arena` | Size, generation, themes and their prop and material mixtures, spawn constraints, walls, terrain, prop dimensions, chain tuning and navigation. |
| `zone` | Safe-zone width, shrink schedule, pressure, and sudden-death rules. |
| `fire` | Burn times, fuel materials and props, spread, ignition and damage. |
| `builds` | What each fighter-build attribute level does (#79): max HP, weight and power tables, and the caps when a build stacks with a power-up. |
| `morale` | State thresholds, gains and losses, anger, score limits, and aim effects. |
| `round` | Round limit, wins required, fight timeout and time past the last knockout. |
| `tactics` | Controller aim, patience, pickup and wall pursuit tuning, retaliation, plan-rule evaluation, and how fighters use force fields (`tactics.forceField`). |

See `src/sim/ruleset-defaults.ts` and `src/sim/level-config.ts` for the fields, and `src/sim/constants.ts` for the default values those fields use. Export the complete Classic body from a checkout with the following command.

```sh
bun -e 'import { CLASSIC } from "./src/sim"; console.log(JSON.stringify(CLASSIC, null, 2))' > classic.json
```

Times with a `Ticks` suffix count 60 Hz sim ticks. Fire durations `burnMin` and `burnMax` count fire steps instead. World distances and velocities use meters and meters per second. Probabilities such as `fire.spread` take values from 0 through 1.

The validator reports the offending field for unknown keys, unknown IDs, invalid types, out-of-range values and incompatible settings. Object keys and enabled lists resolve in Classic order so reordering JSON keys or an enabled list preserves seeded draws. Fixed-width arrays such as minimum/maximum pairs replace the entire array. Theme material rows keep their order and repeat entries to give those materials greater weight. JSON numbers parse as finite IEEE 754 binary64 values in both engines. Numeric strings are rejected, negative zero is normalized to zero, and validation does no rounding or decimal conversion. A record serializes those same values back to JSON for exact round trips.

The arena generator still uses the four-seat layout and places fighters and the armory by the existing algorithms. The 60 Hz tick rate, half-meter grid, collision masks and RNG belong to the sim. Broadcast beat durations and server check-in scheduling use their existing configuration.

## Opening layout

Classic assigns one fighter to each arena quarter. Seeded X jitter changes the openings, and seats are shuffled independently each round. The generator selects physically separated spawn points on connected surfaces, including at least one floor and one elevated start. It checks the starting zone and the arena boundaries before it accepts a layout. `arena.spawns.spread` controls jitter, the outward bias within the quarters, minimum pairwise distance, zone margin and elevation requirements.

In spread mode (Classic) no start weapon belongs to one spawn (#16). `pickups.armory.spread.betweenCaches` weapons lie between each pair of neighbouring spawns, as near equally far from both as the ground allows, no more than `cacheMaxRise` meters above the lowest ground there. Every cache sits on ground that each fighter can reach from its spawn and come back from. `skyDrops` more weapons fall from the sky at `skyDropTicks`, at clear points away from fighters and items; they draw from their own stream of the round seed. The configured power weapons go to elevated or exposed sites. Unarmed house bots initially favor a weapon in their own quarter. Ordinary drops exclude the reserved weapons when an ordinary weapon is available. `pickups.armory.spawnOffset` and `nearSpawn` apply only when spread mode is off (Close Quarters). `arena.navigation.maxGap` is the widest gap house bots try to jump (3.5 m in both presets): wider jumps sent fighters running for a weapon into pits. `pickups.supply.avoidDistance` keeps supply drops away from fighters and loose items where possible. The first Classic supply drop is at eight seconds. In a narrow zone the drop uses the least crowded available landing column.

## Weapon economy (#95)

Classic keeps weapons few and spread out, and every weapon runs out.

- **Start:** `betweenCaches` 1 (three weapons, one between each pair of neighbouring spawns), `powerStart` 1 (one of the `powerWeapons`, high or exposed), `skyDrops` 0. `startWeapons` adds weapons at spread-out spots (below); Classic adds one (#109), so five weapons in all.
- **Supply:** a drop every `pickups.supply.interval` (6 s), a weapon with `weaponChance` (0.6). A drop or a crate brings a weapon only while fewer than `maxLooseWeapons` (4) are in play: inside the zone, on ground a living fighter can reach and come back from, and fewer than the zone's width holds at `spots.itemGap`. With no weapon in play and a fighter bare-handed, the drop is a weapon. With `cutOffDrops` (on), a bare-handed fighter whose own plan reaches none of the weapons in play (across a gap it cannot jump) gets the next drop as a weapon on its own ground, past the cap; two cut off take turns. Sudden death drops follow the same cap. Crates use `armory.crateWeaponChance` (0.3). Close Quarters keeps the #95 pace: 8 s, 0.5, 3 (#109).
- **Spots (`pickups.spots`):** a weapon drops on a nav point with room above it, inside the zone `zoneAhead` ticks ahead, that the fighters (the spawns at the start) can reach and come back from, not within `edgeGap` of a drop edge, at least `itemGap` from loose weapons, `fighterGap` from fighters (`startSpawnGap` from spawns) and `recentGap` from where a weapon was picked up in the last `recentTicks`. When nothing qualifies, the gaps shrink by `relax` per try. The arena's quarters, each split at `highRise` into low ground and high, are filled emptiest first. Mid-round, with fighters bare-handed, the spot is one of the `raceChoices` they reach at about the same time. A supply weapon falls from the sky or from just under whatever is above its spot. A loose weapon left outside the zone for `outsideTicks` is cleared away.
- **Ammo:** every pickup weapon has `weapons.table.<weapon>.ammo`: rounds, throws, slams or hooks; the bat's are hits on fighters; the flamethrower's are pulses of fuel. Empty, the weapon is thrown away. The lightning sword's `ammo` is its bolts; the sword stays. A ruleset stored before #99 (a match's pinned body, a preset) may still say `weapons.table.flamethrower.fuel`: it loads as the flamethrower's `ammo` (`LEGACY_KEYS` in `src/sim/ruleset.ts`).
- **One slot:** a fighter carries one weapon plus fists. A pickup drops the carried weapon with its ammo.
- **Bots (`tactics.pickup`):** at or under `lowAmmoShare` a fighter is low: it takes any weapon with more ammo, goes up to `rearmLimit` for the nearest one, fights a rival within `saveShotsReach` with fists, and drops a low weapon not fired for `dropIdleTicks` when another weapon lies on the floor. A weapon given up on is tried again after `rearmSkipTicks`.

Close Quarters keeps its own start (the old armory) but shares the supply cap, the spots and the ammo.

## Force field (#40)

A rare deployable shield for an area, different from the Shield power-up (which lowers the damage and knockback one
fighter takes for a few hits). One force field at most is in play at a time: on the floor, carried, or up.

- **Drop (`pickups.forceField`):** from `firstTick` (15 s), a supply drop that would bring a power-up brings the force
  field instead with `dropChance` (0.25), while none is in play. It lands on a spot every fighter can reach (the weapon
  spots above). The choice and the spot come from the force field's own stream of the round seed, so the other drops
  stay as they were. Crates and the round's opening power-ups never bring it. A fighter carries one at most; a
  fighter knocked out by damage drops it, and a ring-out loses it.
- **Deploy:** where the holder stands, a circle of `radius` (2.4 m) around the middle of its body. It stays there (it
  does not follow the holder) for `ticks` (360, 6 s) or until it has taken `absorb` (30) damage, then it goes down.
- **What it stops:** anything that would cross its edge, from either side. Rifle, sniper and crossbow rounds, shotgun
  pellets, the railgun's slug, lightning bolts, the grappling hook and flame end on the edge; a rocket bursts on it; a
  grenade or a thrown mine bounces off (keeping `bounce`, 0.45, of its speed); a blast and the hammer's ground wave do
  not reach a fighter on the other side of the edge. Each thing stopped counts its full damage against `absorb` (a
  blast once; a grenade or mine once however often it bounces).
- **What it does not stop:** fighters walk through it, and punches and swings (fists, bat, the lightning sword's slash)
  work through it. So it never traps anyone, never blocks a way or a gap, and never changes the nav graph; a rival can
  walk in and fight up close. Fire, live ground, the zone and falls are not stopped either.
- **Why at the holder, and walk-through:** the holder is the one under fire, so the bubble goes up where it is needed
  with no aim and no throw to miss; it reads at once on video (a bubble around a fighter). A solid wall could trap
  fighters, wall off a gap (fewer ring-outs) or make new spots to get stuck; a walk-through bubble does none of that
  and still makes range useless for a few seconds.
- **Bots (`tactics.forceField`):** a fighter goes up to `seekLimit` (20) path cost for a loose force field. It deploys
  on the ground, where the zone will still be while it is up, and never with a rival within `meleeRange` (2.2 m): when
  a rival's rocket or grenade is within `incomingRange` (6 m) and coming its way; or when a rival with a ranged weapon
  (reach `rangedReach`, 12 m, or more) has a clear line to it within `threatRange` (20 m) while it has taken
  `underFireDamage` (9) in `underFireTicks` (90), is under `hurtShare` (half) of its max HP, plays a cover, hold or
  overwatch stance, or leads the last rival by `leadHp` (25) HP. Inside its own field with its target outside, it keeps
  `shelterMargin` (0.7 m) in from the edge and does not jump out. No fighter shoots, throws or fires a blast that a
  field's edge would stop. A rival inside a field the fighter is not in costs `protectedCost` (25) more in target
  choice, unless the fighter fights up close (fists, bat, hammer, flamethrower, lightning sword, shotgun): then it walks
  in. A plan rule `"do": "use", "item": "forcefield"` deploys at once while the rule is active (docs/rules.md).

## Opening grace and weapon reach

Classic waits for the first fighter-on-fighter damage before the sudden-death countdown. When nobody has landed a hit, the quiet clock begins after `zone.suddenDeath.graceTicks` (20 seconds). If that clock runs out, bots close in on a rival. Sudden death, including the faster zone and its announcement, can start once a hit has landed and the next quiet window expires. Classic uses a seven-second quiet window.

The zone's edges stop only on ground a fighter can hold (#156). The regular shrink aims at `zone.boundary.endHalf` about the level's zone centre, and sudden death at `zone.suddenDeath.endHalf` (0.5 m in Classic). Each edge stops at the nearest point that meets all of these conditions: the lowest surface continues for 1.5 m on each side of the point (no step over 1 m, no crumbling or submerged floor), and no lip over a pit is within 1.5 m inside the edge or 4 m outside it. The search goes up to 6 m out and 2 m in. Thus the zone does not stop on a pit's lip, where it holds a fighter against the lip, and it does not stop over a pit, where it pushes the fighters outside into the pit. The final zone is often off-centre, and in Classic it is usually a few meters wide.

`tactics.weapons.reach` sets each weapon's effective range for aiming, choosing shots, attacking obstructions and positioning. The settings also set vertical reach for melee and a preferred stand-off distance within the band. The controller favors ready weapons and treats obstructing destructibles as targets. Ammunition and fuel still come from the weapon table and carried inventory.

Close Quarters keeps its original opening timer and weapon selection through its ruleset settings.

## Fighter builds

A fighter's strategy for a round can carry a build (#79, #83): three attribute levels, `health`, `weight` and `power`, each from -2 to +2, that add up to 0. No build means neutral, all 0, and a neutral fighter plays the `combat.fighter` values exactly. The build is fixed for the round; a mid-round plan update does not change it. Speed and jump are not part of a build (#82 found that a point in them buys the house bot nothing): every fighter moves at the `combat.fighter` values, and all fighters share one navigation graph.

- `builds.health.hpBonus` is added to `combat.fighter.maxHp`. Health bars, healing, knockback growth and the health rules use the fighter's own max HP.
- `builds.weight.knockback` scales knockback taken, `builds.weight.density` the body's density.
- `builds.power.mul` scales damage and knockback dealt.
- `builds.caps` limit a build stacked with a power-up, as multiples of the base values: the lowest knockback taken and highest density with Heavy, the highest damage and knockback dealt with Damage.

Each table has five entries, levels -2 to +2. Level 0 of every table must be the base (hpBonus 0, multipliers 1), each level up must give at least as much of its attribute (at most as much knockback taken), and no cap may bind a neutral fighter; the validator refuses anything else. The Classic values were tuned with house-bot batches (`scripts/builds-batch.ts`, #82) so that a point of health, weight or power is worth the same. To turn builds off, set every entry to its level-0 value.

**How viewers show a build (#81).** A build is named by the attributes it raises (`BUILD_SHAPES` in `src/sim/build.ts`, the same names the agents' examples use): BALANCED (neutral), TANK (health), ANCHOR (weight), GLASS CANNON (power), FORTRESS (health and weight), SCRAPPER (health and power), WRECKER (weight and power). These seven cover all 19 legal builds. The dialogue card shows the name and the levels (`TANK HP +2 · WGT 0 · PWR −2`; neutral is only `BALANCED`). The HUD chip shows the name. A health bar's length follows the fighter's max HP, with a tick every 25 HP. The body cue is a soft halo the shape of the bot, one per raised attribute, in that attribute's color (health green, weight violet, power orange: the same colors as the chip's levels). It is drawn only; the hitbox does not change. The viewer keeps a build from a record or the live stream only if it is legal (`src/viewer/sanitize.ts`).

## Launch height

Classic keeps launched fighters near the fight, so View all can follow it (#41). Heights are measured from the highest walkable surface when the round starts.

- `combat.launch.maxUpSpeed` caps how fast knockback and blasts make a fighter rise (15 m/s). Sideways speed is kept, so ring-outs still happen. A fighter who is already rising faster, for example off a launch pad, is not slowed by a hit.
- `combat.launch.stackRetention` softens kicks that land in the same tick, such as shotgun pellets or chain blasts. The n-th extra kick keeps `stackRetention`ⁿ of its upward push (0.5). Sideways pushes still add up in full.
- `combat.launch.ceilingAbove` and `ceilingDrag` set a soft ceiling. More than 5 m above the top platform, upward speed decays by 4 per second, like air drag. It is not a wall.
- `pickups.power.jetpack.fuelTicks` is 180 (3 s of thrust; 90 before #109).
- `pickups.power.jetpack.ceiling` and `fade` stop jetpack thrust 4 m above the top platform. The thrust starts to fade 1.5 m below that height.

Close Quarters keeps launches as they were before #41: no cap, full stacking and no ceilings.

## Choose a ruleset

- **The match server's Arena (#64)** — every round uses the server's default preset (`setDefaultRulesetPreset` on the store), with its round settings set to one round (`maxRounds: 1`, `winsToTake: 1`): a changed default applies from the next round. Agents do not choose: the MCP plan and check-in tool schemas follow the Arena's ruleset.
- **CLI** — Use `bun run ai-match --ruleset ./variant.json` or `bun run ai-match --ruleset 'My Preset' --ruleset-db ./records/match-server.db`. Named selection defaults to the local server database in `records/`. Without a local database, the built-in presets are available.

The SQLite store exposes methods to list and read presets, save a new version and set the server default. A fresh database has Classic (the default) and Close Quarters at version 1. These two are built-in (`BUILTIN_PRESETS` in `src/server/store.ts`): their bodies come from the code, and `putRulesetPreset` refuses their names. When the code changes one, `bun run presets sync` (#161; `--dry-run` reports only) writes the new body with version + 1, and leaves an equal one as it is; `bun run presets list` shows them all. Operator presets never change in a sync. Close Quarters is its own design: tight spawns, armory and drop schedule, no launch cap, full launch stacking and no ceilings. Chaos and Sniper Alley are placeholders until they have settings. The admin page in #39 can use this storage interface. Spawn and armory changes in #37 have settings under `arena.spawns` and `pickups.armory`. Weapon and stance changes in #38 can extend `weapons` and `tactics`.

To replay a match, serve its JSON from the viewer's `records/` directory and open `/?record=/records/<name>.json`. For a cross-engine check against the saved final hashes, run `bun scripts/crosscheck.ts --port <port> --record records/<name>.json`.
