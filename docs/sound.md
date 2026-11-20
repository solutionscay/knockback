# Sound (#12)

The viewer makes all of its sounds in code. There are no audio files in the repository. An optional private sample pack can replace any sound by name.

Sound is view-only. It reads sim events and what the viewer draws, and never changes the simulation. The sim hashes stay the same with sound on or off.

## How it works

| File | Job |
|---|---|
| `src/viewer/audio/synth.ts` | sfxr-style synthesis: a recipe (oscillators, envelopes, pitch slides, filters) renders to samples. It is a pure function, and seeded noise makes it give the same samples every time. |
| `src/viewer/audio/recipes.ts` | The sound book: every sound as recipe data, with its voice group, cap, minimum gap and priority |
| `src/viewer/audio/map.ts` | What sounds when: sim events, show beats (countdown, FIGHT!, round end, win) and face moods become cues. It also sets pan and volume from the camera. |
| `src/viewer/audio/mixer.ts` | Voice limiting (below) |
| `src/viewer/audio/director.ts` | The viewer's entry point. It also detects two sounds that have no sim event, from velocities: grenade bounces and falling platforms crashing down. |
| `src/viewer/audio/engine.ts` | WebAudio playback, the sample pack, settings, and the capture-mode log |
| `src/viewer/audio/ui.ts` | The mute button and volume slider (bottom right) |
| `src/viewer/audio/offline.ts`, `scripts/sound-mix.ts` | The offline mix for videos |

### Rules

- **Autoplay:** sound is off until the first click, tap or key press, as browser autoplay rules require. The button says "tap for sound" until then.
- **Settings:** mute and volume are kept in `localStorage` (`knockback.sound`), per browser.
- **Spatial:** a sound on screen plays at full volume, panned by its place across the view. Off screen it gets quieter with distance: half volume about one view width outside.
- **Dialogue blips:** each bot has its own voice pitch, taken from its identity (name, shape, color).
- **Mood beeps:** a beep plays only when a bot's mood really changes. A hit flash or the K.O. face is not a change.

### Voice limiting

Twenty explosions do not clip. Each sound belongs to a group with a cap, a minimum gap between starts, and a priority:

1. **Gap:** a start closer than the group's gap to the last start in that group is dropped. A chain reaction in one tick is one boom.
2. **Group cap:** when the group is full, its oldest voice stops for the new one. At most 4 explosions play at once.
3. **Total cap:** at most 24 voices play. When all are in use, the oldest voice of the lowest priority stops, but only if that priority is not higher than the new sound's.
4. **Stacking:** the n-th voice of a group plays at 1/√n gain.

After that the mix goes through a compressor (−16 dB, 6:1) and a limiter (−2 dB, 20:1).

## Sound names

These names are the contract for a sample pack.

| Group | Sounds |
|---|---|
| explosion | `explosion.small`, `explosion.medium`, `explosion.large` (chosen by blast radius; bigger blasts are lower and louder) |
| weapon | `rocket.launch`, `shotgun.fire`, `grenade.throw`, `grapple.shoot` |
| swing / melee | `bat.swing`, `fist.swing` (misses); `bat.hit`, `fist.hit` |
| bounce | `grenade.bounce` (detected by the viewer), `pad.bounce` |
| grapple / reel | `grapple.latch`, `grapple.reel` |
| jetpack | `jetpack.hiss` (hook) |
| fire | `flame.whoosh`, `fire.crackle` (hooks) |
| chain / platform | `chain.snap`; `platform.creak` (swinging or falling); `platform.crash` (when it lands, detected by the viewer) |
| break / terrain | `glass.break`, `wood.break`, `steel.clang`; `terrain.crumble` (loose terrain pieces) |
| zap / fuse | `zap`; `fuse.lit` |
| item / drop | `item.spawn`; `prop.drop` |
| pickup / shield | `pickup.weapon`, `pickup.power`, `power.off`; `shield.pop` |
| hit | `hit.light`, `hit.heavy`, `hit.shielded` |
| move | `land` (hard landings), `jump` (double jumps), `swap` (in the book, but silent: AI fighters swap several times a second) |
| ko | `ko`, `ringout.whoosh` |
| mood | `mood.up`, `mood.down`, `mood.angry`, `mood.stun`, `mood.sleepy` |
| ui | `countdown.tick`, `countdown.go`, `suddenDeath.siren`, `round.end`, `win.jingle` |
| blip | `blip` (dialogue text) |

**Hooks for features on their way:** events named `jetpack` or `thrust`, `flame` or `flamethrower`, and `ignite`, `burn` or `fire_spread` sound with no viewer change, as soon as the sim sends them. The cue takes its position from the event's `x` and `y`, or from its `fighter`. The table is `EVENT_HOOKS` in `map.ts`.

## Optional private sample pack

The viewer looks for a manifest at `/sounds/manifest.json`. Use `?sounds=<url>` for another place (a path, or an `https://` URL), or `?sounds=off` to never look.

When a manifest is found, its samples replace the generated sounds by name. Sounds the manifest does not name stay generated.

```json
{
  "version": 1,
  "sounds": {
    "explosion.large": "boom.ogg",
    "glass.break": ["glass1.wav", "glass2.wav"],
    "shotgun.fire": { "files": ["shotgun.mp3"], "gain": 0.8 }
  }
}
```

- **Names:** only sound book names count; others are ignored.
- **Files:** paths are relative to the manifest and may not leave its folder. Allowed types are `ogg`, `mp3`, `wav`, `m4a`, `flac` and `webm`. When a sound lists several files, the cue's seed picks one, so a replay sounds the same.
- **Serving it:** `bun run dev` serves the pack from `./sounds/`, or from `--sounds <dir>`. **That folder is git-ignored and docker-ignored.** Never commit or ship third-party samples whose license does not allow redistribution.

## Videos (capture mode)

Capture mode steps frames on command, so there is no real-time audio. Instead, **the viewer logs every cue with its game time, pan and gain**: `window.__kb.drainSounds()` returns the cues since the last call.

`scripts/sound-mix.ts` renders such a log to a WAV, with the same synthesis and voice limiting as the browser. Mux the WAV with the frames:

```bash
bun scripts/sound-mix.ts cues.json audio.wav --from <game time of the first frame> --length <seconds>
ffmpeg -framerate 60 -i frames/%05d.jpg -i audio.wav -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest out.mp4
```

The offline mix uses the generated sounds only, not a sample pack.

`scripts/record.ts` (WebM via the browser's recorder) stays silent for now.

## Licenses

| Sound files | License |
|---|---|
| None in the repository | All sounds are synthesized at run time from the recipes in `src/viewer/audio/recipes.ts`: original work under the repository's license. |
| A private sample pack | It lives outside the repository. Its owner is responsible for its licenses. |
