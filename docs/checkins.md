# Mid-round check-ins (#8, #9)

Before each round every fighter sends a plan. With check-ins on, every AI seat also gets a short status
during the round, about every 10 s of fight, and may change its plan. The fight never pauses for it: the
change applies when the answer arrives, in fight time. **On by default** for `match-server` (and the
container: `KB_CHECKINS`, default true), `ai-match` and the matches `bun run teaser --best-of` records; **off**
for tests, batches, `ai-eval` and crosscheck, so their hashes stay as they are. `--checkins on|off` overrides.

## What a seat gets and answers

The status (`checkinStatus` in `src/ai/checkin.ts`) is the fight at the check-in tick, from that fighter's
point of view: time and zone width; its health, weapons, power-ups, fire and jetpack fuel; its plan and the
rules active now; whom it chases and who chases it; each rival's health, weapons, distance, direction,
target and knockouts; hits taken and dealt in the last 10 s; the 3 nearest pickups; fire in the level.
CLI providers get it as a prompt of about 1,000-1,200 characters (`buildCheckinPrompt`), remote agents get
it as data plus the same prompt.

Open book (#104): plans are public. Spectators see every fighter's full plan, and each check-in shows every
rival's plan now (`rivals[].plan` in the data; the prompt's `RIVAL PLANS` line): target, stance, weapon order
and its rules, about 15-30 tokens per rival. The rules are written from their fields (`autoLabel`), never the
rival's own labels: a label is free text one agent wrote and must not reach another agent's prompt. The MCP
instructions and `get_started` say so.

The answer is `{"keep": true}` or only the plan fields to change, plus an optional line (at most 60
characters, shown as a thought bubble) and why:

```json
{"target": "Tiko", "stance": "cover", "line": "Tiko, you're wobbling.", "why": "Tiko is at 12 health"}
```

Fields: `target` (a rival's name or nearest | weakest | strongest | leader), `stance`, `weapons` (1-3),
`retaliate`, `rules` (replaces the rules). The rest of the plan stays. The build cannot change: an answer with
`build` is refused (#80). A check-in shows each rival's build, since every plan is in once the round runs. The merged plan is validated like a
round plan. Invalid, junk, an error or a merge that changes nothing: the plan stays.

## Timing and replays

- Schedule (`CHECKIN`, data): first at 10 s, then every 10 s up to 5 s before the time-out (8 ticks), at most
  8 asked per seat per round; knocked-out fighters, house bots and seats on autopilot get none; none once one
  fighter is left.
- **A check-in waits for its answer.** It stays open until the answer arrives, the round ends, the agent
  drops (autopilot, as before) or a sanity cap against hung processes passes (`capMs`, 60 s, `--checkin-cap`:
  a miss, and the call is aborted, which kills a CLI). While a seat's check-in is open, that seat's next
  scheduled check-ins are skipped (no overlap, no queue; recorded as `skipped`). No per-provider deadlines:
  a slow model simply reacts late, which is fair and part of what a leaderboard measures.
- **The fight never waits.** The server sim follows a *watch tick*: at broadcast pace the tick the viewers
  have reached (`src/flow/pacing.ts`, the viewer's own beat timing), in fast mode (`ai-match --headless`,
  `match-server --fast`, or nobody to pace for) each open check-in's tick plus its elapsed wall time in fight
  ticks (the lowest). An answer applies at the watch tick it arrived at (`answeredTick`), plus a 0.75 s lead at
  broadcast pace so the stream reaches viewers first, and at least 1 s after its check-in tick
  (`applyTick`). Fast mode with a slow model therefore runs in about real time while its check-in is open.
- The update is a plan update (#8): `{ tick, fighter, strategy, line?, why?, source: "checkin" }`, in the
  round record (`planUpdates`) and the fight record (`updates`, fight version 5). `Fight` applies the updates
  of tick T at the start of that step, in fighter order. Once one has applied, the checkpoints and the final
  hash mix in its tick, fighter and plan, so a record missing an update fails at the next checkpoint. A
  replay needs no AI. With no updates, records and hashes are exactly as before.
- Every check-in is logged in the round record (`checkins`: asked tick, fighter, provider, ms, outcome =
  update | keep | missed | invalid | error | late | autopilot, answered tick, apply tick, skipped check-ins,
  changed fields, prompt and answer size; #104: the answer's line and why, also on a keep, and for a late
  answer what it asked for, `wanted`). `checkinEnd` on the live stream carries the same outcome, ms, answered
  and apply ticks, line, why and wanted.
- Every rule start and stop is in the round record too (`firings`: tick, fighter, rule index, subject, on; #104),
  copied from the sim's own rule events: never hashed or replayed. Records from before #104 have none.

## Remote agents

HTTP (the Arena, #64): `GET /api/arena/turn` returns `status: "checkin"` with `round` (the Arena round), `tick`,
`msLeft`, `checkin` (the status as data), `prompt` and `schema`. Answer with `POST /api/arena/checkin`
`{ round, tick, keep: true }` or `{ round, tick, stance: "cover", line: "..." }` (or `{ round, tick, answer }`
with a model's raw reply). An invalid answer is rejected with the problems and may be fixed; the first
valid answer is final. The check-in stays open (and `/turn` keeps returning it) until it is answered, the
round ends or the hung-call cap passes; the sooner the answer, the sooner it applies.

MCP: `wait_for_turn` returns `status: "checkin"` with the fight status and a briefing; answer with
`submit_checkin` (`keep`, or the fields to change, `line`, `why`). That is the one extra tool (seven in all).

A check-in that runs into the round's end or the cap keeps the plan and is not a disconnect. A connection that drops while a check-in is open
(an MCP tool call or HTTP request whose connection closes, 5 s grace) hands the fighter to the house bot with
the usual autopilot callout, recorded as phase `checkin` at that tick; the agent gets control back as in #22.

`scripts/remote-agent.ts` answers check-ins in every mode (random, fixed, cli, silent).

## Viewer

The live stream sends the round's check-in schedule with its decisions, then `checkin` (seats asked),
`planUpdate`, `checkinEnd` (per seat), `fightTick` (how far the server's sim is, with the lead) and
`checkinsDone`. The viewer adds each update to the match; the sim applies it at its tick and the thought
bubble and plan chip fire then.

The hold rule: the viewer never shows a tick an update could still land on. While a check-in is open, that
is the server's last fight tick + the lead (an answer is stamped with the tick the server has reached when it
arrives, + the lead); while none is open, the next scheduled check-in + 1 s. The server's tick follows its
estimate of the viewers, which runs a little early, so normal viewers never hold and a slow answer never
stalls the fight; only a viewer ahead of the estimate (skipped dialogue, a fast clock) waits briefly.
`state().heldSeconds` reports it. Replays (`?record=`) apply the recorded updates.

The site pages show one small plan card (#104, `src/site/plan-card.ts`) when a spectator taps a fighter (its chip
in the viewer, or its seat) in a round with agents: target and stance, the rules in plain words (`ruleText`) with
the one firing now lit, and the last change with its why. Closed by default; live it reads at the fight's tick,
on a replay at the playhead. The embedded viewer posts its rule and knockout events to the page (`{ kb: "ev" }`)
and the fighter its camera follows.

## Cost and numbers

The end of an `ai-match` log and the `ai-eval` report list, per provider: check-ins asked, answered (miss
rate), updates, keeps, invalid, errors, latency (avg, median, max), prompt size and estimated tokens
(about 4 characters a token; the CLIs report no token counts). Most rounds last 20-50 s, so a round has 1-4
check-ins per seat, fewer for a slow model (it skips while one is open).

```sh
bun run ai-match --headless                                    # default lineup, fast mode, check-ins on
bun run ai-match --checkins off                                # no check-ins
bun run ai-match --checkin-cap 30 --checkin-max 3
bun run ai-eval --matches 5 --checkins on --yes
bun run match-server                                           # broadcast pace: check-ins at real fight time
bun scripts/crosscheck.ts --port <free port> --record records/<file>.json   # Chromium vs Bun on a record with updates
```
