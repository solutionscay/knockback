# Knockback (working name)

Side-view 2D physics brawler prototype. Every match is on a freshly generated,
almost fully destructible level (themes: warehouse, rooftop, junkyard,
construction). The whole loop:

0. **Level card**: the generated arena, seen whole.
1. **Intros**: each of the 4 fighters slams in with its strategy line
   (its one set of orders for the match: target preference, stance and a
   two-weapon loadout from rocket, shotgun, bat, grenade, grappling hook).
2. **3, 2, 1, FIGHT!**
3. **Chaos**: one continuous physics brawl (45-90 s); the shrinking safe zone
   pushes everyone together and toward the pit.
4. **End**: last fighter standing, or most health at the 90 s time-out.
5. **Celebrate**: the winner celebrates; points (win 3, knockout 1) go onto a
   running scoreboard for the session. Next match.

## Run

```sh
bun install
bun run dev                    # http://localhost:5173
bun run dev --host 0.0.0.0     # also on the LAN (prints the LAN URLs)
```

URL options: `?seed=123` picks a match. The next match starts by itself a few
seconds after the celebrate screen; `?hold` waits for the Next match button
instead. `N` or the corner button starts a new match; "Reset scores" clears the
session scoreboard.

## Other commands

```sh
bun test                       # determinism, fight flow, beats, scores, damage, explosions, ring-out
bun run batch 200              # 200 headless bot fights + stats
bun run record <outdir> 19 12  # 1080p WebM of full loops + screenshots (needs the dev server)
bun scripts/crosscheck.ts      # Chromium vs Bun state hash check (needs the dev server)
bun scripts/levels.ts out.jpg  # contact sheet of generated levels (needs the dev server)
bun scripts/fps.ts [seed]      # browser frame rate during a fight (needs the dev server)
bun run typecheck
```

## Layout

- `src/sim/` - pure TypeScript simulation (Rapier 2D deterministic build). No
  rendering, no wall clock, no `Math.random`. Runs in Bun and the browser.
  - `levelgen.ts` seeded level generator + validation; `grid.ts` the cell grid
  - `terrain.ts` destructible terrain physics (chunked colliders, support check, loose pieces)
  - `sim.ts` world, fighters, weapons, objects, power-ups, explosions, damage, ring-outs, state hash
  - `match.ts` one continuous fight, result, match record (seed + strategies) and replay
  - `controller.ts` strategy -> frame-by-frame inputs (target picking, pathing, aiming, firing)
  - `bots.ts` house bots pick a strategy + intro line (aggressive, sniper, coward, opportunist)
  - `nav.ts` surfaces + jump/drop links built from the grid (rebuilt as it is carved)
- `src/flow/` - the match loop as data (beat sequence, runner) and scoring/tally. Pure, tested.
- `src/viewer/` - PixiJS viewer (camera, juice, HUD) that draws each beat. Reads sim state, never writes it.
- `scripts/` - dev server, batch stats, video recorder
