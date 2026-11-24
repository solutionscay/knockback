"""
The world's sprites (#87): pickups, props and projectiles in the plush brawler's toy style. Headless Blender.

    tools/art/render-world.sh OUT_DIR      (the one command: renders, then world_pack.py builds the atlases)
    Blender -b --factory-startup --python tools/art/plush_world.py -- --out DIR [--groups pickups,props,projectiles] [--quick]

Same camera and lights as the fighters (plush_bot.camera_rig, the 55 degree three-quarter camera, orthographic, film
transparent). Each model is turned to face the camera, so its front matches the sim's box (a prop is a 2D box) the
way the fighters' heads turn to the camera. Materials and modelling helpers are the fighters' (plush felt with
stitches, glossy vinyl); the 13 weapon icons are the fighters' own weapon models (plush_action.py), off the hand.

Groups and sprites (frame names):
  pickups      w-<weapon> for all 13 weapons; p-<power> for health, shield, speed, heavy, damage, jetpack, jump
  props        crate, block, barrel, tnt, gas (each -0 intact, -1 damaged, -2 nearly broken), steel
  projectiles  rocket, grenade, mine, hook, bolt (pointing screen right: the viewer turns them)
  tiles        chain: one link of the platforms' chains, a seamless vertical tile (exactly one period tall)
  level        the terrain (#92): per theme, every material's cells and top edges; crack, char and edge overlays and
               the chain anchor (plush_level.py). Props (#92) adds the glass pane, the jump pad and the weight.
Per frame it writes meta.json: the size in pixels, the pixels per game meter, and the anchor (the pixel of the
model's center: the sim body's center for props, the middle for the rest).
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plush_action as pa  # noqa: E402
import plush_bot as pb  # noqa: E402
import plush_level as pl  # noqa: E402

ANGLE = pa.ANGLE
ELEV = 0.18
PPM = {"pickups": 100.0, "props": 80.0, "projectiles": 80.0, "tiles": 200.0, "level": pl.PPM}
CHAIN_W, CHAIN_P = 0.14, 0.32  # the chain tile: its width and its period (one link) in game meters (chains.ts)
ICON_M = 0.88  # a pickup icon fits this many game meters (the badge is 1.12 m across)
WEAPONS = ["rocket", "bat", "rifle", "shotgun", "sniper", "crossbow", "railgun", "hammer", "flamethrower", "lightning",
           "grenade", "mine", "grapple"]
POWERS = ["health", "shield", "speed", "heavy", "damage", "jetpack", "jump"]

# camera directions (world): toward the camera, screen right, up
_az = math.radians(ANGLE)
TOWARD = Vector((-math.sin(_az), -math.cos(_az), 0.0))
RIGHT = Vector((math.cos(_az), -math.sin(_az), 0.0))
UP = Vector((0.0, 0.0, 1.0))
# "icon space" (x toward the camera, y screen right, z up) -> world
PLACE = Matrix(((TOWARD.x, RIGHT.x, UP.x, 0), (TOWARD.y, RIGHT.y, UP.y, 0), (TOWARD.z, RIGHT.z, UP.z, 0), (0, 0, 0, 1)))
# "front space" (x screen right, -y toward the camera, z up: how props and toys are modelled) -> world
FRONT = Matrix(((RIGHT.x, -TOWARD.x, 0, 0), (RIGHT.y, -TOWARD.y, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))


def mats():
    return dict(
        felt_tan=pb.fabric_mat("World tan felt", "#c99a5c", rough=0.9, sheen=0.8, fuzz_bump=0.3, felt=0.25),
        felt_wood=pb.fabric_mat("World wood felt", "#b07a44", rough=0.9, sheen=0.7, fuzz_bump=0.3, felt=0.25),
        felt_dark=pb.fabric_mat("World dark felt", "#6b4221", rough=0.9, sheen=0.6, fuzz_bump=0.25, felt=0.2),
        felt_red=pb.fabric_mat("World red felt", "#d8342c", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        felt_blue=pb.fabric_mat("World blue felt", "#2f8fc0", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        felt_yellow=pb.fabric_mat("World yellow felt", "#f2be1e", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        felt_slate=pb.fabric_mat("World slate felt", "#5a6a8a", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        felt_crimson=pb.fabric_mat("World crimson felt", "#c8102a", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        felt_teal=pb.fabric_mat("World teal felt", "#168778", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        felt_white=pb.fabric_mat("World white felt", "#f4efe4", rough=0.92, sheen=1.0, fuzz_bump=0.35, felt=0.3),
        stuffing=pb.fabric_mat("World stuffing", "#f6efe0", rough=0.95, sheen=1.0, fuzz_bump=0.8, felt=0.7),
        tear=pb.glossy_mat("World tear", "#2a1a10", rough=0.8, coat=0.0, spec=0.1),
        thread=pb.fabric_mat("World thread", pb.THREAD, rough=0.7, sheen=0.5, fuzz_bump=0.1, felt=0.0, sss=0.0),
        dark_thread=pb.fabric_mat("World dark thread", "#3a2410", rough=0.7, sheen=0.5, fuzz_bump=0.1, felt=0.0, sss=0.0),
        steel=pb.glossy_mat("World steel", "#6a7180", rough=0.3, coat=0.7, metal=0.6, spec=0.6),
        steel_dark=pb.glossy_mat("World steel dark", "#3f444e", rough=0.35, coat=0.5, metal=0.6, spec=0.5),
        rivet=pb.glossy_mat("World rivet", "#c3c9d2", rough=0.2, coat=0.5, metal=1.0),
        red_vinyl=pb.glossy_mat("World red vinyl", "#d9342b", rough=0.22, coat=1.0, spec=0.6),
        dark_red_vinyl=pb.glossy_mat("World dark red vinyl", "#8e1d17", rough=0.3, coat=0.8, spec=0.5),
        yellow_vinyl=pb.glossy_mat("World yellow vinyl", "#ffd23a", rough=0.22, coat=1.0, spec=0.6),
        black_vinyl=pb.glossy_mat("World black vinyl", "#1c1e24", rough=0.3, coat=1.0, spec=0.5),
        blue_vinyl=pb.glossy_mat("World blue vinyl", "#5fb7e5", rough=0.22, coat=1.0, spec=0.6),
        white_vinyl=pb.glossy_mat("World white vinyl", "#f2f2f2", rough=0.25, coat=1.0, spec=0.6),
        iron=pb.glossy_mat("World iron", "#3a3e48", rough=0.35, coat=0.6, metal=0.4, spec=0.5),
        gold=pb.glossy_mat("World gold", pb.GOLD, rough=0.22, coat=0.8, metal=0.55, spec=0.6),
        flame=pa.emit_two("World flame", "#fff0c0", "#ff7a1a", 14.0),
        cream=pb.fabric_mat("World cream", "#efe2c4", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.25),
        green_vinyl=pb.glossy_mat("World green vinyl", "#62c43c", rough=0.22, coat=1.0, spec=0.6),
        olive=pb.fabric_mat("World olive", "#6f8a3c", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        pink=pb.fabric_mat("World pink", "#e8649e", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        mine_light=pb.emit_mat("World mine light", "#ff7cc0", 8.0),
        gunmetal=pb.glossy_mat("World gunmetal", "#2e333d", rough=0.18, coat=1.0, metal=0.3, spec=0.6),
        chain=pb.glossy_mat("World chain", "#9a9eaa", rough=0.3, coat=0.8, metal=0.5, spec=0.6),
    )


class Group:
    """One sprite's objects (in front space while built; placed into the world facing the camera)."""

    def __init__(self, name, group, space="front"):
        self.name, self.group, self.space = name, group, space
        self.obs = []
        self.states = None  # props: per damage state, the extra objects shown

    def add(self, ob):
        if ob is not None:
            self.obs.append(ob)
        return ob


def mesh(name, v, f, mat, smooth=True):
    return pb.mesh_obj(name, np.asarray(v, float), f, mat, smooth=smooth)


def soft_box(c, hx, hy, hz, p=4.0, n=20):
    return pb.superellipsoid(n, c, hx, hy, hy, hz, hz, p=p, q=p)


def stitch_rect(B, bvh, hx, hz, y, inset, **kw):
    """Stitches around a rectangle on a front face (y: just in front of it; snapped to the surface)."""
    x0, x1, z0, z1 = -hx + inset, hx - inset, -hz + inset, hz - inset
    pts = []
    for (ax, az), (bx, bz) in (((x0, z0), (x1, z0)), ((x1, z0), (x1, z1)), ((x1, z1), (x0, z1)), ((x0, z1), (x0, z0))):
        for t in np.linspace(0, 1, 40, endpoint=False):
            pts.append((ax + (bx - ax) * t, y, az + (bz - az) * t))
    pb.stitch_path(B, pts, pb.surf_fn(bvh, 0.3), closed=True, **kw)


def stitch_line(B, bvh, a, b, n=50, **kw):
    pts = [tuple(np.asarray(a) + (np.asarray(b) - np.asarray(a)) * (i / n)) for i in range(n + 1)]
    pb.stitch_path(B, pts, pb.surf_fn(bvh, 0.3), **kw)


def extrude_poly(name, pts, depth, mat, bevel=0.035):
    """A plush shape: a 2D outline (x right, z up) extruded toward -y and +y, its edges rounded."""
    import bmesh
    bm = bmesh.new()
    top = [bm.verts.new((x, -depth / 2, z)) for x, z in pts]
    face = bm.faces.new(top)
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    nv = [e for e in ext["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=nv, vec=(0, depth, 0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=4, affect="EDGES", profile=0.7)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    pb.link(ob)
    me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    return ob


# ---------------------------------------------------------------- damage (props)

def damage_objects(G, M, hx, hz, y_front, seed):
    """Two damage states for a destructible prop's front: tears in the felt with stuffing poking out."""
    rng = np.random.default_rng(seed)
    states = [[], [], []]
    v, f = pb.cube_sphere(8)
    tears = [(-0.35, 0.3, 0.6, 30), (0.3, -0.25, 0.5, -40), (0.05, 0.05, 0.45, 70), (-0.2, -0.45, 0.4, -10)]
    for k, (tx, tz, ln, ang) in enumerate(tears):
        level = 1 if k < 2 else 2
        cx, cz = tx * hx, tz * hz
        a = math.radians(ang)
        R = np.array([[math.cos(a), 0, -math.sin(a)], [0, 1, 0], [math.sin(a), 0, math.cos(a)]])
        L = ln * min(hx, hz)
        tv = (v * np.array([L * 0.5, 0.03, 0.035])) @ R.T + np.array([cx, y_front - 0.005, cz])
        tear = mesh(f"{G.name} tear {k}", tv, f, M["tear"])
        G.add(tear)
        puffs = []
        for j in range(3 if level == 1 else 4):
            off = (rng.uniform(-0.4, 0.4) * L, rng.uniform(-0.06, 0.06) * L)
            r = rng.uniform(0.045, 0.075) * (1.2 if level == 2 else 1.0)
            pv = v * r + np.array([cx + off[0], y_front - r * 0.5, cz + off[1]])
            puffs.append(G.add(mesh(f"{G.name} stuffing {k}.{j}", pv, f, M["stuffing"])))
        for s in range(level, 3):
            states[s] += [tear] + puffs
    G.states = states


# ---------------------------------------------------------------- props (front space: x right, -y the front, z up)

def prop_crate(M):
    """A plush supply crate: tan felt planks, a darker felt X brace, stitched edges, the yellow '!' patch."""
    G = Group("crate", "props")
    hx = hz = 0.4
    d = 0.22
    bv, bf = soft_box((0, 0, 0), hx, d, hz, p=5.0)
    body = G.add(mesh("Crate body", bv, bf, M["felt_wood"]))
    bvh = pb.bvh_of(body)
    B = pb.Builder()
    stitch_rect(B, bvh, hx, hz, -d - 0.05, 0.05, dash=0.03, gap=0.02, width=0.012, height=0.008)
    for z in (-0.13, 0.13):
        stitch_line(B, bvh, (-hx + 0.06, -d - 0.05, z), (hx - 0.06, -d - 0.05, z), dash=0.03, gap=0.02, width=0.01, height=0.007)
    for sx in (1, -1):
        sv, sf = pa.tube((sx * -0.3, -d - 0.005, -0.3), (sx * 0.3, -d - 0.005, 0.3), [(0.0, 0.045), (1.0, 0.045)], 12)
        sv[:, 1] = np.minimum(sv[:, 1], -d + 0.01)
        G.add(mesh(f"Crate brace {sx}", sv, sf, M["felt_dark"]))
    pv, pf = soft_box((0, -d - 0.02, 0), 0.14, 0.02, 0.14, p=3.0)
    G.add(mesh("Crate patch", pv, pf, M["felt_yellow"]))
    ev, ef = soft_box((0, -d - 0.045, 0.025), 0.022, 0.01, 0.065, p=3.0)
    G.add(mesh("Crate bang", ev, ef, M["black_vinyl"]))
    dv, df = pb.cube_sphere(6)
    G.add(mesh("Crate dot", dv * 0.022 + np.array([0, -d - 0.045, -0.075]), df, M["black_vinyl"]))
    G.add(B.obj("Crate stitches", M["dark_thread"]))
    damage_objects(G, M, hx, hz, -d, 3)
    return G


def prop_block(M):
    """A plush building block: a soft tan felt cube with a stitched border and a darker base band."""
    G = Group("block", "props")
    hx = hz = 0.45
    d = 0.24
    bv, bf = soft_box((0, 0, 0), hx, d, hz, p=4.5)
    body = G.add(mesh("Block body", bv, bf, M["felt_tan"]))
    bvh = pb.bvh_of(body)
    B = pb.Builder()
    stitch_rect(B, bvh, hx, hz, -d - 0.05, 0.06, dash=0.032, gap=0.02, width=0.012, height=0.008)
    stitch_rect(B, bvh, hx, hz, -d - 0.05, 0.16, dash=0.028, gap=0.02, width=0.01, height=0.007)
    av, af = soft_box((0, 0, -hz + 0.07), hx * 0.97, d * 1.02, 0.07, p=4.0)
    G.add(mesh("Block band", av, af, M["felt_dark"]))
    G.add(B.obj("Block stitches", M["dark_thread"]))
    damage_objects(G, M, hx, hz, -d, 5)
    return G


def prop_steel(M):
    """A metal box: glossy steel panels, a darker X brace and silver rivets (it never breaks)."""
    G = Group("steel", "props")
    hx = hz = 0.5
    d = 0.26
    bv, bf = soft_box((0, 0, 0), hx, d, hz, p=7.0)
    G.add(mesh("Steel body", bv, bf, M["steel"]))
    for sx in (1, -1):
        sv, sf = pa.tube((sx * -0.4, -d - 0.01, -0.4), (sx * 0.4, -d - 0.01, 0.4), [(0.0, 0.05), (1.0, 0.05)], 12)
        G.add(mesh(f"Steel brace {sx}", sv, sf, M["steel_dark"]))
    fv, ff = soft_box((0, -d - 0.004, 0), hx * 0.92, 0.01, hz * 0.92, p=8.0)
    rv, rf = pb.cube_sphere(6)
    for x, z in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        G.add(mesh(f"Steel rivet {x}{z}", rv * 0.045 + np.array([x * (hx - 0.1), -d - 0.02, z * (hz - 0.1)]), rf, M["rivet"]))
    return G


def prop_barrel(M):
    """An explosive barrel: glossy red vinyl with dark ribs, a yellow hazard patch with a black mark."""
    G = Group("barrel", "props")
    hx, hz = 0.34, 0.5
    prof = [(0.0, 0.0), (0.0, hx * 0.92), (0.04, hx), (2 * hz - 0.04, hx), (2 * hz, hx * 0.92), (2 * hz, 0.0)]
    v, f = pb.lathe(prof, 48)
    v[:, 1] *= 0.55  # a shallow barrel: its front matches the sim's box
    v[:, 2] -= hz
    body = G.add(mesh("Barrel body", v, f, M["red_vinyl"]))
    for z in (-hz * 0.55, hz * 0.45):
        rv, rf = pb.lathe([(0, 0), (0, hx + 0.012), (0.07, hx + 0.012), (0.07, 0)], 48)
        rv[:, 1] *= 0.56
        rv[:, 2] += z - 0.035
        G.add(mesh(f"Barrel rib {z:.2f}", rv, rf, M["dark_red_vinyl"]))
    y = -hx * 0.55 - 0.012
    tri = [(0.0, 0.17), (0.16, -0.12), (-0.16, -0.12)]
    G.add(extrude_poly("Barrel hazard", tri, 0.03, M["felt_yellow"], 0.02)).matrix_world = Matrix.Translation((0, y, 0.0))
    mv, mf = soft_box((0, y - 0.03, 0.02), 0.018, 0.012, 0.06, p=3.0)
    G.add(mesh("Barrel mark", mv, mf, M["black_vinyl"]))
    dv, df = pb.cube_sphere(6)
    G.add(mesh("Barrel dot", dv * 0.018 + np.array([0, y - 0.03, -0.065]), df, M["black_vinyl"]))
    damage_objects(G, M, hx * 0.9, hz, -hx * 0.55, 7)
    return G


def prop_tnt(M):
    """A TNT bundle: three red felt sticks with a black band (the burning fuse is drawn by the game)."""
    G = Group("tnt", "props")
    hx, hz = 0.4, 0.3
    for i in (-1, 0, 1):
        v, f = pb.lathe([(0, 0), (0, 0.115), (2 * hz - 0.02, 0.115), (2 * hz, 0.09), (2 * hz, 0)], 32)
        v[:, 2] -= hz
        v[:, 0] += i * 0.26
        v[:, 1] += 0.0 if i == 0 else 0.04
        G.add(mesh(f"TNT stick {i}", v, f, M["felt_red"]))
    bv, bf = soft_box((0, -0.02, 0), hx, 0.13, 0.07, p=4.0)
    G.add(mesh("TNT band", bv, bf, M["black_vinyl"]))
    damage_objects(G, M, hx, hz, -0.12, 9)
    return G


def prop_gas(M):
    """A gas canister: glossy blue vinyl capsule, a white band, a dark valve on top."""
    G = Group("gas", "props")
    hx, hz = 0.22, 0.55
    prof = [(0.0, 0.0), (0.0, hx * 0.5), (0.06, hx * 0.92), (0.14, hx), (2 * hz - 0.14, hx), (2 * hz - 0.06, hx * 0.92), (2 * hz, hx * 0.5), (2 * hz, 0)]
    v, f = pb.lathe(prof, 40)
    v[:, 2] -= hz
    G.add(mesh("Gas body", v, f, M["blue_vinyl"]))
    bv, bf = pb.lathe([(0, 0), (0, hx + 0.01), (0.16, hx + 0.01), (0.16, 0)], 40)
    bv[:, 2] += -hz * 0.25 - 0.08
    G.add(mesh("Gas band", bv, bf, M["white_vinyl"]))
    vv, vf = pb.lathe([(0, 0), (0, 0.07), (0.12, 0.07), (0.12, 0)], 20)
    vv[:, 2] += hz - 0.02
    G.add(mesh("Gas valve", vv, vf, M["iron"]))
    hv, hf = soft_box((0, 0, hz + 0.12), 0.12, 0.03, 0.025, p=3.0)
    G.add(mesh("Gas handle", hv, hf, M["iron"]))
    damage_objects(G, M, hx, hz * 0.8, -hx, 11)
    return G


# ---------------------------------------------------------------- power-up toys (front space)

def plus_pts(a, b):
    return [(-a, -b), (a, -b), (a, -a), (b, -a), (b, a), (a, a), (a, b), (-a, b), (-a, a), (-b, a), (-b, -a), (-a, -a)]


def toy_outline(G, M, pts, depth, mat, name, stitch=True):
    ob = G.add(extrude_poly(name, pts, depth, mat))
    if stitch:
        bvh = pb.bvh_of(ob)
        B = pb.Builder()
        P = np.array(pts, float)
        c = P.mean(0)
        inner = c + (P - c) * 0.8
        loop = [tuple((x, -1.0, z)) for x, z in pb.resample(np.vstack([inner, inner[:1]]), 0.012)]
        pb.stitch_path(B, loop, pb.surf_fn(bvh, 1.2), closed=True, dash=0.026, gap=0.016, width=0.01, height=0.007)
        G.add(B.obj(name + " stitches", M["thread"]))
    return ob


def power_toys(M):
    out = []
    G = Group("p-health", "pickups")
    toy_outline(G, M, plus_pts(0.1, 0.3), 0.16, M["felt_red"], "Health cross")
    out.append(G)
    G = Group("p-shield", "pickups")
    toy_outline(G, M, [(0, 0.34), (0.28, 0.22), (0.25, -0.05), (0, -0.34), (-0.25, -0.05), (-0.28, 0.22)], 0.14, M["felt_blue"], "Shield")
    sv, sf = soft_box((0, -0.09, 0.06), 0.09, 0.02, 0.09, p=2.0)
    G.add(mesh("Shield boss", sv, sf, M["white_vinyl"]))
    out.append(G)
    G = Group("p-speed", "pickups")
    toy_outline(G, M, [(0.07, 0.34), (-0.21, -0.02), (0.0, -0.02), (-0.09, -0.34), (0.23, 0.05), (0.02, 0.05)], 0.14, M["felt_yellow"], "Speed bolt")
    out.append(G)
    G = Group("p-heavy", "pickups")
    v, f = pb.cube_sphere(14)
    G.add(mesh("Kettlebell", v * np.array([0.25, 0.22, 0.24]) + np.array([0, 0, -0.08]), f, M["iron"]))
    hv, hf = pa.ring((0, 0, 0.17), (0, 1, 0), 0.13, pb.circle(0.045, 12), 40)
    G.add(mesh("Kettlebell handle", hv, hf, M["iron"]))
    lv, lf = soft_box((0, -0.22, -0.08), 0.1, 0.02, 0.05, p=3.0)
    G.add(mesh("Kettlebell label", lv, lf, M["felt_yellow"]))
    out.append(G)
    G = Group("p-damage", "pickups")
    v, f = pb.cube_sphere(14)
    G.add(mesh("Glove fist", v * np.array([0.25, 0.2, 0.22]) + np.array([0.04, 0, 0.06]), f, M["felt_crimson"]))
    G.add(mesh("Glove thumb", v * np.array([0.09, 0.08, 0.13]) + np.array([-0.12, -0.13, 0.0]), f, M["felt_crimson"]))
    cv, cf = pa.tube((0.02, 0, -0.3), (0.02, 0, -0.1), [(0.0, 0.16), (1.0, 0.18)], 32)
    G.add(mesh("Glove cuff", cv, cf, M["felt_white"]))
    out.append(G)
    G = Group("p-jetpack", "pickups")
    for x in (-0.11, 0.11):
        v, f = pb.lathe([(0, 0), (0, 0.06), (0.04, 0.095), (0.4, 0.095), (0.46, 0.06), (0.46, 0)], 24)
        v[:, 0] += x
        v[:, 2] -= 0.18
        G.add(mesh(f"Jetpack tank {x}", v, f, M["felt_teal"]))
        fv, ff = pa.tube((x, 0, -0.2), (x, 0, -0.38), [(0.0, 0.06), (1.0, 0.004)], 16)
        G.add(mesh(f"Jetpack flame {x}", fv, ff, M["flame"]))
    bv, bf = soft_box((0, 0.04, 0.05), 0.2, 0.05, 0.15, p=3.0)
    G.add(mesh("Jetpack harness", bv, bf, M["black_vinyl"]))
    out.append(G)
    G = Group("p-jump", "pickups")
    toy_outline(G, M, [(0, 0.34), (0.28, 0.02), (0.1, 0.02), (0.1, -0.32), (-0.1, -0.32), (-0.1, 0.02), (-0.28, 0.02)], 0.14, M["felt_slate"], "Jump arrow")
    out.append(G)
    return out


# ---------------------------------------------------------------- projectiles (icon space: y screen right, z up)

def projectiles(M, weapons):
    out = []
    G = Group("rocket", "projectiles", space="icon")
    v, f = pa.tube((0, -0.42, 0), (0, 0.3, 0), [(0.0, 0.1), (1.0, 0.1)], 32)
    G.add(mesh("Rocket body", v, f, M["cream"]))
    v, f = pa.tube((0, 0.3, 0), (0, 0.55, 0), [(0.0, 0.1), (0.5, 0.075), (1.0, 0.004)], 32)
    G.add(mesh("Rocket nose", v, f, M["red_vinyl"]))
    v, f = pa.tube((0, 0.1, 0), (0, 0.17, 0), [(0.0, 0.104), (1.0, 0.104)], 32)
    G.add(mesh("Rocket band", v, f, M["yellow_vinyl"]))
    for k in range(3):
        a = math.pi / 2 + 2 * math.pi * k / 3  # one fin up, two down to the sides (none points at the camera)
        d = np.array([math.cos(a) * 0.5, 0, math.sin(a)])
        fv, ff = soft_box(tuple(np.array([0, -0.4, 0]) + d * 0.13), 0.012 + 0.07 * abs(d[0]), 0.08, 0.012 + 0.07 * abs(d[2]), p=3.0)
        G.add(mesh(f"Rocket fin {k}", fv, ff, M["red_vinyl"]))
    out.append(G)
    # the grenade, the mine, the hook and the bolt are copies of the fighters' weapon parts (the same toy line; the
    # pickups take the originals)
    def pick(w, pre):
        out = []
        for o in weapons[w].parts:
            if o and o.name.startswith(pre):
                c = o.copy()
                o.users_collection[0].objects.link(c)
                out.append(c)
        return out
    out.append(("grenade", pick("grenade", ("Grenade body", "Grenade top", "Grenade lever", "Grenade pin", "Grenade stitches")), 0.44))
    out.append(("mine", pick("mine", ("Mine body", "Mine dome", "Mine button", "Mine stud", "Mine stitches")), 0.6))
    out.append(("hook", pick("grapple", ("Grapple hook", "Grapple prong")), 0.42))
    out.append(("bolt", pick("crossbow", ("Crossbow bolt", "Crossbow fletch")), 0.62))
    return out


# ---------------------------------------------------------------- tiles (front space)

def chain_tile(M):
    """Chain links, face-on and edge-on in turn, one face-on link per period; copies above and below so the
    frame's top and bottom cut through the edge-on links the same way (the tile repeats)."""
    G = Group("chain", "tiles")
    per = CHAIN_P / math.cos(ELEV)  # the camera looks down ELEV: a world period this long is CHAIN_P on screen
    prof = pb.circle(0.017, 12)
    for k in range(-2, 3):
        v, f = pa.ring((0, 0, 0), (0, 1, 0), 0.042, prof, 40)
        v[:, 2] *= 2.55
        v[:, 2] += k * per
        G.add(mesh(f"Chain face {k}", v, f, M["chain"]))
        v, f = pa.ring((0, 0, 0), (1, 0, 0), 0.042, prof, 40)
        v[:, 2] *= 2.55
        v[:, 2] += (k + 0.5) * per
        G.add(mesh(f"Chain edge {k}", v, f, M["chain"]))
    return G


def render_tile(sc, name, obs, ppm, out_dir, w_m, h_m):
    """Render exactly w_m by h_m (screen meters) around the origin: a tile that repeats with no seam."""
    for o in sc.objects:
        if o.type == "MESH":
            o.hide_render = o not in obs
    cam = aim_camera(sc, Vector((0, 0, 0)), 1.0)
    W, H = int(round(w_m * ppm)), int(round(h_m * ppm))
    sc.render.resolution_x, sc.render.resolution_y = W, H
    cam.data.ortho_scale = max(W, H) / ppm
    bpy.context.view_layer.update()
    sc.render.filepath = os.path.join(out_dir, name + ".png")
    bpy.ops.render.render(write_still=True)
    return {"w": W, "h": H, "ppm": ppm, "ax": W / 2, "ay": 0, "tile": True}


# ---------------------------------------------------------------- placing and rendering

def weapon_space(ob, wf):
    """A weapon part's matrix in its mitt frame (plush_action WFrame: y forward along the barrel, z up)."""
    return wf.M.inverted() @ ob.matrix_basis


def detach(obs, wf):
    """Take weapon parts off the hand: their mitt-frame matrices, unparented (placed later)."""
    out = []
    for ob in obs:
        if ob.parent_type != "BONE":
            continue
        m = weapon_space(ob, wf)
        ob.parent = None
        ob.matrix_world = m
        out.append(ob)
    return out


def world_bbox(obs):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for ob in obs:
        oe = ob.evaluated_get(dg)
        me = oe.to_mesh()
        pts += [oe.matrix_world @ v.co for v in me.vertices]
        oe.to_mesh_clear()
    P = np.array([tuple(p) for p in pts])
    return P


def place(obs, base, scale=1.0, tilt=0.0):
    """Move a group (its current matrices in front or icon space) into the world facing the camera, centered."""
    T = Matrix.Rotation(math.radians(tilt), 4, "X") if tilt else Matrix.Identity(4)
    for ob in obs:
        ob.matrix_world = base @ Matrix.Scale(scale, 4) @ T @ ob.matrix_world
    bpy.context.view_layer.update()


def project(sc, cam, P):
    q = [world_to_camera_view(sc, cam, Vector(p)) for p in P]
    return np.array([(v.x, v.y) for v in q])


def aim_camera(sc, center, extent_m):
    rig, cam, tgt = sc.objects["CamRig"], sc.objects["Cam"], sc.objects["CamTarget"]
    rig.rotation_euler = (0, 0, -math.radians(ANGLE))
    rig.location = Vector(center)
    tgt.location = Vector(center)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = extent_m
    d = 12.0
    cam.location = (0, -d * math.cos(ELEV), d * math.sin(ELEV))
    bpy.context.view_layer.update()
    return cam


def render_sprite(sc, name, obs, ppm, out_dir, anchor_world, margin_px=6):
    """Frame the objects (orthographic, the fighters' camera), render to name.png, return the frame's metadata."""
    for o in sc.objects:
        if o.type == "MESH":
            o.hide_render = o not in obs
    P = world_bbox(obs)
    lo, hi = P.min(0), P.max(0)
    center = (lo + hi) / 2
    big = float(np.linalg.norm(hi - lo)) * 1.2 + 0.1
    cam = aim_camera(sc, center, big)
    sc.render.resolution_x = sc.render.resolution_y = 64
    bpy.context.view_layer.update()
    uv = project(sc, cam, P)
    (u0, v0), (u1, v1) = uv.min(0), uv.max(0)
    # shrink the view to the projected box, keep ppm: the ortho scale spans the larger side of the frame
    w_m, h_m = (u1 - u0) * big, (v1 - v0) * big
    mid_u, mid_v = (u0 + u1) / 2 - 0.5, (v0 + v1) / 2 - 0.5
    # shift the camera so the box is centered: move along the camera's right and up by the uv offset
    cam_right = RIGHT
    cam_up = (cam.matrix_world.to_3x3() @ Vector((0, 1, 0))).normalized()
    shift = cam_right * (mid_u * big) + cam_up * (mid_v * big)
    aim_camera(sc, Vector(center) + shift, 1.0)
    W = int(math.ceil(w_m * ppm)) + 2 * margin_px
    H = int(math.ceil(h_m * ppm)) + 2 * margin_px
    sc.render.resolution_x, sc.render.resolution_y = W, H
    cam.data.ortho_scale = max(W, H) / ppm
    bpy.context.view_layer.update()
    a = world_to_camera_view(sc, cam, Vector(anchor_world))
    sc.render.filepath = os.path.join(out_dir, name + ".png")
    bpy.ops.render.render(write_still=True)
    return {"w": W, "h": H, "ppm": ppm, "ax": round(a.x * W, 2), "ay": round((1 - a.y) * H, 2)}


def render_level(sc, out, meta, meta_path, themes, common, only):
    """The terrain frames (#92), one at a time: build, render, delete (they are many, and only one is ever seen).
    Tiles are framed exactly (render_tile); their anchor is the top-left corner. `tile` says which way the frame
    repeats (xy: a cell, x: a top or bottom edge, y: a side edge), for world_pack.py's edge padding."""
    times = []
    for T in pl.level_tiles(themes, common):
        if only and T.name not in only:
            continue
        t = time.time()
        T.make()
        T.build()
        place(T.obs, FRONT)
        d = os.path.join(out, T.group)
        os.makedirs(d, exist_ok=True)
        if T.kind == "sprite":
            fm = render_sprite(sc, T.name, T.obs, pl.PPM, d, tuple(FRONT @ Vector(T.anchor)))
        else:
            fm = render_tile(sc, T.name, T.obs, pl.PPM, d, T.size[0], T.size[1])
            fm.update(ax=0, ay=0, tile={"cell": "xy", "cap": "x", "overlay": ""}.get(T.kind, "x" if T.name == "e-b" else "y"))
        fm["group"] = T.group
        meta["frames"][T.name if T.group == "level" else T.group[6:] + ":" + T.name] = fm
        json.dump(meta, open(meta_path, "w"), indent=1)
        for ob in T.obs:
            me = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.meshes.remove(me)
        times.append((T.group + "/" + T.name, time.time() - t))
        print("SPRITE %s/%s %dx%d %.1fs" % (T.group, T.name, fm["w"], fm["h"], time.time() - t), flush=True)
    return times


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--groups", default="pickups,props,projectiles")
    ap.add_argument("--only", default="", help="frame names (comma list)")
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--themes", default=",".join(pl.THEMES + ["beach", "forest", "cave", "space"]), help="level: the themes to render (nature: the #94 materials and liquids; beach: #111; forest: #114; cave: #125; space: #127)")
    ap.add_argument("--no-common", action="store_true", help="level: skip the shared overlays")
    a = ap.parse_args(argv)
    t0 = time.time()
    pa.SPRITE = True
    pb.QUICK = a.quick
    sc, ch, weapons = pa.build(hair=False)
    pb.lite_video()
    sc.cycles.samples = 8 if a.quick else a.samples
    sc.render.resolution_percentage = 100
    sc.objects["Floor"].hide_render = True
    for ob in sc.objects:  # nothing keyed: this script places and shows every object itself
        if ob.type != "ARMATURE" and ob.animation_data:
            ob.animation_data_clear()
        ob.hide_viewport = False
    sc.frame_set(1)
    bpy.context.view_layer.update()
    M = mats()
    groups = [s for s in a.groups.split(",") if s]
    only = set(s for s in a.only.split(",") if s)
    out = os.path.abspath(os.path.join(a.out, "world"))
    meta_path = os.path.join(out, "meta.json")
    os.makedirs(out, exist_ok=True)
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {"frames": {}}
    jobs = []  # (frame name, group, objects, ppm, anchor point, per-state objects or None)
    proj = projectiles(M, weapons) if "projectiles" in groups else []  # copies weapon parts: before the pickups
    if "pickups" in groups:
        for w in WEAPONS:
            W = weapons[w]
            parts = [o for o in W.parts if o and o.type == "MESH" and "cup" not in o.name.lower()]
            parts = detach(parts, W.wf)
            P = world_bbox(parts)
            ext = float(max(P.max(0) - P.min(0)))
            place(parts, PLACE, scale=ICON_M / ext * 0.95, tilt=24.0 if w not in ("grenade", "mine") else 0.0)
            jobs.append(("w-" + w, "pickups", parts, PPM["pickups"], None, None))
        for G in power_toys(M):
            P = world_bbox(G.obs)
            ext = float(max(P.max(0) - P.min(0)))
            place(G.obs, FRONT, scale=ICON_M / ext * 0.95)
            jobs.append((G.name, "pickups", G.obs, PPM["pickups"], None, None))
    if "props" in groups:
        import types
        pw = types.SimpleNamespace(Group=Group, mesh=mesh, soft_box=soft_box, extrude_poly=extrude_poly, stitch_line=stitch_line, stitch_rect=stitch_rect)
        level_props = [lambda M, f=f: f(pw, M) for f in (pl.prop_glass, pl.prop_pad, pl.prop_weight)]
        for fn in (prop_crate, prop_block, prop_barrel, prop_tnt, prop_gas, prop_steel, *level_props):
            G = fn(M)
            place(G.obs, FRONT)
            origin = FRONT @ Vector((0, 0, 0))
            if G.states:
                damage = set(o for s in G.states for o in s)
                base = [o for o in G.obs if o not in damage]
                for k, extra in enumerate(G.states):
                    jobs.append((f"{G.name}-{k}", "props", base + extra, PPM["props"], origin, None))
            else:
                jobs.append((G.name, "props", G.obs, PPM["props"], origin, None))
    if "projectiles" in groups:
        for item in proj:
            if isinstance(item, Group):
                place(item.obs, PLACE)
                jobs.append((item.name, "projectiles", item.obs, PPM["projectiles"], None, None))
            else:
                name, parts, size = item
                parts = detach(parts, weapons[{"grenade": "grenade", "mine": "mine", "hook": "grapple", "bolt": "crossbow"}[name]].wf)
                P = world_bbox(parts)
                ext = float(max(P.max(0) - P.min(0)))
                place(parts, PLACE, scale=size / ext)
                jobs.append((name, "projectiles", parts, PPM["projectiles"], None, None))
    if "tiles" in groups:
        G = chain_tile(M)
        place(G.obs, FRONT)
        jobs.append((G.name, "tiles", G.obs, PPM["tiles"], "tile", None))
    # everything is placed at the origin: spread the groups apart so a framing never sees another's objects
    every = set()
    for k, (name, group, obs, ppm, anchor, _) in enumerate(jobs):
        every |= set(obs)
    for ob in sc.objects:
        if ob.type == "MESH" and ob not in every:
            ob.hide_render = True
    times = []
    for name, group, obs, ppm, anchor, _ in jobs:
        if only and name not in only:
            continue
        t = time.time()
        d = os.path.join(out, group)
        os.makedirs(d, exist_ok=True)
        if anchor == "tile":
            fm = render_tile(sc, name, obs, ppm, d, CHAIN_W, CHAIN_P)
        else:
            P = world_bbox(obs)
            center = (P.min(0) + P.max(0)) / 2 if anchor is None else np.array(tuple(anchor))
            fm = render_sprite(sc, name, obs, ppm, d, tuple(center))
        fm["group"] = group
        meta["frames"][name] = fm
        json.dump(meta, open(meta_path, "w"), indent=1)
        times.append((name, time.time() - t))
        print("SPRITE %s %dx%d %.1fs" % (name, fm["w"], fm["h"], time.time() - t), flush=True)
    if "level" in groups:
        import types
        import plush_beach  # #111: its prop skins are built like the world props
        plush_beach.PW = types.SimpleNamespace(Group=Group, mesh=mesh, soft_box=soft_box, extrude_poly=extrude_poly, stitch_line=stitch_line,
                                               stitch_rect=stitch_rect, damage_objects=damage_objects, M=M)
        import plush_forest  # #114: the same for the forest's
        plush_forest.PW = plush_beach.PW
        import plush_cave  # #125: the same for the cave's
        plush_cave.PW = plush_beach.PW
        import plush_space  # #127: the same for the space map's
        plush_space.PW = plush_beach.PW
        times += render_level(sc, out, meta, meta_path, [t for t in a.themes.split(",") if t], not a.no_common, only)
    with open(os.path.join(a.out, "times.txt"), "a") as fh:
        for n_, dt in times:
            fh.write("%-16s %6.1f s\n" % (n_, dt))
    print("DONE %.1fs" % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
