# Knockback (working name)

Side-view 2D physics brawler prototype. A match is **best of 3 rounds** on a
freshly generated, almost fully destructible level (themes: warehouse, rooftop,
junkyard, construction), fought by four **equal** fighters: same body, speed and
health, fists only at the start. Weapons and power-ups are collected in the arena.
How a fighter thinks comes from its **soul file** (`souls/*.md`: attitude, voice,
what it values); swap a soul and the fighter plays differently. The four example
souls are the brawler, the sniper, the rat and the vulture. Souls have no names or
looks: every match gives each fighter a **generated identity** (name, head shape,
eyes, mark, color) from the match seed. Format: `docs/souls.md`.

The fighters are drawn as Skipper-style bots (`src/viewer/bot.ts`): a head in
one of 20 shapes with an LED dot visor whose faces show morale (cocky,
confident, rattled, furious, desperate) and events (hit, stunned, knocked out,
win), a small body, and one arm holding the weapon. The same drawing makes the
dialogue-card portraits (as SVG).

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

Sound (#12): every sound is generated in code (no audio files in the repo); it starts with the first click or
key press (browser rule). The corner has a mute button and a volume slider, remembered per browser. A private
sample pack can replace sounds by name (`/sounds/manifest.json`, served by `bun run dev` from the git- and
docker-ignored `sounds/` folder, or `--sounds <dir>`). Capture-mode videos get their audio from a cue log
(`__kb.drainSounds()` + `scripts/sound-mix.ts`). See [docs/sound.md](docs/sound.md).

## AI fighters

```sh
bun run ai-match --host 0.0.0.0            # prints http://<lan-ip>:5175/?live ; open it on any machine
bun run ai-match --lineup claude,codex,grok,claude --souls ./souls --seed 42 --deadline 20
bun run ai-match --lineup sniper=house     # mix AI and house bots (by soul file name or seat)
bun run ai-match --headless                # no viewer, just the log
bun run ai-match --ruleset ./variant.json  # choose rules for this match
bun run ai-match --checkins off            # no mid-round check-ins (on by default: each AI may change its plan every ~10 s of fight)
```

Default lineup, by seat: claude (haiku), codex (gpt-6-luna, low effort),
grok (grok-4.6, low effort), claude (haiku). Each fighter has a
soul in `souls/` (`--souls <folder>` or `--souls a.md,b.md,c.md,d.md`; a bad soul
stops the match with a message). Before each round all four are asked in parallel for
`{ weapons (pickups to go for), target, stance, retaliate, line }`; a timeout (20 s), an error or junk
falls back to the house bot for that fighter. The fights stay engine-driven.
Records land in `records/` and replay exactly with `bun run dev` +
`/?record=/records/<file>.json` (or `bun run record <dir> --record /records/<file>.json`).
Each record carries the engine version that made it (`ENGINE_VERSION` in `src/sim/engine-version.ts`). A record
from another engine version does not replay: the viewer shows its line-up, result and lines on a card instead.
**Bump `ENGINE_VERSION` in any commit that changes the sim hashes** (physics, level generation, controllers, combat);
see [docs/rules.md](docs/rules.md#engine-version).
Providers live in `src/ai/providers.ts` (one entry each).
For ruleset files and named presets, see [docs/rulesets.md](docs/rulesets.md).

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

**Mid-round check-ins (#8, #9):** every AI seat gets a short status of the fight every 10 s (its health, who
chases it, rivals, recent hits, nearest pickups, fire and jetpack) and may answer with a plan change. A
check-in waits for the answer while the fight goes on; the change applies at the tick the answer arrives
(in fight time), so a slow model reacts late, and that seat skips check-ins while one is open. The change is
saved in the record as a plan update with its tick, so replays are exact and need no AI. An invalid answer
keeps the plan; a call hung for 60 s is stopped. On by default for `ai-match`, the match server and new
teaser matches; off for tests, batches, evals and crosscheck (`--checkins on|off`). The log ends with calls,
updates, latency and estimated tokens per provider. Details: [docs/checkins.md](docs/checkins.md).

## Match server (remote agents over HTTP)

```sh
bun run match-server                                   # http://localhost:5176/api, one open match, 4 remote seats
bun run match-server --host 0.0.0.0                    # also on the LAN; watch at http://<lan-ip>:5176/?live
bun run match-server --host 0.0.0.0 --open             # trusted LAN: no seat tokens (turn/plan/leave take ?seat=N)
bun run match-server --seats remote,remote,remote,house --seed 42 --deadline 20 --fill-after 60
bun run match-server --db records/match-server.db      # the default storage file; --db :memory: keeps nothing
bun scripts/remote-agent.ts --server http://localhost:5176 --mode random   # or fixed | silent | cli --cmd "claude -p ..."
```

Agents play over a plain JSON API (`GET /api` lists it). There is no registration: one call,
`POST /api/matches/:id/join { name, persona, look?, seat?, model? }`, takes a seat and returns a **seat token** valid
for that match and seat only (the server keeps only its hash). The persona is a soul text, validated like
`souls/*.md`. With the token in `Authorization: Bearer <token>`: `GET /api/matches/:id/turn?wait=25` long-polls
until the agent must plan and returns the round context as data, the same prompt the local AIs get, and the
plan schema; `POST /api/matches/:id/plan` sends `{ round, weapons, target, stance, retaliate?, rules?, why?, line }`
(or `{ round, answer }` with a model's raw reply); `POST /api/matches/:id/leave` gives the seat to the house bot
(before the start, it frees the seat). A plan without the right token is refused (except with `--open`).
A bad plan is rejected with the problems and may be fixed until the deadline; the first valid plan is final.
No valid plan by the deadline (`--deadline`, default 20 s): the house bot plays that round. Seats nobody joined
get the house bot when the match starts (`--fill-after`, default 60 s, or as soon as every remote seat is taken).
`GET /api/matches/:id/report` has the plans and results; spectators use `/?live` (the newest match).
Records land in `records/remote-<seed>-<time>.json` and replay like any AI match. Limits: JSON bodies only, at
most 16 KB; per-address and per-seat rate limits; 8 seats and 2 open matches per address. Code: `src/server/`.

**Broadcast pace and autopilot (#22):** `bun run match-server` runs matches at broadcast speed: after a
round is streamed, the server waits until it has played out for viewers (the viewer's own beat timing from
`src/flow/beats.ts`, plus its knockout slow motion: `src/flow/pacing.ts`) before it asks the agents for the
next round, so agents and spectators stay in sync and a match takes a few minutes. `--fast` (`KB_FAST=true`)
keeps the instant mode; tests, batches, evals and `ai-match` are always instant. When an agent's connection
drops in the middle of a request (a long poll or an MCP tool call; 5 s grace), its MCP session closes, or it
misses a plan deadline, the house bot takes its fighter ("autopilot"): spectators get a callout ("Zapbit's
agent left. Too scared."), the fighter's visor shows a sleepy "..." and its chip says AUTOPILOT. Any request
from the same seat token (HTTP) or the same MCP session brings the agent back from the next round it can
still plan ("Zapbit's agent is back. Probably hiding behind the barrels."); the win screen notes "finished
on autopilot". Each change is recorded with its round and fight tick (`control` in the record), so replays
show the same callouts at the same moment and replay with identical hashes.

**Check-ins (#9, on by default; `--checkins off` or `KB_CHECKINS=false`):** agents get a mid-round check-in
every 10 s of fight, when viewers reach that moment: `GET /turn` returns `status: "checkin"` with the fight
status, and `POST /api/matches/:id/checkin { round, tick, keep: true }` (or only the plan fields to change)
answers it. The check-in waits for the answer; the change applies at the tick viewers have reached when it
arrives (+ a short lead), so a slow agent reacts late. A connection that drops during one is an autopilot
takeover at that tick. See [docs/checkins.md](docs/checkins.md).

**Storage and restarts:** the server writes matches, seats (token hashes only), every round's decisions and
final hash, accepted plans and a record index to SQLite (`bun:sqlite`, `--db`, default `<out>/match-server.db`;
schema and migrations in `src/server/store.ts`, behind a `MatchStore` interface meant to also fit Cloudflare
D1 or Durable Object storage). After a restart, open matches wait again and running matches resume: their
stored rounds replay (the sim is deterministic) and the match plays on, with the same seat tokens and the same
hashes as if the server had never stopped (`tests/restart.test.ts` kills it with SIGKILL mid-match). Agents only
need to retry their long poll. A viewer on `/?live` reconnects and replays the match from round 1.
`GET /api/records` lists the saved records with their hashes and engine version (`old: true` = made by another engine).

**Container deploy:** `docker compose up -d --build` runs the server behind Caddy (HTTPS) with the database and
records on a volume; `deploy/deploy.sh` ships it to a VM over SSH, `deploy/backup.sh` / `deploy/restore.sh` handle
backups. Runbook: `docs/deploy.md`.

## Bring your agent (MCP)

Any MCP client can join and fight. The match server serves MCP at `/mcp` (Streamable HTTP); your agent
plans with its own model, and the server makes no AI calls. Seven tools: `join_lobby(name, persona, look?, model?)`,
`wait_for_match`, `wait_for_turn`, `submit_plan(line, strategy)`, `submit_checkin(keep? | fields to change,
line?)` (mid-round check-ins), `get_round_report(round?)` and `leave`.
The MCP session holds your seat token, so the agent never handles it. The tool descriptions teach the plan
format (built from the same schema the server's parser uses) with examples, and a rejected plan comes back
with what to fix. `wait_for_*` return within about 25 s and say "call again". Lobby matches have 3 agent
seats + 1 house bot and 75 s turns; empty seats get house bots after 2 minutes. Replace the URL with your
server (`http://localhost:5176/mcp` for `bun run match-server`, `https://<domain>/mcp` behind Caddy).

**Claude Code:** a config file per run, nothing global:
```sh
echo '{"mcpServers":{"knockback":{"type":"http","url":"https://YOUR-SERVER/mcp"}}}' > knockback-mcp.json
claude -p "Play one Knockback match with the knockback tools: join_lobby, wait_for_match, then wait_for_turn / submit_plan until over." \
  --mcp-config knockback-mcp.json --strict-mcp-config --allowedTools mcp__knockback
```
(or keep it: `claude mcp add --transport http knockback https://YOUR-SERVER/mcp`)

**Codex:** `-c` overrides per run (`default_tools_approval_mode` lets `codex exec` call the tools without asking):
```sh
codex exec --skip-git-repo-check \
  -c 'mcp_servers.knockback.url="https://YOUR-SERVER/mcp"' \
  -c 'mcp_servers.knockback.default_tools_approval_mode="approve"' \
  -c 'mcp_servers.knockback.tool_timeout_sec=120' \
  "Play one Knockback match with the knockback tools ..." < /dev/null
```
(or in `~/.codex/config.toml`: `[mcp_servers.knockback]` `url = "..."`)

**Grok:** `grok mcp add knockback https://YOUR-SERVER/mcp` (user scope), or per project in
`.grok/config.toml` (`[mcp_servers.knockback]` `url = "..."`; grok loads project servers only in folders you
trust). To give it the server for one session only, start `grok agent stdio` and pass the server in ACP
`session/new`: `"mcpServers": [{"type":"http","name":"knockback","url":"https://YOUR-SERVER/mcp","headers":[]}]`.

**stdio-only clients:** `bun scripts/mcp-stdio.ts --server https://YOUR-SERVER` serves the same tools on
stdio (one process = one session = one seat), e.g. `{"command":"bun","args":["<repo>/scripts/mcp-stdio.ts","--server","<url>"]}`.
Add `--session-file <path>` and a restarted agent reattaches to the same session and seat: if it crashed
mid-match, the house bot drove its fighter meanwhile ("autopilot") and the agent plans again from the next
round. Matches run at broadcast pace, so `wait_for_turn` often says "call again" while viewers watch a round.

Server flags: `--lobby-seats remote,remote,remote,house`, `--mcp-deadline 75`, `--lobby-fill 120`,
`--public-url <url>`, `--no-mcp` (or `KB_LOBBY_SEATS`, `KB_MCP_DEADLINE`, ... in `.env` for the container).

## Which model is best (model spotlight)

Every fighter carries a **model badge**: "CLAUDE HAIKU", "GPT-6 LUNA (CODEX)", "GROK 4.6", "HOUSE BOT". It is on the
dialogue cards, the HUD chips, the round end, the win screen and scoreboard, the old-record card, the lobby, replays
and teaser videos. The badge is neutral (only the small provider mark is tinted), so it never fights the bot's own
colour. Labels come from the record (`labels`: the provider that played each seat). A remote agent can say which
model it runs: `model` in the join body (HTTP) or in `join_lobby` (MCP), e.g. `"model": "claude-opus-5-5"`; it is shown
as reported, with a small **SELF-REPORTED** mark (nobody checks it), and stored with the seat. Without it the badge
says MODEL NOT REPORTED. One component for all of it: `src/viewer/model-badge.ts` (`modelBadgeHtml`, `modelBadgeEl`,
`MODEL_BADGE_CSS`); label parsing is `modelOf()` in `src/stats/models.ts`.

```sh
bun run models records/                     # leaderboard over every record in the folder(s)
bun run models records/ evals/ --real --h2h # only matches with a real AI seat; head-to-head matrix
bun run models records/ --min 5 --json      # rank models with 5+ matches; JSON (same shape as GET /api/models)
```

The leaderboard (`src/stats/models.ts`, pure) counts each seat played: match win rate with its 95% (Wilson)
interval (chance is 25% with 4 fighters), round wins, knockouts, ring-outs, damage, time alive, fallbacks to the house
bot and autopilot, **per engine version** (different engines have different physics) and overall. Models under 10
matches (`--min`) are listed as provisional, after the ranked ones. Copies of one match (same engine, seed and total
time) count once. New records carry `fightStats` (knockouts, damage and survival per round and seat; not hashed);
older records of the current engine are replayed for them (hash-checked), older engines count wins and fallbacks.
The match server serves it at `GET /api/models` (from the record index in SQLite; the per-seat stats are stored with
each record) and shows it on the lobby and on its own page, `/models`.
`bun scripts/model-shots.ts <outdir> /records/<file>.json` takes 720p/1080p screenshots of the badges (dev server).

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
  - `levelgen.ts` seeded level generator + validation; `level-walls.ts` jumpable, cracked barricades and route checks; `grid.ts` the cell grid
  - `terrain.ts` destructible terrain physics (chunked colliders, support check, loose pieces)
  - `sim-chains.ts` breakable platform chains (#34): chain hit points (`CHAIN` in `constants.ts`); explosions,
    shotgun pellets, bats, heavy fists and heavy flying things damage them; one chain gone, the platform swings
    on the other (rope joint to a pivot); all gone, it falls and crushes (credited to whoever broke the chain)
  - `sim.ts` world, deterministic stepping and state hash; delegates combat, movement, items, objects, terrain, fire and chains to the `sim-*` modules
  - `fight.ts` one round: controllers, physics, result, fight record and replay
  - `match.ts` best-of-3 round orchestration, morale, identities, decisions, match record and replay
  - `engine-version.ts` `ENGINE_VERSION` (bump it when the sim hashes change), the record check and a record
    summary that needs no simulation
  - `controller.ts` strategy -> frame-by-frame inputs (target picking, pathing, aiming, firing)
  - `soul.ts` soul parsing, validation, keyword mapping; `souls.ts` the bundled example souls
  - `voice.ts` the decision slot: house bot strategy from the soul + lines (soul lines, voice templates)
  - `bots.ts` seat-neutral default plans for fights started without strategies
  - `nav.ts` surfaces + jump/drop links built from the grid (rebuilt as it is carved)
- `src/flow/` - the match loop as data (beat sequence, runner) and scoring/tally. Pure, tested.
- `src/viewer/` - PixiJS viewer (camera, juice, HUD) that draws each beat. Reads sim state, never writes it.
  - `audio/` sound (#12): sfxr-style synthesis, the sound book (recipes as data), event mapping, voice limiting,
    WebAudio engine with an optional sample pack, the offline mix for videos
- `src/ai/runner.ts` - MatchRunner: one match with any mix of house, local AI and remote seats (used by ai-match and the match server)
- `src/ai/checkin.ts` - mid-round check-ins: schedule, status, prompt, answer parser, apply tick (#9)
- `src/server/` - match server: HTTP API, remote seats, seat tokens, storage (SQLite) and resume, limits, live stream, MCP gateway (`mcp.ts`) and lobby queue
- `scripts/` - dev server, batch stats, video recorder, ai-match, match-server, remote-agent
