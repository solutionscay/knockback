"""
The forest's plush art (#114), the second of the new maps: its terrain, its overlays, its creek water, its prop skins
and its backdrop, all in one atlas (group `level-forest`, loaded per match like every theme's). Built with
plush_level.py's helpers (and plush_beach.py's prop plumbing), rendered by plush_world.py (the same camera and lights),
packed by world_pack.py.

Frames (group `level-forest`; the theme's atlas is looked in first, so these replace the shared and nature frames):
  c-dirt-<v>, t-dirt          forest soil: dark felt clods, stitched roots, a pebble; a grass and moss top with leaves
  c-rock-<v>, t-rock          the rock frame and stones: grey stones with moss patches, moss tufts on top
  c-wood-<v>, t-wood          bark (the trunks and the branches): wavy grooves stitched along it, a knot; a mossy lip
  c-crumble-<v>, t-crumble    the leafy canopy (rotten planks in the sim: it gives way fast and burns): layered felt leaves
  c-mud-<v>, t-mud            the creek's muddy banks and walls: glossy dark mud, a leaf in it
  c-bedrock-<v>, t-bedrock    bedrock in the forest's colors
  k-1-<v>, k-2-<v>            crack stages: tears with soil crumbs spilling out (in place of the stuffing)
  e-l, e-r, e-b               the carving edges: a root-brown piping instead of the dark one
  q-water-<v>, s-water-<f>    the creek: murky green water with leaf flecks, a pale crest and a drifting leaf on the loop
  p-<prop>-<state>            prop skins (the same props, the same states): crate a tree stump, barrel a beehive (still
                              explosive: a hazard patch), block a pile of cut logs
  bg-moon, bg-pines           the backdrop: a felt moon, and a strip of pine silhouettes that repeats sideways (the
                              viewer lays it twice, far and near, tinted darker than the level)
"""
import math

import numpy as np

import plush_action as pa
import plush_bot as pb
import plush_level as pl
from plush_level import CELL, Tile, backing, blob, felt, hexs, line_pts, shade, soft, thread, vinyl

THEME = "forest"
G = "level-" + THEME
MATS = ["dirt", "rock", "wood", "crumble", "mud", "bedrock"]
# set by plush_world.py before rendering (as plush_beach.PW): Group, mesh, soft_box, extrude_poly, stitch_line,
# stitch_rect, damage_objects and the world materials M
PW = None

LEAF = [0xc8742e, 0xd9a032, 0xa8452a]  # fallen leaves: orange, ochre, rust


def colors():
    look = pl._TJ["themes"][THEME]
    base = pl._TJ["base"]
    m = {k: look["mat"].get(k, base[k]) for k in MATS}
    t = {k: look["top"].get(k, shade(m[k], 1.35)) for k in MATS}
    return m, t


def leaf(T, x, y, z, r, col, rot=0.0):
    """A small felt leaf with a stitched midrib."""
    T.add(*blob((x, y, z), r, r * 0.25, r * 0.5, n=8, rot=rot), felt(col, felt=0.35))
    d = (math.cos(rot) * r * 0.8, -math.sin(rot) * r * 0.8)
    T.stitch(line_pts((x - d[0], z - d[1]), (x + d[0], z + d[1]), 6), thread(hexs(shade(col, 0.6))), dash=0.012, gap=0.006, width=0.004, height=0.003)


# ---------------------------------------------------------------- the cells

def cell_soil(T, col, rng, v):
    """Forest soil: the dirt cell, darker, with roots stitched through it and a leaf bit."""
    pl.cell_dirt(T, col, rng, v)
    root = thread(hexs(shade(col, 1.45)))
    x0, z0 = rng.uniform(-0.2, 0.0), rng.uniform(-0.15, 0.15)
    pts = [(x0 + t * 0.4, 0, z0 + 0.04 * math.sin(t * 5 + v)) for t in np.linspace(0, 1, 20)]
    T.stitch(pts, root, dash=0.04, gap=0.012, width=0.011, height=0.006)
    if v == 1:
        a = rng.uniform(-0.5, 0.5)
        T.stitch([(x0 + 0.2, 0, z0), (x0 + 0.2 + 0.08 * math.cos(a), 0, z0 - 0.09)], root, dash=0.03, gap=0.01, width=0.008, height=0.005)
    leaf(T, rng.uniform(-0.15, 0.15), -0.05, rng.uniform(-0.18, 0.18), 0.04, LEAF[v], rot=rng.uniform(-1, 1))


def cell_mossy_rock(T, col, rng, v):
    pl.cell_rock(T, col, rng, v)
    moss = [felt(0x4f7a34, felt=0.6), felt(0x5f8a3a, felt=0.6)]
    for k in range(2 + v):
        x, z = rng.uniform(-0.18, 0.18), rng.uniform(0.0, 0.2)
        T.add(*blob((x, -0.058, z), rng.uniform(0.04, 0.06), 0.012, rng.uniform(0.02, 0.03), rot=rng.uniform(-0.4, 0.4)), moss[k % 2])


def cell_bark(T, col, rng, v):
    """Bark: a felt slab with deep wavy grooves stitched along it (they repeat across the cell's edges), a knot."""
    backing(T, shade(col, 0.5))
    T.add(*soft((0, 0, 0), 0.25, 0.04, 0.25, p=10.0), felt(col, felt=0.45, mottle=(0.86, 1.08)))
    groove = thread(hexs(shade(col, 0.5)))
    hi = felt(shade(col, 1.18), felt=0.45)
    for k, x in enumerate((-0.19, -0.065, 0.065, 0.19)):
        ph = rng.uniform(0, 2 * math.pi)
        pts = [(x + 0.018 * math.sin(2 * math.pi * t * 2 + ph), 0, -0.25 + t * 0.5) for t in np.linspace(0, 1, 26)]
        T.stitch(pts, groove, dash=0.05, gap=0.012, width=0.014, height=0.006)
        z = rng.uniform(-0.18, 0.18)
        T.add(*blob((x + 0.06, -0.045, z), 0.022, 0.008, 0.06), hi)
    if v == 1:  # a knot
        x, z = rng.uniform(-0.08, 0.08, 2)
        T.add(*blob((x, -0.048, z), 0.05, 0.016, 0.04), felt(shade(col, 0.7)))
        rv, rf = pa.ring((x, -0.06, z), (0, 1, 0), 0.05, pb.circle(0.009, 8), 28)
        T.add(rv, rf, felt(shade(col, 1.25)))


def cell_canopy(T, col, rng, v):
    """The leafy canopy: a dark green backing under overlapping felt leaves in three greens, stitched veins, a twig."""
    backing(T, shade(col, 0.45))
    T.add(*soft((0, 0, 0), 0.24, 0.025, 0.24, p=5.0), felt(shade(col, 0.7), felt=0.6))
    tones = [col, shade(col, 0.82), shade(col, 1.18)]
    for k in range(11):
        x, z = rng.uniform(-0.22, 0.22), rng.uniform(-0.22, 0.22)
        r = rng.uniform(0.07, 0.1)
        a = rng.uniform(-1.4, 1.4)
        T.add(*blob((x, -0.02 - 0.003 * k, z), r, 0.02, r * 0.5, n=8, rot=a), felt(tones[k % 3], felt=0.5))
        if k % 3 == 0:
            d = (math.cos(a) * r * 0.8, -math.sin(a) * r * 0.8)
            T.stitch(line_pts((x - d[0], z - d[1]), (x + d[0], z + d[1]), 8), thread(hexs(shade(tones[k % 3], 1.35))), dash=0.016, gap=0.008, width=0.005, height=0.004)
    twig = felt(0x5a4030)
    x0, z0 = rng.uniform(-0.15, 0.0), rng.uniform(-0.12, 0.12)
    tv, tf = pa.tube((x0, -0.06, z0), (x0 + 0.18, -0.06, z0 + 0.05 * (1 if v else -1)), [(0.0, 0.012), (1.0, 0.008)], 8)
    T.add(tv, tf, twig)
    if v == 1:  # a red berry pair
        for dx in (0, 0.026):
            T.add(*blob((x0 + 0.1 + dx, -0.07, z0 + 0.04), 0.016, 0.014, 0.016), vinyl(0xc8323a, rough=0.3, coat=0.6))


def cell_creek_mud(T, col, rng, v):
    pl.cell_mud(T, col, rng, v)
    leaf(T, rng.uniform(-0.12, 0.12), -0.052, rng.uniform(-0.15, 0.15), 0.035, LEAF[(v + 1) % 3], rot=rng.uniform(-1, 1))


CELLS = {"dirt": cell_soil, "rock": cell_mossy_rock, "wood": cell_bark, "crumble": cell_canopy, "mud": cell_creek_mud,
         "bedrock": pl.cell_bedrock}


def cap_grass(T, col, rng, leaves=2):
    """Grass and moss on top: the dirt cap's tufts in the top color, with a fallen leaf or two lying in them."""
    pl.cap(T, "dirt", col, rng)
    top = CELL / 2
    for k in range(leaves):
        x = rng.uniform(-0.2, 0.2)
        leaf(T, x, -0.085, top - 0.05, 0.032, LEAF[int(rng.integers(0, 3))], rot=rng.uniform(-0.6, 0.6))
    return T


def cap_leaves(T, col, rng):
    """The canopy's top: a row of leaves sticking up out of a rolled green lip."""
    top = CELL / 2
    T.size = (CELL, pl.TOP_H)
    T.shift = (0.0, -(top - pl.TOP_H / 2))
    T.rep = (2, 0)
    tv, tf = pa.tube((-0.25, -0.05, top - 0.04), (0.25, -0.05, top - 0.04), [(0.0, 0.03), (1.0, 0.03)], 12)
    T.add(tv, tf, felt(shade(col, 0.8), felt=0.5))
    tones = [felt(col, felt=0.5), felt(shade(col, 1.15), felt=0.5), felt(shade(col, 0.88), felt=0.5)]
    for k in range(7):
        x = -0.25 + (k + rng.uniform(0.2, 0.8)) * (0.5 / 7)
        a = rng.uniform(-0.5, 0.5) + math.pi / 2
        c = (x, -0.07, top - 0.07 + 0.03)
        T.add(*blob(c, 0.05, 0.012, 0.022, n=8, rot=a), tones[k % 3])
    return T


def cap(T, m, col, rng):
    if m == "dirt":
        return cap_grass(T, col, rng)
    if m in ("rock", "wood"):  # moss on stones and on bark
        return cap_grass(T, col, rng, leaves=1 if m == "rock" else 0)
    if m == "crumble":
        return cap_leaves(T, col, rng)
    if m == "mud":
        import plush_beach
        return plush_beach.cap_sand(T, col, rng, wet=True)
    return pl.cap(T, m, col, rng)


# ---------------------------------------------------------------- overlays

def tears(rng, n, big):
    """The shared tears, with soil crumbs spilling out of them in place of the stuffing."""
    tear = pb.glossy_mat("Forest tear %d" % len(pl._MAT), "#1e140c", rough=0.8, coat=0.0, spec=0.1)
    pl._MAT[("forest tear", len(pl._MAT))] = tear
    soil = [felt(0x4a3626, felt=0.7), felt(0x6a5034, felt=0.7)]
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
            out.append((*blob(c, r, r * 0.7, r), soil[j % 2]))
    return out


def crack(stage, v):
    T = Tile("k-%d-%d" % (stage, v), G, kind="overlay", rep=(0, 0))
    T.parts += tears(np.random.default_rng(2140 + v), 1, False)
    if stage == 2:
        T.parts += tears(np.random.default_rng(2160 + v), 2, True)
    return T


def edge(T, side):
    """The piping on a carved side: a root-brown roll (pl.edge's)."""
    r = 0.03
    col = felt(0x3a2a1c)
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


# ---------------------------------------------------------------- the creek's water

def water_mat():
    key = ("forest water",)
    if key not in pl._MAT:
        m = pb.glossy_mat("Forest water", "#5f9f86", rough=0.45, coat=0.15, spec=0.18)
        p = [n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"][0]
        p.inputs["Alpha"].default_value = 0.6
        pl._MAT[key] = m
    return pl._MAT[key]


def water_body(T, rng, v):
    T.add(*pl.slab(-0.25, 0.25, -0.25, lambda x: 0.25), water_mat())
    acc = thread("#cdeedc")
    for z in ((-0.1, 0.12) if v == 0 else (0.02,)):
        pts = [(-0.25 + t * 0.5, 0, z + 0.012 * math.sin(t * 2 * math.pi * 2)) for t in np.linspace(0, 1, 30)]
        T.stitch(pts, acc, dash=0.03, gap=0.03, width=0.007, height=0.004)
    silt = felt(0x6a5a3a, felt=0.5)
    for k in range(3):
        x, z = rng.uniform(-0.22, 0.22), rng.uniform(-0.22, 0.0)
        T.add(*blob((x, -0.036, z), 0.01, 0.005, 0.008), silt)


def water_surface(T, f):
    ph = 2 * math.pi * f / pl.SURF_FRAMES
    top = pl.wave("water", ph)
    T.add(*pl.slab(-0.25, 0.25, -0.25, top), water_mat())
    xs = np.linspace(-0.25, 0.25, 33)
    pts = [(x, -0.032, top(x) - 0.006) for x in xs]
    cv, cf = pb.sweep(pts, [np.array([0.0, 0.0, 1.0])] * len(pts), pb.circle(0.012, 8), closed=False, cap=False)
    T.add(cv, cf, felt(0xd8f2e2, felt=0.5))
    # a leaf drifting along (one per cell, moving a cell per loop so the tiling stays seamless)
    x = ((f / pl.SURF_FRAMES) % 1.0) * CELL - 0.25
    for xs_ in (x, x + CELL):
        if -0.28 < xs_ < 0.28:
            leaf(T, xs_, -0.05, top(min(0.25, max(-0.25, xs_))) + 0.004, 0.034, LEAF[0], rot=0.2)
    return T


# ---------------------------------------------------------------- prop skins (front space, as plush_world's props)

def _states(Gp):
    damage = set(o for s in Gp.states for o in s)
    base = [o for o in Gp.obs if o not in damage]
    return [(base + extra, [o for o in damage if o not in extra]) for extra in Gp.states]


def mushroom(Gp, name, x, y, z, s, cap_col=0xc8423a):
    stem = felt(0xeee4cc, felt=0.4)
    tv, tf = pa.tube((x, y, z), (x, y, z + 0.07 * s), [(0.0, 0.02 * s), (1.0, 0.016 * s)], 10)
    Gp.add(PW.mesh(name + " stem", tv, tf, stem))
    Gp.add(PW.mesh(name + " cap", *blob((x, y, z + 0.075 * s), 0.055 * s, 0.045 * s, 0.032 * s, n=10), vinyl(cap_col, rough=0.35, coat=0.5)))
    for k, (dx, dz) in enumerate(((-0.02, 0.012), (0.018, 0.02), (0.0, 0.03))):
        Gp.add(PW.mesh(name + " dot %d" % k, *blob((x + dx * s, y - 0.04 * s, z + (0.075 + dz) * s), 0.008 * s, 0.006 * s, 0.008 * s), felt(0xfaf4e6)))


def prop_stump():
    """A tree stump (the crate's skin): bark sides with wavy grooves, a pale cut top with growth rings, roots at the
    foot, moss and a cluster of red-capped mushrooms."""
    M = PW.M
    Gp = PW.Group("p-crate", G)
    hx = hz = 0.4
    d = 0.22
    bark_c = 0x6e5038
    bv, bf = PW.soft_box((0, 0, -0.03), hx, d, hz - 0.03, p=4.0)
    body = Gp.add(PW.mesh("Stump body", bv, bf, felt(bark_c, felt=0.45)))
    bvh = pb.bvh_of(body)
    B = pb.Builder()
    for x in (-0.27, -0.09, 0.09, 0.27):
        PW.stitch_line(B, bvh, (x, -d - 0.05, -hz + 0.05), (x + 0.03, -d - 0.05, hz - 0.12), dash=0.05, gap=0.015, width=0.014, height=0.008)
    Gp.add(B.obj("Stump grooves", thread(hexs(shade(bark_c, 0.5)))))
    tv, tf = pa.tube((-hx + 0.02, -0.02, hz - 0.05), (hx - 0.02, -0.02, hz - 0.05), [(0.0, 0.05), (0.08, 0.06), (0.92, 0.06), (1.0, 0.05)], 20)
    tv[:, 1] *= 3.6
    Gp.add(PW.mesh("Stump top", tv, tf, felt(0xd8b47e, felt=0.35)))
    ring = thread("#9a7448")
    Br = pb.Builder()
    for x0, x1 in ((-0.3, 0.3), (-0.18, 0.18)):
        PW.stitch_line(Br, bvh, (x0, -d - 0.07, hz - 0.03), (x1, -d - 0.07, hz - 0.03), dash=0.03, gap=0.015, width=0.007, height=0.005)
    Gp.add(Br.obj("Stump rings", ring))
    root = felt(shade(bark_c, 0.85), felt=0.45)
    for k, (x, sx) in enumerate(((-hx, -1), (hx, 1), (-0.12, -1))):
        tv, tf = pa.tube((x - sx * 0.08, -d * 0.6, -hz + 0.1), (x + sx * 0.1, -d * 0.6, -hz + 0.01), [(0.0, 0.07), (1.0, 0.025)], 12)
        Gp.add(PW.mesh("Stump root %d" % k, tv, tf, root))
    moss = felt(0x5f8a3a, felt=0.6)
    for k, (x, z) in enumerate(((-0.25, 0.22), (-0.15, 0.27), (0.28, -0.05))):
        Gp.add(PW.mesh("Stump moss %d" % k, *blob((x, -d - 0.03, z), 0.07, 0.025, 0.04), moss))
    mushroom(Gp, "Stump shroom a", 0.2, -d - 0.04, -0.2, 1.1)
    mushroom(Gp, "Stump shroom b", 0.29, -d - 0.04, -0.24, 0.8)
    PW.damage_objects(Gp, M, hx, hz, -d, 3)
    return Gp


def prop_hive():
    """A beehive (the explosive barrel's skin): a straw skep of coiled felt bands, a dark entrance, two bees, and the
    yellow hazard patch (it still blows up)."""
    M = PW.M
    Gp = PW.Group("p-barrel", G)
    hx, hz = 0.34, 0.5
    prof = [(0.0, 0.0), (0.0, hx * 0.95), (0.25, hx), (0.55, hx * 0.92), (0.8, hx * 0.72), (0.93, hx * 0.45), (2 * hz, 0.0)]
    v, f = pb.lathe(prof, 48)
    v[:, 1] *= 0.6
    v[:, 2] -= hz
    Gp.add(PW.mesh("Hive body", v, f, felt(0xd9a54a, felt=0.4)))
    band = felt(0xb8822e, felt=0.4)
    for k, zt in enumerate((0.12, 0.3, 0.48, 0.66, 0.82)):
        # the radius of the profile at height zt (linear between its points)
        pz = [p[0] for p in prof]
        pr = [p[1] for p in prof]
        r = float(np.interp(zt, pz, pr)) + 0.01
        rv, rf = pa.ring((0, 0, zt - hz), (0, 0, 1), r, pb.circle(0.022, 8), 48)
        rv[:, 1] *= 0.6
        Gp.add(PW.mesh("Hive coil %d" % k, rv, rf, band))
    Gp.add(PW.mesh("Hive door", *blob((0.0, -hx * 0.6 - 0.01, -hz + 0.07), 0.07, 0.02, 0.04), felt(0x2a1a0e)))
    for k, (x, z, a) in enumerate(((-0.24, 0.18, 0.4), (0.27, -0.06, -0.3))):
        y = -hx * 0.6 - 0.07
        Gp.add(PW.mesh("Bee %d" % k, *blob((x, y, z), 0.04, 0.03, 0.028, rot=a), felt(0xf2c12e, felt=0.3)))
        Gp.add(PW.mesh("Bee stripe %d" % k, *blob((x + 0.008, y - 0.012, z), 0.012, 0.022, 0.03, rot=a), felt(0x1e1a16)))
        for s in (-1, 1):
            Gp.add(PW.mesh("Bee wing %d %d" % (k, s), *blob((x + s * 0.02, y + 0.01, z + 0.035), 0.025, 0.006, 0.016, rot=s * 0.6), vinyl(0xeef6ff, rough=0.2, coat=0.8)))
    y = -hx * 0.6 - 0.014
    tri = [(0.0, 0.13), (0.12, -0.09), (-0.12, -0.09)]
    from mathutils import Matrix
    Gp.add(PW.extrude_poly("Hive hazard", tri, 0.03, M["felt_yellow"], 0.02)).matrix_world = Matrix.Translation((0, y, -0.05))
    mv, mf = PW.soft_box((0, y - 0.03, -0.035), 0.014, 0.01, 0.045, p=3.0)
    Gp.add(PW.mesh("Hive mark", mv, mf, M["black_vinyl"]))
    dv, df = pb.cube_sphere(6)
    Gp.add(PW.mesh("Hive dot", dv * 0.014 + np.array([0, y - 0.03, -0.1]), df, M["black_vinyl"]))
    PW.damage_objects(Gp, M, hx * 0.9, hz, -hx * 0.6, 7)
    return Gp


def prop_logpile():
    """Cover (the building block's skin): three cut logs stacked, bark brown with pale ringed ends, moss on top."""
    M = PW.M
    Gp = PW.Group("p-block", G)
    hx = hz = 0.45
    r = 0.15
    bark = [felt(0x6e5038, felt=0.45), felt(0x5e4430, felt=0.45), felt(0x7a5a40, felt=0.45)]
    end = felt(0xd8b47e, felt=0.35)
    grain = thread("#3e2c1e")
    ringc = thread("#9a7448")
    for k, z in enumerate((-hz + r, -hz + r, 0.0)):
        x0, x1 = (-hx + 0.02, -0.01) if k == 0 else (0.01, hx - 0.02) if k == 1 else (-hx * 0.55, hx * 0.55)
        if k == 2:
            z = -hz + r + 2 * r * 0.88
        tv, tf = pa.tube((x0, 0, z), (x1, 0, z), [(0.0, r * 0.95), (0.06, r), (0.94, r), (1.0, r * 0.95)], 24)
        log = Gp.add(PW.mesh("Log %d" % k, tv, tf, bark[k]))
        B = pb.Builder()
        PW.stitch_line(B, pb.bvh_of(log), (x0 + 0.06, -r - 0.05, z + 0.05), (x1 - 0.06, -r - 0.05, z + 0.04), dash=0.05, gap=0.015, width=0.01, height=0.006)
        PW.stitch_line(B, pb.bvh_of(log), (x0 + 0.06, -r - 0.05, z - 0.05), (x1 - 0.06, -r - 0.05, z - 0.06), dash=0.05, gap=0.015, width=0.01, height=0.006)
        Gp.add(B.obj("Log grain %d" % k, grain))
        # the near end, facing the camera a little: a pale disc with a ring stitched on it
        for x in (x0, x1):
            Gp.add(PW.mesh("Log end %d %.2f" % (k, x), *blob((x, 0, z), 0.025, r * 0.82, r * 0.82), end))
            rv, rf = pa.ring((x + (0.026 if x > 0 else -0.026), 0, z), (1, 0, 0), r * 0.45, pb.circle(0.008, 6), 24)
            Gp.add(PW.mesh("Log ring %d %.2f" % (k, x), rv, rf, felt(0x9a7448)))
    # the top log is set back, under the others' front: a strip of moss across it and a mushroom
    zt = -hz + r + 2 * r * 0.88
    Gp.add(PW.mesh("Log moss", *blob((-0.05, -r * 0.7, zt + r * 0.8), 0.16, 0.05, 0.035), felt(0x5f8a3a, felt=0.6)))
    mushroom(Gp, "Log shroom", 0.12, -r - 0.02, zt + r * 0.6, 1.0, cap_col=0xd98a3a)
    PW.damage_objects(Gp, M, hx, hz, -r, 5)
    return Gp


PROPS = {"crate": prop_stump, "barrel": prop_hive, "block": prop_logpile}


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

PINES_W, PINES_H = 4.0, 1.6


def bg_moon():
    T = Tile("bg-moon", G, kind="sprite", rep=(0, 0))
    T.add(*blob((0, 0, 0), 0.42, 0.05, 0.42, n=12), felt(0xe8e6cf, felt=0.25, mottle=(0.95, 1.04)))
    for k, (x, z, r) in enumerate(((-0.12, 0.1, 0.08), (0.14, -0.06, 0.06), (0.02, -0.2, 0.05), (0.2, 0.18, 0.04))):
        T.add(*blob((x, -0.035, z), r, 0.012, r), felt(0xc9c6ad, felt=0.3))
    T.stitch([(math.cos(a) * 0.38, 0, math.sin(a) * 0.38) for a in np.linspace(0, 2 * math.pi, 80)], thread("#d2cfb4"), dash=0.035, gap=0.02, width=0.01, height=0.006)
    T.anchor = (0.0, 0.0, 0.0)
    return T


def pine(T, x, h, w, mat, trunk):
    """A felt pine: a short trunk and three stacked triangles (soft extruded wedges)."""
    tv, tf = pa.tube((x, 0.02, -PINES_H / 2), (x, 0.02, -PINES_H / 2 + h * 0.25), [(0.0, w * 0.08), (1.0, w * 0.07)], 8)
    T.add(tv, tf, trunk)
    z0 = -PINES_H / 2 + h * 0.15
    for k in range(3):
        zb = z0 + k * h * 0.26
        ww = w * (1.0 - 0.22 * k)
        hh = h * 0.42
        n = 9
        pts = []
        for j in range(n):
            t = j / (n - 1)
            pts.append((x - ww / 2 + ww * t, zb + 0.03 * math.sin(t * math.pi * 4)))
        pts.append((x, zb + hh))
        # a flat felt wedge: fan triangles over the outline
        P = np.array([[px, 0.0, pz] for px, pz in pts] + [[x, -0.03, zb + hh * 0.35]])
        c = len(P) - 1
        F = [(i, i + 1, c) for i in range(len(pts) - 1)] + [(len(pts) - 1, 0, c)]
        back = P.copy()
        back[:, 1] = 0.03
        V = np.vstack([P, back])
        F2 = F + [(a + len(P), c2 + len(P), b + len(P)) for a, b, c2 in F]
        T.add(V, [list(t) for t in F2], mat)


def bg_pines():
    """A strip of pine silhouettes, PINES_W by PINES_H, that repeats sideways (trees across the seam drawn on both
    sides). No ground band: the viewer fills below it in the pines' own color, so no flat line runs along the backdrop."""
    T = Tile("bg-pines", G, kind="cap", rep=(0, 0))
    T.size = (PINES_W, PINES_H)
    rng = np.random.default_rng(2300)
    dark = felt(0x2c4436, felt=0.35, mottle=(0.92, 1.05))
    trunk = felt(0x3a2e24, felt=0.4)
    xs = np.arange(-PINES_W / 2 + 0.2, PINES_W / 2, 0.42)
    for x in xs:
        x = float(x + rng.uniform(-0.08, 0.08))
        h = float(rng.uniform(0.9, 1.45))
        w = float(rng.uniform(0.38, 0.52))
        for xx in (x, x - PINES_W, x + PINES_W):
            if -PINES_W / 2 - w < xx < PINES_W / 2 + w:
                pine(T, xx, h, w, dark, trunk)
    return T


# ---------------------------------------------------------------- every frame

def forest_tiles():
    out = []
    mcol, tcol = colors()
    for m in MATS:
        for v in (0, 1):
            T = Tile("c-%s-%d" % (m, v), G)
            T.make = (lambda T=T, m=m, v=v, c=mcol[m]: CELLS[m](T, c, np.random.default_rng(2000 + MATS.index(m) * 10 + v), v))
            out.append(T)
        T = Tile("t-" + m, G, kind="cap")
        T.make = (lambda T=T, m=m, c=tcol[m]: cap(T, m, c, np.random.default_rng(2080 + MATS.index(m))))
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
        T = Tile("q-water-%d" % v, G)
        T.make = (lambda T=T, v=v: water_body(T, np.random.default_rng(2100 + v), v))
        out.append(T)
    for f in range(pl.SURF_FRAMES):
        T = Tile("s-water-%d" % f, G, kind="cap", rep=(2, 0))
        T.make = (lambda T=T, f=f: water_surface(T, f))
        out.append(T)
    for kind in PROPS:
        for state in range(3):
            out.append(prop_tile(kind, state))
    for fn in (bg_moon, bg_pines):
        T = fn()
        if not hasattr(T, "make"):
            T.make = lambda: None
        out.append(T)
    return out
