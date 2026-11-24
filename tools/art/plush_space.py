"""
The space map's plush art (#127), the fourth of the new maps: an asteroid station's terrain, its overlays, its coolant,
its prop skins and its backdrop, all in one atlas (group `level-space`, loaded per match like every theme's). Built with
plush_level.py's helpers (and plush_beach.py's prop plumbing), rendered by plush_world.py (the same camera and lights),
packed by world_pack.py.

Frames (group `level-space`; the theme's atlas is looked in first, so these replace the shared and nature frames):
  c-dirt-<v>, t-dirt          regolith: grey felt dust with stitched little craters and pebbles; a dusty pebbly top
  c-rock-<v>, t-rock          the asteroid rock (the frame): dark lumpy stones with pale mineral flecks
  c-steel-<v>, t-steel        station plating (girders, bulkheads, the catwalk): riveted panels; a yellow hazard lip
  c-concrete-<v>, t-concrete  hull panels: pale plates with a seam and a small green status light
  c-crumble-<v>, t-crumble    rusted grating (it gives way fast): a felt grid with rust patches
  c-ice-<v>, t-ice            ice (in the regolith, the ice ledges): a pale blue glossy block, frost; a frost lip
  c-bedrock-<v>, t-bedrock    bedrock in the station's colors
  k-1-<v>, k-2-<v>            crack stages: tears with grey dust spilling out (in place of the stuffing)
  e-l, e-r, e-b               the carving edges: a dark slate piping
  q-coolant-<v>, s-coolant-<f>  the coolant: glowing cyan with frost flecks, a bright crest and rising bubbles
  p-<prop>-<state>            prop skins (the same props, the same states): crate a cargo pod, barrel a fuel canister
                              (still explosive: a hazard patch), block a stack of hull plates
  bg-planet, bg-station, bg-rock  the backdrop: a ringed planet, a far station with lit windows, a drifting asteroid
                              (the viewer draws the stars itself; no ground band: the void is below)
"""
import math

import numpy as np

import plush_action as pa
import plush_bot as pb
import plush_level as pl
from plush_level import CELL, Tile, backing, blob, felt, hexs, line_pts, shade, soft, thread, vinyl

THEME = "space"
G = "level-" + THEME
MATS = ["dirt", "rock", "steel", "concrete", "crumble", "ice", "bedrock"]
# set by plush_world.py before rendering (as plush_beach.PW)
PW = None


def colors():
    look = pl._TJ["themes"][THEME]
    base = pl._TJ["base"]
    m = {k: look["mat"].get(k, base[k]) for k in MATS}
    t = {k: look["top"].get(k, shade(m[k], 1.35)) for k in MATS}
    return m, t


def glow(col, strength=3.0):
    key = ("space glow", col, strength)
    if key not in pl._MAT:
        inner = hexs(shade(int(col[1:], 16), 1.45))
        pl._MAT[key] = pa.emit_two("Space glow %s %.1f" % (col, strength), inner, col, strength * 0.45)
    return pl._MAT[key]


# ---------------------------------------------------------------- the cells

def cell_regolith(T, col, rng, v):
    """Regolith: the dirt cell in grey, with a stitched little crater or two and grey pebbles."""
    pl.cell_dirt(T, col, rng, v)
    rim = thread(hexs(shade(col, 1.4)))
    for k in range(1 + v):
        x, z = rng.uniform(-0.14, 0.14, 2)
        r = rng.uniform(0.04, 0.06)
        T.stitch([(x + math.cos(a) * r, 0, z + math.sin(a) * r) for a in np.linspace(0, 2 * math.pi, 22)], rim, dash=0.018, gap=0.01, width=0.008, height=0.006)
        T.add(*blob((x, -0.04, z), r * 0.8, 0.006, r * 0.8), felt(shade(col, 0.7), felt=0.6))
    peb = [felt(0x8a8892, felt=0.5), felt(0x5c5a64, felt=0.5)]
    for k in range(3):
        x, z = rng.uniform(-0.22, 0.22, 2)
        r = rng.uniform(0.018, 0.03)
        T.add(*blob((x, -0.052, z), r, r * 0.7, r * 0.8, rot=rng.uniform(0, 3)), peb[k % 2])


def cell_asteroid(T, col, rng, v):
    """Asteroid rock: the rock cell, darker, with pale mineral flecks."""
    pl.cell_rock(T, col, rng, v)
    fleck = felt(0xb8b4c4, felt=0.4)
    for k in range(4 + v):
        x, z = rng.uniform(-0.2, 0.2, 2)
        T.add(*blob((x, -0.06, z), 0.012, 0.006, 0.01, rot=rng.uniform(0, 3)), fleck)


def cell_plating(T, col, rng, v):
    pl.cell_steel(T, col, rng, v)


def cell_hull(T, col, rng, v):
    """Hull panels: the concrete cell as pale plates, a stitched seam across and (v1) a small green status light."""
    pl.cell_concrete(T, col, rng, v)
    seam = thread(hexs(shade(col, 0.55)))
    T.stitch(line_pts((-0.25, 0.0), (0.25, 0.0), 30), seam, dash=0.03, gap=0.01, width=0.01, height=0.006)
    for x in (-0.18, 0.18):
        T.add(*blob((x, -0.05, 0.0), 0.014, 0.01, 0.014), vinyl(0xc0c6d0, rough=0.25, metal=1.0))
    if v == 1:
        T.add(*blob((0.12, -0.055, 0.14), 0.02, 0.012, 0.02), glow("#48ff9a", 2.0))


def cell_grating(T, col, rng, v):
    """Rusted grating: a dark backing under a felt grid of bars, rust patches on it."""
    backing(T, 0x1a1a22)
    bar = felt(col, felt=0.4)
    for k in range(5):
        x = -0.2 + k * 0.1
        T.add(*soft((x, -0.02, 0), 0.016, 0.03, 0.25, p=6.0), bar)
        T.add(*soft((0, -0.03, x), 0.25, 0.03, 0.016, p=6.0), bar)
    rust = felt(0xa0522d, felt=0.6)
    for k in range(2 + v):
        x, z = rng.uniform(-0.18, 0.18, 2)
        T.add(*blob((x, -0.06, z), rng.uniform(0.03, 0.05), 0.006, rng.uniform(0.02, 0.04), rot=rng.uniform(0, 3)), rust)


CELLS = {"dirt": cell_regolith, "rock": cell_asteroid, "steel": cell_plating, "concrete": cell_hull, "crumble": cell_grating,
         "ice": pl.cell_ice, "bedrock": pl.cell_bedrock}


def cap_dust(T, col, rng):
    """Regolith's top: a rolled dusty lip with a row of pebbles sitting on it."""
    top = CELL / 2
    T.size = (CELL, pl.TOP_H)
    T.shift = (0.0, -(top - pl.TOP_H / 2))
    T.rep = (2, 0)
    tv, tf = pa.tube((-0.25, -0.05, top - 0.035), (0.25, -0.05, top - 0.035), [(0.0, 0.03), (1.0, 0.03)], 12)
    T.add(tv, tf, felt(shade(col, 0.85), felt=0.6))
    tones = [felt(col, felt=0.5), felt(shade(col, 1.15), felt=0.5), felt(0x5c5a64, felt=0.5)]
    for k in range(5):
        x = -0.25 + (k + rng.uniform(0.2, 0.8)) * 0.1
        r = rng.uniform(0.02, 0.03)
        T.add(*blob((x, -0.07, top - 0.035 - r * 0.2), r, r * 0.7, r * 0.75, rot=rng.uniform(0, 3)), tones[k % 3])
    return T


def cap_frost(T, col, rng):
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
        return cap_dust(T, col, rng)
    if m == "ice":
        return cap_frost(T, col, rng)
    return pl.cap(T, m, col, rng)


# ---------------------------------------------------------------- overlays

def tears(rng, n, big):
    """The shared tears, with grey dust crumbs spilling out of them."""
    tear = pb.glossy_mat("Space tear %d" % len(pl._MAT), "#0c0c12", rough=0.8, coat=0.0, spec=0.1)
    pl._MAT[("space tear", len(pl._MAT))] = tear
    grit = [felt(0x8a8892, felt=0.6), felt(0x55535e, felt=0.6)]
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
    T.parts += tears(np.random.default_rng(4140 + v), 1, False)
    if stage == 2:
        T.parts += tears(np.random.default_rng(4160 + v), 2, True)
    return T


def edge(T, side):
    r = 0.03
    col = felt(0x34323e)
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


# ---------------------------------------------------------------- the coolant

def coolant_mat():
    key = ("space coolant",)
    if key not in pl._MAT:
        m = pb.glossy_mat("Space coolant", "#2a9ec8", rough=0.2, coat=0.7, spec=0.35)
        p = [n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"][0]
        p.inputs["Alpha"].default_value = 0.72
        p.inputs["Emission Color"].default_value = pb.srgb("#18a8d8")
        p.inputs["Emission Strength"].default_value = 0.45
        pl._MAT[key] = m
    return pl._MAT[key]


def coolant_body(T, rng, v):
    T.add(*pl.slab(-0.25, 0.25, -0.25, lambda x: 0.25), coolant_mat())
    acc = thread("#c8f4ff")
    for z in ((-0.12, 0.08) if v == 0 else (-0.02,)):
        pts = [(-0.25 + t * 0.5, 0, z + 0.015 * math.sin(t * 2 * math.pi * 2)) for t in np.linspace(0, 1, 30)]
        T.stitch(pts, acc, dash=0.04, gap=0.025, width=0.007, height=0.004)
    frost = felt(0xeefcff, felt=0.6)
    for k in range(2 + v):
        x, z = rng.uniform(-0.2, 0.2, 2)
        T.add(*blob((x, -0.036, z), 0.012, 0.006, 0.01, rot=rng.uniform(0, 3)), frost)


def coolant_surface(T, f):
    ph = 2 * math.pi * f / pl.SURF_FRAMES
    k = 2 * math.pi / CELL
    amp = 0.018
    top = lambda x: 0.16 + amp * math.sin(k * x - ph) + amp * 0.4 * math.sin(2 * k * x + 2 * ph + 1.0)
    T.add(*pl.slab(-0.25, 0.25, -0.25, top), coolant_mat())
    xs = np.linspace(-0.25, 0.25, 33)
    pts = [(x, -0.032, top(x) - 0.006) for x in xs]
    cv, cf = pb.sweep(pts, [np.array([0.0, 0.0, 1.0])] * len(pts), pb.circle(0.012, 8), closed=False, cap=False)
    T.add(cv, cf, glow("#8af0ff", 2.0))
    # bubbles rising to the top and popping (each half a loop apart: the tiling stays seamless)
    b = vinyl(0xd8faff, rough=0.15, coat=0.9)
    for x, off in ((-0.12, 0.0), (0.11, 0.5)):
        t = (f / pl.SURF_FRAMES + off) % 1.0
        r = 0.016 + 0.01 * t
        z = -0.15 + t * 0.3
        if z < top(x) - 0.02:
            T.add(*blob((x, -0.035, z), r, r * 0.7, r), b)
    return T


# ---------------------------------------------------------------- prop skins (front space, as plush_world's props)

def _states(Gp):
    damage = set(o for s in Gp.states for o in s)
    base = [o for o in Gp.obs if o not in damage]
    return [(base + extra, [o for o in damage if o not in extra]) for extra in Gp.states]


def prop_pod():
    """A cargo pod (the crate's skin): a rounded pale grey box with orange corner bands, a stitched hatch and a small
    blue status light."""
    M = PW.M
    Gp = PW.Group("p-crate", G)
    hx = hz = 0.4
    d = 0.22
    bv, bf = PW.soft_box((0, 0, 0), hx, d, hz, p=5.0)
    body = Gp.add(PW.mesh("Pod body", bv, bf, felt(0xc8ccd4, felt=0.35)))
    bvh = pb.bvh_of(body)
    band = felt(0xe8782a, felt=0.4)
    for sx in (-1, 1):
        bv, bf = PW.soft_box((sx * (hx - 0.07), -0.01, 0), 0.06, d + 0.012, hz + 0.01, p=5.0)
        Gp.add(PW.mesh("Pod band %d" % sx, bv, bf, band))
    B = pb.Builder()
    PW.stitch_rect(B, bvh, hx - 0.14, hz, -d - 0.05, 0.08, dash=0.04, gap=0.014, width=0.01, height=0.006)
    Gp.add(B.obj("Pod hatch", thread("#6a707c")))
    Gp.add(PW.mesh("Pod light", *blob((0.2, -d - 0.02, 0.25), 0.03, 0.02, 0.03), glow("#4ac8ff", 2.4)))
    Gp.add(PW.mesh("Pod label", *soft((-0.05, -d - 0.012, -0.22), 0.12, 0.006, 0.04, p=4.0), felt(0x2a2e38)))
    PW.damage_objects(Gp, M, hx, hz, -d, 3)
    return Gp


def prop_canister():
    """A fuel canister (the explosive barrel's skin): a white felt cylinder with red bands, a valve on top, and the
    yellow hazard patch (it still blows up)."""
    M = PW.M
    Gp = PW.Group("p-barrel", G)
    hx, hz = 0.34, 0.5
    prof = [(0.0, 0.0), (0.0, hx * 0.9), (0.04, hx), (2 * hz - 0.06, hx), (2 * hz - 0.02, hx * 0.8), (2 * hz, 0.0)]
    v, f = pb.lathe(prof, 48)
    v[:, 1] *= 0.6
    v[:, 2] -= hz
    Gp.add(PW.mesh("Canister body", v, f, felt(0xeef0f4, felt=0.3)))
    red = felt(0xd8322a, felt=0.35)
    for zt in (0.18, 0.82):
        rv, rf = pa.ring((0, 0, zt - hz), (0, 0, 1), hx + 0.012, pb.circle(0.035, 8), 48)
        rv[:, 1] *= 0.6
        Gp.add(PW.mesh("Canister band %.2f" % zt, rv, rf, red))
    tv, tf = pa.tube((0, 0, hz - 0.02), (0, 0, hz + 0.08), [(0.0, 0.05), (1.0, 0.04)], 12)
    Gp.add(PW.mesh("Canister valve", tv, tf, vinyl(0x8a909c, rough=0.3, metal=0.9)))
    y = -hx * 0.6 - 0.014
    tri = [(0.0, 0.13), (0.12, -0.09), (-0.12, -0.09)]
    from mathutils import Matrix
    Gp.add(PW.extrude_poly("Canister hazard", tri, 0.03, M["felt_yellow"], 0.02)).matrix_world = Matrix.Translation((0, y, 0.0))
    mv, mf = PW.soft_box((0, y - 0.03, 0.015), 0.014, 0.01, 0.045, p=3.0)
    Gp.add(PW.mesh("Canister mark", mv, mf, M["black_vinyl"]))
    dv, df = pb.cube_sphere(6)
    Gp.add(PW.mesh("Canister dot", dv * 0.014 + np.array([0, y - 0.03, -0.05]), df, M["black_vinyl"]))
    PW.damage_objects(Gp, M, hx * 0.9, hz, -hx * 0.6, 7)
    return Gp


def prop_plates():
    """Cover (the building block's skin): a stack of hull plates, pale and grey alternating, riveted, a yellow-black
    hazard strip on the top plate."""
    M = PW.M
    Gp = PW.Group("p-block", G)
    hx = hz = 0.45
    d = 0.24
    tones = [felt(0xb8bec8, felt=0.35), felt(0x8a909c, felt=0.35)]
    n = 4
    h = 2 * hz / n
    for k in range(n):
        z = -hz + h * (k + 0.5)
        off = (0.03 if k % 2 else -0.03)
        bv, bf = PW.soft_box((off, 0, z), hx - 0.02, d, h / 2 - 0.01, p=6.0)
        Gp.add(PW.mesh("Plate %d" % k, bv, bf, tones[k % 2]))
        for x in (-hx + 0.08, hx - 0.08):
            Gp.add(PW.mesh("Plate rivet %d %.2f" % (k, x), *blob((x + off, -d - 0.02, z), 0.015, 0.01, 0.015), vinyl(0xd0d4dc, rough=0.2, metal=1.0)))
    zt = hz - h / 2
    for j in range(6):
        x = -hx + 0.1 + j * 0.14
        col = felt(0xe8c44a if j % 2 == 0 else 0x1e1e24, felt=0.35)
        Gp.add(PW.mesh("Plate stripe %d" % j, *soft((x, -d - 0.012, zt), 0.06, 0.006, h / 2 - 0.03, p=4.0), col))
    PW.damage_objects(Gp, M, hx, hz, -d, 5)
    return Gp


PROPS = {"crate": prop_pod, "barrel": prop_canister, "block": prop_plates}


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

def bg_planet():
    """A ringed planet: a felt disc in dusky violet bands, a tilted felt ring around it."""
    T = Tile("bg-planet", G, kind="sprite", rep=(0, 0))
    T.add(*blob((0, 0, 0), 0.5, 0.06, 0.5, n=14), felt(0x6a5a9a, felt=0.3, mottle=(0.92, 1.06)))
    # a storm spot and two stitched cloud bands (felt blobs inside the disc would only peek out as slivers)
    T.add(*blob((0.16, -0.062, -0.12), 0.1, 0.012, 0.06), felt(0x8a7ab8, felt=0.3))
    band = thread("#4e4378")
    for z in (0.18, -0.02):
        hw = math.sqrt(0.5 ** 2 - z ** 2) * 0.92
        T.stitch([(x, 0, z + 0.015 * math.sin(x * 9)) for x in np.linspace(-hw, hw, 40)], band, dash=0.05, gap=0.02, width=0.014, height=0.008)
    rv, rf = pa.ring((0, -0.02, 0), (0, 1, 0.0), 0.78, pb.circle(0.035, 8), 64)
    rv[:, 2] *= 0.22
    ca, sa = math.cos(-0.25), math.sin(-0.25)
    x, z = rv[:, 0].copy(), rv[:, 2].copy()
    rv[:, 0], rv[:, 2] = x * ca - z * sa, x * sa + z * ca
    T.add(rv, rf, felt(0xd8c8a8, felt=0.3))
    T.anchor = (0.0, 0.0, 0.0)
    return T


def bg_station():
    """A far station: a long felt truss with two modules, solar panels and a row of lit windows."""
    T = Tile("bg-station", G, kind="sprite", rep=(0, 0))
    hull = felt(0x5a6070, felt=0.35)
    T.add(*soft((0, 0, 0), 0.7, 0.04, 0.04, p=4.0), hull)
    for x in (-0.35, 0.3):
        T.add(*soft((x, -0.01, 0), 0.14, 0.05, 0.11, p=5.0), felt(0x6a7084, felt=0.35))
        for j in range(4):
            T.add(*blob((x - 0.09 + j * 0.06, -0.065, 0.02), 0.012, 0.008, 0.012), glow("#ffd27a", 2.0))
    panel = felt(0x2a3a6a, felt=0.3)
    for x in (-0.62, 0.62):
        for z in (-0.16, 0.16):
            T.add(*soft((x, 0.0, z), 0.1, 0.01, 0.07, p=3.0), panel)
    T.anchor = (0.0, 0.0, 0.0)
    return T


def bg_rock():
    """A drifting asteroid: a lumpy dark felt rock with a few stitched craters."""
    T = Tile("bg-rock", G, kind="sprite", rep=(0, 0))
    T.add(*blob((0, 0, 0), 0.32, 0.12, 0.24, n=10, rot=0.3), felt(0x4c4856, felt=0.4))
    rim = thread("#6e6a7a")
    for x, z, r in ((-0.1, 0.05, 0.06), (0.12, -0.04, 0.045), (0.02, -0.12, 0.035)):
        T.stitch([(x + math.cos(a) * r, 0, z + math.sin(a) * r) for a in np.linspace(0, 2 * math.pi, 22)], rim, dash=0.02, gap=0.01, width=0.008, height=0.006)
    T.anchor = (0.0, 0.0, 0.0)
    return T


# ---------------------------------------------------------------- every frame

def space_tiles():
    out = []
    mcol, tcol = colors()
    for m in MATS:
        for v in (0, 1):
            T = Tile("c-%s-%d" % (m, v), G)
            T.make = (lambda T=T, m=m, v=v, c=mcol[m]: CELLS[m](T, c, np.random.default_rng(4000 + MATS.index(m) * 10 + v), v))
            out.append(T)
        T = Tile("t-" + m, G, kind="cap")
        T.make = (lambda T=T, m=m, c=tcol[m]: cap(T, m, c, np.random.default_rng(4080 + MATS.index(m))))
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
        T = Tile("q-coolant-%d" % v, G)
        T.make = (lambda T=T, v=v: coolant_body(T, np.random.default_rng(4100 + v), v))
        out.append(T)
    for f in range(pl.SURF_FRAMES):
        T = Tile("s-coolant-%d" % f, G, kind="cap", rep=(2, 0))
        T.make = (lambda T=T, f=f: coolant_surface(T, f))
        out.append(T)
    for kind in PROPS:
        for state in range(3):
            out.append(prop_tile(kind, state))
    for fn in (bg_planet, bg_station, bg_rock):
        T = fn()
        if not hasattr(T, "make"):
            T.make = lambda: None
        out.append(T)
    return out
