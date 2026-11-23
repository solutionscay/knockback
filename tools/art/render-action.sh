#!/bin/sh
# (#85) round 3: the plush brawler in action and with weapons, headless.
#
#   tools/art/render-action.sh OUT_DIR              everything, as a chain of short Blender runs
#   tools/art/render-action.sh OUT_DIR [options]    one Blender run with plush_action.py options, e.g.
#                                                   --preview 6, --stills bat, --loop run --frames 0:12
#
# Writes OUT_DIR/raw (transparent renders), the composited stills, frames, loop mp4s, frame strips,
# sheet-weapons.png, sheet-contact.png and times.txt, and tools/art/build/plush-action.blend.
# Needs Blender 5.x (BLENDER=/path overrides), python3 with Pillow and numpy, and ffmpeg.
#
# Machine safety (a 16 GB Mac mini): CPU only, 6 threads (KB_THREADS), nice 10, one Blender at a
# time, and short runs: loop frames render in chunks of at most 24 frames (about 6 minutes).
set -e
cd "$(dirname "$0")/../.."
OUT="${1:?usage: tools/art/render-action.sh OUT_DIR [options]}"
shift
BL="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"

blender() {
  if pgrep -f "MacOS/Blender -b" >/dev/null; then
    echo "another headless Blender is running; wait for it" >&2
    exit 2
  fi
  nice -n 10 "$BL" -b -t "${KB_THREADS:-6}" --factory-startup --python-exit-code 1 \
    --python tools/art/plush_action.py -- --out "$OUT" "$@"
}

if [ $# -gt 0 ]; then
  blender "$@"
else
  blender --stills rocket,bat,rifle --save        # 3 hero stills, 1400x1600, 128 samples
  blender --loop idle --frames 0:24
  blender --loop run --frames 0:24
  blender --loop punch --frames 0:24
  blender --loop launched --frames 0:20
  blender --loop launched --frames 20:40
  blender --loop rocket --frames 0:18
  blender --loop rocket --frames 18:36
  blender --loop bat --frames 0:16
  blender --loop bat --frames 16:32
  blender --loop rifle --frames 0:24
fi
python3 tools/art/plush_action_sheet.py "$OUT"
