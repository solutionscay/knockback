"""
The level's plush art (#92): the terrain cells per theme and their overlays. Built here, rendered by plush_world.py (the same camera and lights as the fighters and the #87 world sprites).

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
"""
import math

import bpy
import numpy as np

import plush_action as pa
import plush_bot as pb

CELL = 0.5
TOP_H = 0.15625  # 20 px at 128 px/m
EDGE_W = 0.078125  # 10 px
PPM = 128.0
MATS = ["dirt", "rock", "wood", "steel", "concrete", "crumble", "bedrock", "brick"]
MAT_ID = {"dirt": 1, "rock": 2, "wood": 3, "steel": 4, "concrete": 5, "crumble": 6, "bedrock": 7, "brick": 8}
THEMES = ["warehouse", "rooftop", "junkyard", "construction"]

# The themed palettes (src/viewer/palette.ts keeps the same `mat` colors for debris).
BASE = {"dirt": 0x6b5a45, "rock": 0x6f7480, "wood": 0x9a6a3c, "steel": 0x56657e, "concrete": 0x8a8f99,
        "crumble": 0xb59a6a, "bedrock": 0x1c1a26, "brick": 0x8e4a3a}
PALETTE = {
    "warehouse": ({"concrete": 0x7c818c, "steel": 0x4f6a8c}, {"concrete": 0xe8c44a, "steel": 0x9fb6d6, "wood": 0xc8955a}),
    "rooftop": ({"concrete": 0x9a9aa4}, {"concrete": 0xcfcfd6, "brick": 0xb86a55, "wood": 0xc8955a, "steel": 0xa8b4c6}),
    "junkyard": ({"dirt": 0x5e4d38, "steel": 0x7a5a48}, {"dirt": 0x8a9a5a, "steel": 0xb08066, "wood": 0xc8955a}),
    "construction": ({"steel": 0xc76a2a, "dirt": 0x705a40}, {"dirt": 0xa58a5a, "steel": 0xf0a050, "wood": 0xd9a560}),
}


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
    """Every terrain frame, as Tiles (built lazily: call .build() just before rendering)."""
    out = []
    for th in themes:
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
