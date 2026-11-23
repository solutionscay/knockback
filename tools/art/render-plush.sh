#!/bin/sh
# (#85) build the plush Skipper brawler in Blender and render every deliverable, headless.
#
#   tools/art/render-plush.sh OUT_DIR                 every deliverable, as a chain of short Blender runs
#   tools/art/render-plush.sh OUT_DIR [options]       one Blender run with plush_bot.py options, e.g.
#                                                     --quick, --only turnaround,poses, --frames 0:45
#
# Writes OUT_DIR/raw/*.png (transparent renders), OUT_DIR/*.png (on the navy background), the sheets,
# OUT_DIR/plush-turntable.mp4 and plush-run.mp4, OUT_DIR/times.txt, and tools/art/build/plush-*.blend.
# Needs Blender 5.x (BLENDER=/path overrides), python3 with Pillow and numpy, and ffmpeg.
#
# Machine safety (a 16 GB Mac mini): CPU only (the script never selects the GPU), 6 threads
# (KB_THREADS), nice 10, one Blender at a time, and no run longer than about 30 minutes: the
# full set is split into separate processes, and the videos render in frame chunks.
set -e
cd "$(dirname "$0")/../.."
OUT="${1:?usage: tools/art/render-plush.sh OUT_DIR [options]}"
shift
BL="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"

blender() {
  if pgrep -f "MacOS/Blender -b" >/dev/null; then
    echo "another headless Blender is running; wait for it" >&2
    exit 2
  fi
  nice -n 10 "$BL" -b -t "${KB_THREADS:-6}" --factory-startup --python-exit-code 1 \
    --python tools/art/plush_bot.py -- --out "$OUT" "$@"
}

if [ $# -gt 0 ]; then
  blender "$@"
else
  # stills: about 7 minutes each at 1600 px, 128 samples; at most 4 per run
  blender --only turnaround
  blender --only colors
  blender --only heads
  # the bigger pose frames and the builds use less hair, to keep Blender under ~5 GB RSS
  blender --only poses --poses run,jump,launched --hair 0.3
  blender --only poses --poses victory --hair 0.3
  (export KB_POSE_ANGLE=-30; blender --only poses --poses punch --hair 0.3)  # the punching arm faces this side
  blender --only builds --hair 0.25       # 4 builds, each its own model and .blend
  for f in 0:45 45:90 90:135 135:180; do  # 6 s turntable at 30 fps, 1080p
    blender --only turntable --frames "$f"
  done
  for f in 0:36 36:72; do                 # 2.4 s run cycle, 1080x1080
    blender --only run --frames "$f"
  done
fi
python3 tools/art/plush_sheet.py "$OUT"
