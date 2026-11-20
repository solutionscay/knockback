# Knockback (working name)

Side-view 2D physics brawler prototype. A match is **best of 3 rounds** on a
freshly generated, almost fully destructible level (themes: warehouse, rooftop,
junkyard, construction), fought by four characters with swagger: **Brick** the
Brawler, **Pike** the Sniper, **Squeaks** the Rat and **Goldie** the Vulture
(see `docs/characters.md`).

1. **Level card**, then each fighter's **intro line** in an RPG dialogue frame.
2. **3, 2, 1, FIGHT!** One continuous round; the safe zone pushes everyone together.
3. **Round result**, then **between-round dialogue**: each fighter reacts to what
   happened (morale: cocky, confident, rattled, furious, desperate) and picks a
   strategy for the next round. Level and health reset; morale carries over.
4. First to 2 round wins takes the match; round 3 is winner-takes-all.
5. **Celebrate** + session scoreboard (round win 3, knockout 1). Next match.

The lines and strategies come from one function per fighter
(`src/sim/voice.ts`, `Brain`), the slot where AI agents plug in.

## Run

```sh
bun install
bun run dev                    # http://localhost:5173
bun run dev --host 0.0.0.0     # also on the LAN (prints the LAN URLs)
```

Camera: **View all** (everyone on screen) is the default; `A` = Auto (frames the
busiest action), `V` = View all, `1`-`4` = follow a fighter, or use the camera
bar bottom-left. URL options: `?seed=123` picks a match. The next match starts by itself a few
seconds after the celebrate screen; `?hold` waits for the Next match button
instead. `N` or the corner button starts a new match; "Reset scores" clears the
session scoreboard.

## Other commands

```sh
bun test                       # determinism, fight flow, beats, scores, damage, explosions, ring-out
bun run batch 200              # 200 headless bot fights + stats
bun run record <outdir> 6 104  # 1080p WebM of full loops in "View all" (--camera auto|all|follow:N); needs the dev server
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
