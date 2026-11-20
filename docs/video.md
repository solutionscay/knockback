# Match videos: `bun run teaser`

One command makes a finished match video: the operator's video rules built in, the sound track, a 720p copy for posting, stills and a README.

```bash
bun run teaser --record records/ai-50500507-….json   # a saved match
bun run teaser --best-of 4                            # play 4 real AI matches (default providers), keep the best
bun run teaser --server http://localhost:5176         # the newest finished match of a running match server
bun run teaser --seed 42 --fast                       # a quick 720p30 preview of a house-bot match (no AI calls)
```

| Option | Meaning |
|---|---|
| `--record <file>` | A saved match record. It must be from this engine version (see [rules.md](rules.md#engine-version)). |
| `--seed <n>` | A house-bot match with this seed. No AI calls. |
| `--best-of <n>` | Plays n real AI matches headless in parallel (`scripts/ai-match.ts`, default providers), then keeps the one with the most action per fight second. The score weights explosions, chains, platform falls, ring-outs, K.O.s, sudden death and fire. The README lists every candidate. |
| `--server <url>` | The newest finished record of a match server (`GET /api/records`, skipping old-engine ones) |
| `--out <dir>` | Output folder (default `videos/<seed or source>-<date>`; `videos/` is git-ignored) |
| `--sizes 1080,720` | Output heights. Capture runs at the largest one, so `--sizes 720` captures and encodes at 720p only. The 720p copy stays under 30 MB: if a quality-based encode is too big, it is redone at the bitrate that fits. |
| `--fps 30\|60` | Frame rate (default 60) |
| `--fast` | A quick preview: 30 fps, 720p only, a fast x264 preset. An explicit `--fps` or `--sizes` wins over it. |
| `--workers <n>` | Parallel capture pages (default 6; more doesn't help at 1080p, see Speed) |
| `--keep-frames` | Keep the captured JPEGs in `<out>/.work/frames` |

## What you get

| File | Contents |
|---|---|
| `knockback-<seed>-1080p60.mp4`, `knockback-<seed>-720p60.mp4` | H.264 High, AAC stereo, `+faststart` |
| `still-trash-talk.jpg`, `still-round-1.jpg`, `still-round-<last>.jpg`, `still-scoreboard.jpg` | Stills at those moments |
| `README.md` | Seed, arena, the AI per bot, every line, the scene list with times, the match in numbers, the audio mix, the time each step took |
| `match.json` | The record the video was made from |
| `timing.json` | The time each step took |
| `.work/` | The plan, the sound cues, the audio WAV (and the frames with `--keep-frames`) |

## The video rules (built in, no flags)

| Rule | How |
|---|---|
| View all the whole video, never closer | Viewer video mode, `?capture&video` (`src/viewer/video.ts`). The game doesn't zoom on the talking bot or the winner, and the camera is View all. The arena card's overview is wider still. |
| All 4 trash-talk cards before every round, fully typed and readable | Each card runs to its end, starting 0.6 s before its line is fully typed, for at most 2.6 s (`scripts/teaser/plan.ts`) |
| Every round in full, continuous, no jump cuts | 3·2·1·FIGHT! and the whole fight. Only **dead stretches** play at 2× with a "2×" tag: 3 s or more with no two fighters within 7 m and no action event within 1.5 s, found by replaying the record in the sim. Busy matches have none. |
| Round-end and win screens with the scoreboard | Every round-end screen in full, and 8 s of the win screen |
| Clean screen | Video mode hides the camera bar, the buttons and the dialogue SKIP and SPACE hints. The clock and plan chips stay. |
| Captions only at the start and end | "Claude, Codex and Grok plan the fight" over round 1's cards; "KNOCKBACK · AI agents plan. Physics decides." over the last 3 s. Both are drawn by the viewer's caption box, so the font matches the game. |
| No slow motion | Video mode turns off the K.O. slow motion. The short impact pauses (0.05–0.14 s) stay: they are game feel, not slow motion. |
| Sound | The capture logs every frame's sound cues (`__kb.drainSounds()`). They are moved onto the output timeline (2× parts compress) and mixed by the offline mixer used by `scripts/sound-mix.ts` ([sound.md](sound.md)). |

## How it works

1. **Record:** from the source, saved as `match.json`.
2. **Sim pass:** the record is replayed in Bun for its dead stretches per round and its event counts. A record from another engine is refused here.
3. **Scan:** a private viewer server (the real `index.html` bundle) and one browser page run the whole match without drawing. `__kb.timeline()` gives every beat's first frame and the sim tick at every frame. Then the planner builds the segments.
4. **Capture:** N pages each take a contiguous chunk of the planned frames. A page fast-forwards to its chunk without drawing, then steps one frame at a time and saves a JPEG (CDP `Page.captureScreenshot`, `optimizeForSpeed`) for each planned frame. The game is deterministic, so every page plays the same match. Each page also keeps the sound cues from the frame after the previous chunk, so frames skipped between chunks keep their sounds.
5. **Audio:** the cues go onto the output timeline, into the voice limiter, the compressor and the soft limiter, and out as a WAV.
6. **Encode:** all sizes encode at once (x264 `medium`, or `veryfast` with `--fast`), then the stills, the README and the timing.

## Speed

Measured on the development Mac (Apple Silicon, 10 cores), frames per second of screenshots:

| Capture | 1 page | 2 | 4 | 6 | 8 |
|---|---|---|---|---|---|
| 1920×1080 | 34 | 58 | 81 | **92** | 93 |
| 1280×720 | 30 | 57 | 117 | **170** | 193 |

Measured full runs: a match with 2 minutes of fighting, three rounds (record `ai-50500507`), 186 s of video:

| Run | Scan + plan | Capture | Audio | Encode | Total |
|---|---|---|---|---|---|
| Default: 1080p60 + 720p60 | 10 s | 111 s (11,167 frames) | 3 s | 171 s (both at once) | **297 s (5.0 min)** |
| `--fast`: 720p30 | 10 s | 36 s (5,591 frames) | 3 s | 23 s | **73 s** |

`--best-of n` adds the AI matches themselves (they run in parallel; two took 36 s). Encoding the 1080p file is the biggest step; `--sizes 720` skips it.

**Why no real-time capture:** frame stepping is exact and deterministic, so no frames are dropped and the timing is right. Parallel pages already make it faster than real time at 720p, and close to it at 1080p.

## Viewer API used (capture mode)

| Call | What it does |
|---|---|
| `?capture&video` | Video mode (above) |
| `__kb.advance(dt, frames, render)` | Steps the game; `render = false` skips drawing (fast-forward) |
| `__kb.timeline()` | `{ beats: [{ frame, kind, round, index }], ticks: [...], frames }` |
| `__kb.caption({ kind: "start", text } \| { kind: "end", title, text } \| null)` | Sets or clears the caption |
| `__kb.tag(on)` | Shows or hides the "2×" tag |
| `__kb.drainSounds()` | The sound cues since the last call |
