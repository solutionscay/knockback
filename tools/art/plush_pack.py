"""
(#85) pack the sprite frames from plush_sprites.py into one atlas per sheet and write the layout the
viewer reads (src/viewer/plush-bot.ts).

    python3 tools/art/plush_pack.py OUT_DIR [DEST=src/viewer/art/plush]

Memory (phase 2): every frame is trimmed to its own opaque pixels (plus a margin) and the trimmed frames are
shelf-packed, so a sheet costs what its frames cover, not its whole cell. Per frame the atlas holds:
  tint R, fixed R, tint L, fixed L   (R: rendered lighting; L: the lights mirrored, for a bot facing left: the viewer
                                      flips the sprite, so the light stays on the same side of the screen)
  silhouette at half resolution      (white, the frame's alpha grown by SIL_GROW pixels: the outline, the hit
                                      flash, the build halos; it is drawn scaled 2x)
The four color layers of a frame share one trim rectangle (the union of their alpha), so a frame is one trim plus
five atlas positions. Each atlas is written twice:
  <name>.ktx2  Basis UASTC (zstd), premultiplied alpha: the viewer transcodes it to the GPU's block format (BC7, ASTC
               4x4 or ETC2: 1 byte per pixel, a quarter of RGBA) with the libktx transcoder pixi.js ships
  <name>.webp  lossy WebP, for a GPU with none of those formats (it would decode the KTX2 to full RGBA anyway)
Atlas sizes are multiples of 4 (block-compressed textures need it). Needs basisu (brew install basis_universal).

layout.ts gives, in cell pixels (the whole rendered square, before trimming): the ground point, the visor points,
the head and torso anchors (center, +x, +z of the bone, projected), the near shoulder and wrist, and (aimed
weapons) the muzzle and the barrel angle of every frame, plus its trim and atlas positions. It also imports the atlases (URLs
only: the viewer loads a sheet when a match needs it).
"""
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

MAX_W = 2048
SIL_GROW = 3
PAD = 6       # margin around a frame's alpha: the grown silhouette and its blur fit inside
GAP = 2       # transparent pixels between packed frames (no bleeding under linear filtering)
QUALITY = 90
LAYERS = (("R", "tint"), ("R", "fixed"), ("L", "tint"), ("L", "fixed"))


def ident(name):
    parts = name.replace("_", "-").split("-")
    return parts[0] + "".join(p.capitalize() for p in parts[1:]) + "Url"


def shelf_pack(sizes, max_w=MAX_W):
    """Rectangles (w, h) -> positions (x, y) and the atlas size: tallest first, in rows."""
    order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
    pos = [None] * len(sizes)
    x = y = row_h = 0
    width = 0
    for i in order:
        w, h = sizes[i]
        if x + w > max_w:
            x, y, row_h = 0, y + row_h + GAP, 0
        pos[i] = (x, y)
        x += w + GAP
        row_h = max(row_h, h)
        width = max(width, x - GAP)
    return pos, ((width + 3) // 4 * 4, (y + row_h + 3) // 4 * 4)


def main():
    out = os.path.abspath(sys.argv[1])
    dest = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "..", "src", "viewer", "art", "plush"))
    src = os.path.join(out, "sprites")
    meta = json.load(open(os.path.join(src, "meta.json")))
    os.makedirs(dest, exist_ok=True)
    for f in os.listdir(dest):
        if f.endswith((".png", ".webp", ".ktx2")):
            os.remove(os.path.join(dest, f))
    layout = {"ppm": meta["ppm"], "cell": meta["cell"], "angle": meta["angle"], "sheets": {}}
    total_bytes, total_px, ktx_bytes = 0, 0, 0
    names = sorted(meta["sheets"])
    for name in names:
        sm = meta["sheets"][name]
        n = len(sm["frames"])
        cell = meta["cell"]
        rects, tiles = [], []
        for k in range(n):
            ims = [Image.open(os.path.join(src, name, f, L, "f%02d.png" % k)).convert("RGBA") for f, L in LAYERS]
            alpha = np.max([np.asarray(im.getchannel("A")) for im in ims[:2]], axis=0)
            bb = Image.fromarray(np.max([np.asarray(im.getchannel("A")) for im in ims], axis=0)).point(lambda v: 255 if v > 2 else 0).getbbox()
            if bb is None:
                bb = (0, 0, 2, 2)
            # an even trim origin and size: the half-resolution silhouette lines up exactly
            x0, y0 = max(0, (bb[0] - PAD) // 2 * 2), max(0, (bb[1] - PAD) // 2 * 2)
            x1, y1 = min(cell, bb[2] + PAD), min(cell, bb[3] + PAD)
            w, h = (x1 - x0 + 1) // 2 * 2, (y1 - y0 + 1) // 2 * 2
            box = (x0, y0, x0 + w, y0 + h)
            for im in ims:
                tiles.append(im.crop(box))
            a = Image.fromarray(alpha).filter(ImageFilter.MaxFilter(2 * SIL_GROW + 1)).filter(ImageFilter.GaussianBlur(0.7)).crop(box)
            a = a.resize((w // 2, h // 2), Image.LANCZOS)
            sil = Image.new("RGBA", a.size, (255, 255, 255, 0))
            sil.putalpha(a)
            tiles.append(sil)
            rects.append((x0, y0, w, h))
        pos, (aw, ah) = shelf_pack([t.size for t in tiles])
        atlas = Image.new("RGBA", (aw, ah), (0, 0, 0, 0))
        for t, p in zip(tiles, pos):
            atlas.paste(t, p)
        p = os.path.join(dest, name + ".webp")
        atlas.save(p, "WEBP", quality=QUALITY, method=6)
        kp = os.path.join(dest, name + ".ktx2")
        pm = np.asarray(atlas).astype(np.float32)
        pm[..., :3] *= pm[..., 3:] / 255.0
        with tempfile.TemporaryDirectory() as td:
            tmp = os.path.join(td, "a.png")
            Image.fromarray(pm.round().astype(np.uint8)).save(tmp)
            subprocess.run(["basisu", "-ktx2", "-uastc", "-uastc_rdo_l", "1.0", "-file", tmp, "-output_file", kp],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        total_bytes += os.path.getsize(p)
        ktx_bytes += os.path.getsize(kp)
        total_px += aw * ah
        frames = []
        r2 = lambda q: [round(q[0], 2), round(q[1], 2)]
        for k, fm in enumerate(sm["frames"]):
            f = {"visor": [r2(q) for q in fm["visor"]], "head": [r2(q) for q in fm["head"]],
                 "torso": [r2(q) for q in fm["torso"]], "shoulder": r2(fm["shoulder"]),
                 "trim": list(rects[k]), "at": [list(pos[k * 5 + i]) for i in range(5)]}
            if "wrist" in fm:
                f["wrist"] = r2(fm["wrist"])
            if "sole" in fm:
                f["sole"] = r2(fm["sole"])
            if "angle" in fm:
                f["angle"] = fm["angle"]
                f["muzzle"] = r2(fm["barrel"][1])
            frames.append(f)
        layout["sheets"][name] = {"n": n, "ground": r2(sm["ground"]), "size": [aw, ah], "frames": frames}
        print("%-26s %2d frames atlas %4dx%-4d %5.2f Mpx webp %6.1f KB ktx2 %6.1f KB" % (name, n, aw, ah, aw * ah / 1e6, os.path.getsize(p) / 1024, os.path.getsize(kp) / 1024))
    ts = os.path.join(dest, "layout.ts")
    with open(ts, "w") as fh:
        fh.write("// Generated by tools/art/plush_pack.py (#85): the plush sprite sheets and their layout. Do not edit.\n")
        fh.write("// Cell pixels (the rendered square); ppm: sprite pixels per game meter; frames at about 12 fps.\n")
        fh.write("// Per frame: trim [x, y, w, h] in the cell; at: atlas positions of tint R, fixed R, tint L, fixed L, silhouette (half size).\n")
        for name in names:
            fh.write('import %s from "./%s.webp";\n' % (ident(name), name))
            fh.write('import %s from "./%s.ktx2";\n' % (ident(name).replace("Url", "Ktx"), name))
        fh.write("export const PLUSH_URLS = {\n")
        for name in names:
            fh.write('  "%s": { webp: %s, ktx2: %s },\n' % (name, ident(name), ident(name).replace("Url", "Ktx")))
        fh.write("} as const;\n")
        fh.write("export const PLUSH_LAYOUT = " + json.dumps(layout, separators=(",", ":")) + " as const;\n")
    write_portraits(src, meta, dest)
    print("TOTAL webp %.2f MB, ktx2 %.2f MB on disk; %.2f Mpx: %.1f MB as RGBA textures, %.1f MB as BC7/ASTC/ETC2 -> %s"
          % (total_bytes / 1e6, ktx_bytes / 1e6, total_px / 1e6, total_px * 4 / 1e6, total_px / 1e6, dest))


def write_portraits(src, meta, dest, build="balanced"):
    """The portrait parts (src/viewer/portrait.ts draws them as SVG for the cards, the site and the share images):
    the build's idle first frame (body, boots and fist together) and every mark's first frame, the tint and the
    fixed layer each as a PNG data URI, cropped, with their anchors in cell pixels."""
    import base64
    import io

    def layers(names, k=0):
        out = {}
        for L in ("tint", "fixed"):
            im = None
            for n in names:
                f = os.path.join(src, n, "R", L, "f%02d.png" % k)
                if not os.path.exists(f):
                    continue
                layer = Image.open(f).convert("RGBA")
                im = layer if im is None else Image.alpha_composite(im, layer)
            out[L] = im
        return out

    def part(ims, fm):
        a = np.max([np.asarray(ims[L].getchannel("A")) for L in ims], axis=0)
        bb = Image.fromarray(a).point(lambda v: 255 if v > 2 else 0).getbbox()
        x0, y0, x1, y1 = max(0, bb[0] - 2), max(0, bb[1] - 2), bb[2] + 2, bb[3] + 2
        rec = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
        for L, im in ims.items():
            buf = io.BytesIO()
            im.crop((x0, y0, x1, y1)).save(buf, "PNG", optimize=True)
            rec[L] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        rec["head"] = fm["head"]
        rec["torso"] = fm["torso"]
        return rec

    body_names = ["%s-body-idle" % build, "%s-bootl-idle" % build, "%s-bootr-idle" % build, "%s-fist-idle" % build]
    sm = meta["sheets"]
    fm = sm["%s-body-idle" % build]["frames"][0]
    body = part(layers(body_names), fm)
    body["visor"] = fm["visor"]
    marks = {}
    for n in sorted(sm):
        if n.startswith("mark-"):
            marks[n[5:]] = part(layers([n]), sm[n]["frames"][0])
    data = {"ppm": meta["ppm"], "ground": sm["%s-body-idle" % build]["ground"], "body": body, "marks": marks}
    ts = os.path.join(dest, "portraits.ts")
    with open(ts, "w") as fh:
        fh.write("// Generated by tools/art/plush_pack.py (#85): the plush portrait parts (src/viewer/portrait.ts). Do not edit.\n")
        fh.write("// The %s idle first frame and every mark's first frame: tint and fixed layers as PNG data URIs, cell pixels.\n" % build)
        fh.write("export const PORTRAIT = " + json.dumps(data, separators=(",", ":")) + " as const;\n")
    print("portraits.ts %.1f KB" % (os.path.getsize(ts) / 1024))


if __name__ == "__main__":
    main()
