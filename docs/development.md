# Development

The local viewer, tests, the other scripts and the source layout.

## The local viewer

The local viewer (`bun run dev`) plays house-bot matches with the Classic ruleset: **best of 3 rounds** on a
freshly generated, almost fully destructible level (themes: warehouse, rooftop, junkyard, construction, beach), four fighters
with the same body and speed, each choosing a build (health, weight, power) per round. How a fighter thinks comes from
its **soul file** (`souls/*.md`: attitude, voice, what it values); swap a soul and the fighter plays differently. The
four example souls are the brawler, the sniper, the rat and the vulture. Souls have no names or looks: every match
gives each fighter a **generated identity** (name, head shape, eyes, mark, color) from the match seed. Format:
[souls.md](souls.md).

The stage (#100): 3-4 rows of soft ground (the theme's dirt, concrete or brick) over a hard frame of rock or steel,
hanging platforms that are mostly jump-through (jump up through, hold down to drop), and at most one gap near the
middle, always with a jump-through catwalk over it. Fighters wall-jump out of holes and dig through soft ground with
digging punches. Ring-outs come from the gap, the level's edges and the zone.

The fighters are plush bots rendered in Blender (#85, sprite sheets per build in `src/viewer/art/plush`, drawn by
`src/viewer/plush-bot.ts`). Their LED visor faces are drawn in code (`src/viewer/bot.ts`) and show morale (cocky,
confident, rattled, furious, desperate) and events (hit, stunned, knocked out, win); the same drawing makes the
dialogue-card portraits (as SVG).

1. **Level card**, then each fighter's **intro line** in an RPG dialogue frame.
2. **3, 2, 1, FIGHT!** One continuous round; the safe zone pushes everyone together.
3. **Round result**, then **between-round dialogue**: each fighter reacts to what
   happened and picks a strategy for the next round. Level and health reset; morale carries over.
4. First to 2 round wins takes the match; round 3 is winner-takes-all.
5. **Celebrate** + session scoreboard (round win 3, knockout 1). Next match.

The lines and strategies come from one function per fighter (`src/sim/voice.ts`, `Brain`), the slot where AI agents
plug in. The match server's Arena plays one-round matches instead ([arena.md](arena.md)).

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

Sound (#12): every sound is generated in code (no audio files in the repo); it starts with the first click or
key press (browser rule). The corner has a mute button and a volume slider, remembered per browser. A private
sample pack can replace sounds by name (`/sounds/manifest.json`, served by `bun run dev` from the git- and
docker-ignored `sounds/` folder, or `--sounds <dir>`). Capture-mode videos get their audio from a cue log
(`__kb.drainSounds()` + `scripts/sound-mix.ts`). See [docs/sound.md](sound.md).

## Tests

```sh
bun test            # or: bun run test (about 5 s)
bun run typecheck
```

`tests/` holds a small suite: each file protects one contract that a player, an agent or the operator relies on
(issue #61). No test uses real time, a model provider or the network; servers run in-process with temporary
directories.

- `determinism` - golden fight and match hashes; records replay; a record that does not reach its hash is refused.
  A sim change that moves the goldens updates them in the same commit, and says why.
- `keys-http` - `POST /api/keys`; joining needs the owner key in the Authorization header (none, `?key=`, revoked: 401);
  an agent name stays with its owner (409), and its owner joining again gets the same seat.
- `arena` - the Arena: rounds run with house bots only; an agent claims a seat and plays from the next round; a
  silent agent loses it after 2 missed rounds; leave; rotation with more than 4 agents; a round resumes after a restart.
- `arena-http` - the Arena over HTTP: owner key, seat token, 4xx with what is wrong, no custom matches, a finished
  round loads from storage with the same hash.
- `mcp-flow` - an MCP agent plays round after round in the Arena with its key; a bad plan comes back with what to fix;
  a closed session leaves the Arena.
- `mcp-tools` - the MCP tools an agent sees; plan schemas come from the parser's constants and follow the Arena's ruleset.
- `plan-parser` - valid plans parse; each kind of invalid plan names the field and the value.
- `soul-guard` - personal data and file paths are stripped from soul.md.
- `store` - a fresh database gets the current schema; an old schema is refused with the reset command.
- `old-engine` - rounds from an older engine (#88): kept in the database and on disk, never listed or shown; their
  URLs are a clean 404 (no re-simulation); scripts still list them and tell them apart; an in-flight round that no
  longer replays at startup is set aside for a fresh one.
- `stuck` - bots go somewhere (#88): Arena-style house-bot rounds stay under 1.5% of alive time hopping or pacing on
  one spot, no such stretch over 10 s, and a known spot that once held a fighter hopping in place no longer does.
- `site-join` - the Connect page's MCP snippets carry the key only in a header or an environment variable; the join status says
  where the owner's agent is in the Arena.

Add a test only for a contract like these, and check that it fails when the behavior breaks.

## Other commands

```sh
bun run batch 200              # 200 headless bot fights + stats
bun scripts/equal-batch.ts 200 # equal fighters: win spread per seat and soul, time to first weapon, pickups, kills per weapon
bun scripts/stall-batch.ts 200 # stalemates: longest stretch without fighter damage per round, round lengths, time-outs, sudden deaths
bun scripts/records-engine.ts records/   # which engine each record was played on (#88): current or older (older = training data, never shown); --db for the server's index, --json
bun scripts/stuck.ts sims 100 1 --out runs.json   # stuck and aimless (#88): hopping or pacing on one spot (src/stats/stuck.ts);
bun scripts/stuck.ts records records/ --out runs.json   #   the same over match records (agents' seats apart); then
bun scripts/stuck.ts report runs.json [after.json]      #   rates by plan, build, map, weapon and seat kind, before/after
bun scripts/wall-batch.ts 200 1 1 # wall-stalled pursuit by seat and round, plus round and checkpoint hashes
bun run teaser --record records/<file>.json  # a finished match video in one command: View all, every card and round, sound, 1080p + 720p, stills, README (docs/video.md)
bun run record <outdir> 6 104  # 1080p WebM of full loops in "View all" (--camera auto|all|follow:N); needs the dev server
bun scripts/crosscheck.ts      # Chromium vs Bun state hash check (needs the dev server)
bun scripts/levels.ts out.jpg  # contact sheet of generated levels (needs the dev server)
bun scripts/fps.ts [seed]      # browser frame rate during a fight (needs the dev server)
bun run typecheck
```

## Layout

- `src/sim/` - pure TypeScript simulation (Rapier 2D deterministic build). No
  rendering, no wall clock, no `Math.random`. Runs in Bun and the browser.
  - `levelgen.ts` seeded level generator; `level-validate.ts` its playability checks; `level-walls.ts` jumpable, cracked barricades and route checks; `grid.ts` the cell grid
  - `terrain.ts` destructible terrain physics (chunked colliders, support check, loose pieces)
  - `sim-chains.ts` breakable platform chains (#34): chain hit points (`CHAIN` in `constants.ts`); explosions,
    shotgun pellets, bats, heavy fists and heavy flying things damage them; one chain gone, the platform swings
    on the other (rope joint to a pivot); all gone, it falls and crushes (credited to whoever broke the chain)
  - `sim.ts` world, deterministic stepping and state hash; delegates combat, movement, items, objects, terrain, fire and chains to the `sim-*` modules
  - `fight.ts` one round: controllers, physics, result, fight record and replay
  - `match.ts` round orchestration (rounds per match from the ruleset: Classic best of 3, the Arena 1), morale, identities, decisions, match record and replay
  - `controller.ts` strategy -> frame-by-frame inputs (target picking, pathing, aiming, firing)
  - `soul.ts` soul parsing, validation, keyword mapping; `souls.ts` the bundled example souls
  - `voice.ts` the decision slot: house bot strategy from the soul + lines (soul lines, voice templates)
  - `bots.ts` seat-neutral default plans for fights started without strategies
  - `nav.ts` surfaces + jump/drop links built from the grid (rebuilt as it is carved)
- `src/flow/` - the match loop as data (beat sequence, runner) and scoring/tally. Pure.
- `src/viewer/` - PixiJS viewer (camera, juice, HUD) that draws each beat. Reads sim state, never writes it.
  - `audio/` sound (#12): sfxr-style synthesis, the sound book (recipes as data), event mapping, voice limiting,
    WebAudio engine with an optional sample pack, the offline mix for videos
- `src/ai/runner.ts` - MatchRunner: one match with any mix of house, local AI and remote seats (used by ai-match and the match server)
- `src/ai/checkin.ts` - mid-round check-ins: schedule, status, prompt, answer parser, apply tick (#9)
- `src/server/` - match server: HTTP API, remote seats, seat tokens, storage (SQLite) and resume, limits, live stream, MCP gateway (`mcp.ts`) and the Arena (`arena.ts`)
- `scripts/` - dev server, batch stats, video recorder, ai-match, match-server, remote-agent
