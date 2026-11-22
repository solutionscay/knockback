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
| `pickups` | Enabled power-ups, weighted drops, power-up strengths and durations, and the armory and supply schedule. An empty power-up list turns off power-ups. |
| `arena` | Size, generation, themes and their prop and material mixtures, spawn constraints, walls, terrain, prop dimensions, chain tuning and navigation. |
| `zone` | Safe-zone width, shrink schedule, pressure, and sudden-death rules. |
| `fire` | Burn times, fuel materials and props, spread, ignition and damage. |
| `builds` | What each fighter-build attribute level does (#79): max HP, weight and power tables, and the caps when a build stacks with a power-up. |
| `morale` | State thresholds, gains and losses, anger, score limits, and aim effects. |
| `round` | Round limit, wins required, fight timeout and time past the last knockout. |
| `tactics` | Controller aim, patience, pickup and wall pursuit tuning, retaliation and plan-rule evaluation. |

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

## Opening grace and weapon reach

Classic waits for the first fighter-on-fighter damage before the sudden-death countdown. When nobody has landed a hit, the quiet clock begins after `zone.suddenDeath.graceTicks` (20 seconds). If that clock runs out, bots close in on a rival. Sudden death, including the faster zone and its announcement, can start once a hit has landed and the next quiet window expires. Classic uses a seven-second quiet window.

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
- `pickups.power.jetpack.ceiling` and `fade` stop jetpack thrust 4 m above the top platform. The thrust starts to fade 1.5 m below that height.

Close Quarters keeps launches as they were before #41: no cap, full stacking and no ceilings.

## Choose a ruleset

- **The match server's Arena (#64)** — every round uses the server's default preset (`setDefaultRulesetPreset` on the store), with its round settings set to one round (`maxRounds: 1`, `winsToTake: 1`): a changed default applies from the next round. Agents do not choose: the MCP plan and check-in tool schemas follow the Arena's ruleset.
- **CLI** — Use `bun run ai-match --ruleset ./variant.json` or `bun run ai-match --ruleset 'My Preset' --ruleset-db ./records/match-server.db`. Named selection defaults to the local server database in `records/`. Without a local database, the built-in presets are available.

The SQLite store exposes methods to list and read presets, save a new version and set the server default. A fresh database has Classic (the default, immutable) and Close Quarters at version 1. Close Quarters is its own design: tight spawns, armory and drop schedule, no launch cap, full launch stacking and no ceilings. Chaos and Sniper Alley are placeholders until they have settings. The admin page in #39 can use this storage interface. Spawn and armory changes in #37 have settings under `arena.spawns` and `pickups.armory`. Weapon and stance changes in #38 can extend `weapons` and `tactics`.

To replay a match, serve its JSON from the viewer's `records/` directory and open `/?record=/records/<name>.json`. For a cross-engine check against the saved final hashes, run `bun scripts/crosscheck.ts --port <port> --record records/<name>.json`.
