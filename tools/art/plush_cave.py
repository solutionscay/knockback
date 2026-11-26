"""
The cave's plush art (#125), the third of the new maps: its terrain, its overlays, its slime, its prop skins and its
backdrop, all in one atlas (group `level-cave`, loaded per match like every theme's). Built with plush_level.py's
helpers (and plush_beach.py's prop plumbing), rendered by plush_world.py (the same camera and lights), packed by
world_pack.py.

Frames (group `level-cave`; the theme's atlas is looked in first, so these replace the shared and nature frames):
  c-dirt-<v>, t-dirt          cave gravel: dark felt clods and grey pebbles, a tiny glowing crystal; a pebbly top
  c-rock-<v>, t-rock          the dark rock (the frame, the ceiling, the stalactites, the pillars, the ledges): slate
                              slabs with stitched strata, a glowing crystal vein; a pale mineral lip on top
  c-wood-<v>, t-wood          mine timber: dark planks with an iron strap and bolts
  c-crumble-<v>, t-crumble    rotten timber (it gives way fast and burns): split planks, cobweb threads
  c-ice-<v>, t-ice            cave ice (slippery, it shatters): a pale blue glossy block, frost, a glint; a frost lip
  c-bedrock-<v>, t-bedrock    bedrock in the cave's colors (the ceiling's top and the floor's bottom)
  k-1-<v>, k-2-<v>            crack stages: tears with gravel crumbs spilling out (in place of the stuffing)
  e-l, e-r, e-b               the carving edges: a slate piping instead of the dark one
  q-slime-<v>, s-slime-<f>    the slime: glowing green goo with bubbles, a bright crest and bubbles that swell and pop
  p-<prop>-<state>            prop skins (the same props, the same states): crate a mine cart with ore, barrel a
                              glowing crystal cluster (still explosive: a hazard patch), block a pile of boulders
  bg-crystal, bg-columns      the backdrop: a glowing crystal cluster, and a strip of rock columns (stalagmites rising,
                              stalactites hanging) that repeats sideways (the viewer lays it twice, far and near)
"""
import math

import numpy as np

import plush_action as pa
import plush_bot as pb
import plush_level as pl
from plush_level import CELL, Tile, backing, blob, felt, hexs, line_pts, shade, soft, thread, vinyl

THEME = "cave"
G = "level-" + THEME
MATS = ["dirt", "rock", "wood", "crumble", "ice", "bedrock"]
# set by plush_world.py before rendering (as plush_beach.PW): Group, mesh, soft_box, extrude_poly, stitch_line,
# stitch_rect, damage_objects and the world materials M
PW = None

CRYSTAL = ["#8a5cff", "#3ad8ff", "#b66bff"]  # violet, cyan, orchid: the glowing crystals


def colors():
    look = pl._TJ["themes"][THEME]
    base = pl._TJ["base"]
    m = {k: look["mat"].get(k, base[k]) for k in MATS}
    t = {k: look["top"].get(k, shade(m[k], 1.35)) for k in MATS}
    return m, t


def glow(col, strength=3.0):
    key = ("cave glow", col, strength)
    if key not in pl._MAT:
        # a lighter tint of the color in the middle (white would blow out to a white crystal), the color at the edges
        inner = hexs(shade(int(col[1:], 16), 1.45))
        pl._MAT[key] = pa.emit_two("Cave glow %s %.1f" % (col, strength), inner, col, strength * 0.45)
    return pl._MAT[key]


def shard(T, x, z, h, w, a, col, strength=2.5, y=-0.06):
    """A glowing crystal shard: a long six-sided point, its foot at (x, z), leaning by a, h long."""
    d = (math.sin(a), math.cos(a))
    tv, tf = pa.tube((x, y, z), (x + d[0] * h, y, z + d[1] * h), [(0.0, w), (0.7, w * 0.9), (1.0, w * 0.05)], 6)
    T.add(tv, tf, glow(col, strength))


# ---------------------------------------------------------------- the cells

def cell_gravel(T, col, rng, v):
    """Cave gravel: the dirt cell, darker, more pebbles; v1 has a tiny glowing crystal in it."""
    pl.cell_dirt(T, col, rng, v)
    peb = [felt(0x7a7c86, felt=0.5), felt(0x5a5c66, felt=0.5), felt(0x8e8a80, felt=0.5)]
    for k in range(4):
        x, z = rng.uniform(-0.22, 0.22, 2)
        r = rng.uniform(0.02, 0.035)
        T.add(*blob((x, -0.052, z), r, r * 0.7, r * 0.8, rot=rng.uniform(0, 3)), peb[k % 3])
    if v == 1:
        x, z = rng.uniform(-0.12, 0.12, 2)
        shard(T, x, z, 0.08, 0.018, 0.4, CRYSTAL[1], 2.0)
        shard(T, x + 0.02, z, 0.06, 0.014, -0.5, CRYSTAL[1], 2.0)


def cell_slate(T, col, rng, v):
    """Dark rock: overlapping slate slabs with stitched strata lines across (they run on through the cell's edges);
    v1 has a glowing crystal vein along a crack."""
    backing(T, shade(col, 0.5))
    tones = [felt(col, felt=0.35), felt(shade(col, 0.86), felt=0.35), felt(shade(col, 1.12), felt=0.35)]
    rows = [(-0.17, 0.09), (0.0, 0.08), (0.17, 0.09)]
    for k, (z, hz) in enumerate(rows):
        off = rng.uniform(-0.1, 0.1)
        for j, x in enumerate((-0.25 + off, 0.0 + off, 0.25 + off)):
            T.add(*soft((x, -0.005 - 0.004 * ((j + k) % 2), z), 0.13, 0.04, hz, p=4.0), tones[(j + k) % 3])
    strata = thread(hexs(shade(col, 0.55)))
    for z in (-0.085, 0.085):
        pts = [(-0.25 + t * 0.5, 0, z + 0.01 * math.sin(t * 2 * math.pi + z * 20)) for t in np.linspace(0, 1, 24)]
        T.stitch(pts, strata, dash=0.04, gap=0.012, width=0.01, height=0.005)
    if v == 1:
        x0, z0 = rng.uniform(-0.15, -0.05), rng.uniform(-0.15, 0.15)
        pts = [(x0 + t * 0.3, 0, z0 + 0.05 * math.sin(t * 5)) for t in np.linspace(0, 1, 16)]
        T.stitch(pts, glow(CRYSTAL[0], 2.2), dash=0.03, gap=0.012, width=0.012, height=0.008)
        shard(T, x0 + 0.15, z0 + 0.02, 0.07, 0.018, 0.3, CRYSTAL[0], 2.4)


def cell_timber(T, col, rng, v):
    """Mine timber: the plank cell with an iron strap across and two bolts."""
    pl.cell_wood(T, col, rng, v)
    z = -0.12 if v == 0 else 0.1
    T.add(*soft((0, -0.058, z), 0.25, 0.008, 0.028, p=6.0), vinyl(0x3a3c44, rough=0.4, metal=0.7))
    for x in (-0.16, 0.16):
        T.add(*blob((x, -0.072, z), 0.016, 0.01, 0.016), vinyl(0x9a9ca4, rough=0.25, metal=1.0))


def cell_rotten(T, col, rng, v):
    """Rotten timber: the crumbling plank cell, with a cobweb stitched across a corner."""
    pl.cell_crumble(T, col, rng, v)
    web = thread("#c9c6d6")
    cx, cz = (-0.25, 0.25) if v == 0 else (0.25, 0.25)
    sx = 1 if v == 0 else -1
    for a in np.linspace(0.1, 1.45, 4):
        T.stitch(line_pts((cx, cz), (cx + sx * math.sin(a) * 0.2, cz - math.cos(a) * 0.2), 8), web, dash=0.02, gap=0.012, width=0.004, height=0.004)
    for r in (0.08, 0.15):
        pts = [(cx + sx * math.sin(a) * r, 0, cz - math.cos(a) * r) for a in np.linspace(0.1, 1.45, 10)]
        T.stitch(pts, web, dash=0.016, gap=0.01, width=0.004, height=0.004)


def cell_cave_ice(T, col, rng, v):
    pl.cell_ice(T, col, rng, v)


CELLS = {"dirt": cell_gravel, "rock": cell_slate, "wood": cell_timber, "crumble": cell_rotten, "ice": cell_cave_ice,
         "bedrock": pl.cell_bedrock}


def cap_pebbles(T, col, rng):
    """Gravel's top: a rolled lip in the top color with a row of pebbles sitting on it."""
    top = CELL / 2
    T.size = (CELL, pl.TOP_H)
    T.shift = (0.0, -(top - pl.TOP_H / 2))
    T.rep = (2, 0)
    tv, tf = pa.tube((-0.25, -0.05, top - 0.035), (0.25, -0.05, top - 0.035), [(0.0, 0.03), (1.0, 0.03)], 12)
    T.add(tv, tf, felt(shade(col, 0.85), felt=0.5))
    tones = [felt(col, felt=0.5), felt(shade(col, 1.15), felt=0.5), felt(0x7a7c86, felt=0.5)]
    for k in range(6):
        x = -0.25 + (k + rng.uniform(0.2, 0.8)) * (0.5 / 6)
        r = rng.uniform(0.022, 0.032)
        T.add(*blob((x, -0.07, top - 0.035 - r * 0.2), r, r * 0.7, r * 0.75, rot=rng.uniform(0, 3)), tones[k % 3])
    return T


def cap_frost(T, col, rng):
    """Ice's top: a glossy rolled lip with frost tufts."""
    top = CELL / 2
    T.size = (CELL, pl.TOP_H)
    T.shift = (0.0, -(top - pl.TOP_H / 2))
    T.rep = (2, 0)
    r = 0.035
    tv, tf = pa.tube((-0.25, -0.05, top - r), (0.25, -0.05, top - r), [(0.0, r), (1.0, r)], 16)
    T.add(tv, tf, vinyl(col, rough=0.08, coat=1.0, spec=0.9))
    frost = felt(0xffffff, felt=0.7)
    for k in range(5):
        x = -0.25 + (k + rng.uniform(0.2, 0.8)) * 0.1
        T.add(*blob((x, -0.08, top - 0.02), 0.02, 0.01, 0.012, rot=rng.uniform(-0.4, 0.4)), frost)
    return T


def cap(T, m, col, rng):
    if m == "dirt":
        return cap_pebbles(T, col, rng)
    if m == "ice":
        return cap_frost(T, col, rng)
    return pl.cap(T, m, col, rng)


# ---------------------------------------------------------------- overlays

def tears(rng, n, big):
    """The shared tears, with gravel crumbs spilling out of them in place of the stuffing."""
    tear = pb.glossy_mat("Cave tear %d" % len(pl._MAT), "#0e0c12", rough=0.8, coat=0.0, spec=0.1)
    pl._MAT[("cave tear", len(pl._MAT))] = tear
    grit = [felt(0x6a6c76, felt=0.6), felt(0x4a4450, felt=0.6)]
    out = []
    for k in range(n):
        x, z = rng.uniform(-0.08, 0.08), rng.uniform(-0.1, 0.1)
        a = rng.uniform(-1.2, 1.2)
        L = rng.uniform(0.24, 0.3) * (1.2 if big else 1.0)
        tv, tf = blob((x, -0.06, z), L / 2, 0.012, 0.036 * (1.35 if big else 1.0), n=8, rot=a)
        out.append((tv, tf, tear))
        for j in range(5 if not big else 8):
            t = rng.uniform(-0.38, 0.38)
            r = rng.uniform(0.016, 0.026) * (1.15 if big else 1.0)
            c = (x + math.cos(a) * L * t + rng.uniform(-0.012, 0.012), -0.07, z - math.sin(a) * L * t - rng.uniform(0.0, 0.03))
            out.append((*blob(c, r, r * 0.7, r), grit[j % 2]))
    return out


def crack(stage, v):
    T = Tile("k-%d-%d" % (stage, v), G, kind="overlay", rep=(0, 0))
    T.parts += tears(np.random.default_rng(3140 + v), 1, False)
    if stage == 2:
        T.parts += tears(np.random.default_rng(3160 + v), 2, True)
    return T


def edge(T, side):
    """The piping on a carved side: a slate roll (pl.edge's), a little lighter than the rock so the hole reads."""
    r = 0.03
    col = felt(0x3c3e4a)
    if side == "b":
        T.size = (CELL, pl.EDGE_W)
        T.shift = (0.0, CELL / 2 - pl.EDGE_W / 2)
        T.rep = (2, 0)
        tv, tf = pa.tube((-0.25, -0.05, -0.25 + r + 0.006), (0.25, -0.05, -0.25 + r + 0.006), [(0.0, r), (1.0, r)], 12)
    else:
        sx = 1 if side == "r" else -1
        T.size = (pl.EDGE_W, CELL)
        T.shift = (-sx * (CELL / 2 - pl.EDGE_W / 2), 0.0)
        T.rep = (0, 2)
        x = sx * (0.25 - r - 0.006)
        tv, tf = pa.tube((x, -0.05, -0.25), (x, -0.05, 0.25), [(0.0, r), (1.0, r)], 12)
    T.add(tv, tf, col)
    return T


# ---------------------------------------------------------------- the slime

def slime_mat():
    key = ("cave slime",)
    if key not in pl._MAT:
        m = pb.glossy_mat("Cave slime", "#3c9a2a", rough=0.25, coat=0.6, spec=0.3)
        p = [n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"][0]
        p.inputs["Alpha"].default_value = 0.78
        p.inputs["Emission Color"].default_value = pb.srgb("#2fa818")
        p.inputs["Emission Strength"].default_value = 0.45
        pl._MAT[key] = m
    return pl._MAT[key]


def slime_body(T, rng, v):
    T.add(*pl.slab(-0.25, 0.25, -0.25, lambda x: 0.25), slime_mat())
    acc = thread("#c8ff8a")
    for z in ((-0.12, 0.08) if v == 0 else (-0.02,)):
        pts = [(-0.25 + t * 0.5, 0, z + 0.02 * math.sin(t * 2 * math.pi)) for t in np.linspace(0, 1, 30)]
        T.stitch(pts, acc, dash=0.05, gap=0.025, width=0.008, height=0.004)
    b = vinyl(0xd8ff9a, rough=0.15, coat=0.9)
    for k in range(2 + v):
        x, z = rng.uniform(-0.2, 0.2, 2)
        r = rng.uniform(0.014, 0.026)
        T.add(*blob((x, -0.036, z), r, r * 0.7, r), b)


def slime_wave(phase):
    k = 2 * math.pi / CELL
    amp = 0.014
    return lambda x: 0.16 + amp * math.sin(k * x - phase) + amp * 0.5 * math.sin(2 * k * x + 2 * phase + 1.0)


def slime_surface(T, f):
    ph = 2 * math.pi * f / pl.SURF_FRAMES
    top = slime_wave(ph)
    T.add(*pl.slab(-0.25, 0.25, -0.25, top), slime_mat())
    xs = np.linspace(-0.25, 0.25, 33)
    pts = [(x, -0.032, top(x) - 0.006) for x in xs]
    cv, cf = pb.sweep(pts, [np.array([0.0, 0.0, 1.0])] * len(pts), pb.circle(0.013, 8), closed=False, cap=False)
    T.add(cv, cf, glow("#9cf04a", 2.0))
    # bubbles that swell and pop (each a loop, half a loop apart: the tiling stays seamless)
    b = vinyl(0xd8ff9a, rough=0.15, coat=0.9)
    for x, off in ((-0.12, 0.0), (0.11, 0.5)):
        t = (f / pl.SURF_FRAMES + off) % 1.0
        r = 0.04 * math.sin(math.pi * t)
        if r > 0.006:
            T.add(*blob((x, -0.02, top(x) - 0.01 + r * 0.6), r, r * 0.7, r), b)
    return T


# ---------------------------------------------------------------- prop skins (front space, as plush_world's props)

def _states(Gp):
    damage = set(o for s in Gp.states for o in s)
    base = [o for o in Gp.obs if o not in damage]
    return [(base + extra, [o for o in damage if o not in extra]) for extra in Gp.states]


def crystal_cluster(Gp, name, x, y, z, s, cols, n=5, seed=0):
    rng = np.random.default_rng(3400 + seed)
    for k in range(n):
        a = (k - (n - 1) / 2) * 0.32 + rng.uniform(-0.08, 0.08)
        h = (0.42 - abs(k - (n - 1) / 2) * 0.09) * s * rng.uniform(0.85, 1.05)
        w = 0.07 * s * rng.uniform(0.85, 1.1)
        d = (math.sin(a), math.cos(a))
        tv, tf = pa.tube((x + k * 0.01 - 0.02, y, z), (x + d[0] * h, y, z + d[1] * h), [(0.0, w), (0.72, w * 0.95), (1.0, w * 0.06)], 6)
        Gp.add(PW.mesh("%s %d" % (name, k), tv, tf, glow(cols[k % len(cols)], 2.2)))


def prop_cart():
    """A mine cart (the crate's skin): a dark felt tub with an iron rim and rivets, two wheels, heaped grey ore with a
    glowing crystal on top."""
    M = PW.M
    Gp = PW.Group("p-crate", G)
    hx = hz = 0.4
    d = 0.22
    tub_c = 0x5a4a3c
    bv, bf = PW.soft_box((0, 0, 0.0), hx, d, hz - 0.12, p=4.0)
    body = Gp.add(PW.mesh("Cart tub", bv, bf, felt(tub_c, felt=0.4)))
    bvh = pb.bvh_of(body)
    B = pb.Builder()
    for z in (-0.12, 0.08):
        PW.stitch_line(B, bvh, (-hx + 0.05, -d - 0.05, z), (hx - 0.05, -d - 0.05, z), dash=0.05, gap=0.015, width=0.01, height=0.006)
    Gp.add(B.obj("Cart seams", thread(hexs(shade(tub_c, 0.55)))))
    iron = vinyl(0x3a3c44, rough=0.35, metal=0.8)
    tv, tf = pa.tube((-hx - 0.02, -0.02, hz - 0.12), (hx + 0.02, -0.02, hz - 0.12), [(0.0, 0.04), (1.0, 0.04)], 16)
    tv[:, 1] *= 4.5
    Gp.add(PW.mesh("Cart rim", tv, tf, iron))
    for x in (-hx + 0.06, hx - 0.06):
        for z in (-0.2, 0.15):
            Gp.add(PW.mesh("Cart rivet %.2f %.2f" % (x, z), *blob((x, -d - 0.035, z), 0.018, 0.012, 0.018), vinyl(0xa8aab2, rough=0.2, metal=1.0)))
    for x in (-0.22, 0.22):
        rv, rf = pa.ring((x, -d - 0.04, -hz + 0.11), (0, 1, 0), 0.08, pb.circle(0.03, 10), 32)
        Gp.add(PW.mesh("Cart wheel %.2f" % x, rv, rf, iron))
        Gp.add(PW.mesh("Cart hub %.2f" % x, *blob((x, -d - 0.06, -hz + 0.11), 0.03, 0.02, 0.03), vinyl(0xa8aab2, rough=0.2, metal=1.0)))
    ore = [felt(0x6a6c76, felt=0.5), felt(0x585a64, felt=0.5), felt(0x7c7e88, felt=0.5)]
    for k, (x, z, r) in enumerate(((-0.24, 0.32, 0.1), (-0.06, 0.36, 0.12), (0.14, 0.33, 0.11), (0.28, 0.3, 0.08))):
        Gp.add(PW.mesh("Cart ore %d" % k, *blob((x, -0.04, z), r, r * 0.8, r * 0.75, rot=k * 0.7), ore[k % 3]))
    crystal_cluster(Gp, "Cart crystal", 0.02, -0.12, 0.36, 0.45, [CRYSTAL[1], CRYSTAL[0]], n=3, seed=1)
    PW.damage_objects(Gp, M, hx, hz, -d, 3)
    return Gp


def prop_crystals():
    """A glowing crystal cluster (the explosive barrel's skin): violet and cyan points out of a dark rock foot, and the
    yellow hazard patch on the rock (it still blows up)."""
    M = PW.M
    Gp = PW.Group("p-barrel", G)
    hx, hz = 0.34, 0.5
    rock = felt(0x3e4050, felt=0.4)
    Gp.add(PW.mesh("Crystal foot", *blob((0, 0, -hz + 0.13), hx, 0.2, 0.15, n=10), rock))
    crystal_cluster(Gp, "Crystal", 0.0, -0.02, -hz + 0.18, 1.55, CRYSTAL, n=5, seed=2)
    y = -0.2 - 0.016
    tri = [(0.0, 0.09), (0.085, -0.065), (-0.085, -0.065)]
    from mathutils import Matrix
    Gp.add(PW.extrude_poly("Crystal hazard", tri, 0.025, M["felt_yellow"], 0.015)).matrix_world = Matrix.Translation((0, y, -hz + 0.12))
    mv, mf = PW.soft_box((0, y - 0.025, -hz + 0.13), 0.01, 0.008, 0.032, p=3.0)
    Gp.add(PW.mesh("Crystal mark", mv, mf, M["black_vinyl"]))
    dv, df = pb.cube_sphere(6)
    Gp.add(PW.mesh("Crystal dot", dv * 0.01 + np.array([0, y - 0.025, -hz + 0.085]), df, M["black_vinyl"]))
    PW.damage_objects(Gp, M, hx * 0.9, hz, -0.2, 7)
    return Gp


def prop_boulders():
    """Cover (the building block's skin): three felt boulders heaped, slate grey with stitched strata, a crystal tip."""
    M = PW.M
    Gp = PW.Group("p-block", G)
    hx = hz = 0.45
    tones = [felt(0x585c6a, felt=0.4), felt(0x4c505c, felt=0.4), felt(0x646878, felt=0.4)]
    strata = thread("#2e3038")
    for k, (x, z, rx, rz) in enumerate(((-0.22, -0.24, 0.24, 0.21), (0.22, -0.25, 0.23, 0.2), (0.0, 0.14, 0.26, 0.23))):
        rock = Gp.add(PW.mesh("Boulder %d" % k, *blob((x, 0, z), rx, 0.22, rz, n=10, rot=k * 0.5), tones[k]))
        B = pb.Builder()
        PW.stitch_line(B, pb.bvh_of(rock), (x - rx * 0.7, -0.3, z + 0.03), (x + rx * 0.7, -0.3, z - 0.02), dash=0.04, gap=0.014, width=0.009, height=0.005)
        Gp.add(B.obj("Boulder strata %d" % k, strata))
    crystal_cluster(Gp, "Boulder crystal", 0.12, -0.16, 0.3, 0.35, [CRYSTAL[2], CRYSTAL[1]], n=3, seed=3)
    PW.damage_objects(Gp, M, hx, hz, -0.22, 5)
    return Gp


PROPS = {"crate": prop_cart, "barrel": prop_crystals, "block": prop_boulders}


def prop_tile(kind, state):
    T = Tile("p-%s-%d" % (kind, state), G, kind="sprite", rep=(0, 0))
    T.anchor = (0.0, 0.0, 0.0)

    def make(T=T, kind=kind, state=state):
        Gp = PROPS[kind]()
        show, hide = _states(Gp)[state]
        import bpy
        for ob in hide:
            me = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.meshes.remove(me)
        T.obs = list(show)
    T.make = make
    return T


# ---------------------------------------------------------------- the backdrop

COLS_W, COLS_H = 4.0, 2.4


def bg_crystal():
    """A glowing crystal cluster for the cave's back wall (the viewer scatters a few, dimmed, as the map's light)."""
    T = Tile("bg-crystal", G, kind="sprite", rep=(0, 0))
    T.add(*blob((0, 0.02, -0.22), 0.28, 0.06, 0.08, n=10), felt(0x2a2836, felt=0.4))
    rng = np.random.default_rng(3500)
    for k in range(6):
        a = (k - 2.5) * 0.3 + rng.uniform(-0.06, 0.06)
        h = (0.5 - abs(k - 2.5) * 0.09) * rng.uniform(0.85, 1.05)
        shard(T, (k - 2.5) * 0.04, -0.22, h, 0.06, a, CRYSTAL[k % 3], 3.0, y=-0.02)
    T.anchor = (0.0, 0.0, 0.0)
    return T


def column(T, x, h, w, mat, up, lean=0.0):
    """A felt rock column (#134: round, not a flat wedge): a tapered cone rising from the strip's foot (a stalagmite) or
    hanging from its top (a stalactite), its root flared into the fill, a round cross-section and a rounded point, a
    strata line stitched across it. Its outline is two smooth curves, so no step or kink shows at any scale."""
    base = -COLS_H / 2 if up else COLS_H / 2
    s = 1 if up else -1

    def r(t):  # half width: a flared root, a long taper, a blunt rounded point (a fifth of the root's width)
        flare = 1 + 0.35 * max(0.0, 1 - t / 0.12) ** 2
        return w / 2 * flare * (0.2 + 0.8 * (1 - t) ** 0.9) * math.sqrt(max(0.0, 1 - t ** 8))

    def at(t, side):
        return (x + lean * t * t + side * r(t), base + s * (h * t - 0.06))
    L, R = (lambda t: at(t, -1)), (lambda t: at(t, 1))
    V, F = band(L, R, lambda t, u, wd: 0.004 + 0.12 * min(1.0, wd / 0.5) * math.sqrt(max(0.0, 1 - (2 * u - 1) ** 2)), n_t=40, n_u=12)
    T.add(V, F, mat)
    for t in (0.3, 0.55):
        rr = r(t) * 0.9
        zc = base + s * (h * t - 0.06)
        T.stitch([(x + lean * t * t + q, 0, zc - s * 0.03 * (1 - (q / rr) ** 2)) for q in np.linspace(-rr, rr, 16)], thread("#262532"), dash=0.05, gap=0.02, width=0.014, height=0.008)


def bg_columns():
    """A strip of rock columns, COLS_W by COLS_H, that repeats sideways (columns across the seam drawn on both sides):
    stalagmites rising from its foot, stalactites hanging from its top. No band at either end: the viewer fills above
    and below it in the columns' own color, so no flat line runs along the backdrop."""
    T = Tile("bg-columns", G, kind="cap", rep=(0, 0))
    T.size = (COLS_W, COLS_H)
    rng = np.random.default_rng(3600)
    dark = felt(0x3a3848, felt=0.35, mottle=(0.92, 1.05))
    for up, step, hr in ((True, 0.55, (0.7, 1.5)), (False, 0.48, (0.5, 1.1))):
        for x in np.arange(-COLS_W / 2 + 0.2, COLS_W / 2, step):
            x = float(x + rng.uniform(-0.1, 0.1))
            h = float(rng.uniform(*hr))
            w = float(rng.uniform(0.32, 0.5))
            lean = float(rng.uniform(-0.04, 0.04))  # the same for the copies across the seam
            for xx in (x, x - COLS_W, x + COLS_W):
                if -COLS_W / 2 - w < xx < COLS_W / 2 + w:
                    column(T, xx, h, w, dark, up, lean)
    return T


# ---------------------------------------------------------------- rounded stalactites (#134)

def band(L, R, height, n_t=28, n_u=12):
    """A plush surface between two outlines, L(t) and R(t) (t 0..1 from top to bottom, points (x, z) in screen meters):
    a grid of n_t by n_u quads (as triangles), each point pushed toward the camera (-y) by height(t, u, width), u 0..1
    from L to R. The silhouette is the two outlines (sampled finely), so it is smooth at any size."""
    V = []
    for i in range(n_t + 1):
        t = i / n_t
        (lx, lz), (rx, rz) = L(t), R(t)
        wdt = math.hypot(rx - lx, rz - lz)
        for j in range(n_u + 1):
            u = j / n_u
            V.append((lx + (rx - lx) * u, -height(t, u, wdt), lz + (rz - lz) * u))
    F = []
    for i in range(n_t):
        for j in range(n_u):
            a, b = i * (n_u + 1) + j, i * (n_u + 1) + j + 1
            c, d = a + n_u + 1, b + n_u + 1
            F += [(a, b, d), (a, d, c)]
    return np.array(V), F


def dome(depth):
    """A round cross-section (a squashed cylinder): full depth on the middle line, nothing at either outline."""
    return lambda t, u, w: 0.004 + depth * min(1.0, w / 0.4) * math.sqrt(max(0.0, 1 - (2 * u - 1) ** 2))


ST_TOP, ST_DEPTH = 0.2, 0.07  # a tip's half width where it meets the cell above; how far a stalactite bulges


def st_radius(kind, t):
    """Half width along a hanging cell, t 0..1 from its top: a mid segment narrows from nearly the cell's width to
    ST_TOP, a tip from ST_TOP to a rounded point (an ogive: full most of the way, then closing fast). A wide tip (tipw)
    hangs from a square cell (a 3-wide stalactite's root): it starts at the cell's full width, upright, and eases in onto
    the tip's outline by 0.4 of its length, so the root's straight sides run on into it with no step."""
    if kind == "mid":
        return 0.24 + (ST_TOP - 0.24) * (3 * t * t - 2 * t ** 3)
    r = ST_TOP * math.sqrt(max(0.0, 1 - t ** 1.6)) * (1 - 0.15 * t)
    if kind == "tipw":
        k = min(1.0, t / 0.4)
        r += (CELL / 2 - ST_TOP) * (1 - (3 * k * k - 2 * k ** 3))
    return r


def st_shape(kind):
    """The parts of one hanging-rock cell (the frame is one cell; outside the shape it is transparent):
       tip  both sides open and nothing under it: a rounded point, 0.45 m long
       tipw the same under a square cell (#148: a 3-wide root): full width at its top
       mid  both sides open, rock under it: a tapered segment
       l, r one side open and nothing under it (a stalactite's shoulder, a step in the ceiling's underside): the open
            side flares in along an S curve, from the cell's top corner on that side to its bottom corner on the other,
            upright at both ends, so it runs on from a straight side above and into the narrower rock below"""
    top, bot = CELL / 2, -CELL / 2
    if kind in ("tip", "tipw", "mid"):
        length = CELL if kind == "mid" else 0.45
        z = lambda t: top - length * t
        return band(lambda t: (-st_radius(kind, t), z(t)), lambda t: (st_radius(kind, t), z(t)), dome(ST_DEPTH))
    sx = -1 if kind == "l" else 1  # the open side

    def curve(t):  # the S curve: x from the open side's edge to the far edge, upright at both ends
        k = 3 * t * t - 2 * t ** 3
        return (sx * (CELL / 2 - CELL * k), top - CELL * t)

    def wall(t):  # the closed sides, the matching point: along the top, then down the far side
        if t < 0.5:
            return (sx * (CELL / 2 - CELL * 2 * t), top)
        return (-sx * CELL / 2, top - CELL * (2 * t - 1))

    def h(t, u, w):  # rounded only along the open side (the rock carries on full depth past the closed sides)
        d = u * w
        return 0.004 + ST_DEPTH * math.sqrt(max(0.0, 1 - max(0.0, 1 - d / 0.14) ** 2))
    L, R = (curve, wall) if sx < 0 else (wall, curve)
    if sx > 0:  # keep the quads facing the camera: the left outline on the left
        return band(lambda t: wall(t), lambda t: curve(t), lambda t, u, w: h(t, 1 - u, w))
    return band(L, R, h)


def stalactite(kind, stage):
    """Frame st-<kind>-<stage> (#134): a hanging cave-rock cell drawn round (terrainview.ts picks it from the cell's
    open sides), in the slate's colors, a stitched strata line or two across it; stage 1 and 2 add the cave's tears
    (gravel spilling out), smaller and kept inside the shape."""
    T = Tile("st-%s-%d" % (kind, stage), G, kind="overlay", rep=(0, 0))
    mcol, _ = colors()
    col = mcol["rock"]
    V, F = st_shape(kind)
    T.add(V, F, felt(col, felt=0.35, mottle=(0.9, 1.06)))
    strata = thread(hexs(shade(col, 0.55)))
    if kind in ("tip", "tipw", "mid"):
        for t in ((0.45,) if kind == "mid" else (0.3, 0.62)):
            r = st_radius(kind, t) * 0.92
            zc = CELL / 2 - (CELL if kind == "mid" else 0.45) * t
            T.stitch([(x, 0, zc - 0.02 * (1 - (x / r) ** 2)) for x in np.linspace(-r, r, 14)], strata, dash=0.03, gap=0.012, width=0.009, height=0.005)
    else:
        sx = -1 if kind == "l" else 1
        pts = []
        for t in np.linspace(0.05, 0.95, 16):
            k = 3 * t * t - 2 * t ** 3
            pts.append((sx * (CELL / 2 - CELL * k) - sx * 0.09, 0, CELL / 2 - CELL * t - 0.06))
        T.stitch([p for p in pts if abs(p[0]) < 0.24 and abs(p[2]) < 0.24], strata, dash=0.03, gap=0.012, width=0.009, height=0.005)
    if stage:
        # the tears, smaller, moved into the widest part of the shape and in front of its bulge
        k, (cx, cz) = {"tip": (0.5, (0, 0.1)), "tipw": (0.5, (0, 0.1)), "mid": (0.7, (0, 0)), "l": (0.7, (0.08, 0.08)), "r": (0.7, (-0.08, 0.08))}[kind]
        parts = tears(np.random.default_rng(3200 + stage * 10 + "tmlr".index(kind[0])), 1, False)
        if stage == 2:
            parts += tears(np.random.default_rng(3240 + "tmlr".index(kind[0])), 1, True)
        for v, f, m in parts:
            v = np.asarray(v, float).copy()
            v[:, 0] = v[:, 0] * k + cx
            v[:, 2] = v[:, 2] * k + cz
            v[:, 1] = v[:, 1] - ST_DEPTH + 0.04
            T.add(v, f, m)
    return T


# ---------------------------------------------------------------- every frame

def cave_tiles():
    out = []
    mcol, tcol = colors()
    for m in MATS:
        for v in (0, 1):
            T = Tile("c-%s-%d" % (m, v), G)
            T.make = (lambda T=T, m=m, v=v, c=mcol[m]: CELLS[m](T, c, np.random.default_rng(3000 + MATS.index(m) * 10 + v), v))
            out.append(T)
        T = Tile("t-" + m, G, kind="cap")
        T.make = (lambda T=T, m=m, c=tcol[m]: cap(T, m, c, np.random.default_rng(3080 + MATS.index(m))))
        out.append(T)
    for st in (1, 2):
        for v in (0, 1):
            T = crack(st, v)
            T.make = lambda: None
            out.append(T)
    for s in ("l", "r", "b"):
        T = Tile("e-" + s, G, kind="edge")
        T.make = (lambda T=T, s=s: edge(T, s))
        out.append(T)
    for v in (0, 1):
        T = Tile("q-slime-%d" % v, G)
        T.make = (lambda T=T, v=v: slime_body(T, np.random.default_rng(3100 + v), v))
        out.append(T)
    for f in range(pl.SURF_FRAMES):
        T = Tile("s-slime-%d" % f, G, kind="cap", rep=(2, 0))
        T.make = (lambda T=T, f=f: slime_surface(T, f))
        out.append(T)
    for kind in PROPS:
        for state in range(3):
            out.append(prop_tile(kind, state))
    for kind in ("tip", "tipw", "mid", "l", "r"):
        for stage in (0, 1, 2):
            T = stalactite(kind, stage)
            T.make = lambda: None
            out.append(T)
    for fn in (bg_crystal, bg_columns):
        T = fn()
        if not hasattr(T, "make"):
            T.make = lambda: None
        out.append(T)
    return out
