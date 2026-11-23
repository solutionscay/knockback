"""
The fighters' sprite frames (#85): the plush brawler for the viewer (src/viewer/plush-bot.ts). Headless Blender.

    tools/art/render-sprites.sh OUT_DIR      (the one command: renders, then plush_pack.py builds the atlases)
    Blender -b --factory-startup --python tools/art/plush_sprites.py -- --out DIR [--sheets a,b] [--quick]

An orthographic camera at the game's three-quarter angle (55 degrees, plush_action.ANGLE) renders square cells at
a fixed scale (--ppm sprite pixels per game meter; 80, about 1.8x the median View-all scale at 1080p). The suit is
neutral grey so the viewer can tint it, and there are no LED dots (the viewer draws the face in code).

Sheets (frames at about 12 fps, sampled from the 24 fps loops in plush_action.py), named after the build:
  <build>-body-<loop>   the bot without its near (weapon) arm: idle, run, punch, launched, jump, flinch, ko, celebrate
  <build>-fist-<loop>   the near arm with its plain mitt, the body as a holdout (drawn over the body: the fist)
  <build>-arm-<weapon>  the near arm with the weapon on its socket (rocket, bat, rifle), the body as a holdout
  mark-<mark>           a head mark, one frame (shared by every build; the viewer moves it with the head anchors)
Each sheet has two layers: "tint" (the suit fabric, the mitts, the visor rim: tinted at runtime) and "fixed"
(everything else: fleece, leather, boots, buckle, stitches, glass, weapons). Each holds the other as a holdout,
so they stack without seams.

Per frame it writes meta.json: the ground point (the bot stands on it), the visor (center, screen-right edge
middle, top edge middle, screen-left edge middle: the viewer maps its code LED face onto them), the head and
torso anchors (bone center, +x, +z projected: the mark overlays follow them), the near shoulder (the arm layer's
pivot), and for the aimed weapons the barrel (its far end is the muzzle) and its screen angle.

Rollout phase 1: every sheet is rendered for both facings (L: the lights mirrored), the head is turned toward the
camera (plush_action.HEAD_TURN), and each major mark is its own one-frame overlay sheet (mark-*).
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
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plush_action as pa  # noqa: E402
import plush_bot as pb  # noqa: E402

# plush units -> game meters: the plush bot (feet to head top ~1.96) stands as tall as the code bot (1.68 m)
GAME_PER_UNIT = 0.86
NEUTRAL = "#e4e4e4"
TINT_MATS = {"Suit", "SuitDark", "SuitLight", "Mitt", "Rim", "Armor"}
BOOTS = {"l": ("Boot.L", "Sole.L"), "r": ("Boot.R", "Sole.R")}  # (anchor's treaded soles only exist on anchor)
# the ground loops: their bodies render without the boots, and each boot is its own sheet, so the viewer can stand each
# foot on the ground under it (slopes, steps, crate corners) as the code bot's feet do
FOOT_LOOPS = ("idle", "run", "punch", "flinch")
NEAR_ARM = ("Sleeve.R", "Cuff.R", "Mitt.R", "Patch.sh.R")
NEAR_SLEEVE = ("Sleeve.R", "Cuff.R", "Patch.sh.R")  # the per-build part of the near arm; the mitt goes with the weapon

# loop: frame indices in the 24 fps loop (about 12 fps)
BODY_LOOPS = {
    "idle": list(range(0, 24, 2)), "run": list(range(0, 24, 2)), "punch": list(range(0, 24, 2)),
    "launched": list(range(0, 40, 3)), "jump": list(range(0, 16, 2)), "flinch": list(range(0, 12, 2)),
    "ko": list(range(0, 24, 2)), "celebrate": list(range(0, 24, 2)),
}
WEAPON_LOOPS = (("rocket", list(range(0, 36, 3))), ("bat", list(range(0, 32, 2))), ("rifle", list(range(0, 24, 2))),
                ("shotgun", list(range(0, 24, 2))), ("sniper", list(range(0, 28, 2))), ("crossbow", list(range(0, 24, 2))),
                ("railgun", list(range(0, 28, 2))), ("hammer", list(range(0, 32, 2))), ("flamethrower", list(range(0, 24, 2))),
                ("lightning", list(range(0, 24, 2))), ("grenade", list(range(0, 24, 2))), ("mine", list(range(0, 24, 2))),
                ("grapple", list(range(0, 24, 2))))
BUILD_NAMES = ("balanced", "tank", "anchor", "glass")


def sheets_for(build):
    """The sheets of one build (names start with it): body and fist per loop, the sleeve of every weapon loop."""
    out = {}
    for l, idx in BODY_LOOPS.items():
        out["%s-body-%s" % (build, l)] = (l, idx, "body")    # the bot without its near arm (ground loops: nor its boots)
        out["%s-fist-%s" % (build, l)] = (l, idx, "fist")    # the near arm with its plain mitt (body as holdout)
        if l in FOOT_LOOPS:
            out["%s-bootl-%s" % (build, l)] = (l, idx, "boot")  # one boot each (the other parts as a holdout)
            out["%s-bootr-%s" % (build, l)] = (l, idx, "boot")
    for w, idx in WEAPON_LOOPS:
        out["%s-sleeve-%s" % (build, w)] = (w, idx, "sleeve")  # the near arm's sleeve and cuff in the weapon's loop
    return out


SHEETS = {}
for _b in BUILD_NAMES:
    SHEETS.update(sheets_for(_b))
# the weapons, shared by every build (rendered on balanced): the mitt, its socket and the weapon; the viewer pins it
# to each build's sleeve at the wrist
for _w, _idx in WEAPON_LOOPS:
    SHEETS["weapon-" + _w] = (_w, _idx, "weapon")
SHARED = ("mark-", "weapon-")  # sheet prefixes that render with balanced only
# the head marks (src/sim/identity.ts MAJOR_MARKS): one overlay frame each at the idle loop's first frame; the viewer
# moves it with the head (or, for the cape, the torso) anchors of every body frame
MARKS = ["headband", "antenna", "crown", "ears", "catears", "horns", "propeller", "mohawk", "halo", "beanie", "cape",
         "bow", "sprout", "tophat", "bolts", "scarf"]  # the 14 major marks, then the minor bolts and scarf
# marks in motion: frames of a flap, a spin or a whip (each frame turns part of the mark about a pivot, rest space)
MARK_FRAMES = {"headband": 3, "cape": 3, "scarf": 3, "propeller": 4, "antenna": 5}
for _m in MARKS:
    SHEETS["mark-" + _m] = ("idle", [0] * MARK_FRAMES.get(_m, 1), "mark")
FACINGS = ("R", "L")  # L: the lights mirrored left-right (the viewer flips the sprite, so the light stays put)
# the barrel of each aimed weapon, in its part's (unshifted) mesh coordinates
BARREL = {"rocket": ("Rocket tube", (0.2, -0.42, 0.42), (0.2, 0.74, 0.42)),
          "rifle": ("Rifle barrel", (0.0, 0.36, 0.38), (0.0, 0.98, 0.38)),
          "shotgun": ("Shotgun barrel", (0.0, 0.28, 0.40), (0.0, 0.93, 0.40)),
          "sniper": ("Sniper barrel", (0.0, 0.34, 0.37), (0.0, 1.46, 0.37)),
          "crossbow": ("Crossbow bolt", (0.0, 0.06, 0.43), (0.0, 0.97, 0.43)),
          "railgun": ("Railgun body", (0.0, 0.3, 0.36), (0.0, 1.09, 0.36)),
          "flamethrower": ("Flamer nozzle", (0.0, 0.28, 0.38), (0.0, 0.92, 0.38)),
          "lightning": ("Sword blade", (0.0, 0.1, 0.36), (0.0, 1.1, 0.36)),
          # thrown and placed: the object's center (where the game's grenade or mine starts), from below it
          "grenade": ("Grenade body", (0.0, 0.0, 0.305), (0.0, 0.0, 0.455)),
          "mine": ("Mine body", (0.0, -0.1, 0.355), (0.0, 0.0, 0.355)),
          "grapple": ("Grapple hook shaft", (0.0, 0.48, 0.36), (0.0, 0.7, 0.36))}
# loop frames where a part of a weapon is gone: the crossbow's bolt and the grapple's hook fly on frame 5, the grenade
# and the mine leave the mitt on frame 8; all are back on frame 18 (the reload, or a new one)
GONE = {"crossbow": (lambda W: W.bolt, range(6, 18)),
        "grenade": (lambda W: W.held, range(9, 18)), "mine": (lambda W: W.held, range(9, 18)),
        "grapple": (lambda W: W.held, range(6, 18))}


def split_arm_stitches(ch):
    """Split the one stitches object into the near arm's stitches and the rest (the arm layer needs its own); then
    the arm's into the mitt's and the sleeve's (the mitt goes with the shared weapon layer)."""
    so = ch.stitches
    arm_obs = [ch.parts[n][0] for n in NEAR_ARM if n in ch.parts]
    arm_bvh = pb.bvh_of(*arm_obs)
    co = pb.get_co(so)
    is_arm = np.zeros(len(co), bool)
    for g0, g1 in ch.stitch_groups:
        c = Vector(co[g0:g1].mean(0))
        r = arm_bvh.find_nearest(c, 0.04)
        if r[0] is not None:
            is_arm[g0:g1] = True
    arm = so.copy()
    arm.data = so.data.copy()
    arm.name = "Stitches arm"
    so.users_collection[0].objects.link(arm)
    import bmesh
    for ob, drop in ((so, is_arm), (arm, ~is_arm)):
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(drop)[0]], context="VERTS")
        bm.to_mesh(ob.data)
        bm.free()
        ob.data.update()
    # the arm's stitches: the mitt's (nearest part the mitt) and the sleeve's
    mitt_bvh = pb.bvh_of(ch.parts["Mitt.R"][0])
    sleeve_bvh = pb.bvh_of(*[ch.parts[n][0] for n in NEAR_SLEEVE if n in ch.parts])
    co = pb.get_co(arm)
    on_mitt = np.zeros(len(co), bool)
    import bmesh as _bm
    for piece in _pieces(arm):  # one connected piece per stitch dash
        c = Vector(co[piece].mean(0))
        rm, rs = mitt_bvh.find_nearest(c, 0.06), sleeve_bvh.find_nearest(c, 0.06)
        dm = rm[3] if rm[0] is not None else 9
        ds = rs[3] if rs[0] is not None else 9
        if dm < ds:
            on_mitt[piece] = True
    mitt = arm.copy()
    mitt.data = arm.data.copy()
    mitt.name = "Stitches mitt"
    arm.users_collection[0].objects.link(mitt)
    for ob, drop in ((arm, on_mitt), (mitt, ~on_mitt)):
        bm = _bm.new()
        bm.from_mesh(ob.data)
        bm.verts.ensure_lookup_table()
        _bm.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(drop)[0]], context="VERTS")
        bm.to_mesh(ob.data)
        bm.free()
        ob.data.update()
    return arm, mitt


def split_near(so, parts, name, maxd=0.05):
    """Move the stitch dashes of `so` lying on `parts` (within maxd) into a new object; None if there are none."""
    if not parts:
        return None
    bvh = pb.bvh_of(*parts)
    co = pb.get_co(so)
    take = np.zeros(len(co), bool)
    for piece in _pieces(so):
        if bvh.find_nearest(Vector(co[piece].mean(0)), maxd)[0] is not None:
            take[piece] = True
    if not take.any():
        return None
    import bmesh as _bm
    new = so.copy()
    new.data = so.data.copy()
    new.name = name
    so.users_collection[0].objects.link(new)
    for ob, drop in ((so, take), (new, ~take)):
        bm = _bm.new()
        bm.from_mesh(ob.data)
        bm.verts.ensure_lookup_table()
        _bm.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(drop)[0]], context="VERTS")
        bm.to_mesh(ob.data)
        bm.free()
        ob.data.update()
    return new


def sole_point(obs):
    """The middle of a boot's sole, posed (world): the lowest few centimeters of its evaluated mesh."""
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for ob in obs:
        if ob.type != "MESH" or ob.name.startswith("Stitches"):
            continue
        oe = ob.evaluated_get(dg)
        me = oe.to_mesh()
        pts += [oe.matrix_world @ v.co for v in me.vertices]
        oe.to_mesh_clear()
    zmin = min(p.z for p in pts)
    low = [p for p in pts if p.z < zmin + 0.03]
    return sum(low, Vector()) / len(low)


class MarkMotion:
    """Frames of a mark in motion: part of the mark turned about a pivot (rest space, so the head or torso bone carries
    it): the headband's tails and the scarf's flap, the cape flares back, the propeller spins, the antenna whips."""

    def __init__(self, ch):
        self.ch = ch
        self.saved = {}

    def _group(self, mark):
        obs = self.ch.marks[mark]
        named = lambda *pre: [o for o in obs if o.name.startswith(pre)]
        center = lambda os_: np.vstack([pb.get_co(o) for o in os_]).mean(0)
        if mark == "antenna":
            return obs, np.array(self.ch.antenna_base), (0, 1, 0), [-36, -18, 0, 18, 36]
        if mark == "propeller":
            spin = named("Prop blade", "Prop hub")
            return spin, center(named("Prop hub")), (0, 0, 1), [0, 45, 90, 135]
        if mark == "headband":
            d = np.cross(np.array([-0.36, 0.13, 0.0]) / 0.383, (0, 0, 1))
            return named("Headband tail"), center(named("Headband knot")), tuple(d), [-14, 2, 16]
        if mark == "scarf":
            d = np.cross(np.array([-0.18, 0.4, 0.0]) / 0.439, (0, 0, 1))
            return named("Scarf tail"), center(named("Scarf knot")), tuple(d), [-12, 2, 16]
        if mark == "cape":
            return obs, np.array([0.0, 0.22, 1.08]), (1, 0, 0), [0, 9, 18]
        raise KeyError(mark)

    def pose(self, mark, k):
        obs, pivot, axis, angles = self._group(mark)
        from mathutils import Matrix as _M
        R = np.array(_M.Rotation(math.radians(angles[k]), 3, Vector(axis)))
        for o in obs:
            if o.name not in self.saved:
                self.saved[o.name] = (o, pb.get_co(o).copy())
            co = self.saved[o.name][1]
            pb.set_co(o, (co - pivot) @ R.T + pivot)
        bpy.context.view_layer.update()

    def rest(self, mark):
        for o, co in [self.saved.pop(n) for n in [o.name for o in self._group(mark)[0]] if n in self.saved]:
            pb.set_co(o, co)
        bpy.context.view_layer.update()


def _pieces(ob):
    """Vertex index arrays of the mesh's connected pieces (one per stitch dash)."""
    n = len(ob.data.vertices)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for e in ob.data.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            parent[a] = b
    out = {}
    for v in range(n):
        out.setdefault(find(v), []).append(v)
    return [np.array(v) for v in out.values()]


def ortho_camera(sc, angle, cell_units, center_z, elev=0.18):
    rig, cam, tgt = sc.objects["CamRig"], sc.objects["Cam"], sc.objects["CamTarget"]
    rig.rotation_euler = (0, 0, -math.radians(angle))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = cell_units
    tgt.location = (0, 0, center_z)
    d = 12.0
    cam.location = (0, -d * math.cos(elev), center_z + d * math.sin(elev))
    return cam


def px(sc, cam, co):
    v = world_to_camera_view(sc, cam, Vector(co))
    return (round(v.x * sc.render.resolution_x, 2), round((1 - v.y) * sc.render.resolution_y, 2))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--build", default="balanced", choices=BUILD_NAMES, help="the build to render (marks: balanced only)")
    ap.add_argument("--sheets", default="", help="sheet names (default: every sheet of --build, plus the marks for balanced)")
    ap.add_argument("--ppm", type=float, default=80.0, help="sprite pixels per game meter")
    ap.add_argument("--cell", type=float, default=3.0, help="cell size in game meters (square)")
    ap.add_argument("--angle", type=float, default=pa.ANGLE)
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--hair", type=float, default=0.15)
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args(argv)
    t0 = time.time()
    pa.SPRITE = True
    pb.QUICK = a.quick
    pb.HAIR = a.hair
    mine = lambda n: n.startswith(a.build + "-") or (a.build == "balanced" and n.startswith(SHARED))
    if not a.sheets:
        a.sheets = ",".join(n for n in SHEETS if mine(n))
    for n in a.sheets.split(","):
        if n and not mine(n):
            sys.exit("sheet %s is not a %s sheet (marks and weapons render with balanced)" % (n, a.build))
    sc, ch, weapons = pa.build(hair=a.hair > 0, build_name=a.build)
    pb.set_body_color(NEUTRAL)
    pb.lite_video()
    sc.render.use_persistent_data = True  # small frames: keep the scene between renders
    sc.cycles.samples = 8 if a.quick else a.samples
    sc.cycles.adaptive_threshold = 0.04
    cell_px = int(round(a.cell * a.ppm))
    sc.render.resolution_x = sc.render.resolution_y = cell_px
    sc.render.resolution_percentage = 100
    cell_units = a.cell / GAME_PER_UNIT
    cam = ortho_camera(sc, a.angle, cell_units, center_z=cell_units * 0.42)
    sc.objects["Floor"].hide_render = True
    # the visor glass: a softer sheen, so the highlight never reads as an LED eye at game size
    for m in bpy.data.materials:
        if m.name == "Visor" and m.node_tree:
            for nd in m.node_tree.nodes:
                if nd.type == "BSDF_PRINCIPLED":
                    nd.inputs["Roughness"].default_value = 0.34
                    nd.inputs["Coat Weight"].default_value = 0.25
                    nd.inputs["Coat Roughness"].default_value = 0.3
    arm_st, mitt_st = split_arm_stitches(ch)
    boot_obs = {k: {ch.parts[n][0] for n in names if n in ch.parts} for k, names in BOOTS.items()}
    boot_st = {k: split_near(ch.stitches, list(v), "Stitches boot " + k) for k, v in boot_obs.items()}
    for k in boot_obs:
        if boot_st[k] is not None:
            boot_obs[k].add(boot_st[k])
    boots = boot_obs["l"] | boot_obs["r"]
    motion = MarkMotion(ch)
    # no keyed visibility on anything but the rig: this script sets every object's visibility itself
    for ob in sc.objects:
        if ob.type != "ARMATURE" and ob.animation_data:
            ob.animation_data_clear()
        ob.hide_viewport = False  # hidden objects are not evaluated: their matrices (the metadata) would go stale
    # what belongs where
    face_obs = set(ch.faces.values()) | {o for o in sc.objects if o.name.startswith("LED grid")}
    marks = {o for obs in ch.marks.values() for o in obs}
    near = {ch.parts[n][0] for n in NEAR_ARM if n in ch.parts} | {arm_st, mitt_st}
    sleeve = {ch.parts[n][0] for n in NEAR_SLEEVE if n in ch.parts} | {arm_st}
    mitt = {ch.parts["Mitt.R"][0], mitt_st}
    body = {o for o, _ in ch.parts.values()} | {ch.stitches}
    body -= face_obs
    body -= marks
    weapon_obs = {}
    for wname, W in weapons.items():
        obs = set(o for o in W.parts if o)
        # the socket parts were collected in build(); find them by name
        for kind in ("socket", "bracket", "snap"):
            obs |= {o for o in sc.objects if o.type == "MESH" and o.name.startswith(W.name.capitalize() + " " + kind)}
        weapon_obs[wname] = obs
    fx = {o for W in weapons.values() for o, _ in W.fx} | {o for o in sc.objects if o.name.startswith(("Bat trail", "Bat tip", "Bat mid"))}
    lights = [o for o in sc.objects if o.type == "LIGHT"]
    light_x = {o.name: o.location.x for o in lights}

    def set_facing(f):
        for o in lights:
            o.location.x = light_x[o.name] * (-1 if f == "L" else 1)

    def mat_names(o):
        return {s.material.name for s in o.material_slots if s.material}

    def is_tint(o):
        return bool(mat_names(o) & TINT_MATS)

    every = {o for o in sc.objects if o.type == "MESH" and o.name != "Floor"}
    rig = ch.rig
    head_pb, torso_pb = rig.pose.bones["head"], rig.pose.bones["torso"]
    head_rest_inv = rig.data.bones["head"].matrix_local.inverted()
    torso_rest_inv = rig.data.bones["torso"].matrix_local.inverted()
    HC, TC = Vector(tuple(pb.HEAD_C)), Vector((0, 0, 0.86))
    X, Z = Vector((0.3, 0, 0)), Vector((0, 0, 0.3))
    XT = X * pb.BUILDS[a.build]["torso"]  # the torso anchor's +x scales with the build's width: the cape fits it
    # visor reference points at rest (world): the glass's front surface at its center, side edges and top edge
    vis = [o for o in sc.objects if o.name.startswith("Visor glass")][0]
    vb = pb.bvh_of(vis)
    vz, vw, vh = pb.VISOR["z"], pb.VISOR["w"], pb.VISOR["h"]

    def front(x, z):
        hit = vb.ray_cast(Vector((x, -3, z)), Vector((0, 1, 0)), 6)
        return hit[0]

    vis_rest = {"c": front(0, vz), "a": front(vw * 0.42, vz), "b": front(-vw * 0.42, vz), "u": front(0, vz + vh * 0.4)}
    out = os.path.abspath(os.path.join(a.out, "sprites"))
    os.makedirs(out, exist_ok=True)
    meta = {"ppm": a.ppm, "cell": cell_px, "angle": a.angle, "game_per_unit": GAME_PER_UNIT, "sheets": {}}
    meta_path = os.path.join(out, "meta.json")
    if os.path.exists(meta_path):
        meta["sheets"] = json.load(open(meta_path))["sheets"]
    sc.frame_set(pa.LOOPS["idle"][0])
    bpy.context.view_layer.update()  # the camera's matrix must be current before projecting
    ground = px(sc, cam, (0, 0, 0))
    times = []
    for name in [s for s in a.sheets.split(",") if s]:
        loop, idx, kind = SHEETS[name]
        start = pa.LOOPS[loop][0]
        wname = loop if kind in ("sleeve", "weapon") else None
        mark = name[5:] if kind == "mark" else None
        if kind == "body":
            show = body - near - (boots if loop in FOOT_LOOPS else set())
        elif kind == "boot":
            side = name.split("-")[1][-1]
            show = boot_obs[side]
        elif kind == "fist":
            show = near
        elif kind == "sleeve":
            show = sleeve
        elif kind == "weapon":
            show = mitt | weapon_obs[wname]
        else:
            show = set(ch.marks[mark])
        # the arm layer: the rest of the body hides what is behind it; a head mark: the whole body does; the cape is
        # drawn behind the body sprite, so it needs no holdout
        # the sleeve: the body without the near arm hides what is behind it; the weapon (with its mitt): the whole body,
        # sleeve included (a weapon part behind the sleeve is cut; drawn over each build's sleeve it stays behind it)
        holdout = ((body - near) if kind in ("sleeve", "fist") else (body - mitt) if kind == "weapon" else (body - near - show) if kind == "boot"
                   else body if kind == "mark" and mark != "cape" else set())
        frames_meta = []
        for i in idx:
            sc.frame_set(start + i)
            Mh = rig.matrix_world @ head_pb.matrix @ head_rest_inv
            Mt = rig.matrix_world @ torso_pb.matrix @ torso_rest_inv
            pts = {k: px(sc, cam, Mh @ v) for k, v in vis_rest.items()}
            r_, l_ = (pts["a"], pts["b"]) if pts["a"][0] > pts["b"][0] else (pts["b"], pts["a"])
            fm = {"visor": [pts["c"], r_, pts["u"], l_],
                  "head": [px(sc, cam, Mh @ HC), px(sc, cam, Mh @ (HC + X)), px(sc, cam, Mh @ (HC + Z))],
                  "torso": [px(sc, cam, Mt @ TC), px(sc, cam, Mt @ (TC + XT)), px(sc, cam, Mt @ (TC + Z))],
                  "shoulder": px(sc, cam, rig.matrix_world @ rig.pose.bones["upperarm.R"].head),
                  "wrist": px(sc, cam, rig.matrix_world @ rig.pose.bones["hand.R"].head)}
            if kind == "boot":
                fm["sole"] = px(sc, cam, sole_point(boot_obs[side]))
            if wname in BARREL:
                pn, p0, p1 = BARREL[wname]
                ob = sc.objects[pn]
                q0, q1 = px(sc, cam, ob.matrix_world @ Vector(p0)), px(sc, cam, ob.matrix_world @ Vector(p1))
                fm["barrel"] = [q0, q1]
                fm["angle"] = round(math.atan2(q1[1] - q0[1], q1[0] - q0[0]), 4)
            frames_meta.append(fm)
        t = time.time()
        for facing in FACINGS:
            set_facing(facing)
            for layer in ("tint", "fixed"):
                mine = {o for o in show if is_tint(o) == (layer == "tint")}
                other = (show - mine) | holdout
                for o in every:
                    o.hide_render = o not in mine and o not in other
                    o.is_holdout = o in other
                for o in face_obs | fx:
                    o.hide_render = True
                d = os.path.join(out, name, facing, layer)
                os.makedirs(d, exist_ok=True)
                gone = set(GONE[wname][0](weapons[wname])) if kind == "weapon" and wname in GONE else set()
                for k, i in enumerate(idx):
                    sc.frame_set(start + i)
                    if mark in MARK_FRAMES:
                        motion.pose(mark, k)
                    for o in gone:  # a part that has left the weapon (the shot bolt), back on the reload
                        o.hide_render = i in GONE[wname][1] or (o not in mine and o not in other)
                    sc.render.filepath = os.path.join(d, "f%02d.png" % k)
                    bpy.ops.render.render(write_still=True)
                if mark in MARK_FRAMES:
                    motion.rest(mark)
        set_facing("R")
        dt = time.time() - t
        times.append((name, len(idx), dt))
        meta["sheets"][name] = {"loop": loop, "src": idx, "kind": kind, "ground": ground, "frames": frames_meta}
        json.dump(meta, open(meta_path, "w"), indent=1)
        print("SHEET %s %d frames x 2 layers x 2 facings %.1fs" % (name, len(idx), dt), flush=True)
    for o in every:
        o.is_holdout = False
    with open(os.path.join(a.out, "times.txt"), "a") as fh:
        for n_, k, dt in times:
            fh.write("%-28s %3d frames x4 %7.1f s\n" % (n_, k, dt))
    print("DONE %.1fs" % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
