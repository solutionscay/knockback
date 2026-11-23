"""
(#85) round 3: lay out the action renders. Reads OUT_DIR/raw, writes:

- weapon-*.png and sheet-weapons.png (the hero stills on the navy background, labeled)
- loop-NAME.mp4 (24 fps, the loop played 3 times), frames-NAME/ (composited frames),
  strip-NAME.png (every frame of the loop in a grid, numbered)
- sheet-contact.png (8 frames from every loop, one row per loop)

    python3 tools/art/plush_action_sheet.py OUT_DIR
"""
import glob
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plush_sheet as ps  # noqa: E402

ORDER = ["idle", "run", "punch", "launched", "rocket", "bat", "rifle"]
TITLES = {"idle": "IDLE", "run": "RUN", "punch": "PUNCH", "launched": "LAUNCHED",
          "rocket": "ROCKET", "bat": "BAT", "rifle": "RIFLE"}


def grid(frames, cols, cell, labels=None, pad_left=0, title=None):
    rows = (len(frames) + cols - 1) // cols
    w, h = pad_left + cols * cell, rows * cell
    canvas = Image.fromarray(ps.background(w, h).astype(np.uint8))
    d = ImageDraw.Draw(canvas)
    f = ps.font(max(14, cell // 14))
    for k, im in enumerate(frames):
        x, y = pad_left + (k % cols) * cell, (k // cols) * cell
        canvas.paste(im.resize((cell, cell), Image.LANCZOS), (x, y))
        if labels:
            d.text((x + 8, y + 6), labels[k], font=f, fill=ps.LABEL)
    if title:
        tf = ps.font(max(22, cell // 7))
        d.text((24, h / 2 - cell // 10), title, font=tf, fill=ps.LABEL)
    return canvas


def main():
    out = os.path.abspath(sys.argv[1])
    raw = os.path.join(out, "raw")
    stills = {}
    for w in ("rocket", "bat", "rifle"):
        p = os.path.join(raw, "weapon-%s.png" % w)
        if os.path.exists(p):
            stills[w] = ps.composite(p)
            stills[w].save(os.path.join(out, "weapon-%s.png" % w))
    if stills:
        ps.sheet([(stills[w], TITLES[w]) for w in ("rocket", "bat", "rifle") if w in stills],
                 os.path.join(out, "sheet-weapons.png"), crop=(0.04, 0.0, 0.96, 1.0))
    contact = []
    for name in ORDER:
        fs = sorted(glob.glob(os.path.join(raw, "loop-" + name, "f*.png")))
        if not fs:
            continue
        d = os.path.join(out, "frames-" + name)
        os.makedirs(d, exist_ok=True)
        ims = []
        for i, f in enumerate(fs):
            im = ps.composite(f)
            im.save(os.path.join(d, "f%04d.png" % i))
            ims.append(im)
        mp4 = os.path.join(out, "loop-%s.mp4" % name)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-stream_loop", "2", "-framerate", "24",
                        "-i", os.path.join(d, "f%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-crf", "16", "-preset", "slow", "-movflags", "+faststart", mp4], check=True)
        grid(ims, 12, 270, labels=["%d" % i for i in range(len(ims))]).save(os.path.join(out, "strip-%s.png" % name))
        pick = [ims[round(j * len(ims) / 8)] for j in range(8)]
        contact.append((name, pick, len(ims)))
        print("loop", name, len(ims), "frames ->", mp4)
    if contact:
        cell, left = 300, 330
        rows = [grid(p, 8, cell, pad_left=left, title="%s\n%d f" % (TITLES[n], k)) for n, p, k in contact]
        sheet = Image.new("RGB", (rows[0].width, sum(r.height for r in rows)))
        y = 0
        for r in rows:
            sheet.paste(r, (0, y))
            y += r.height
        sheet.save(os.path.join(out, "sheet-contact.png"))
        print("sheet-contact.png", sheet.size)


if __name__ == "__main__":
    main()
