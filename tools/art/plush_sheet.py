"""
(#85) put the transparent Blender renders on the navy studio background,
add a soft glow to the emissive parts, and lay out the labeled sheets and the videos.

    python3 tools/art/plush_sheet.py OUT_DIR      (reads OUT_DIR/raw, writes OUT_DIR/*.png, *.mp4)

Needs Pillow and numpy (system python3), and ffmpeg for the videos.
"""
import glob
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG_TOP = np.array([22, 27, 56], float)
BG_BOT = np.array([12, 15, 36], float)
LABEL = (178, 186, 230)


def font(size):
    for f in ("/System/Library/Fonts/Avenir Next.ttc", "/System/Library/Fonts/Helvetica.ttc"):
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size, index=2 if "Avenir" in f else 0)
            except Exception:
                pass
    return ImageFont.load_default(size)


def background(w, h):
    y = np.linspace(0, 1, h)[:, None, None]
    x = np.linspace(-1, 1, w)[None, :, None]
    yy = np.linspace(-1, 1, h)[:, None, None]
    base = BG_TOP * (1 - y) + BG_BOT * y
    glow = np.exp(-(x ** 2 * 1.6 + (yy + 0.1) ** 2 * 2.2)) * 10
    img = base + glow * np.array([0.7, 0.8, 1.6])
    return np.broadcast_to(img, (h, w, 3)).copy()


def composite(path):
    """Transparent render -> RGB on the navy background, with a soft bloom on bright pixels."""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(float) / 255
    rgb, al = a[..., :3], a[..., 3:4]
    h, w = al.shape[:2]
    bg = background(w, h) / 255
    out = rgb * al + bg * (1 - al)
    # bloom: only very bright, saturated-light pixels (LEDs, antenna ball, glowing mitts)
    lum = (rgb * al).max(-1)
    mask = np.clip((lum - 0.9) / 0.1, 0, 1)[..., None] * rgb * al
    m8 = Image.fromarray((mask * 255).astype(np.uint8))
    s = max(w, h) / 1600
    b1 = np.asarray(m8.filter(ImageFilter.GaussianBlur(10 * s))).astype(float) / 255
    b2 = np.asarray(m8.filter(ImageFilter.GaussianBlur(34 * s))).astype(float) / 255
    out = 1 - (1 - out) * (1 - np.clip(b1 * 0.55 + b2 * 0.6, 0, 1))
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def label(img, text, size):
    d = ImageDraw.Draw(img)
    f = font(size)
    tw = d.textlength(text, font=f)
    d.text(((img.width - tw) / 2, img.height - size * 2.2), text, font=f, fill=LABEL)


def sheet(cells, out, cell_w=None, label_size=None, crop=None):
    """cells: [(image, label)] in one row, on one background. Labels scale with the cell height."""
    if label_size is None:
        label_size = max(28, int(max(im.height for im, _ in cells) * 0.042))
    ims = []
    for im, text in cells:
        if crop:
            l, t, r, b = crop
            im = im.crop((int(l * im.width), int(t * im.height), int(r * im.width), int(b * im.height)))
        ims.append((im, text))
    h = max(i.height for i, _ in ims) + int(label_size * 2.6)
    w = sum(i.width for i, _ in ims)
    canvas = Image.fromarray(background(w, h).astype(np.uint8))
    x = 0
    for im, text in ims:
        # paste the raw cell's pixels; the cell already has the same background
        canvas.paste(im, (x, 0))
        cell = canvas.crop((x, 0, x + im.width, h))
        label(cell, text, label_size)
        canvas.paste(cell, (x, 0))
        x += im.width
    canvas.save(out)
    print("sheet", out, canvas.size)


def main():
    out = os.path.abspath(sys.argv[1])
    raw = os.path.join(out, "raw")
    C = {}
    for p in sorted(glob.glob(os.path.join(raw, "*.png"))):
        name = os.path.splitext(os.path.basename(p))[0]
        C[name] = composite(p)
        C[name].save(os.path.join(out, name + ".png"))
    have = lambda *ks: all(k in C for k in ks)
    if have("turn-front", "turn-threequarter", "turn-side", "turn-back"):
        sheet([(C["turn-front"], "FRONT"), (C["turn-threequarter"], "THREE-QUARTER"), (C["turn-side"], "SIDE"), (C["turn-back"], "BACK")],
              os.path.join(out, "sheet-turnaround.png"), crop=(0.08, 0.0, 0.92, 1.0))
    if have("turn-threequarter", "color-blue", "color-pink"):
        sheet([(C["turn-threequarter"], "ORANGE"), (C["color-blue"], "BLUE"), (C["color-pink"], "PINK")],
              os.path.join(out, "sheet-colors.png"), crop=(0.08, 0.0, 0.92, 1.0))
    if have("build-balanced", "build-tank", "build-anchor", "build-glass"):
        sheet([(C["build-balanced"], "BALANCED"), (C["build-tank"], "TANK"), (C["build-anchor"], "ANCHOR"), (C["build-glass"], "GLASS CANNON")],
              os.path.join(out, "sheet-builds.png"), crop=(0.04, 0.0, 0.96, 1.0))
    poses = [k for k in ("run", "jump", "punch", "launched", "victory") if "pose-" + k in C]
    if poses:
        sheet([(C["pose-" + k], k.upper()) for k in poses], os.path.join(out, "sheet-poses.png"), crop=(0.06, 0.0, 0.94, 1.0))
    heads = [k for k in ("antenna", "catears", "headband") if "head-" + k in C]
    if heads:
        names = {"antenna": "ANTENNA", "catears": "CAT EARS", "headband": "HEADBAND"}
        sheet([(C["head-" + k], names[k]) for k in heads], os.path.join(out, "sheet-heads.png"), crop=(0.08, 0.0, 0.92, 1.0))
    for vid, fps, loops in (("turntable", 30, 1), ("run", 30, 1)):
        frames = sorted(glob.glob(os.path.join(raw, vid, "f*.png")))
        if not frames:
            continue
        d = os.path.join(out, "frames-" + vid)
        os.makedirs(d, exist_ok=True)
        for i, f in enumerate(frames):
            composite(f).save(os.path.join(d, "f%04d.png" % i))
        mp4 = os.path.join(out, "plush-%s.mp4" % vid)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(fps), "-stream_loop", str(loops - 1),
                        "-i", os.path.join(d, "f%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-crf", "16", "-preset", "slow", "-movflags", "+faststart", mp4], check=True)
        print("video", mp4, len(frames), "frames")


if __name__ == "__main__":
    main()
