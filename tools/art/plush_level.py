"""
The level's plush art (#92): the terrain cells per theme, their overlays, and the glass pane, jump pad and swinging
weight. Built here, rendered by plush_world.py (the same camera and lights as the fighters and the #87 world sprites).

Terrain tiles are front-facing felt slabs. Each cell is modelled once and repeated 3 x 3, so the frame (exactly one
cell, centered) cuts through its neighbours the same way on every side; the felt's noise is periodic over one cell
(4D noise on a circle), so the tile repeats with no seam. world_pack.py also flattens the lights' gentle falloff
across the frame. Coordinates here are screen meters (x right, z up, -y toward the camera); `cellz` stretches z by
1 / cos(ELEV) so a cell is exactly CELL tall on screen.

Frames (group `level-<theme>`, one atlas per theme, loaded per match):
  c-<mat>-<v>   a cell of material <mat> (dirt, rock, wood, steel, concrete, crumble, bedrock, brick), variant v (0, 1)
  t-<mat>       its top edge, where nothing is above it (the theme's top color), CELL wide, TOP_H tall
Frames (group `level`, shared by every theme):
  k-1-<v>, k-2-<v>   crack stages 1 and 2 (felt tears with stuffing), overlays, variant v
  char-<v>           burned out: scorched felt over the cell (an overlay)
  e-l, e-r, e-b      the piping on an exposed left, right or bottom side
  anchor             the bolt a hanging platform's chain is fixed to
Frames (group `level-nature`, #94: loaded with any theme that uses them):
  c-<mat>-<v>, t-<mat>   sand, mud and ice cells and their top edges (their own colors: no theme recolors them yet)
  q-<liquid>-<v>         a cell full of water, oil, lava or acid, variant v (0, 1)
  s-<liquid>-<f>         the liquid's top cell (its surface, in the top part of the cell), loop frame f (0-7)
Frames (group `level-beach`, #111): the beach's terrain, overlays, water, prop skins and backdrop (plush_beach.py).
Frames (group `level-forest`, #114): the forest's terrain, overlays, creek water, prop skins and backdrop (plush_forest.py).
Props (group `props`): glass, pad, weight.

The palettes come from tools/art/themes.json, written from src/sim/themes.ts (`bun scripts/themes-json.ts`).
"""
import json
import math
import os

import bpy
import numpy as np
from mathutils import Matrix

import plush_action as pa
import plush_bot as pb

CELL = 0.5
TOP_H = 0.15625  # 20 px at 128 px/m
EDGE_W = 0.078125  # 10 px
PPM = 128.0
MATS = ["dirt", "rock", "wood", "steel", "concrete", "crumble", "bedrock", "brick"]
MAT_ID = {"dirt": 1, "rock": 2, "wood": 3, "steel": 4, "concrete": 5, "crumble": 6, "bedrock": 7, "brick": 8}
THEMES = ["warehouse", "rooftop", "junkyard", "construction"]

# The themed palettes: src/sim/themes.ts (the source), exported to themes.json (#94).
_TJ = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "themes.json")))
BASE = {k: v for k, v in _TJ["base"].items() if k in MATS}
PALETTE = {t: (_TJ["themes"][t]["mat"], _TJ["themes"][t]["top"]) for t in THEMES}
NATURE_MATS = ["sand", "mud", "ice"]
NATURE_BASE = {k: _TJ["base"][k] for k in NATURE_MATS}
LIQUIDS = ["water", "oil", "lava", "acid"]
SURF_FRAMES = 8


def shade(c, k):
    r, g, b = (c >> 16) & 255, (c >> 8) & 255, c & 255
    return (min(255, int(r * k)) << 16) | (min(255, int(g * k)) << 8) | min(255, int(b * k))


def hexs(c):
    return "#%06x" % c


def theme_colors(theme):
    mat, top = PALETTE[theme]
    m = {k: mat.get(k, v) for k, v in BASE.items()}
    t = {k: top.get(k, shade(m[k], 1.35)) for k in m}
    return m, t


# ---------------------------------------------------------------- periodic felt

def tile_fabric(name, color, period=CELL, rough=0.9, sheen=0.8, fuzz_bump=0.3, felt=0.25, mottle=(0.84, 1.06)):
    """The fighters' felt (plush_bot.fabric_mat) with its noise periodic over one cell in x and z: object x and z go
    round a circle each, into 4D noise, so a tile's left edge matches its right and its top its bottom."""
    m, nt, out = pb.node_mat(name)
    L = nt.links
    p = nt.nodes.new("ShaderNodeBsdfPrincipled")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    L.new(tc.outputs["Object"], sep.inputs[0])
    trig = {}
    for axis, per in (("X", period), ("Z", period / math.cos(0.18))):
        mul = nt.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        L.new(sep.outputs[axis], mul.inputs[0])
        mul.inputs[1].default_value = 2 * math.pi / per
        for fn in ("COSINE", "SINE"):
            t = nt.nodes.new("ShaderNodeMath")
            t.operation = fn
            L.new(mul.outputs[0], t.inputs[0])
            trig[axis + fn] = t.outputs[0]
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    L.new(trig["XCOSINE"], comb.inputs[0])
    L.new(trig["XSINE"], comb.inputs[1])
    L.new(trig["ZCOSINE"], comb.inputs[2])
    vec, w = comb.outputs[0], trig["ZSINE"]

    def per_scale(per_m):  # features per meter -> 4D noise scale (one period = one turn of radius 1)
        return per_m * period / (2 * math.pi)

    def noise4(scale_m, detail, rough_=0.5):
        n = nt.nodes.new("ShaderNodeTexNoise")
        n.noise_dimensions = "4D"
        n.inputs["Scale"].default_value = per_scale(scale_m)
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough_
        L.new(vec, n.inputs["Vector"])
        L.new(w, n.inputs["W"])
        return n

    rgb = nt.nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = pb.srgb(color)
    mot = noise4(9, 3)
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = mottle
    L.new(mot.outputs["Fac"], mr.inputs["Value"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    L.new(rgb.outputs[0], mul.inputs[6])
    L.new(mr.outputs[0], mul.inputs[7])
    base = mul.outputs[2]
    L.new(base, p.inputs["Base Color"])
    light = nt.nodes.new("ShaderNodeMix")
    light.data_type = "RGBA"
    light.inputs["Factor"].default_value = 0.3
    L.new(base, light.inputs[6])
    light.inputs[7].default_value = (1, 0.97, 0.9, 1)
    L.new(light.outputs[2], p.inputs["Sheen Tint"])
    p.inputs["Sheen Weight"].default_value = sheen * 0.75
    p.inputs["Sheen Roughness"].default_value = 0.35
    p.inputs["Roughness"].default_value = rough
    p.inputs["Specular IOR Level"].default_value = 0.25
    fine = noise4(420, 6, 0.7)
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.voronoi_dimensions = "4D"
    vor.feature = "DISTANCE_TO_EDGE"
    vor.inputs["Scale"].default_value = per_scale(110)
    L.new(vec, vor.inputs["Vector"])
    L.new(w, vor.inputs["W"])
    add = nt.nodes.new("ShaderNodeMath")
    add.operation = "MULTIPLY_ADD"
    L.new(vor.outputs["Distance"], add.inputs[0])
    add.inputs[1].default_value = felt * 4
    L.new(fine.outputs["Fac"], add.inputs[2])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = fuzz_bump
    bump.inputs["Distance"].default_value = 0.004
    L.new(add.outputs[0], bump.inputs["Height"])
    L.new(bump.outputs["Normal"], p.inputs["Normal"])
    L.new(p.outputs[0], out.inputs["Surface"])
    return m


_MAT = {}


def felt(color, **kw):
    key = ("felt", color, tuple(sorted(kw.items())))
    if key not in _MAT:
        _MAT[key] = tile_fabric("Level felt %06x %d" % (color, len(_MAT)), hexs(color), **kw)
    return _MAT[key]


def vinyl(color, **kw):
    key = ("vinyl", color, tuple(sorted(kw.items())))
    if key not in _MAT:
        kw.setdefault("rough", 0.3)
        kw.setdefault("coat", 0.7)
        _MAT[key] = pb.glossy_mat("Level vinyl %06x %d" % (color, len(_MAT)), hexs(color), **kw)
    return _MAT[key]


def thread(color=None):
    key = ("thread", color)
    if key not in _MAT:
        _MAT[key] = pb.fabric_mat("Level thread %d" % len(_MAT), color or pb.THREAD, rough=0.7, sheen=0.5, fuzz_bump=0.1, felt=0.0, sss=0.0)
    return _MAT[key]


# ---------------------------------------------------------------- geometry (screen meters; parts are (v, f, mat))

COSE = math.cos(0.18)


def soft(c, hx, hy, hz, p=6.0, n=12):
    return pb.superellipsoid(n, c, hx, hy, hy, hz, hz, p=p, q=p)


def blob(c, rx, ry, rz, n=6, rot=0.0):
    v, f = pb.cube_sphere(n)
    v = v * np.array([rx, ry, rz])
    if rot:
        a = rot
        R = np.array([[math.cos(a), 0, -math.sin(a)], [0, 1, 0], [math.sin(a), 0, math.cos(a)]])
        v = v @ R.T
    return v + np.array(c), f


def rot_y(v, a, c=(0, 0, 0)):
    R = np.array([[math.cos(a), 0, -math.sin(a)], [0, 1, 0], [math.sin(a), 0, math.cos(a)]])
    return (v - np.array(c)) @ R.T + np.array(c)


class Tile:
    """Parts of one cell (repeated over a 3 x 3 block when built) and its stitch lines."""

    def __init__(self, name, group, kind="cell", rep=(1, 1)):
        self.name, self.group, self.kind, self.rep = name, group, kind, rep
        self.parts = []  # (v, f, mat)
        self.once = []  # parts not repeated (a backing slab)
        self.stitches = []  # (points, mat, kw)
        self.obs = []
        self.size = (CELL, CELL)
        self.shift = (0.0, 0.0)  # moves the geometry so the frame is centered on the origin
        self.states = None
        self.anchor = None

    def add(self, v, f, mat):
        self.parts.append((np.asarray(v, float), f, mat))

    def stitch(self, pts, mat, **kw):
        self.stitches.append((np.asarray(pts, float), mat, kw))

    def build(self):
        """Make the objects: every part repeated over the block, merged per material; stitches snapped onto them."""
        rx, rz = self.rep
        offs = [(i * CELL, k * CELL) for i in range(-rx, rx + 1) for k in range(-rz, rz + 1)]
        by_mat = {}
        for v, f, mat in self.parts:
            for ox, oz in offs:
                by_mat.setdefault(mat, []).append((v + np.array([ox, 0, oz]), f))
        for v, f, mat in self.once:
            by_mat.setdefault(mat, []).append((v, f))
        sx, sz = self.shift
        for k, (mat, lst) in enumerate(by_mat.items()):
            B = pb.Builder()
            for v, f in lst:
                w = v.copy()
                w[:, 0] += sx
                w[:, 2] = (w[:, 2] + sz) / COSE
                B.add(w, f)
            ob = B.obj("%s %d" % (self.name, k), mat)
            self.obs.append(ob)
        if self.stitches:
            bvh = pb.bvh_of(*self.obs)
            groups = {}
            for pts, mat, kw in self.stitches:
                for ox, oz in offs:
                    q = pts + np.array([ox + sx, -0.3, oz + sz])
                    q[:, 2] /= COSE
                    groups.setdefault(id(mat), (mat, []))[1].append((q, kw))
            for mat, lst in groups.values():
                B = pb.Builder()
                for q, kw in lst:
                    kw = dict(kw)
                    kw.setdefault("dash", 0.026)
                    kw.setdefault("gap", 0.018)
                    kw.setdefault("width", 0.011)
                    kw.setdefault("height", 0.007)
                    pb.stitch_path(B, [tuple(p) for p in q], pb.surf_fn(bvh, 0.5), **kw)
                ob = B.obj(self.name + " stitches", mat)
                if ob:
                    self.obs.append(ob)
        return self


def backing(T, color, d=0.0, mat=None):
    v, f = soft((0, 0.03 + d, 0), 0.9, 0.03, 0.9, p=12.0, n=8)
    T.once.append((v, f, mat or felt(color)))


def rect_stitch(T, cx, cz, hx, hz, mat, **kw):
    x0, x1, z0, z1 = cx - hx, cx + hx, cz - hz, cz + hz
    pts = []
    for (ax, az), (bx, bz) in (((x0, z0), (x1, z0)), ((x1, z0), (x1, z1)), ((x1, z1), (x0, z1)), ((x0, z1), (x0, z0))):
        for t in np.linspace(0, 1, 30, endpoint=False):
            pts.append((ax + (bx - ax) * t, 0, az + (bz - az) * t))
    pts.append(pts[0])
    T.stitch(pts, mat, **kw)


def line_pts(a, b, n=30):
    return [(a[0] + (b[0] - a[0]) * t, 0, a[1] + (b[1] - a[1]) * t) for t in np.linspace(0, 1, n)]


# ---------------------------------------------------------------- the cells

def cell_concrete(T, col, rng, v):
    backing(T, shade(col, 0.62))
    T.add(*soft((0, 0, 0), 0.238, 0.05, 0.238, p=7.0), felt(col))
    tones = [felt(shade(col, 1.18)), felt(shade(col, 0.82))]
    for k in range(6):
        x, z = rng.uniform(-0.18, 0.18, 2)
        r = rng.uniform(0.012, 0.026)
        T.add(*blob((x, -0.052, z), r, 0.006, r * rng.uniform(0.7, 1.0)), tones[k % 2])
    if v == 1:  # a felt patch, darned on
        x, z = rng.uniform(-0.1, 0.1, 2)
        T.add(*soft((x, -0.054, z), 0.06, 0.006, 0.05, p=5.0, n=8), felt(shade(col, 0.9)))
        rect_stitch(T, x, z, 0.05, 0.04, thread("#3a3540"), dash=0.016, gap=0.012, width=0.008, height=0.006)
    rect_stitch(T, 0, 0, 0.2, 0.2, thread(hexs(shade(col, 0.55))))


def cell_brick(T, col, rng, v):
    backing(T, 0xb3a68f)
    tones = [felt(col), felt(shade(col, 0.88)), felt(shade(col, 1.1))]
    for cz, xs in ((0.125, (0.0,)), (-0.125, (0.25,))):
        for cx in xs:
            T.add(*soft((cx, 0, cz), 0.232, 0.045, 0.108, p=5.0), tones[int(rng.integers(0, 3))])
            T.stitch(line_pts((cx - 0.19, cz - 0.075), (cx + 0.19, cz - 0.075)), thread(hexs(shade(col, 0.6))), dash=0.022, gap=0.016)


def planks(T, col, rng, rows, nail, grain, tilt=0.0):
    tones = [felt(col), felt(shade(col, 0.9)), felt(shade(col, 1.08))]
    for cz, xs in rows:
        for cx in xs:
            v_, f_ = soft((cx, 0, cz), 0.243, 0.045, 0.113, p=6.0)
            if tilt:
                v_ = rot_y(v_, rng.uniform(-tilt, tilt), (cx, 0, cz))
            T.add(v_, f_, tones[int(rng.integers(0, 3))])
            T.stitch(line_pts((cx - 0.2, cz + rng.uniform(-0.04, 0.04)), (cx + 0.2, cz + rng.uniform(-0.04, 0.04))), grain, dash=0.03, gap=0.02)
            for sx in (-1, 1):
                T.add(*blob((cx + sx * 0.2, -0.05, cz), 0.017, 0.008, 0.017), nail)


def cell_wood(T, col, rng, v):
    backing(T, shade(col, 0.45))
    rows = [(0.125, (0.0,)), (-0.125, (0.25,))] if v == 0 else [(0.125, (0.25,)), (-0.125, (0.0,))]
    planks(T, col, rng, rows, vinyl(0x2a1a0e), thread(hexs(shade(col, 0.55))))


def cell_crumble(T, col, rng, v):
    backing(T, shade(col, 0.4))
    rows = [(0.125, (0.0,)), (-0.125, (0.25,))] if v == 0 else [(0.125, (0.25,)), (-0.125, (0.0,))]
    planks(T, col, rng, rows, vinyl(0x3a3028), thread("#5a4630"), tilt=0.06)
    # a darned patch, and a hole showing the dark behind
    x, z = (rng.uniform(-0.12, 0.12), 0.125 if v else -0.125)
    T.add(*soft((x, -0.05, z), 0.06, 0.008, 0.055, p=4.0, n=8), felt(shade(col, 0.78)))
    T.stitch(line_pts((x - 0.05, z - 0.045), (x + 0.05, z + 0.045), 12), thread("#3a2a1a"), dash=0.014, gap=0.01, width=0.008)
    T.stitch(line_pts((x - 0.05, z + 0.045), (x + 0.05, z - 0.045), 12), thread("#3a2a1a"), dash=0.014, gap=0.01, width=0.008)
    hx_, hz_ = rng.uniform(-0.15, 0.15), -z
    T.add(*blob((hx_, -0.044, hz_), 0.05, 0.01, 0.028, rot=rng.uniform(-0.4, 0.4)), felt(0x1d140c))


def cell_steel(T, col, rng, v):
    backing(T, shade(col, 0.4), mat=vinyl(shade(col, 0.4), rough=0.4))
    T.add(*soft((0, 0, 0), 0.24, 0.04, 0.24, p=9.0), vinyl(col, rough=0.32, coat=0.8, metal=0.3))
    dark = vinyl(shade(col, 0.62), rough=0.35, metal=0.3)
    rivet = vinyl(0xc3c9d2, rough=0.2, metal=1.0)
    if v == 0:
        for sx in (1, -1):
            tv, tf = pa.tube((sx * -0.19, -0.04, -0.19), (sx * 0.19, -0.04, 0.19), [(0.0, 0.02), (1.0, 0.02)], 10)
            T.add(tv, tf, dark)
        for x, z in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            T.add(*blob((x * 0.19, -0.045, z * 0.19), 0.02, 0.012, 0.02), rivet)
    else:  # a girder web: two lightening holes and a row of rivets top and bottom
        for x in (-0.12, 0.12):
            T.add(*blob((x, -0.038, 0), 0.07, 0.006, 0.07, n=10), vinyl(0x15171d, rough=0.6, coat=0.0))
            rv, rf = pa.ring((x, -0.041, 0), (0, 1, 0), 0.072, pb.circle(0.011, 8), 32)
            T.add(rv, rf, dark)
        for z in (-0.2, 0.2):
            for x in (-0.18, -0.06, 0.06, 0.18):
                T.add(*blob((x, -0.044, z), 0.016, 0.01, 0.016), rivet)


def cell_dirt(T, col, rng, v):
    backing(T, shade(col, 0.72))
    tones = [felt(col, felt=0.4), felt(shade(col, 0.86), felt=0.4), felt(shade(col, 1.12), felt=0.4)]
    for k in range(9):
        x, z = rng.uniform(-0.25, 0.25), rng.uniform(-0.25, 0.25)
        T.add(*blob((x, -0.01, z), rng.uniform(0.07, 0.12), rng.uniform(0.03, 0.045), rng.uniform(0.05, 0.08), rot=rng.uniform(-0.5, 0.5)), tones[k % 3])
    peb = [felt(0x8b8a86), felt(0x6d6058)]
    for k in range(3):
        x, z = rng.uniform(-0.22, 0.22, 2)
        r = rng.uniform(0.018, 0.03)
        T.add(*blob((x, -0.05, z), r, r * 0.7, r * 0.85), peb[k % 2])
    seed = thread("#d8c49a")
    for k in range(4):
        x, z = rng.uniform(-0.2, 0.2, 2)
        a = rng.uniform(0, math.pi)
        d = (math.cos(a) * 0.018, math.sin(a) * 0.018)
        T.stitch(line_pts((x - d[0], z - d[1]), (x + d[0], z + d[1]), 6), seed, dash=0.03, gap=0.01, width=0.009)


def cell_rock(T, col, rng, v):
    backing(T, shade(col, 0.5))
    tones = [felt(col), felt(shade(col, 0.85)), felt(shade(col, 1.12))]
    stones = [(-0.12, 0.12), (0.13, 0.1), (-0.1, -0.13), (0.12, -0.12)] if v == 0 else [(0.0, 0.13), (-0.14, -0.06), (0.14, -0.1), (0.25, 0.25)]
    for k, (x, z) in enumerate(stones):
        x += rng.uniform(-0.02, 0.02)
        z += rng.uniform(-0.02, 0.02)
        T.add(*blob((x, -0.005, z), rng.uniform(0.11, 0.135), 0.05, rng.uniform(0.1, 0.12), n=8, rot=rng.uniform(-0.6, 0.6)), tones[k % 3])


def cell_bedrock(T, col, rng, v):
    backing(T, shade(col, 0.7))
    T.add(*soft((0, 0, 0), 0.24, 0.06, 0.24, p=4.0), felt(shade(col, 1.25)))
    th = thread("#4a4560")
    T.stitch(line_pts((-0.25, -0.25), (0.25, 0.25), 40), th)
    T.stitch(line_pts((-0.25, 0.25), (0.25, -0.25), 40), th)


CELLS = {"dirt": cell_dirt, "rock": cell_rock, "wood": cell_wood, "steel": cell_steel, "concrete": cell_concrete,
         "crumble": cell_crumble, "bedrock": cell_bedrock, "brick": cell_brick}


def cap(T, mat_name, col, rng):
    """The top edge of a cell with nothing above it, in the theme's top color: a rolled felt lip (a glossy trim on
    steel, a row of felt tufts on dirt). The frame: CELL wide, TOP_H tall, its top at the cell's top."""
    top = CELL / 2
    T.size = (CELL, TOP_H)
    T.shift = (0.0, -(top - TOP_H / 2))
    T.rep = (2, 0)
    r = 0.04
    if mat_name == "steel":
        tv, tf = pa.tube((-0.25, -0.06, top - r), (0.25, -0.06, top - r), [(0.0, r), (1.0, r)], 16)
        T.add(tv, tf, vinyl(col, rough=0.25, coat=0.9, metal=0.4))
        for x in (-0.125, 0.125):
            T.add(*blob((x, -0.06 - r, top - r), 0.016, 0.01, 0.016), vinyl(0xd8dde4, rough=0.2, metal=1.0))
    elif mat_name == "dirt":
        tv, tf = pa.tube((-0.25, -0.05, top - 0.035), (0.25, -0.05, top - 0.035), [(0.0, 0.03), (1.0, 0.03)], 12)
        T.add(tv, tf, felt(shade(col, 0.85), felt=0.5))
        tones = [felt(col, felt=0.5), felt(shade(col, 1.12), felt=0.5), felt(shade(col, 0.9), felt=0.5)]
        for k in range(14):
            x = -0.25 + (k + rng.uniform(0.1, 0.9)) * (0.5 / 14)
            h = rng.uniform(0.05, 0.08)
            a = rng.uniform(-0.35, 0.35)
            p0 = np.array([x, -0.06, top - 0.06])
            p1 = p0 + np.array([math.sin(a) * h, 0, math.cos(a) * h])
            p1[2] = min(p1[2], top - 0.004)
            tv, tf = pa.tube(tuple(p0), tuple(p1), [(0.0, 0.016), (0.6, 0.011), (1.0, 0.002)], 8)
            T.add(tv, tf, tones[k % 3])
    else:
        tv, tf = pa.tube((-0.25, -0.05, top - r), (0.25, -0.05, top - r), [(0.0, r), (1.0, r)], 16)
        T.add(tv, tf, felt(col))
        T.stitch(line_pts((-0.25, top - r), (0.25, top - r), 30), thread(hexs(shade(col, 0.55))), dash=0.026, gap=0.016)
    return T


def edge(T, side):
    """The piping on an exposed side: a dark felt roll along the left, right or bottom edge."""
    r = 0.03
    col = felt(0x2a2330)
    if side == "b":
        T.size = (CELL, EDGE_W)
        T.shift = (0.0, CELL / 2 - EDGE_W / 2)
        T.rep = (2, 0)
        tv, tf = pa.tube((-0.25, -0.05, -0.25 + r + 0.006), (0.25, -0.05, -0.25 + r + 0.006), [(0.0, r), (1.0, r)], 12)
    else:
        sx = 1 if side == "r" else -1
        T.size = (EDGE_W, CELL)
        T.shift = (-sx * (CELL / 2 - EDGE_W / 2), 0.0)
        T.rep = (0, 2)
        x = sx * (0.25 - r - 0.006)
        tv, tf = pa.tube((x, -0.05, -0.25), (x, -0.05, 0.25), [(0.0, r), (1.0, r)], 12)
    T.add(tv, tf, col)
    return T


def tears(T, rng, n, big):
    tear = pb.glossy_mat("Level tear %d" % len(_MAT), "#22160e", rough=0.8, coat=0.0, spec=0.1)
    stuffing = pb.fabric_mat("Level stuffing %d" % len(_MAT), "#f6efe0", rough=0.95, sheen=1.0, fuzz_bump=0.8, felt=0.7)
    out = []
    for k in range(n):
        x, z = rng.uniform(-0.08, 0.08), rng.uniform(-0.1, 0.1)
        a = rng.uniform(-1.2, 1.2)
        L = rng.uniform(0.24, 0.3) * (1.2 if big else 1.0)
        tv, tf = blob((x, -0.06, z), L / 2, 0.012, 0.036 * (1.35 if big else 1.0), n=8, rot=a)
        out.append((tv, tf, tear))
        for j in range(4 if not big else 6):
            t = rng.uniform(-0.38, 0.38)
            r = rng.uniform(0.03, 0.045) * (1.15 if big else 1.0)
            c = (x + math.cos(a) * L * t + rng.uniform(-0.01, 0.01), -0.07, z - math.sin(a) * L * t + rng.uniform(-0.01, 0.01))
            out.append((*blob(c, r, r * 0.7, r), stuffing))
    return out


def crack(stage, v):
    """Crack stage 1 or 2: felt tears with stuffing (stage 2 keeps stage 1's tear and adds bigger ones)."""
    T = Tile("k-%d-%d" % (stage, v), "level", kind="overlay", rep=(0, 0))
    rng = np.random.default_rng(40 + v)
    T.parts += tears(T, rng, 1, False)
    if stage == 2:
        T.parts += tears(T, np.random.default_rng(60 + v), 2, True)
    return T


def char(v):
    """Burned out: scorched black felt with a few glowing threads, laid over the cell."""
    T = Tile("char-%d" % v, "level", kind="cell")
    rng = np.random.default_rng(80 + v)
    T.add(*soft((0, -0.055, 0), 0.25, 0.008, 0.25, p=14.0), felt(0x1a120d, felt=0.6, mottle=(0.7, 1.15)))
    ember = pa.emit_two("Level ember %d" % v, "#ffcf7a", "#ff6a1a", 3.0)
    for k in range(2):
        x0, z0 = rng.uniform(-0.2, 0.0), rng.uniform(-0.18, 0.18)
        pts = [(x0 + t * 0.3, 0, z0 + math.sin(t * 7 + k) * 0.03) for t in np.linspace(0, 1, 16)]
        T.stitch(pts, ember, dash=0.022, gap=0.03, width=0.008, height=0.006)
    for k in range(3):
        x, z = rng.uniform(-0.2, 0.2, 2)
        T.add(*blob((x, -0.064, z), rng.uniform(0.02, 0.035), 0.004, rng.uniform(0.015, 0.025), rot=rng.uniform(0, 3)), felt(0x0a0706))
    return T


def anchor():
    """The bolt a hanging platform's chain is fixed to: a steel eye bolt on a felt washer."""
    T = Tile("anchor", "level", kind="sprite", rep=(0, 0))
    T.add(*soft((0, -0.02, 0), 0.085, 0.015, 0.085, p=2.0, n=10), felt(0x3a3540))
    rv, rf = pa.ring((0, -0.05, 0.0), (0, 1, 0), 0.05, pb.circle(0.018, 10), 32)
    T.add(rv, rf, vinyl(0xb0b0b8, rough=0.25, metal=0.9))
    T.add(*blob((0, -0.045, 0), 0.025, 0.012, 0.025), vinyl(0x2a2a30, rough=0.3, metal=0.6))
    T.anchor = (0.0, 0.0, 0.0)
    return T


def level_tiles(themes=THEMES, common=True):
    """Every terrain frame, as Tiles (built lazily: call .build() just before rendering). "nature" in `themes`: the
    #94 materials and liquids."""
    out = []
    if "nature" in themes:
        out += nature_tiles()
    if "beach" in themes:  # #111: the beach's own atlas (plush_beach.py)
        import plush_beach
        out += plush_beach.beach_tiles()
    if "forest" in themes:  # #114: the forest's own atlas (plush_forest.py)
        import plush_forest
        out += plush_forest.forest_tiles()
    for th in [t for t in themes if t in THEMES]:
        mcol, tcol = theme_colors(th)
        for m in MATS:
            for v in (0, 1):
                T = Tile("c-%s-%d" % (m, v), "level-" + th)
                T.make = (lambda T=T, m=m, v=v, c=mcol[m], th=th: CELLS[m](T, c, np.random.default_rng(THEMES.index(th) * 100 + MAT_ID[m] * 10 + v), v))
                out.append(T)
            T = Tile("t-" + m, "level-" + th, kind="cap")
            T.make = (lambda T=T, m=m, c=tcol[m], th=th: cap(T, m, c, np.random.default_rng(THEMES.index(th) * 100 + MAT_ID[m])))
            out.append(T)
    if common:
        for st in (1, 2):
            for v in (0, 1):
                T = crack(st, v)
                T.make = lambda: None
                out.append(T)
        for v in (0, 1):
            T = char(v)
            T.make = lambda: None
            out.append(T)
        for s in ("l", "r", "b"):
            T = Tile("e-" + s, "level", kind="edge")
            T.make = (lambda T=T, s=s: edge(T, s))
            out.append(T)
        T = anchor()
        T.make = lambda: None
        out.append(T)
    return out


# ---------------------------------------------------------------- #94: sand, mud, ice and the liquids

def cell_sand(T, col, rng, v):
    """Sand: a pale felt slab under many tiny felt grains, wind ripples stitched across, a shell or a pebble."""
    backing(T, shade(col, 0.8))
    T.add(*soft((0, 0, 0), 0.245, 0.03, 0.245, p=9.0), felt(col, felt=0.6, mottle=(0.9, 1.06)))
    tones = [felt(shade(col, 1.1), felt=0.6), felt(shade(col, 0.88), felt=0.6), felt(shade(col, 0.95), felt=0.6)]
    for k in range(26):
        x, z = rng.uniform(-0.24, 0.24, 2)
        r = rng.uniform(0.008, 0.016)
        T.add(*blob((x, -0.032, z), r, r * 0.6, r), tones[k % 3])
    rip = thread(hexs(shade(col, 0.7)))
    for z0 in ((-0.12, 0.1) if v == 0 else (-0.02, 0.17)):
        pts = [(-0.25 + t * 0.5, 0, z0 + 0.025 * math.sin(t * 2 * math.pi)) for t in np.linspace(0, 1, 30)]
        T.stitch(pts, rip, dash=0.03, gap=0.016, width=0.009)
    if v == 1:
        x, z = rng.uniform(-0.12, 0.12, 2)
        T.add(*blob((x, -0.04, z), 0.03, 0.012, 0.024, rot=0.4), felt(0xf2e6d8, felt=0.3))


def cell_mud(T, col, rng, v):
    """Mud: a dark, wet-looking slab (low gloss vinyl) with felt clods and a shiny puddle or two."""
    backing(T, shade(col, 0.6))
    T.add(*soft((0, 0, 0), 0.245, 0.04, 0.245, p=6.0), vinyl(col, rough=0.55, coat=0.35))
    tones = [felt(shade(col, 1.15), felt=0.5), felt(shade(col, 0.85), felt=0.5)]
    for k in range(7):
        x, z = rng.uniform(-0.22, 0.22, 2)
        T.add(*blob((x, -0.035, z), rng.uniform(0.04, 0.07), 0.018, rng.uniform(0.03, 0.05), rot=rng.uniform(-0.6, 0.6)), tones[k % 2])
    wet = vinyl(shade(col, 0.7), rough=0.08, coat=1.0)
    for k in range(1 + v):
        x, z = rng.uniform(-0.15, 0.15, 2)
        T.add(*blob((x, -0.046, z), rng.uniform(0.05, 0.08), 0.004, rng.uniform(0.025, 0.04)), wet)
    for k in range(3):
        x, z = rng.uniform(-0.2, 0.2, 2)
        r = rng.uniform(0.01, 0.018)
        T.add(*blob((x, -0.05, z), r, r, r), vinyl(shade(col, 1.3), rough=0.15, coat=0.9))


def cell_ice(T, col, rng, v):
    """Ice: a clear, glossy block (a pale blue vinyl) with white stitched cracks and frosted felt corners."""
    backing(T, shade(col, 0.7), mat=vinyl(shade(col, 0.7), rough=0.2, coat=0.9))
    T.add(*soft((0, 0, 0), 0.24, 0.045, 0.24, p=8.0), vinyl(col, rough=0.06, coat=1.0, spec=0.9))
    frost = felt(0xeef8ff, felt=0.7, mottle=(0.95, 1.05))
    for x, z in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        if rng.uniform() < 0.6:
            T.add(*blob((x * 0.2, -0.048, z * 0.2), 0.045, 0.006, 0.035, rot=rng.uniform(0, 3)), frost)
    crack = thread("#ffffff")
    x0, z0 = rng.uniform(-0.1, 0.1, 2)
    for k in range(3 if v == 0 else 4):
        a = rng.uniform(0, 2 * math.pi)
        L = rng.uniform(0.12, 0.2)
        mid = (x0 + math.cos(a) * L * 0.5 + rng.uniform(-0.03, 0.03), z0 + math.sin(a) * L * 0.5 + rng.uniform(-0.03, 0.03))
        end = (x0 + math.cos(a) * L, z0 + math.sin(a) * L)
        T.stitch(line_pts((x0, z0), mid, 8) + line_pts(mid, end, 8)[1:], crack, dash=0.02, gap=0.008, width=0.007, height=0.006)
    glint = pb.emit_mat("Ice glint %d" % len(_MAT), "#ffffff", 1.4)
    _MAT[("glint", len(_MAT))] = glint
    tv, tf = pa.tube((-0.17, -0.05, 0.12), (-0.09, -0.05, 0.19), [(0.0, 0.007), (1.0, 0.007)], 8)
    T.add(tv, tf, glint)


NATURE_CELLS = {"sand": cell_sand, "mud": cell_mud, "ice": cell_ice}


def liquid_mat(kind):
    """The liquids' satin: water clear blue (see-through), oil a black-violet gloss, lava hot felt, acid glowing green."""
    key = ("liquid", kind)
    if key in _MAT:
        return _MAT[key]
    spec = {
        "water": ("#3d93dc", 0.62, 0.55, 0.0, None, 0.0),
        "oil": ("#2c2240", 0.9, 0.45, 0.15, None, 0.0),
        "lava": ("#c8300a", 1.0, 0.7, 0.1, "#ff3c00", 0.9),
        "acid": ("#6ad83a", 0.82, 0.55, 0.0, "#4fc020", 0.6),
    }[kind]
    col, alpha, rough, coat, emit, strength = spec
    m = pb.glossy_mat("Liquid %s" % kind, col, rough=rough, coat=coat, spec=0.15)
    p = [n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"][0]
    p.inputs["Alpha"].default_value = alpha
    if emit:
        p.inputs["Emission Color"].default_value = pb.srgb(emit)
        p.inputs["Emission Strength"].default_value = strength
    _MAT[key] = m
    return m


LIQ_ACCENT = {"water": "#bfe6ff", "oil": "#7a5cff", "lava": "#ffd27a", "acid": "#d8ff9a"}
LIQ_DARK = {"water": 0x2a6aa8, "oil": 0x120d18, "lava": 0x3a140a, "acid": 0x2f7a1a}


def slab(x0, x1, z0, top, ty=0.03, n=33):
    """A thin slab, flat bottom at z0, its top edge the profile top(x) (x0..x1), ty thick (front -ty, back +ty)."""
    xs = np.linspace(x0, x1, n)
    v = []
    for y in (-ty, ty):
        for x in xs:
            v.append((x, y, z0))
            v.append((x, y, top(x)))
    f = []
    for side in (0, 1):
        o = side * 2 * n
        for i in range(n - 1):
            a, b, c, d = o + 2 * i, o + 2 * (i + 1), o + 2 * (i + 1) + 1, o + 2 * i + 1
            f.append([a, b, c, d] if side == 0 else [a, d, c, b])
    for i in range(n - 1):  # the top strip
        f.append([2 * i + 1, 2 * (i + 1) + 1, 2 * n + 2 * (i + 1) + 1, 2 * n + 2 * i + 1])
    return np.array(v, float), f


def wave(kind, phase):
    """The surface line of one cell, periodic over the cell (x in -0.25..0.25) and over the loop (phase 0..2pi)."""
    amp = {"water": 0.022, "oil": 0.012, "lava": 0.016, "acid": 0.018}[kind]
    k = 2 * math.pi / CELL
    return lambda x: 0.16 + amp * math.sin(k * x - phase) + amp * 0.4 * math.sin(2 * k * x + 2 * phase + 1.0)


def liquid_body(T, kind, rng, v):
    """A cell full of liquid: the satin slab, with what moves in it (ripple lines, crust, bubbles)."""
    T.add(*slab(-0.25, 0.25, -0.25, lambda x: 0.25), liquid_mat(kind))
    acc = thread(LIQ_ACCENT[kind])
    if kind == "water":
        for z in ((-0.1, 0.12) if v == 0 else (0.0,)):
            pts = [(-0.25 + t * 0.5, 0, z + 0.012 * math.sin(t * 2 * math.pi * 2)) for t in np.linspace(0, 1, 30)]
            T.stitch(pts, acc, dash=0.03, gap=0.03, width=0.007, height=0.004)
    elif kind == "oil":
        T.stitch([(-0.25 + t * 0.5, 0, -0.05 + 0.02 * math.sin(t * 2 * math.pi)) for t in np.linspace(0, 1, 30)], acc, dash=0.05, gap=0.02, width=0.008, height=0.004)
    elif kind == "lava":
        vein = pa.emit_two("Lava vein %d" % v, "#fff0a0", "#ffa020", 2.5)
        for z in ((-0.14, 0.06) if v == 0 else (-0.05, 0.15)):
            T.stitch([(-0.25 + t * 0.5, 0, z + 0.03 * math.sin(t * 2 * math.pi + z * 9)) for t in np.linspace(0, 1, 30)], vein, dash=0.05, gap=0.02, width=0.012, height=0.006)
        crust = felt(LIQ_DARK[kind], felt=0.5, mottle=(0.8, 1.2))
        for k in range(2 + v):
            x, z = rng.uniform(-0.18, 0.18, 2)
            T.add(*blob((x, -0.035, z), rng.uniform(0.05, 0.08), 0.008, rng.uniform(0.03, 0.05), rot=rng.uniform(0, 3)), crust)
    if kind in ("lava", "acid"):
        b = vinyl(int(LIQ_ACCENT[kind][1:], 16), rough=0.2, coat=0.8)
        for k in range(2):
            x, z = rng.uniform(-0.2, 0.2, 2)
            r = rng.uniform(0.012, 0.022)
            T.add(*blob((x, -0.036, z), r, r * 0.7, r), b)


def liquid_surface(T, kind, f):
    """The liquid's top cell, loop frame f: the slab up to a moving wave line, a rolled satin crest along it, and
    (lava, acid) bubbles that swell and pop; (water) foam dots riding the crest."""
    ph = 2 * math.pi * f / SURF_FRAMES
    top = wave(kind, ph)
    T.add(*slab(-0.25, 0.25, -0.25, top), liquid_mat(kind))
    xs = np.linspace(-0.25, 0.25, 33)
    pts = [(x, -0.032, top(x) - 0.006) for x in xs]
    N = [np.array([0.0, 0.0, 1.0])] * len(pts)
    cv, cf = pb.sweep(pts, N, pb.circle(0.011, 8), closed=False, cap=False)
    T.add(cv, cf, vinyl(int(LIQ_ACCENT[kind][1:], 16), rough=0.15, coat=0.9) if kind != "oil" else vinyl(0x4a3a6a, rough=0.05, coat=1.0))
    if kind == "oil":  # a rainbow sheen below the crest
        for k, c in enumerate(("#7a5cff", "#3ad0c0", "#e0d05a")):
            T.stitch([(x, 0, top(x) - 0.05 - k * 0.018) for x in xs], thread(c), dash=0.05, gap=0.015, width=0.006, height=0.004)
    if kind == "water":
        foam = felt(0xf4fbff, felt=0.5)
        for k in range(3):
            x = ((k / 3 + f / SURF_FRAMES) % 1.0) * CELL - 0.25
            T.add(*blob((x, -0.045, top(x) + 0.004), 0.016, 0.008, 0.011), foam)
    if kind in ("lava", "acid"):
        b = vinyl(int(LIQ_ACCENT[kind][1:], 16), rough=0.2, coat=0.8)
        for k, (x, off) in enumerate(((-0.13, 0.0), (0.1, 0.45))):
            t = (f / SURF_FRAMES + off) % 1.0
            r = 0.035 * math.sin(math.pi * t)
            if r > 0.006:
                T.add(*blob((x, -0.02, top(x) - 0.01 + r * 0.6), r, r * 0.7, r), b)
    return T


def nature_tiles():
    out = []
    g = "level-nature"
    for m in NATURE_MATS:
        col = NATURE_BASE[m]
        for v in (0, 1):
            T = Tile("c-%s-%d" % (m, v), g)
            T.make = (lambda T=T, m=m, v=v, c=col: NATURE_CELLS[m](T, c, np.random.default_rng(900 + NATURE_MATS.index(m) * 10 + v), v))
            out.append(T)
        T = Tile("t-" + m, g, kind="cap")
        top = {"sand": 0xeedcae, "mud": 0x7a5c40, "ice": 0xe6f6ff}[m]
        T.make = (lambda T=T, m=m, c=top: cap(T, m, c, np.random.default_rng(950 + NATURE_MATS.index(m))))
        out.append(T)
    for kind in LIQUIDS:
        for v in (0, 1):
            T = Tile("q-%s-%d" % (kind, v), g)
            T.make = (lambda T=T, k=kind, v=v: liquid_body(T, k, np.random.default_rng(970 + LIQUIDS.index(k) * 10 + v), v))
            out.append(T)
        for f in range(SURF_FRAMES):
            T = Tile("s-%s-%d" % (kind, f), g, kind="cap", rep=(2, 0))
            T.make = (lambda T=T, k=kind, f=f: liquid_surface(T, k, f))
            out.append(T)
    return out


# ---------------------------------------------------------------- props (front space: x right, -y the front, z up)

def prop_glass(pw, M):
    """A glass pane: a tall glossy, see-through pale blue pane in a thin felt frame, two white glints. One state:
    any hit shatters it (the shards are effects)."""
    G = pw.Group("glass", "props")
    hx, hz = 0.08, 0.9
    pane = pb.glossy_mat("Glass pane", "#a8e6ff", rough=0.08, coat=1.0, spec=0.8)
    p = [n for n in pane.node_tree.nodes if n.type == "BSDF_PRINCIPLED"][0]
    p.inputs["Alpha"].default_value = 0.42
    v, f = pw.soft_box((0, 0, 0), hx * 0.8, 0.03, hz * 0.97, p=6.0)
    G.add(pw.mesh("Glass pane", v, f, pane))
    frame = pb.fabric_mat("Glass frame", "#d8f2ff", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2)
    for z in (-1, 1):
        v, f = pw.soft_box((0, 0, z * (hz - 0.05)), hx, 0.045, 0.05, p=4.0)
        G.add(pw.mesh("Glass frame %d" % z, v, f, frame))
    for sx in (-1, 1):
        v, f = pw.soft_box((sx * (hx - 0.015), 0, 0), 0.018, 0.04, hz - 0.08, p=4.0)
        G.add(pw.mesh("Glass side %d" % sx, v, f, frame))
    glint = pb.emit_mat("Glass glint", "#ffffff", 1.6)
    for k, (z, ln) in enumerate(((0.45, 0.3), (0.2, 0.18), (-0.35, 0.22))):
        v, f = pa.tube((-0.035, -0.034, z - ln / 2), (0.035, -0.034, z + ln / 2), [(0.0, 0.008), (1.0, 0.008)], 8)
        G.add(pw.mesh("Glass glint %d" % k, v, f, glint))
    return G


def prop_pad(pw, M):
    """A jump pad: a springy green vinyl cushion on silver coils, on a black base with yellow felt chevrons."""
    G = pw.Group("pad", "props")
    hx, hz = 0.6, 0.15
    v, f = pw.soft_box((0, 0, -hz + 0.05), hx, 0.22, 0.05, p=6.0)
    base = G.add(pw.mesh("Pad base", v, f, M["black_vinyl"]))
    for k in range(5):
        x = -0.48 + k * 0.24
        pts = [(x - 0.05, 0.035), (x + 0.0, 0.035), (x + 0.05, 0.0), (x + 0.0, -0.035), (x - 0.05, -0.035), (x + 0.0, 0.0)]
        ob = G.add(pw.extrude_poly("Pad chevron %d" % k, pts, 0.01, M["felt_yellow"], 0.004))
        ob.matrix_world = Matrix.Translation((0, -0.226, -hz + 0.05))
    for x in (-0.36, 0.0, 0.36):
        pts = []
        for i in range(97):
            t = i / 96
            a = t * 2 * math.pi * 3.5
            pts.append((x + math.cos(a) * 0.075, math.sin(a) * 0.075 * 0.8, -hz + 0.1 + t * 0.09))
        N = [np.array([math.cos(i / 96 * 2 * math.pi * 3.5), math.sin(i / 96 * 2 * math.pi * 3.5), 0.0]) for i in range(97)]
        sv, sf = pb.sweep(pts, N, pb.circle(0.011, 8), closed=False)
        G.add(pw.mesh("Pad spring %.2f" % x, sv, sf, M["rivet"]))
    v, f = pw.soft_box((0, 0, hz - 0.055), hx * 0.98, 0.2, 0.055, p=4.0)
    top = G.add(pw.mesh("Pad cushion", v, f, M["green_vinyl"]))
    bvh = pb.bvh_of(top)
    B = pb.Builder()
    pw.stitch_line(B, bvh, (-hx + 0.08, -0.3, hz - 0.055), (hx - 0.08, -0.3, hz - 0.055), dash=0.03, gap=0.02, width=0.012, height=0.008)
    G.add(B.obj("Pad stitches", M["thread"]))
    return G


def prop_weight(pw, M):
    """A swinging weight: a dark iron weight with a ring on top for the rope and a yellow felt label."""
    G = pw.Group("weight", "props")
    hx, hz = 0.5, 0.5
    pts = [(-hx * 0.72, hz), (hx * 0.72, hz), (hx, -hz), (-hx, -hz)]
    body = G.add(pw.extrude_poly("Weight body", pts, 0.42, M["iron"], 0.07))
    rv, rf = pa.ring((0, 0, hz + 0.08), (0, 1, 0), 0.1, pb.circle(0.035, 12), 40)
    G.add(pw.mesh("Weight ring", rv, rf, M["iron"]))
    v, f = pw.soft_box((0, -0.23, -0.02), 0.24, 0.02, 0.13, p=4.0)
    label = G.add(pw.mesh("Weight label", v, f, M["felt_yellow"]))
    bvh = pb.bvh_of(label)
    B = pb.Builder()
    pw.stitch_rect(B, bvh, 0.24, 0.13, -0.3, 0.035, dash=0.022, gap=0.015, width=0.01, height=0.007)
    G.add(B.obj("Weight label stitches", M["dark_thread"]))
    for k, x in enumerate((-0.09, 0.0, 0.09)):
        v, f = pw.soft_box((x, -0.255, -0.02), 0.026, 0.012, 0.07, p=3.0)
        G.add(pw.mesh("Weight mark %d" % k, v, f, M["black_vinyl"]))
    return G
