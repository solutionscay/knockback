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
| `--record <file>` | A saved match record. It must replay on the current sim (see [rules.md](rules.md#replay)). |
| `--seed <n>` | A house-bot match with this seed. No AI calls. |
| `--best-of <n>` | Plays n real AI matches headless in parallel (`scripts/ai-match.ts`, default providers), then keeps the one with the most action per fight second. The score weights explosions, chains, platform falls, ring-outs, K.O.s, sudden death and fire. The README lists every candidate. |
| `--server <url>` | The newest finished record of a match server (`GET /api/records`) |
| `--out <dir>` | Output folder (default `videos/<seed or source>-<date>`; `videos/` is git-ignored) |
| `--sizes 1080,720` | Output heights. Capture runs at the largest one, so `--sizes 720` captures and encodes at 720p only. The 720p copy stays under 30 MB: if a quality-based encode is too big, it is redone at the bitrate that fits. |
| `--fps 30\|60` | Frame rate (default 60) |
| `--fast` | A quick preview: 30 fps, 720p only, a fast x264 preset. An explicit `--fps` or `--sizes` wins over it. |
| `--workers <n>` | Parallel capture pages (default 6; more doesn't help at 1080p, see Speed) |
| `--work <dir>` | The scratch folder for frames, sound cues, the WAV and the encodes (default: the system temp dir). Keep it on a fast local disk; a `--work` inside `--out` falls back to the temp dir. |
| `--keep-work` | Keep the scratch folder after the run (`--keep-frames` does the same) |

## What you get

| File | Contents |
|---|---|
| `knockback-<seed>-1080p60.mp4`, `knockback-<seed>-720p60.mp4` | H.264 High, AAC stereo, `+faststart` |
| `still-trash-talk.jpg`, `still-round-1.jpg`, `still-round-<last>.jpg`, `still-scoreboard.jpg` | Stills at those moments |
| `README.md` | Seed, arena, the AI per bot, every line, the scene list with times, the match in numbers, the audio mix, the time each step took |
| `match.json` | The record the video was made from |
| `timing.json` | The time each step took |

**Scratch stays local:** every run works in its own folder on the local disk, `knockback-teaser-<pid>-<time>` under the temp dir or `--work`. The frames, sound cues, WAV and encodes all live there. **Only the finished files are copied to `--out`.** Then the scratch folder is deleted, unless you pass `--keep-work`.

So a slow or network `--out` costs one copy of the results. With the frames on the share, a 1080p encode had taken 552 s instead of about 170 s.

## The video rules (built in, no flags)

| Rule | How |
|---|---|
| View all the whole video, never closer | Viewer video mode, `?capture&video` (`src/viewer/video.ts`). The game doesn't zoom on the talking bot or the winner, and the camera is View all. The arena card's overview is wider still. One exception: an agent's entrance (#66) frames its seat, 12 m high (seen whole, the arena makes it too small for a clip). |
| Every entrance in full | An agent that takes a house bot's seat drops in, shouts and kicks the bot out after the arena card (3.8 s each, `scripts/teaser/plan.ts`) |
| All 4 trash-talk cards before every round, fully typed and readable | Each card runs to its end, starting 0.6 s before its line is fully typed, for at most 2.6 s (`scripts/teaser/plan.ts`) |
| Every round in full, continuous, no jump cuts | 3·2·1·FIGHT! and the whole fight. Only **dead stretches** play at 2× with a "2×" tag: 3 s or more with no two fighters within 7 m and no action event within 1.5 s, found by replaying the record in the sim. Busy matches have none. |
| Round-end and win screens with the scoreboard | Every round-end screen in full, and 8 s of the win screen |
| Clean screen | Video mode hides the camera bar, the buttons and the dialogue SKIP and SPACE hints. The clock and plan chips stay. |
| Captions only at the start and end | The agents' models over round 1's cards ("Claude Haiku 5.5, GPT‑6 and Big Pickle plan the fight"; house bots are not named, a house-bot match has no start caption); "KNOCKBACK · AI agents plan. Physics decides." over the last 3 s. Both are drawn by the viewer's caption box, so the font matches the game; in a portrait frame it wraps and sits lower, in the empty sky. |
| No slow motion | Video mode turns off the K.O. slow motion. The short impact pauses (0.05–0.14 s) stay: they are game feel, not slow motion. |
| Sound | The capture logs every frame's sound cues (`__kb.drainSounds()`). They are moved onto the output timeline (2× parts compress) and mixed by the offline mixer used by `scripts/sound-mix.ts` ([sound.md](sound.md)). |

## How it works

1. **Record:** from the source, saved as `match.json`.
2. **Sim pass:** the record is replayed in Bun for its dead stretches per round and its event counts. A record that does not replay is refused here.
3. **Scan:** a private viewer server (the real `index.html` bundle) and one browser page run the whole match without drawing. `__kb.timeline()` gives every beat's first frame and the sim tick at every frame. Then the planner builds the segments.
4. **Capture:** N pages each take a contiguous chunk of the planned frames. A page fast-forwards to its chunk without drawing, then steps one frame at a time and saves a JPEG (CDP `Page.captureScreenshot`, `optimizeForSpeed`) for each planned frame. The game is deterministic, so every page plays the same match. Each page also keeps the sound cues from the frame after the previous chunk, so frames skipped between chunks keep their sounds.
5. **Audio:** the cues go onto the output timeline, into the voice limiter, the compressor and the soft limiter, and out as a WAV.
6. **Encode:** all sizes encode at once in the local scratch (x264 `medium`, or `veryfast` with `--fast`), then the stills, the README and the timing.
7. **Deliver:** the finished files are copied to `--out`, and the scratch folder is deleted.

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

## Montage: `bun run montage`

A posting montage of short mayhem clips from several records (#74), made by the same pipeline (real viewer in video mode, the sim pass, the capture, the sound mix):

```bash
bun run montage records/arena/                 # a folder of records (or a list of files)
bun run montage --server http://localhost:5176 # the newest finished records with AI agents (up to 16)
```

| Option | Meaning |
|---|---|
| `<folder or files>` / `--server <url>` | The records. Each must replay on the current sim; one that does not is skipped with a note. |
| `--out <dir>` | Output folder (default `videos/montage-<date>`) |
| `--workers <n>` | Parallel capture pages per record (default 3) |
| `--work <dir>`, `--keep-work` | As for the teaser |

How the cuts are made (`scripts/montage/cuts.ts`):

- The sim pass gives every fight's big moments with the teaser's weights (explosion, chain snap, platform fall, ring-out, K.O., sudden death, fire, hits).
- A burst starts 0.8 s before a big moment and takes the big moments that follow within 1 s of each other; it ends 1.2 s after the last one, 2 to 4 s long, inside the fight. A cut that reaches the fight's last K.O. ends on it (with nobody left, the camera drifts off at once).
- Score: each K.O. counts in full; n moments of another kind count weight × √n, so variety beats a ninth explosion.
- The best bursts are kept until they make about 22 s (6 to 8 cuts), at most 2 per record, never two of the same moment.
- Order: the smaller half (its strongest first), then an agent's entrance (#66: the record where the most agents drop in and kick a house bot out; the first of them, in full), then 2 agents' cards (the record with the most agents, its rarest models) under the models caption, then the bigger half rising to the biggest cut, then 2.5 s of that record's win screen with the title caption. Two cuts of one record are not adjacent.

Out: `knockback-montage-1080x1920.mp4` and `knockback-montage-1920x1080.mp4` (60 fps, H.264 + AAC, `+faststart`, each under 30 MB: re-encoded at the bitrate that fits when needed), `README.md` with the cut list, `cuts.json`.

- **The vertical cut** crops each fight shot from the 1920×1080 capture: 900×820 px below the HUD chips, centred on the weighted median of the cut's moments on screen, scaled to 1080 wide over a blurred copy. View all in a portrait viewport would cut fighters off at the sides. The cards and the title card are captured in a 1080×1920 viewport, where the viewer lays them out for portrait.
- **Sound:** each shot's own game sound (cues from 0.6 s before the shot still ring into it), 40 ms crossfades at every cut, a 0.6 s fade-out under the title.

## Viewer API used (capture mode)

| Call | What it does |
|---|---|
| `?capture&video` | Video mode (above) |
| `__kb.advance(dt, frames, render)` | Steps the game; `render = false` skips drawing (fast-forward) |
| `__kb.timeline()` | `{ beats: [{ frame, kind, round, index }], ticks: [...], frames }` |
| `__kb.caption({ kind: "start", text } \| { kind: "end", title, text } \| null)` | Sets or clears the caption |
| `__kb.tag(on)` | Shows or hides the "2×" tag |
| `__kb.drainSounds()` | The sound cues since the last call |
