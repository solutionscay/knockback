"""
Pack the world sprites from plush_world.py (#87) into one atlas per group and write the layout the viewer reads
(src/viewer/world-art.ts).

    python3 tools/art/world_pack.py OUT_DIR [groups=pickups,props,projectiles,tiles] [DEST=src/viewer/art/world]

Each group (pickups, props, projectiles) is one atlas: its frames shelf-packed, written as KTX2 (Basis UASTC,
premultiplied: BC7/ASTC/ETC2 on the GPU) and WebP, like the fighters' (plush_pack.py). layout.ts gives every frame's
atlas position and size, its anchor (the pixel the viewer puts at the object's center) and its pixels per meter.
Tiles (the chain link) are not packed: a tiling sprite repeats its whole texture, so each is its own file
(tile-<name>) and WORLD_TILES gives its URLs and size.
The level (#92) goes to src/viewer/art/level: one atlas per theme (level-<theme>: its cells and top edges) and one
shared (level: cracks, char, edge piping, the chain anchor). A terrain frame sits next to copies of itself, so each is
padded with its own edge pixels (no seam from filtering) on a 4-pixel grid, and the lights' slow falloff across a
repeating frame is divided out (a plane fit to the luminance, along the axes it repeats on).
Needs basisu (brew install basis_universal).
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plush_pack import ident, shelf_pack  # noqa: E402


def meta_frames(out):
    return json.load(open(os.path.join(os.path.abspath(out), "world", "meta.json")))["frames"]


def write_ktx2(im, path):
    """KTX2, Basis UASTC, alpha premultiplied (as plush_pack.py)."""
    pm = np.asarray(im).astype(np.float32)
    pm[..., :3] *= pm[..., 3:] / 255.0
    with tempfile.TemporaryDirectory() as td:
        tmp = os.path.join(td, "a.png")
        Image.fromarray(pm.round().astype(np.uint8)).save(tmp)
        subprocess.run(["basisu", "-ktx2", "-uastc", "-uastc_rdo_l", "1.0", "-file", tmp, "-output_file", path], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


PAD = 4


def flatten(a, axes):
    """Divide out a linear brightness slope (luminance, alpha-weighted, at most 15%) along x and/or y, keeping the mean."""
    if not axes:
        return a
    h, w = a.shape[:2]
    f = a.astype(np.float64)
    wgt = f[..., 3] / 255.0
    ys, xs = np.mgrid[0:h, 0:w]
    cols = [np.ones(h * w)]
    if "x" in axes:
        cols.append((xs.ravel() - (w - 1) / 2) / w)
    if "y" in axes:
        cols.append((ys.ravel() - (h - 1) / 2) / h)
    X = np.stack(cols, 1)
    lum = f[..., :3] @ np.array([0.2126, 0.7152, 0.0722])
    coef, *_ = np.linalg.lstsq(X * wgt.ravel()[:, None], lum.ravel() * wgt.ravel(), rcond=None)
    fit = np.einsum("ij,j->i", X, coef).reshape(h, w)
    k = np.clip(coef[0] / np.maximum(fit, 1.0), 0.85, 1.15)
    f[..., :3] *= k[..., None]
    return np.clip(f.round(), 0, 255).astype(np.uint8)


def level_pack(out, dest=None):
    dest = os.path.abspath(dest or os.path.join(os.path.dirname(__file__), "..", "..", "src", "viewer", "art", "level"))
    src = os.path.join(os.path.abspath(out), "world")
    meta = json.load(open(os.path.join(src, "meta.json")))["frames"]
    os.makedirs(dest, exist_ok=True)
    for f in os.listdir(dest):
        if f.endswith((".webp", ".ktx2")):
            os.remove(os.path.join(dest, f))
    groups = sorted(set(fm["group"] for fm in meta.values() if fm["group"].startswith("level")))
    layout = {"frames": {}, "sizes": {}}
    tot_px = tot_k = tot_w = 0
    for g in groups:
        names = sorted(n for n, fm in meta.items() if fm["group"] == g)
        ims = []
        for n in names:
            fm = meta[n]
            a = np.asarray(Image.open(os.path.join(src, g, n.split(":")[-1] + ".png")).convert("RGBA"))
            tile = fm.get("tile")
            if tile is not None:
                a = flatten(a, tile)
            ims.append(np.pad(a, ((PAD, PAD), (PAD, PAD), (0, 0)), mode="edge" if tile else "constant"))
        sizes = [((im.shape[1] + 3) // 4 * 4, (im.shape[0] + 3) // 4 * 4) for im in ims]
        order = sorted(range(len(ims)), key=lambda i: -sizes[i][1])
        pos, x, y, row, aw = [None] * len(ims), 0, 0, 0, 0
        for i in order:
            w, h = sizes[i]
            if x + w > 1024:
                x, y, row = 0, y + row, 0
            pos[i] = (x, y)
            x += w
            row = max(row, h)
            aw = max(aw, x)
        ah = y + row
        atlas = np.zeros((ah, aw, 4), np.uint8)
        for n, im, (px, py) in zip(names, ims, pos):
            atlas[py:py + im.shape[0], px:px + im.shape[1]] = im
            fm = meta[n]
            layout["frames"][n] = {"g": g, "x": px + PAD, "y": py + PAD, "w": im.shape[1] - 2 * PAD, "h": im.shape[0] - 2 * PAD, "ax": fm["ax"], "ay": fm["ay"], "ppm": fm["ppm"]}
        layout["sizes"][g] = [aw, ah]
        im = Image.fromarray(atlas)
        wp, kp = os.path.join(dest, g + ".webp"), os.path.join(dest, g + ".ktx2")
        im.save(wp, "WEBP", quality=90, method=6)
        write_ktx2(im, kp)
        tot_px += aw * ah
        tot_k += os.path.getsize(kp)
        tot_w += os.path.getsize(wp)
        print("%-20s %2d frames atlas %4dx%-4d webp %6.1f KB ktx2 %6.1f KB" % (g, len(names), aw, ah, os.path.getsize(wp) / 1024, os.path.getsize(kp) / 1024))
    with open(os.path.join(dest, "layout.ts"), "w") as fh:
        fh.write("// Generated by tools/art/world_pack.py (#92): the level's terrain frames, one atlas per theme and one shared. Do not edit.\n")
        fh.write("// Atlas pixels (the frame inside its edge padding); ax, ay: the anchor pixel (tiles: the top-left); ppm: pixels per game meter.\n")
        for g in groups:
            fh.write('import %s from "./%s.webp";\n' % (ident(g), g))
            fh.write('import %s from "./%s.ktx2";\n' % (ident(g).replace("Url", "Ktx"), g))
        fh.write("export const LEVEL_URLS = {\n")
        for g in groups:
            key = g[6:] if g != "level" else "common"
            fh.write('  %s: { webp: %s, ktx2: %s },\n' % (key, ident(g), ident(g).replace("Url", "Ktx")))
        fh.write("} as const;\n")
        fh.write("export const LEVEL_LAYOUT = " + json.dumps(layout, separators=(",", ":")) + " as const;\n")
    print("LEVEL TOTAL %.2f Mpx; download ktx2 %.2f MB, webp %.2f MB" % (tot_px / 1e6, tot_k / 1e6, tot_w / 1e6))


def main():
    out = os.path.abspath(sys.argv[1])
    groups = (sys.argv[2] if len(sys.argv) > 2 else "pickups,props,projectiles,tiles,level").split(",")
    if "level" in groups:
        groups.remove("level")
        level_pack(out)
        if not groups:
            return
    tiles = [n for n, fm in meta_frames(sys.argv[1]).items() if fm["group"] == "tiles"] if "tiles" in groups else []
    groups = [g for g in groups if g != "tiles"]
    dest = os.path.abspath(sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), "..", "..", "src", "viewer", "art", "world"))
    src = os.path.join(out, "world")
    meta = json.load(open(os.path.join(src, "meta.json")))["frames"]
    os.makedirs(dest, exist_ok=True)
    for f in os.listdir(dest):
        if f.endswith((".webp", ".ktx2")):
            os.remove(os.path.join(dest, f))
    layout = {"frames": {}, "sizes": {}}
    tot_px = tot_k = tot_w = 0
    for g in groups:
        names = sorted(n for n, fm in meta.items() if fm["group"] == g)
        ims = [Image.open(os.path.join(src, g, n + ".png")).convert("RGBA") for n in names]
        pos, (aw, ah) = shelf_pack([im.size for im in ims])
        atlas = Image.new("RGBA", (aw, ah), (0, 0, 0, 0))
        for n, im, p in zip(names, ims, pos):
            atlas.paste(im, p)
            fm = meta[n]
            layout["frames"][n] = {"g": g, "x": p[0], "y": p[1], "w": im.width, "h": im.height, "ax": fm["ax"], "ay": fm["ay"], "ppm": fm["ppm"]}
        layout["sizes"][g] = [aw, ah]
        wp = os.path.join(dest, g + ".webp")
        atlas.save(wp, "WEBP", quality=90, method=6)
        kp = os.path.join(dest, g + ".ktx2")
        write_ktx2(atlas, kp)
        tot_px += aw * ah
        tot_k += os.path.getsize(kp)
        tot_w += os.path.getsize(wp)
        print("%-12s %2d frames atlas %4dx%-4d webp %6.1f KB ktx2 %6.1f KB" % (g, len(names), aw, ah, os.path.getsize(wp) / 1024, os.path.getsize(kp) / 1024))
    tile_meta = {}
    for n in tiles:
        im = Image.open(os.path.join(src, "tiles", n + ".png")).convert("RGBA")
        wp, kp = os.path.join(dest, "tile-" + n + ".webp"), os.path.join(dest, "tile-" + n + ".ktx2")
        im.save(wp, "WEBP", quality=90, method=6)
        write_ktx2(im, kp)
        tile_meta[n] = {"w": im.width, "h": im.height, "ppm": meta[n]["ppm"]}
        tot_px += im.width * im.height
        tot_k += os.path.getsize(kp)
        tot_w += os.path.getsize(wp)
        print("tile %-7s %dx%d webp %6.1f KB ktx2 %6.1f KB" % (n, im.width, im.height, os.path.getsize(wp) / 1024, os.path.getsize(kp) / 1024))
    with open(os.path.join(dest, "layout.ts"), "w") as fh:
        fh.write("// Generated by tools/art/world_pack.py (#87): the world sprites (pickups, props, projectiles). Do not edit.\n")
        fh.write("// Atlas pixels; ax, ay: the pixel at the object's center; ppm: sprite pixels per game meter.\n")
        for g in groups:
            fh.write('import %s from "./%s.webp";\n' % (ident(g), g))
            fh.write('import %s from "./%s.ktx2";\n' % (ident(g).replace("Url", "Ktx"), g))
        fh.write("export const WORLD_URLS = {\n")
        for g in groups:
            fh.write('  %s: { webp: %s, ktx2: %s },\n' % (g, ident(g), ident(g).replace("Url", "Ktx")))
        fh.write("} as const;\n")
        fh.write("export const WORLD_LAYOUT = " + json.dumps(layout, separators=(",", ":")) + " as const;\n")
        for n in tiles:
            fh.write('import %s from "./tile-%s.webp";\n' % (ident("tile-" + n), n))
            fh.write('import %s from "./tile-%s.ktx2";\n' % (ident("tile-" + n).replace("Url", "Ktx"), n))
        fh.write("export const WORLD_TILES = {\n")
        for n in tiles:
            fh.write('  %s: { webp: %s, ktx2: %s, ...%s },\n' % (n, ident("tile-" + n), ident("tile-" + n).replace("Url", "Ktx"), json.dumps(tile_meta[n])))
        fh.write("} as const;\n")
    print("TOTAL %.2f Mpx: %.2f MB as BC7/ASTC/ETC2 (%.1f MB RGBA); download ktx2 %.2f MB, webp %.2f MB" % (tot_px / 1e6, tot_px / 1e6, tot_px * 4 / 1e6, tot_k / 1e6, tot_w / 1e6))


if __name__ == "__main__":
    main()
