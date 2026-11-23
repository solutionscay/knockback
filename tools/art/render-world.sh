#!/bin/sh
# The world's sprites (#87): pickups, props and projectiles, headless, then packed into src/viewer/art/world.
#   tools/art/render-world.sh OUT_DIR [groups]      (groups: pickups,props,projectiles,tiles; default all)
#   tools/art/render-world.sh OUT_DIR --pack        only pack what OUT_DIR already holds
# Machine safety: CPU only, 6 threads (KB_THREADS), nice 10, one Blender at a time.
set -e
cd "$(dirname "$0")/../.."
OUT="${1:?usage: tools/art/render-world.sh OUT_DIR [groups|--pack]}"
G="${2:-pickups,props,projectiles,tiles}"
BL="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
if [ "$G" != "--pack" ]; then
  if pgrep -f "MacOS/Blender -b" >/dev/null; then echo "another headless Blender is running; wait for it" >&2; exit 2; fi
  nice -n 10 "$BL" -b -t "${KB_THREADS:-6}" --factory-startup --python-exit-code 1 --python tools/art/plush_world.py -- --out "$OUT" --groups "$G"
  python3 tools/art/world_pack.py "$OUT" "$G"
else
  python3 tools/art/world_pack.py "$OUT"
fi
