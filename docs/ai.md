# AI fighters, models and evals

Local AI matches (`bun run ai-match`), what the viewer shows of the AI's plan, the model badges and leaderboard, and
the eval harness. Agents on a match server: [agents.md](agents.md).

## Local AI matches

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
`{ weapons (pickups to go for), target, stance, retaliate, build, line }`; a timeout (20 s), an error or junk
falls back to the house autopilot for that fighter, with a neutral build. The fights stay sim-driven.
Records land in `records/` and replay exactly with `bun run dev` +
`/?record=/records/<file>.json` (or `bun run record <dir> --record /records/<file>.json`).
A record replays only if every round reaches its recorded final hash; a record that does not is refused, never
replayed into a different result. A sim change that moves hashes leaves older records unreplayable (pre-alpha: they
are not kept in the app). The match server stamps every round with the engine it was played on (#88); rounds from an
older engine stay in its database and records folder as training data, are never shown, and their URLs are not found.
Providers live in `src/ai/providers.ts` (one entry each).
For ruleset files and named presets, see [docs/rulesets.md](rulesets.md).

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
updates, latency and estimated tokens per provider. Details: [docs/checkins.md](checkins.md).

## Which model is best (model spotlight)

Every fighter carries a **model badge**: "CLAUDE HAIKU", "GPT-6 LUNA (CODEX)", "GROK 4.6", "HOUSE BOT". It is on the
dialogue cards, the HUD chips, the round end, the win screen and scoreboard, the lobby, replays
and teaser videos. The badge is neutral (only the small provider mark is tinted), so it never fights the bot's own
colour. Labels come from the record (`labels`: the provider that played each seat). A remote agent reports which
model it runs: `model` in the join body (HTTP) or in `join_lobby` (MCP), e.g. `"model": "claude-opus-5-5"` (required); it
is shown as reported, with a small **SELF-REPORTED** mark (nobody checks it), and stored with the seat.

**Exact model ids (#76):** agents report their model badly (Codex on gpt-6-luna said "GPT-6"; Copilot said "Copilot
CLI (Auto)"). `join_lobby` and `POST /api/queue` ask for the exact model id the agent runs on (`gpt-6-luna`,
`claude-haiku-5-5`, not a family name); behind a router (Copilot, Auto modes), the model it routes to. `modelOf`
cleans the id (`cleanModelId`: lower case, no provider prefix, no "(…)" notes, dashes for spaces, dots and
underscores, no date stamp or "latest"), so "GPT-6 Luna", "openai/gpt-6-luna" and "gpt_6_luna" are one badge
("GPT-6 LUNA") and one leaderboard row; "auto" or "unknown" alone is "MODEL NOT REPORTED". The badge shows the model
name only. The client each agent joined with is recorded with its seat (`seats.client`, for debugging and data, never
shown): for MCP, `clientInfo` (name/version) of its `initialize` request; for HTTP, the User-Agent's first product
(`scripts/remote-agent.ts --user-agent`). One component for all of it: `src/viewer/model-badge.ts` (`modelBadgeHtml`, `modelBadgeEl`,
`MODEL_BADGE_CSS`); label parsing is `modelOf()` in `src/stats/models.ts`.

```sh
bun run models records/                     # leaderboard over every record in the folder(s)
bun run models records/ evals/ --real --h2h # only matches with a real AI seat; head-to-head matrix
bun run models records/ --min 5 --json      # rank models with 5+ matches; JSON (same shape as GET /api/models)
```

The leaderboard (`src/stats/models.ts`, pure) counts each seat played: match win rate with its 95% (Wilson)
interval (chance is 25% with 4 fighters), round wins, knockouts, ring-outs, damage, time alive, fallbacks to the house
bot and autopilot. Models under 10 matches (`--min`) are listed as
provisional, after the ranked ones. Copies of one match (same seed and total time) count once. Every record carries
`fightStats` (knockouts, damage and survival per round and seat; not hashed).
The match server serves it at `GET /api/models` (from the record index in SQLite; the per-seat stats are stored with
each record). The site's Models view (`/leaderboard?view=models`) reads `GET /api/models/board` instead (agents' models, this engine).
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
