# Match rulesets

Classic is the built-in ruleset and the initial default for new server and MCP lobby matches. A ruleset is JSON. A file or API request can override individual fields. Omitted fields take their values from Classic.

```json
{
  "schemaVersion": 1,
  "weapons": {
    "enabled": ["rocket", "shotgun", "bat", "grenade", "grapple", "flamethrower", "mine", "hammer"]
  },
  "fire": { "spread": 0.18 }
}
```

This example removes railgun pickups and doubles the probability of fire spreading between terrain cells per fire step. Engine version 5 uses Classic for records of its own engine version that lack a ruleset. The viewer shows a summary for records made by earlier engines. New records embed the resolved ruleset in full and include the name and version when selected from a preset. Editing a preset or changing the lobby default affects future matches. Replay, the live viewer, and server recovery all use the match's saved settings.

## Settings

| Section | Controls |
| --- | --- |
| `schemaVersion` | The ruleset format version, currently 1. |
| `combat` | Fighter dimensions, health, movement, density, impact damage, ring-outs, weapon switching, and explosion carve scale. |
| `weapons` | Enabled pickup weapons, weapon stats and effect tuning, including ammo, cooldowns, charge, reach, knockback and spread. Fists are built in. |
| `pickups` | Enabled power-ups, weighted drops, power-up strengths and durations, and the armory and supply schedule. An empty power-up list turns off power-ups. |
| `arena` | Size, generation, themes and their prop and material mixtures, spawn constraints, walls, terrain, prop dimensions, chain tuning and navigation. |
| `zone` | Safe-zone width, shrink schedule, pressure, and sudden-death rules. |
| `fire` | Burn times, fuel materials and props, spread, ignition and damage. |
| `morale` | State thresholds, gains and losses, anger, score limits, and aim effects. |
| `round` | Round limit, wins required, fight timeout and time past the last knockout. |
| `tactics` | Controller aim, patience, pickup and wall pursuit tuning, retaliation and plan-rule evaluation. |

See `src/sim/ruleset-defaults.ts` and `src/sim/level-config.ts` for the fields, and `src/sim/constants.ts` for the default values those fields use. Export the complete Classic body from a checkout with the following command.

```sh
bun -e 'import { CLASSIC } from "./src/sim"; console.log(JSON.stringify(CLASSIC, null, 2))' > classic.json
```

Times with a `Ticks` suffix count 60 Hz sim ticks. Fire durations `burnMin` and `burnMax` count fire steps instead. World distances and velocities use meters and meters per second. Probabilities such as `fire.spread` take values from 0 through 1.

The validator reports the offending field for unknown keys, unknown IDs, invalid types, out-of-range values and incompatible settings. Object keys and enabled lists resolve in Classic order so reordering JSON keys or an enabled list preserves seeded draws. Fixed-width arrays such as minimum/maximum pairs replace the entire array. Theme material rows keep their order and repeat entries to give those materials greater weight. JSON numbers parse as finite IEEE 754 binary64 values in both engines. Numeric strings are rejected, negative zero is normalized to zero, and validation does no rounding or decimal conversion. A record serializes those same values back to JSON for exact round trips.

The arena generator still uses the four-seat layout and places fighters and the armory by the existing algorithms. The 60 Hz tick rate, half-meter grid, collision masks and RNG belong to the engine. Broadcast beat durations and server check-in scheduling use their existing configuration.

## Opening layout

Classic assigns one fighter to each arena quarter. Seeded X jitter changes the openings, and seats are shuffled independently each round. The generator selects physically separated spawn points on connected surfaces, including at least one floor and one elevated start. It checks the starting zone and the arena boundaries before it accepts a layout. `arena.spawns.spread` controls jitter, the outward bias within the quarters, minimum pairwise distance, zone margin and elevation requirements.

`pickups.armory.spawnOffset` sets the target offset for a fighter's local weapon. Spread mode also places extra weapon caches per quarter and reserves the configured power weapons for elevated or exposed sites. The placement search prefers the configured distance from fighters. Unarmed house bots initially favor a weapon in their own quarter. Tight quarters and narrow surfaces can require a nearer site or leave an extra cache unfilled. Ordinary drops exclude the reserved weapons when an ordinary weapon is available. `pickups.supply.avoidDistance` keeps supply drops away from fighters and loose items where possible. The first Classic supply drop is at eight seconds. In a narrow zone the drop uses the least crowded available landing column.

## Choose a ruleset

- **HTTP** — Send a ruleset object or preset name in the `ruleset` field of `POST /api/matches`. Omit it to use the server default. An invalid selection returns HTTP 400 with the field name or preset error.
- **MCP** — Pass a preset name in `join_lobby`'s optional `ruleset` argument. Agents pair in open matches with the same selection. Plan and check-in tool schemas update for each session after it joins.
- **CLI** — Use `bun run ai-match --ruleset ./variant.json` or `bun run ai-match --ruleset 'My Preset' --ruleset-db ./records/match-server.db`. Named selection defaults to the local server database in `records/`. Without a local database, the built-in presets are available.

The SQLite store exposes methods to list and read presets, save a new version and set the server default. Classic is immutable. Close Quarters uses the original tight spawns, armory and drop schedule. Chaos and Sniper Alley are placeholders until they have settings. The admin page in #39 can use this storage interface. Spawn and armory changes in #37 have settings under `arena.spawns` and `pickups.armory`. Weapon and stance changes in #38 can extend `weapons` and `tactics`.

To replay a match, serve its JSON from the viewer's `records/` directory and open `/?record=/records/<name>.json`. For a cross-engine check against the saved final hashes, run `bun scripts/crosscheck.ts --port <port> --record records/<name>.json`.
