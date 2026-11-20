# Knockback (working name)

Side-view 2D physics brawler prototype. A match is **best of 3 rounds** on a
freshly generated, almost fully destructible level (themes: warehouse, rooftop,
junkyard, construction), fought by four **equal** fighters: same body, speed and
health, fists only at the start. Weapons and power-ups are collected in the arena.
Who a fighter is comes from its **soul file** (`souls/*.md`: name, color, attitude,
voice, what it values); swap a soul and the fighter changes. The four example souls
are **Brick** the Brawler, **Pike** the Sniper, **Squeaks** the Rat and **Goldie**
the Vulture. Format: `docs/souls.md`.

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

## AI fighters

```sh
bun run ai-match --host 0.0.0.0            # prints http://<lan-ip>:5175/?live ; open it on any machine
bun run ai-match --lineup claude,codex,grok,claude --souls ./souls --seed 42 --deadline 20
bun run ai-match --lineup pike=house       # mix AI and house bots
bun run ai-match --headless                # no viewer, just the log
```

Default lineup: Brick = claude (haiku), Pike = codex (gpt-6-luna, low effort),
Squeaks = grok (grok-4.6, low effort), Goldie = claude (haiku). Each fighter has a
soul in `souls/` (`--souls <folder>` or `--souls a.md,b.md,c.md,d.md`; a bad soul
stops the match with a message). Before each round all four are asked in parallel for
`{ weapons (pickups to go for), target, stance, retaliate, line }`; a timeout (20 s), an error or junk
falls back to the house bot for that fighter. The fights stay engine-driven.
Records land in `records/` and replay exactly with `bun run dev` +
`/?record=/records/<file>.json` (or `bun run record <dir> --record /records/<file>.json`).
Providers live in `src/ai/providers.ts` (one entry each).

**Plan rules:** a plan can also carry up to 4 conditional rules ("when someone holds the rocket, target them",
"below 30% health, go for health"). The controller evaluates them during the round, deterministically. House
bots get 0-2 rules from their soul (turn this off with `Match({ houseRules: false })` or
`--house-rules off` in the batch scripts). Watch them fire with `?debug=rules` in the viewer. Schema: `docs/rules.md`.

**Seeing the AI think (viewer):** during the fight, each fighter's chip in the top corners shows its plan
(target · stance · first weapon; ⚑ = a rule is overriding it). Plan changes show as dotted thought bubbles
and rule firings as tags in the fighter's color with a line to the subject: at most 2 on screen, none during
knockout slow motion; `?thoughts=off` hides them for clean videos. The between-round card lists the rules with
their firing counts and the AI's reason; the round recap names a best rule. Screenshots: `docs/screenshots/`.

**Deadlines:** each provider has its own (`src/ai/providers.ts`): Claude 20 s, Codex 45 s with a second,
hedged call if the first has not answered after 15 s, Grok 30 s. `--deadline <s>` overrides them all.

## AI eval (measure before changing prompts or rules)

```sh
bun run ai-eval --matches 3 --lineup stub,stub,house,house        # free, about 1 s: stub AIs vs house bots
bun run ai-eval --matches 3 --tag baseline                        # 3 real matches, default lineup
bun run ai-eval --seeds 100-119 --concurrency 3 --yes             # 20 matches (more than 40 AI calls needs --yes)
bun run ai-eval --matches 3 --compare evals/<old run>/report.json # print the change for each metric
bun run ai-eval --rescore evals/<run>                             # recompute a run's report from its records (no AI calls)
bun scripts/replay-prompts.ts <record.json> --print 0 3           # rebuild a record's prompts with the current prompt code
```

Runs N AI matches with no viewer and writes one folder (default `evals/<time>-<tag>/`)
with every record, the prompts with raw answers, a log, `report.json` and `report.md`:

- **variety:** per field, distribution, entropy and share of the most common value;
- **change:** plan changes between rounds, per field and per fighter;
- **rules:** n/a until conditional plans exist;
- **follows the stats:** did the AI target its killer, the round winner or its top damager, and did the killer's weapon enter its wish list, compared with house bots (house seats, or with no house seats, the house bot's plan in the AI's place);
- **facts:** heuristic: lines like "X knocked me out" or "X's rocket" that the round facts don't support (the same check runs on every live answer and logs `factWarnings` in the decision meta);
- **why:** how many AI plans gave their optional one-sentence reason, with samples;
- **reliability:** response times and fallbacks per provider;
- **results:** AI seats against house seats.

Souls rotate across seats every match. Flags: `--matches`, `--seeds a-b`, `--lineup`, `--souls`,
`--deadline`, `--concurrency 1..4`, `--out`, `--tag`, `--compare`, `--yes`.

**Cost:** each real AI seat makes one CLI call per round, that is 2 or 3 calls per seat per match.
3 matches with the default lineup (4 AI seats) make up to 36 calls with about 160k prompt characters
(about 40k tokens), and take about 1.5 minutes (the baseline run: 36 calls, 162k characters, 97 s).
The script prints its estimate before it starts. Stub and house seats are free, and `--rescore` makes no calls.

## Other commands

```sh
bun test                       # determinism, fight flow, beats, scores, damage, explosions, ring-out
bun run batch 200              # 200 headless bot fights + stats
bun scripts/equal-batch.ts 200 # equal fighters: win spread per seat and soul, time to first weapon, pickups, kills per weapon
bun scripts/stall-batch.ts 200 # stalemates: longest stretch without fighter damage per round, round lengths, time-outs, sudden deaths
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
  - `soul.ts` soul parsing, validation, keyword mapping; `souls.ts` the bundled example souls
  - `voice.ts` the decision slot: house bot strategy from the soul + lines (soul lines, voice templates)
  - `bots.ts` seat-neutral default plans for fights started without strategies
  - `nav.ts` surfaces + jump/drop links built from the grid (rebuilt as it is carved)
- `src/flow/` - the match loop as data (beat sequence, runner) and scoring/tally. Pure, tested.
- `src/viewer/` - PixiJS viewer (camera, juice, HUD) that draws each beat. Reads sim state, never writes it.
- `scripts/` - dev server, batch stats, video recorder
