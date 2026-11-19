# Knockback (working name)

Side-view 2D physics brawler prototype. Four fighters, WEGO rounds: every
fighter gets an order at the same time (`{ target, weapon, stance }`), then
about 6 seconds of real physics play out. Seven rounds, shrinking safe zone,
last fighter standing wins.

## Run

```sh
bun install
bun run dev                    # http://localhost:5173
bun run dev --host 0.0.0.0     # also on the LAN (prints the LAN URLs)
```

URL options: `?seed=123` picks a match, `?loop` starts a new match after each
one ends. Press `N` or the corner button for a new match.

## Other commands

```sh
bun test                       # determinism, rounds, damage, explosions, ring-out
bun run batch 200              # 200 headless bot matches + stats
bun run record <outdir>        # 1080p WebM of 2 matches + screenshots (needs the dev server)
bun run typecheck
```

## Layout

- `src/sim/` - pure TypeScript simulation (Rapier 2D deterministic build). No
  rendering, no wall clock, no `Math.random`. Runs in Bun and the browser.
  - `sim.ts` world, fighters, weapons, explosions, damage, ring-outs, state hash
  - `match.ts` round flow, match record and replay
  - `controller.ts` order -> frame-by-frame inputs (pathing, aiming, firing)
  - `bots.ts` house bots (aggressive, sniper, coward, opportunist)
  - `nav.ts` surfaces + jump/drop links, `map.ts` the arena
- `src/viewer/` - PixiJS viewer (camera, juice, HUD). Reads sim state, never writes it.
- `scripts/` - dev server, batch stats, video recorder
