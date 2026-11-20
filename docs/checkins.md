# Mid-round check-ins (#8, #9)

Before each round every fighter sends a plan. With check-ins on, every AI seat also gets a short status
during the round, about every 10 s of fight, and may change its plan. The fight never pauses for it: the
change applies when the answer arrives, in fight time. Off by default (it costs calls); turn it on with
`--checkins on` on `ai-match`, `ai-eval` and `match-server`.

## What a seat gets and answers

The status (`checkinStatus` in `src/ai/checkin.ts`) is the fight at the check-in tick, from that fighter's
point of view: time and zone width; its health, weapons, power-ups, fire and jetpack fuel; its plan and the
rules active now; whom it chases and who chases it; each rival's health, weapons, distance, direction,
target and knockouts; hits taken and dealt in the last 10 s; the 3 nearest pickups; fire in the level.
CLI providers get it as a prompt of about 1,000-1,200 characters (`buildCheckinPrompt`), remote agents get
it as data plus the same prompt.

The answer is `{"keep": true}` or only the plan fields to change, plus an optional line (at most 60
characters, shown as a thought bubble) and why:

```json
{"target": "Tiko", "stance": "cover", "line": "Tiko, you're wobbling.", "why": "Tiko is at 12 health"}
```

Fields: `target` (a rival's name or nearest | weakest | strongest | leader), `stance`, `weapons` (1-3),
`retaliate`, `rules` (replaces the rules). The rest of the plan stays. The merged plan is validated like a
round plan. Invalid, junk, an error, a timeout or a merge that changes nothing: the plan stays.

## Timing and replays

- Schedule (`CHECKIN`, data): first at 10 s, then every 10 s, at most 6 a round per seat, none in the last
  5 s; knocked-out fighters, house bots and seats on autopilot get none; none once one fighter is left.
- The sim stops at the check-in tick T and asks every eligible seat in parallel (deadline 8 s). An answer
  that took L ms applies at tick `T + max(1 s, ceil(L / 1000 x 60))` (`applyTick`). At broadcast pace the
  check-in is asked when viewers reach T (`fightSecondsAt` in `src/flow/pacing.ts`), and the update gets a
  0.75 s lead so it reaches viewers before they play its tick. In fast mode (`ai-match`, `ai-eval`, tests,
  `match-server --fast`) the same rule turns the measured latency into fight time.
- The update is a plan update (#8): `{ tick, fighter, strategy, line?, why?, source: "checkin" }`, in the
  round record (`planUpdates`) and the fight record (`updates`, fight version 5). `Fight` applies the updates
  of tick T at the start of that step, in fighter order. Once one has applied, the checkpoints and the final
  hash mix in its tick, fighter and plan, so a record missing an update fails at the next checkpoint. A
  replay needs no AI. With no updates, records and hashes are exactly as before.
- Every check-in is logged in the round record (`checkins`: tick, fighter, provider, ms, outcome = update |
  keep | missed | invalid | error | late | autopilot, apply tick, changed fields, prompt and answer size).

## Remote agents

HTTP: `GET /api/matches/:id/turn` returns `status: "checkin"` with `round`, `tick`, `msLeft`, `checkin` (the
status as data), `prompt` and `schema`. Answer with `POST /api/matches/:id/checkin`
`{ round, tick, keep: true }` or `{ round, tick, stance: "cover", line: "..." }` (or `{ round, tick, answer }`
with a model's raw reply). An invalid answer is rejected with the problems and may be fixed until the
deadline; the first valid answer is final. The check-in stays open (and `/turn` keeps returning it) until it
is answered or its deadline passes.

MCP: `wait_for_turn` returns `status: "checkin"` with the fight status and a briefing; answer with
`submit_checkin` (`keep`, or the fields to change, `line`, `why`). That is the one extra tool (seven in all).

A missed check-in keeps the plan and is not a disconnect. A connection that drops while a check-in is open
(an MCP tool call or HTTP request whose connection closes, 5 s grace) hands the fighter to the house bot with
the usual autopilot callout, recorded as phase `checkin` at that tick; the agent gets control back as in #22.

`scripts/remote-agent.ts` answers check-ins in every mode (random, fixed, cli, silent).

## Viewer

The live stream sends the round's check-in schedule with its decisions, then `checkin`, `planUpdate` and
`checkinEnd` (and `checkinsDone`). The viewer adds each update to the match; the engine applies it at its tick
and the thought bubble and plan chip fire then. It never shows a fight tick an answer could still change: at
a scheduled check-in it waits until the server has asked (a viewer ahead of the pacing estimate, e.g. after
skipping dialogue, holds there briefly), and while a check-in is open it stays behind the earliest tick an
answer could apply at. Replays (`?record=`) apply the recorded updates.

## Cost and numbers

The end of an `ai-match` log and the `ai-eval` report list, per provider: check-ins asked, answered (miss
rate), updates, keeps, invalid, errors, latency (avg, median, max), prompt size and estimated tokens
(about 4 characters a token; the CLIs report no token counts). Most rounds last 20-50 s, so a round has 1-4
check-ins per seat.

```sh
bun run ai-match --headless --checkins on                      # default lineup, fast mode
bun run ai-match --checkins on --checkin-deadline 6 --checkin-max 3
bun run ai-eval --matches 5 --checkins on --yes
bun run match-server --checkins on                             # broadcast pace: check-ins at real fight time
bun scripts/crosscheck.ts --port <free port> --record records/<file>.json   # Chromium vs Bun on a record with updates
```
