"""
The beach's plush art (#111), the first of the new maps: its terrain, its overlays, its water, its prop skins and its
backdrop, all in one atlas (group `level-beach`, loaded per match like every theme's). Built here with plush_level.py's
helpers, rendered by plush_world.py (the same camera and lights), packed by world_pack.py.

Frames (group `level-beach`; the theme's atlas is looked in first, so these replace the shared and nature frames):
  c-sand-<v>, t-sand          dry sand (the top two rows): pale felt grains, wind ripples, a shell
  c-dirt-<v>, t-dirt          wet sand (the beach's dirt: it holds its shape): darker, damp gloss, crab holes, shells
  c-rock-<v>, t-rock          the rock frame and walls: warm grey stones with barnacles, seaweed on top
  c-wood-<v>, t-wood          boardwalk planks: salt-bleached boards, nail heads
  c-crumble-<v>, t-crumble    rotten boardwalk planks
  c-bedrock-<v>, t-bedrock    bedrock in the beach's colors
  k-1-<v>, k-2-<v>            crack stages: tears with sand spilling out (in place of the stuffing)
  e-l, e-r, e-b               the carving edges: a sandy piping instead of the dark one
  q-water-<v>, s-water-<f>    the tide pools: clear turquoise with sand specks, a foam crest on the 8-frame loop
  p-<prop>-<state>            prop skins (the same props, the same states): crate a driftwood crate, barrel a buoy
                              (still explosive: a hazard patch), block a lashed bundle of driftwood logs
  bg-sun, bg-cloud-<v>, bg-island, bg-sea
                              the backdrop: a felt sun, two clouds, a far island with a palm, and a strip of sea that
                              repeats sideways (the viewer lays it along the horizon)
"""
import math

import numpy as np

import plush_action as pa
import plush_bot as pb
import plush_level as pl
from plush_level import CELL, Tile, backing, blob, felt, hexs, line_pts, shade, soft, thread, vinyl

THEME = "beach"
G = "level-" + THEME
MATS = ["sand", "dirt", "rock", "wood", "crumble", "bedrock"]
# set by plush_world.py before rendering: Group, mesh, soft_box, extrude_poly, stitch_line, stitch_rect,
# damage_objects and the world materials M (the prop skins are built the way the world props are)
PW = None


def colors():
    look = pl._TJ["themes"][THEME]
    base = pl._TJ["base"]
    m = {k: look["mat"].get(k, base[k]) for k in MATS}
    t = {k: look["top"].get(k, shade(m[k], 1.35)) for k in MATS}
    return m, t


# ---------------------------------------------------------------- the cells

def cell_dry(T, col, rng, v):
    pl.cell_sand(T, col, rng, v)
    if v == 0:  # a tiny starfish
        x, z = rng.uniform(-0.14, 0.14, 2)
        for k in range(5):
            a = k * 2 * math.pi / 5 + 0.3
            T.add(*blob((x + math.cos(a) * 0.018, -0.042, z + math.sin(a) * 0.018), 0.02, 0.007, 0.008, rot=-a), felt(0xe8794a, felt=0.4))


def cell_wet(T, col, rng, v):
    """Wet sand: a darker, smoother slab with damp glossy patches, fewer grains, crab holes and a shell."""
    backing(T, shade(col, 0.78))
    T.add(*soft((0, 0, 0), 0.245, 0.035, 0.245, p=8.0), felt(col, felt=0.45, mottle=(0.88, 1.05)))
    damp = vinyl(shade(col, 0.86), rough=0.35, coat=0.45)
    for k in range(2):
        x, z = rng.uniform(-0.16, 0.16, 2)
        T.add(*blob((x, -0.037, z), rng.uniform(0.06, 0.09), 0.004, rng.uniform(0.03, 0.05), rot=rng.uniform(-0.3, 0.3)), damp)
    tones = [felt(shade(col, 1.1), felt=0.5), felt(shade(col, 0.85), felt=0.5)]
    for k in range(12):
        x, z = rng.uniform(-0.24, 0.24, 2)
        r = rng.uniform(0.007, 0.013)
        T.add(*blob((x, -0.038, z), r, r * 0.6, r), tones[k % 2])
    hole = felt(shade(col, 0.42))
    for k in range(1 + v):
        x, z = rng.uniform(-0.18, 0.18, 2)
        T.add(*blob((x, -0.039, z), 0.016, 0.004, 0.012), hole)
    if v == 1:  # a pink fan shell with stitched ribs
        x, z = rng.uniform(-0.1, 0.1, 2)
        T.add(*blob((x, -0.043, z), 0.034, 0.01, 0.026), felt(0xf0b4a8, felt=0.3))
        rib = thread("#c87a6e")
        for a in (-0.6, 0.0, 0.6):
            T.stitch(line_pts((x, z - 0.02), (x + math.sin(a) * 0.028, z + math.cos(a) * 0.02), 6), rib, dash=0.012, gap=0.006, width=0.005, height=0.004)
    rip = thread(hexs(shade(col, 0.72)))
    z0 = -0.15 if v == 0 else 0.12
    T.stitch([(-0.25 + t * 0.5, 0, z0 + 0.02 * math.sin(t * 2 * math.pi)) for t in np.linspace(0, 1, 30)], rip, dash=0.034, gap=0.02, width=0.008)


def cell_beach_rock(T, col, rng, v):
    pl.cell_rock(T, col, rng, v)
    shell = felt(0xefe6d4, felt=0.3)
    dot = felt(0x3a3430)
    for k in range(2 + v):
        x, z = rng.uniform(-0.2, 0.2, 2)
        r = rng.uniform(0.016, 0.024)
        T.add(*blob((x, -0.058, z), r, r * 0.8, r), shell)
        T.add(*blob((x, -0.058 - r * 0.75, z), r * 0.35, r * 0.2, r * 0.35), dot)


def cell_board(T, col, rng, v):
    """Boardwalk planks: the wood cell, salt-bleached streaks stitched along the boards."""
    pl.cell_wood(T, col, rng, v)
    salt = thread(hexs(shade(col, 1.45)))
    for cz in (0.125, -0.125):
        z = cz + rng.uniform(-0.05, 0.05)
        T.stitch(line_pts((-0.22, z), (0.05 + rng.uniform(0, 0.15), z + rng.uniform(-0.02, 0.02)), 14), salt, dash=0.05, gap=0.03, width=0.007, height=0.004)


CELLS = {"sand": cell_dry, "dirt": cell_wet, "rock": cell_beach_rock, "wood": cell_board, "crumble": pl.cell_crumble,
         "bedrock": pl.cell_bedrock}


def cap_sand(T, col, rng, wet=False):
    """Sand's top edge: a soft rolled lip with grains on it (dry: pale; wet: a damp gloss along it)."""
    top = CELL / 2
    T.size = (CELL, pl.TOP_H)
    T.shift = (0.0, -(top - pl.TOP_H / 2))
    T.rep = (2, 0)
    r = 0.036
    tv, tf = pa.tube((-0.25, -0.05, top - r), (0.25, -0.05, top - r), [(0.0, r), (1.0, r)], 16)
    T.add(tv, tf, felt(col, felt=0.55) if not wet else vinyl(col, rough=0.4, coat=0.4))
    tones = [felt(shade(col, 1.06), felt=0.6), felt(shade(col, 0.88), felt=0.6)]
    for k in range(7):
        x = -0.25 + (k + rng.uniform(0.2, 0.8)) * (0.5 / 7)
        rr = rng.uniform(0.008, 0.013)
        T.add(*blob((x, -0.085, top - r * 1.2 + rng.uniform(-0.01, 0.012)), rr, rr * 0.6, rr), tones[k % 2])
    return T


def cap(T, m, col, rng):
    if m == "sand":
        return cap_sand(T, col, rng)
    if m == "dirt":
        return cap_sand(T, col, rng, wet=True)
    if m == "rock":  # seaweed and beach grass on the stones: the dirt cap's tufts, in the top color
        return pl.cap(T, "dirt", col, rng)
    return pl.cap(T, m, col, rng)


# ---------------------------------------------------------------- overlays

def tears(rng, n, big):
    """The shared tears, with sand spilling out of them in place of the stuffing."""
    tear = pb.glossy_mat("Beach tear %d" % len(pl._MAT), "#3a2814", rough=0.8, coat=0.0, spec=0.1)
    pl._MAT[("beach tear", len(pl._MAT))] = tear
    sand = felt(0xcfae6e, felt=0.7, mottle=(0.9, 1.08))
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
            out.append((*blob(c, r, r * 0.6, r), sand))
    return out


def crack(stage, v):
    T = Tile("k-%d-%d" % (stage, v), G, kind="overlay", rep=(0, 0))
    T.parts += tears(np.random.default_rng(1140 + v), 1, False)
    if stage == 2:
        T.parts += tears(np.random.default_rng(1160 + v), 2, True)
    return T


def edge(T, side):
    """The piping on a carved side, sandy brown (pl.edge's roll)."""
    r = 0.03
    col = felt(0x6b5034)
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


# ---------------------------------------------------------------- the tide pools' water

def water_mat():
    key = ("beach water",)
    if key not in pl._MAT:
        m = pb.glossy_mat("Beach water", "#27b0b4", rough=0.5, coat=0.1, spec=0.15)
        p = [n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"][0]
        p.inputs["Alpha"].default_value = 0.58
        pl._MAT[key] = m
    return pl._MAT[key]


def water_body(T, rng, v):
    T.add(*pl.slab(-0.25, 0.25, -0.25, lambda x: 0.25), water_mat())
    acc = thread("#c8fbf4")
    for z in ((-0.1, 0.12) if v == 0 else (0.02,)):
        pts = [(-0.25 + t * 0.5, 0, z + 0.012 * math.sin(t * 2 * math.pi * 2)) for t in np.linspace(0, 1, 30)]
        T.stitch(pts, acc, dash=0.03, gap=0.03, width=0.007, height=0.004)
    speck = felt(0xd9c58e, felt=0.5)
    for k in range(3):
        x, z = rng.uniform(-0.22, 0.22), rng.uniform(-0.22, 0.0)
        T.add(*blob((x, -0.036, z), 0.01, 0.005, 0.008), speck)


def water_surface(T, f):
    ph = 2 * math.pi * f / pl.SURF_FRAMES
    top = pl.wave("water", ph)
    T.add(*pl.slab(-0.25, 0.25, -0.25, top), water_mat())
    xs = np.linspace(-0.25, 0.25, 33)
    pts = [(x, -0.032, top(x) - 0.006) for x in xs]
    cv, cf = pb.sweep(pts, [np.array([0.0, 0.0, 1.0])] * len(pts), pb.circle(0.013, 8), closed=False, cap=False)
    T.add(cv, cf, felt(0xf4fffd, felt=0.5))
    foam = felt(0xffffff, felt=0.6)
    for k in range(4):
        x = ((k / 4 + f / pl.SURF_FRAMES) % 1.0) * CELL - 0.25
        T.add(*blob((x, -0.047, top(x) + 0.006), 0.019, 0.009, 0.013), foam)
    return T


# ---------------------------------------------------------------- prop skins (front space, as plush_world's props)

def _states(Gp):
    """Per damage state: the base objects and that state's tears, and the objects the state does not show."""
    damage = set(o for s in Gp.states for o in s)
    base = [o for o in Gp.obs if o not in damage]
    return [(base + extra, [o for o in damage if o not in extra]) for extra in Gp.states]


def prop_crate():
    """A driftwood crate: salt-grey felt planks, a rope lashing with a knot, a felt starfish, barnacles at a corner."""
    M = PW.M
    Gp = PW.Group("p-crate", G)
    hx = hz = 0.4
    d = 0.22
    bv, bf = PW.soft_box((0, 0, 0), hx, d, hz, p=5.0)
    body = Gp.add(PW.mesh("Drift crate body", bv, bf, felt(0xa99a83)))
    bvh = pb.bvh_of(body)
    B = pb.Builder()
    PW.stitch_rect(B, bvh, hx, hz, -d - 0.05, 0.05, dash=0.03, gap=0.02, width=0.012, height=0.008)
    for z in (-0.2, 0.0, 0.2):
        PW.stitch_line(B, bvh, (-hx + 0.06, -d - 0.05, z), (hx - 0.06, -d - 0.05, z), dash=0.03, gap=0.02, width=0.01, height=0.007)
    Gp.add(B.obj("Drift crate stitches", thread("#5a4a36")))
    rope = felt(0xd8bd84, felt=0.4)
    for x in (-0.22, 0.22):
        tv, tf = pa.tube((x, -d - 0.02, -hz - 0.01), (x, -d - 0.02, hz + 0.01), [(0.0, 0.026), (1.0, 0.026)], 12)
        Gp.add(PW.mesh("Drift crate rope %.2f" % x, tv, tf, rope))
    Gp.add(PW.mesh("Drift crate knot", *blob((0.22, -d - 0.05, 0.1), 0.045, 0.03, 0.04), rope))
    star = [(0.13 * math.cos(math.pi / 2 + k * math.pi / 5) * (1 if k % 2 == 0 else 0.45), 0.13 * math.sin(math.pi / 2 + k * math.pi / 5) * (1 if k % 2 == 0 else 0.45)) for k in range(10)]
    ob = Gp.add(PW.extrude_poly("Drift crate star", star, 0.03, felt(0xe8743c), 0.012))
    from mathutils import Matrix
    ob.matrix_world = Matrix.Translation((-0.04, -d - 0.025, -0.02))
    for k, (x, z) in enumerate(((0.3, -0.3), (0.24, -0.33), (0.33, -0.22))):
        Gp.add(PW.mesh("Drift crate barnacle %d" % k, *blob((x, -d - 0.02, z), 0.026, 0.02, 0.026), felt(0xefe6d4)))
    PW.damage_objects(Gp, M, hx, hz, -d, 3)
    return Gp


def prop_buoy():
    """A buoy (the explosive barrel's skin): a white vinyl float with two red bands, a black cap and eye, and the
    yellow hazard patch (it still blows up)."""
    M = PW.M
    Gp = PW.Group("p-barrel", G)
    hx, hz = 0.34, 0.5
    prof = [(0.0, 0.0), (0.0, hx * 0.55), (0.08, hx * 0.92), (0.2, hx), (2 * hz - 0.2, hx), (2 * hz - 0.08, hx * 0.9), (2 * hz, hx * 0.5), (2 * hz, 0.0)]
    v, f = pb.lathe(prof, 48)
    v[:, 1] *= 0.6
    v[:, 2] -= hz
    Gp.add(PW.mesh("Buoy body", v, f, M["white_vinyl"]))
    for z0, z1 in ((-hz * 0.62, -hz * 0.22), (hz * 0.18, hz * 0.58)):
        rv, rf = pb.lathe([(0, 0), (0, hx + 0.012), (z1 - z0, hx + 0.012), (z1 - z0, 0)], 48)
        rv[:, 1] *= 0.61
        rv[:, 2] += z0
        Gp.add(PW.mesh("Buoy band %.2f" % z0, rv, rf, M["red_vinyl"]))
    cv, cf = pb.lathe([(0, 0), (0, 0.11), (0.06, 0.1), (0.07, 0)], 24)
    cv[:, 2] += hz - 0.04
    Gp.add(PW.mesh("Buoy cap", cv, cf, M["black_vinyl"]))
    rv, rf = pa.ring((0, 0, hz + 0.07), (0, 1, 0), 0.045, pb.circle(0.014, 8), 28)
    Gp.add(PW.mesh("Buoy eye", rv, rf, M["iron"]))
    y = -hx * 0.6 - 0.014
    tri = [(0.0, 0.13), (0.12, -0.09), (-0.12, -0.09)]
    from mathutils import Matrix
    Gp.add(PW.extrude_poly("Buoy hazard", tri, 0.03, M["felt_yellow"], 0.02)).matrix_world = Matrix.Translation((0, y, 0.0))
    mv, mf = PW.soft_box((0, y - 0.03, 0.015), 0.014, 0.01, 0.045, p=3.0)
    Gp.add(PW.mesh("Buoy mark", mv, mf, M["black_vinyl"]))
    dv, df = pb.cube_sphere(6)
    Gp.add(PW.mesh("Buoy dot", dv * 0.014 + np.array([0, y - 0.03, -0.05]), df, M["black_vinyl"]))
    PW.damage_objects(Gp, M, hx * 0.9, hz, -hx * 0.6, 7)
    return Gp


def prop_logs():
    """Cover (the building block's skin): three driftwood logs stacked and lashed with rope, their ends ringed."""
    M = PW.M
    Gp = PW.Group("p-block", G)
    hx = hz = 0.45
    r = 0.15
    wood = [felt(0xb9a98e, felt=0.4), felt(0xa39278, felt=0.4), felt(0xc4b59a, felt=0.4)]
    ring = felt(0x8a7458)
    grain = thread("#7a6650")
    for k, z in enumerate((-hz + r, 0.0, hz - r)):
        x0, x1 = -hx + 0.02 + 0.03 * (k % 2), hx - 0.02 - 0.03 * ((k + 1) % 2)
        tv, tf = pa.tube((x0, 0, z), (x1, 0, z), [(0.0, r * 0.95), (0.1, r), (0.9, r), (1.0, r * 0.95)], 24)
        log = Gp.add(PW.mesh("Log %d" % k, tv, tf, wood[k]))
        for x in (x0, x1):
            Gp.add(PW.mesh("Log end %d %.2f" % (k, x), *blob((x, 0, z), 0.02, r * 0.8, r * 0.8), ring))
        B = pb.Builder()
        PW.stitch_line(B, pb.bvh_of(log), (x0 + 0.1, -r - 0.05, z + 0.03), (x1 - 0.12, -r - 0.05, z - 0.02), dash=0.05, gap=0.03, width=0.008, height=0.005)
        Gp.add(B.obj("Log grain %d" % k, grain))
    rope = felt(0xd8bd84, felt=0.4)
    for x in (-0.24, 0.24):
        tv, tf = pa.tube((x, -r - 0.012, -hz - 0.01), (x, -r - 0.012, hz + 0.01), [(0.0, 0.024), (1.0, 0.024)], 12)
        Gp.add(PW.mesh("Log rope %.2f" % x, tv, tf, rope))
    PW.damage_objects(Gp, M, hx, hz, -r, 5)
    return Gp


PROPS = {"crate": prop_crate, "barrel": prop_buoy, "block": prop_logs}


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

SEA_W, SEA_H = 4.0, 1.0


def bg_sun():
    T = Tile("bg-sun", G, kind="sprite", rep=(0, 0))
    T.add(*blob((0, 0, 0), 0.5, 0.06, 0.5, n=12), felt(0xf7a531, felt=0.2, mottle=(0.95, 1.05)))
    T.add(*blob((0, -0.03, 0), 0.4, 0.05, 0.4, n=12), felt(0xffc94a, felt=0.2, mottle=(0.97, 1.03)))
    for k in range(12):
        a = k * 2 * math.pi / 12
        c = (math.cos(a) * 0.66, 0.02, math.sin(a) * 0.66)
        T.add(*blob(c, 0.1, 0.03, 0.04, rot=-a), felt(0xf08a2a, felt=0.3))
    T.stitch([(math.cos(a) * 0.45, 0, math.sin(a) * 0.45) for a in np.linspace(0, 2 * math.pi, 80)], thread("#f09a3a"), dash=0.04, gap=0.025, width=0.012, height=0.008)
    T.anchor = (0.0, 0.0, 0.0)
    return T


def bg_cloud(v):
    T = Tile("bg-cloud-%d" % v, G, kind="sprite", rep=(0, 0))
    rng = np.random.default_rng(1200 + v)
    col = [0xfbe4d6, 0xf6d2c4][v]
    n = 5 if v == 0 else 4
    for k in range(n):
        x = -0.9 + 1.8 * k / (n - 1) + rng.uniform(-0.08, 0.08)
        rz = 0.2 + 0.18 * math.sin(math.pi * (k + 0.5) / n) + rng.uniform(-0.03, 0.03)
        T.add(*blob((x, 0, rz * 0.6), rz * 1.3, 0.08, rz, n=8), felt(shade(col, 1.0 - 0.04 * (k % 2)), felt=0.3))
    T.add(*soft((0, 0.02, 0.05), 1.05, 0.06, 0.12, p=3.0), felt(shade(col, 0.92), felt=0.3))
    T.anchor = (0.0, 0.0, 0.0)
    return T


def bg_island():
    T = Tile("bg-island", G, kind="sprite", rep=(0, 0))
    T.add(*soft((0, 0, -0.05), 1.3, 0.08, 0.28, p=2.2, n=14), felt(0x3e6b66, felt=0.3))
    T.add(*soft((-0.25, -0.02, 0.05), 0.6, 0.06, 0.22, p=2.2, n=12), felt(0x4a7a70, felt=0.3))
    trunk = felt(0x6a5a44)
    pts = [(0.25 + 0.12 * t * t, 0, 0.12 + 0.95 * t) for t in np.linspace(0, 1, 12)]
    for a, b in zip(pts[:-1], pts[1:]):
        tv, tf = pa.tube(a, b, [(0.0, 0.035), (1.0, 0.03)], 8)
        T.add(tv, tf, trunk)
    top = pts[-1]
    leaf = felt(0x2f5a3c, felt=0.3)
    for k, a in enumerate((-2.6, -1.9, -0.9, -0.3, 0.4)):
        c = (top[0] + math.cos(a) * 0.22, -0.02, top[2] - 0.04 + math.sin(abs(a) * 0.5) * 0.06 - 0.07 * (k % 2))
        T.add(*blob(c, 0.26, 0.03, 0.055, rot=a if abs(a) < 1.6 else a + math.pi), leaf)
    T.anchor = (0.0, 0.0, 0.0)
    return T


def bg_sea():
    """A strip of sea, SEA_W by SEA_H, that repeats sideways: periodic felt (period 2 m), wave stitches with whole
    periods over the strip, a pale line along the horizon (its top edge) and sun glints."""
    T = Tile("bg-sea", G, kind="cap", rep=(0, 0))
    T.size = (SEA_W, SEA_H)
    sea = pl.tile_fabric("Beach sea", "#2a7d93", period=2.0, mottle=(0.92, 1.05))
    W = SEA_W * 1.6
    T.add(*pl.slab(-W, W, -SEA_H, lambda x: SEA_H / 2 - 0.06, ty=0.04, n=97), sea)
    T.add(*pl.slab(-W, W, SEA_H / 2 - 0.07, lambda x: SEA_H / 2 + 0.02, ty=0.03, n=97), felt(0x9fd6d8, felt=0.2))
    for k, (z, per, amp, col) in enumerate(((0.3, 1.0, 0.02, "#6cc0cc"), (0.08, 2.0, 0.03, "#5ab4c4"), (-0.18, 1.0, 0.035, "#4aa6ba"), (-0.38, 0.5, 0.025, "#3e9ab0"))):
        pts = [(x, 0, z + amp * math.sin(2 * math.pi * x / per + k)) for x in np.linspace(-W, W, 240)]
        T.stitch(pts, thread(col), dash=0.08 + 0.02 * k, gap=0.05, width=0.012 + 0.003 * k, height=0.006)
    glint = felt(0xffe2a8, felt=0.2)
    for x0 in (-1.4, 0.3, 1.3):
        for xs in (x0, x0 - SEA_W, x0 + SEA_W):
            T.add(*blob((xs, -0.06, 0.38 - 0.1 * (x0 > 0)), 0.09, 0.006, 0.012), glint)
    return T


# ---------------------------------------------------------------- every frame

def beach_tiles():
    out = []
    mcol, tcol = colors()
    for m in MATS:
        for v in (0, 1):
            T = Tile("c-%s-%d" % (m, v), G)
            T.make = (lambda T=T, m=m, v=v, c=mcol[m]: CELLS[m](T, c, np.random.default_rng(1000 + MATS.index(m) * 10 + v), v))
            out.append(T)
        T = Tile("t-" + m, G, kind="cap")
        T.make = (lambda T=T, m=m, c=tcol[m]: cap(T, m, c, np.random.default_rng(1080 + MATS.index(m))))
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
        T.make = (lambda T=T, v=v: water_body(T, np.random.default_rng(1100 + v), v))
        out.append(T)
    for f in range(pl.SURF_FRAMES):
        T = Tile("s-water-%d" % f, G, kind="cap", rep=(2, 0))
        T.make = (lambda T=T, f=f: water_surface(T, f))
        out.append(T)
    for kind in PROPS:
        for state in range(3):
            out.append(prop_tile(kind, state))
    for fn in (bg_sun, lambda: bg_cloud(0), lambda: bg_cloud(1), bg_island, bg_sea):
        T = fn()
        if not hasattr(T, "make"):
            T.make = lambda: None
        out.append(T)
    return out
