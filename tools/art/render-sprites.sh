#!/bin/sh
# The fighters' sprite sheets (#85): the plush brawler for the viewer (src/viewer/plush-bot.ts), headless.
#   tools/art/render-sprites.sh OUT_DIR          render every sheet of every build (short runs), then pack into src/viewer/art/plush
#   BUILDS="tank glass" tools/art/render-sprites.sh OUT_DIR   only those builds (the marks always render)
#   tools/art/render-sprites.sh OUT_DIR --pack   only pack what OUT_DIR already holds
# Machine safety: CPU only, 6 threads (KB_THREADS), nice 10, one Blender at a time, a few minutes per run.
set -e
cd "$(dirname "$0")/../.."
OUT="${1:?usage: tools/art/render-sprites.sh OUT_DIR [--pack]}"
BL="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
blender() {
  if pgrep -f "MacOS/Blender -b" >/dev/null; then echo "another headless Blender is running; wait for it" >&2; exit 2; fi
  nice -n 10 "$BL" -b -t "${KB_THREADS:-6}" --factory-startup --python-exit-code 1 \
    --python tools/art/plush_sprites.py -- --out "$OUT" "$@"
}
W="rocket bat rifle shotgun sniper crossbow railgun hammer flamethrower lightning grenade mine grapple"
list() { pre=$1; shift; for x in "$@"; do printf "%s%s," "$pre" "$x"; done; }
if [ "$2" != "--pack" ]; then
  for B in ${BUILDS:-balanced tank anchor glass}; do
    blender --build $B --sheets $(list $B-body- idle run punch launched jump flinch ko celebrate)
    blender --build $B --sheets $(list $B-fist- idle run punch launched jump flinch ko celebrate)
    blender --build $B --sheets $(list $B-bootl- idle run punch flinch)$(list $B-bootr- idle run punch flinch)
    blender --build $B --sheets $(list $B-sleeve- $W)
  done
  # shared by every build (rendered on balanced): the weapons with their mitt, and the head marks
  blender --build balanced --sheets $(list weapon- $W)
  blender --build balanced --sheets $(list mark- headband antenna crown ears catears horns propeller mohawk halo beanie cape bow sprout tophat bolts scarf)
fi
python3 tools/art/plush_pack.py "$OUT"
