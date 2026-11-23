"""
(#85) the PLUSH SKIPPER BRAWLER as a real Blender model. Headless.

    tools/art/render-plush.sh OUT_DIR        (the one command; see that file)
    Blender -b --factory-startup --python tools/art/plush_bot.py -- --out DIR [--quick] [--only a,b] [--build B]

Everything is built from this script: the meshes, the materials, the fuzz (particle hair), the
stitches, the rig and the poses. Nothing is loaded from disk.

Scene units: the bot stands on z = 0 and is about 2.25 units tall with its antenna. It faces -Y,
so the Blender front view sees its face; +X is the bot's left.

Parts
- head:   the squircle outline from src/viewer/bot.ts (the SVG path, sampled) as the front profile,
          rounded front to back into a soft volume; 4 plush panels with pinched, stitched seams.
- visor:  dark glossy glass that follows the head, a raised rim (tinted vinyl), an LED dot grid
          (emissive dots; one dot object per expression, so a pose can change the face).
- suit:   torso with quilted chevron channels (real displaced geometry), quilted hips, quilted
          ring-channel sleeves and legs, cream fleece collar and cuffs, padded mitts, a stitched
          brown belt with a gold buckle, X-stitched brown patches on shoulders and knees, boots.
- marks:  antenna with a glowing ball (default), cat ears, headband. Swap with set_head().
- builds: balanced, tank (puffier), anchor (vinyl armor, heavy boots), glass (slim, glowing mitts).
          A build changes geometry, so each build is its own build_character() call.

Tint: every body-colored material reads one node group, "KB Body Color" (one RGB node). Change
it with set_body_color(); the suit, the rim, the antenna, the mitts and the anchor armor follow.

Rig: root, hips, torso, head, antenna, upperarm/forearm/hand x2, thigh/shin/foot x2. The limbs
deform smoothly at elbows and knees (weights from the limb axis); other parts follow one bone.
Poses are keyframes on the armature action (POSE_FRAMES); the run cycle is keyed per frame.
"""
import argparse
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.join(HERE, "build")


def srgb(h):
    """'#rrggbb' -> linear RGBA."""
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c) + (1.0,)


COLORS = {"orange": "#e8701c", "blue": "#2f5fd8", "pink": "#e0508f"}
FLEECE = "#f0d6a8"
BROWN = "#6e3b22"
BOOT = "#77401f"
THREAD = "#f4d79a"
GOLD = "#e6a630"
GLASS = "#0d121c"
LED = "#ffc96b"

QUICK = False
HAIR = 1.0      # strand density scale (--hair); lower it for video frames

# ---------------------------------------------------------------- mesh helpers

COLL = None


def link(ob):
    COLL.objects.link(ob)
    return ob


def mesh_obj(name, verts, faces, mat=None, smooth=True, recalc=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [list(map(int, f)) for f in faces])
    me.validate(clean_customdata=False)
    if recalc:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
    me.update()
    if smooth:
        me.shade_smooth()
    ob = link(bpy.data.objects.new(name, me))
    if mat:
        me.materials.append(mat)
    return ob


def get_co(ob):
    n = len(ob.data.vertices)
    a = np.empty(n * 3, dtype=np.float64)
    ob.data.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)


def get_nrm(ob):
    n = len(ob.data.vertices)
    a = np.empty(n * 3, dtype=np.float64)
    ob.data.vertices.foreach_get("normal", a)
    return a.reshape(-1, 3)


def set_co(ob, co):
    ob.data.vertices.foreach_set("co", co.reshape(-1).astype(np.float32))
    ob.data.update()


def displace(ob, fn):
    co, n = get_co(ob), get_nrm(ob)
    off = fn(co, n)
    set_co(ob, co + n * off[:, None])


def smooth_mesh(ob, iters=3, f=0.5):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    for _ in range(iters):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=f, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def bvh_of(*obs):
    vs, ts, off = [], [], 0
    for ob in obs:
        me = ob.data
        co = get_co(ob)
        me.calc_loop_triangles()
        tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get("vertices", tri)
        vs.append(co)
        ts.append(tri.reshape(-1, 3) + off)
        off += len(co)
    return BVHTree.FromPolygons(np.vstack(vs).tolist(), np.vstack(ts).tolist())


def cube_sphere(n):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=n - 1, use_grid_fill=True)
    bm.verts.index_update()
    v = np.array([x.co[:] for x in bm.verts])
    f = [[x.index for x in face.verts] for face in bm.faces]
    bm.free()
    v = np.tan(np.clip(v, -1, 1) * math.pi / 4)  # equal-angle cube map
    v /= np.linalg.norm(v, axis=1)[:, None]
    return v, f


def superellipsoid(n, c, ax, fy, by, tz, bz, p=2.5, q=2.5, ax_neg=None):
    """Soft box. ax: half width; fy/by: half depth front(-Y)/back; tz/bz: half height top/bottom."""
    d, f = cube_sphere(n)
    a = np.where(d[:, 0] >= 0, ax, ax if ax_neg is None else ax_neg)
    b = np.where(d[:, 1] < 0, fy, by)
    cc = np.where(d[:, 2] > 0, tz, bz)
    t = ((np.abs(d[:, 0]) / a) ** p + (np.abs(d[:, 1]) / b) ** p) ** (q / p) + (np.abs(d[:, 2]) / cc) ** q
    t = t ** (-1 / q)
    return d * t[:, None] + np.array(c), f


def lathe(profile, seg=48):
    """profile: [(z, r)] along +Z, first and last r = 0 (poles). Returns verts, faces."""
    verts, faces = [], []
    inner = profile[1:-1]
    verts.append((0, 0, profile[0][0]))
    for z, r in inner:
        for i in range(seg):
            a = 2 * math.pi * i / seg
            verts.append((r * math.cos(a), r * math.sin(a), z))
    verts.append((0, 0, profile[-1][0]))
    top = len(verts) - 1
    for i in range(seg):
        faces.append([0, 1 + (i + 1) % seg, 1 + i])
    for k in range(len(inner) - 1):
        b0, b1 = 1 + k * seg, 1 + (k + 1) * seg
        for i in range(seg):
            j = (i + 1) % seg
            faces.append([b0 + i, b0 + j, b1 + j, b1 + i])
    b0 = 1 + (len(inner) - 1) * seg
    for i in range(seg):
        faces.append([b0 + i, b0 + (i + 1) % seg, top])
    return np.array(verts, dtype=np.float64), faces


def align(verts, start, end):
    """Map a mesh built along +Z (0..1 scaled by length) so +Z runs start->end."""
    s, e = Vector(start), Vector(end)
    d = e - s
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    m = np.array(q.to_matrix())
    return verts @ m.T + np.array(s)


def frame_from(t, n):
    t = t / np.linalg.norm(t)
    b = np.cross(t, n)
    b /= np.linalg.norm(b)
    n = np.cross(b, t)
    return t, n, b


def sweep(path, normals, profile, closed=True, cap=True):
    """Sweep a closed 2D profile [(a, b)] along a path: point = P + a*N + b*B (B = T x N)."""
    P = np.array(path, dtype=np.float64)
    N = np.array(normals, dtype=np.float64)
    m, k = len(P), len(profile)
    verts, faces = [], []
    for i in range(m):
        if closed:
            t = P[(i + 1) % m] - P[i - 1]
        else:
            t = P[min(i + 1, m - 1)] - P[max(i - 1, 0)]
        t, n, b = frame_from(t, N[i])
        for a, bb in profile:
            verts.append(P[i] + a * n + bb * b)
    rng = m if closed else m - 1
    for i in range(rng):
        i2 = (i + 1) % m
        for j in range(k):
            j2 = (j + 1) % k
            faces.append([i * k + j, i * k + j2, i2 * k + j2, i2 * k + j])
    if not closed and cap:
        for end in (0, m - 1):
            c = len(verts)
            verts.append(np.mean([verts[end * k + j] for j in range(k)], axis=0))
            for j in range(k):
                faces.append([end * k + j, end * k + (j + 1) % k, c])
    return np.array(verts), faces


def circle(r, n=12, rb=None, ca=0.0):
    rb = r if rb is None else rb
    return [(ca + r * math.cos(2 * math.pi * i / n), rb * math.sin(2 * math.pi * i / n)) for i in range(n)]


def rounded_rect_2d(w, h, r, n=10):
    """Closed outline of a w x h rounded rectangle, centered, counter-clockwise."""
    pts = []
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def resample(pts, step, closed=False):
    P = np.array(pts, dtype=np.float64)
    if closed:
        P = np.vstack([P, P[:1]])
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    L = s[-1]
    n = max(2, int(L / step))
    ss = np.linspace(0, L, n + (0 if closed else 1), endpoint=not closed)
    out = np.empty((len(ss), P.shape[1]))
    for d in range(P.shape[1]):
        out[:, d] = np.interp(ss, s, P[:, d])
    return out


class Builder:
    """Collects many small meshes into one object."""

    def __init__(self):
        self.v, self.f, self.groups = [], [], []

    def add(self, verts, faces):
        o = len(self.v)
        self.groups.append((o, o + len(verts)))
        self.v.extend(map(tuple, np.asarray(verts)))
        self.f.extend([[i + o for i in fc] for fc in faces])

    def obj(self, name, mat, smooth=True):
        if not self.v:
            return None
        return mesh_obj(name, self.v, self.f, mat, smooth)


_ELL = None


def ellipsoid_unit():
    global _ELL
    if _ELL is None:
        _ELL = cube_sphere(3)
    return _ELL


def add_dash(B, c, t, n, length, width, height):
    """One stitch: a small ellipsoid at c, long axis t, flat against the surface normal n."""
    v, f = ellipsoid_unit()
    t, n, b = frame_from(np.asarray(t, float), np.asarray(n, float))
    M = np.stack([t * length / 2, b * width / 2, n * height / 2], axis=1)
    B.add(v @ M.T + c, f)


def stitch_path(B, pts, nrm, dash=0.034, gap=0.02, width=0.011, height=0.007, lift=0.002, closed=False):
    """Dashed stitches along a polyline on a surface. nrm: function(point)->(point_on_surface, normal)."""
    P = resample(pts, 0.003, closed)
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    L = s[-1]
    period = dash + gap
    k = 0.0 if closed else (L % period) / 2
    while k + dash <= L:
        m = k + dash / 2
        i = min(np.searchsorted(s, m), len(P) - 1)
        i0, i1 = max(i - 3, 0), min(i + 3, len(P) - 1)
        t = P[i1] - P[i0]
        hit = nrm(P[i])
        if hit is not None:
            loc, n = hit
            add_dash(B, np.asarray(loc) + np.asarray(n) * lift, t, n, dash, width, height)
        k += period


def surf_fn(bvh, maxd=0.2):
    def f(p):
        r = bvh.find_nearest(Vector(p), maxd)
        if r[0] is None:
            return None
        return r[0], r[1]
    return f


def radial_path(bvh, center, u, w, a0, a1, n=160):
    """Points where rays from center (in the plane spanned by u, w) leave the surface."""
    out = []
    c = Vector(center)
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        d = (Vector(u) * math.cos(a) + Vector(w) * math.sin(a)).normalized()
        o = c + d * 3.0
        hit = bvh.ray_cast(o, -d, 6.0)  # from outside, so the outermost surface wins
        if hit[0] is not None:
            out.append(tuple(hit[0]))
    return out


def surface_patch(bvh, center, ndir, t1, w, h, thick, nexp=3.0, K=10, M=72, embed=0.008, bulge=0.6, height_fn=None):
    """A pillowy patch that hugs a surface: rounded-square outline (superellipse) projected along -ndir."""
    ndir = Vector(ndir).normalized()
    t1 = Vector(t1)
    t1 = (t1 - ndir * t1.dot(ndir)).normalized()
    t2 = ndir.cross(t1)
    c = Vector(center)
    verts, faces, ok = [], [], True
    outline = []
    for i in range(M):
        a = 2 * math.pi * i / M
        ca, sa = math.cos(a), math.sin(a)
        rr = (abs(ca) ** nexp + abs(sa) ** nexp) ** (-1 / nexp)
        outline.append((w * rr * ca, h * rr * sa))

    def place(x, y, r):
        o = c + t1 * x + t2 * y + ndir * 1.5
        hit = bvh.ray_cast(o, -ndir, 4.0)
        if hit[0] is None:
            hit = bvh.find_nearest(c + t1 * x + t2 * y, 0.5)
            if hit[0] is None:
                return None
        loc, n = hit[0], hit[1]
        if n.dot(ndir) < 0:
            n = -n
        z = thick * max(0.0, 1 - r ** 8) ** (bulge / 2) - embed * r ** 10
        if height_fn:
            z += height_fn(x, y) * (1 - r ** 6)
        return tuple(loc + n * z)

    p0 = place(0, 0, 0)
    if p0 is None:
        return None, None
    verts.append(p0)
    for k in range(1, K + 1):
        r = k / K
        for i in range(M):
            x, y = outline[i]
            p = place(x * r, y * r, r)
            if p is None:
                p = place(x * r * 0.9, y * r * 0.9, r)
            if p is None:
                return None, None
            verts.append(p)
    for i in range(M):
        faces.append([0, 1 + i, 1 + (i + 1) % M])
    for k in range(K - 1):
        b0, b1 = 1 + k * M, 1 + (k + 1) * M
        for i in range(M):
            j = (i + 1) % M
            faces.append([b0 + i, b1 + i, b1 + j, b0 + j])
    return np.array(verts), faces


def orient_out(ob, direction):
    """Flip an open surface so its normals face along direction (on average)."""
    me = ob.data
    n = np.mean([p.normal[:] for p in me.polygons], axis=0)
    if np.dot(n, direction) < 0:
        me.flip_normals()
        me.update()


def metaball_mesh(name, elems, res=0.014, bbox=None, smooth=4):
    """elems: [(type, co, radius, (sx, sy, sz))]. bbox: (center, half-extents) to fit the result."""
    mb = bpy.data.metaballs.new(name.replace(".", "_") + "MB")
    mb.resolution = res
    mb.render_resolution = res
    mb.threshold = 0.6
    for typ, co, rad, size in elems:
        e = mb.elements.new()
        e.type = typ
        e.co = co
        e.radius = rad
        if size is not None:
            e.size_x, e.size_y, e.size_z = size
    tmp = link(bpy.data.objects.new(name.replace(".", "_") + "MBX", mb))
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp)
    bpy.data.metaballs.remove(mb)
    me.name = name
    ob = link(bpy.data.objects.new(name, me))
    smooth_mesh(ob, smooth, 0.5)
    if bbox:
        co = get_co(ob)
        lo, hi = co.min(0), co.max(0)
        cc, he = np.array(bbox[0]), np.array(bbox[1])
        co = (co - (lo + hi) / 2) / ((hi - lo) / 2) * he + cc
        set_co(ob, co)
    me.shade_smooth()
    return ob


# ---------------------------------------------------------------- materials

def node_mat(name):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    return m, nt, out


def body_color_group():
    ng = bpy.data.node_groups.get("KB Body Color")
    if ng:
        return ng
    ng = bpy.data.node_groups.new("KB Body Color", "ShaderNodeTree")
    ng.interface.new_socket(name="Color", in_out="OUTPUT", socket_type="NodeSocketColor")
    rgb = ng.nodes.new("ShaderNodeRGB")
    rgb.name = rgb.label = "Body Color"
    rgb.outputs[0].default_value = srgb(COLORS["orange"])
    o = ng.nodes.new("NodeGroupOutput")
    ng.links.new(rgb.outputs[0], o.inputs[0])
    return ng


def set_body_color(hexcol):
    body_color_group().nodes["Body Color"].outputs[0].default_value = srgb(hexcol)


def fabric_mat(name, color=None, tint_hsv=None, rough=0.9, sheen=1.0, fuzz_bump=0.35, felt=0.25, scale=1.0,
               emission=None, sss=0.08):
    """Plush fabric. color: hex, or None for the body tint (optionally shifted by tint_hsv=(h, s, v))."""
    m, nt, out = node_mat(name)
    L = nt.links
    p = nt.nodes.new("ShaderNodeBsdfPrincipled")
    p.location = (300, 0)
    if color is None:
        g = nt.nodes.new("ShaderNodeGroup")
        g.node_tree = body_color_group()
        g.location = (-700, 200)
        col = g.outputs[0]
        if tint_hsv:
            hsv = nt.nodes.new("ShaderNodeHueSaturation")
            hsv.inputs["Hue"].default_value = 0.5 + tint_hsv[0]
            hsv.inputs["Saturation"].default_value = tint_hsv[1]
            hsv.inputs["Value"].default_value = tint_hsv[2]
            L.new(col, hsv.inputs["Color"])
            col = hsv.outputs[0]
    else:
        rgb = nt.nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = srgb(color)
        col = rgb.outputs[0]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    # mottling: low-frequency value variation, like real pile
    mot = nt.nodes.new("ShaderNodeTexNoise")
    mot.inputs["Scale"].default_value = 9 * scale
    mot.inputs["Detail"].default_value = 3
    L.new(tc.outputs["Object"], mot.inputs["Vector"])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["To Min"].default_value = 0.84
    mr.inputs["To Max"].default_value = 1.06
    L.new(mot.outputs["Fac"], mr.inputs["Value"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    L.new(col, mul.inputs[6])
    L.new(mr.outputs[0], mul.inputs[7])
    base = mul.outputs[2]
    L.new(base, p.inputs["Base Color"])
    # sheen tinted toward a lighter version of the base: the velvet rim of plush
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
    if sss:
        p.inputs["Subsurface Weight"].default_value = sss
        p.inputs["Subsurface Scale"].default_value = 0.01
    # fuzz bump: fine fibres plus curly felt cells
    fine = nt.nodes.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 420 * scale
    fine.inputs["Detail"].default_value = 6
    fine.inputs["Roughness"].default_value = 0.7
    L.new(tc.outputs["Object"], fine.inputs["Vector"])
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.feature = "DISTANCE_TO_EDGE"
    vor.inputs["Scale"].default_value = 110 * scale
    vor.inputs["Randomness"].default_value = 1.0
    L.new(tc.outputs["Object"], vor.inputs["Vector"])
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
    if emission:
        L.new(base, p.inputs["Emission Color"]) if emission == "tint" else None
        if emission != "tint":
            p.inputs["Emission Color"].default_value = srgb(emission)
        p.inputs["Emission Strength"].default_value = 2.5
    L.new(p.outputs[0], out.inputs["Surface"])
    return m


def glossy_mat(name, color=None, tint_hsv=None, rough=0.3, coat=0.6, metal=0.0, spec=0.5):
    m, nt, out = node_mat(name)
    p = nt.nodes.new("ShaderNodeBsdfPrincipled")
    if color is None:
        g = nt.nodes.new("ShaderNodeGroup")
        g.node_tree = body_color_group()
        col = g.outputs[0]
        if tint_hsv:
            hsv = nt.nodes.new("ShaderNodeHueSaturation")
            hsv.inputs["Hue"].default_value = 0.5 + tint_hsv[0]
            hsv.inputs["Saturation"].default_value = tint_hsv[1]
            hsv.inputs["Value"].default_value = tint_hsv[2]
            nt.links.new(col, hsv.inputs["Color"])
            col = hsv.outputs[0]
        nt.links.new(col, p.inputs["Base Color"])
    else:
        p.inputs["Base Color"].default_value = srgb(color)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = 0.08
    p.inputs["Metallic"].default_value = metal
    p.inputs["Specular IOR Level"].default_value = spec
    nt.links.new(p.outputs[0], out.inputs["Surface"])
    return m


def emit_mat(name, color, strength):
    m, nt, out = node_mat(name)
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = srgb(color)
    e.inputs["Strength"].default_value = strength
    nt.links.new(e.outputs[0], out.inputs["Surface"])
    return m


def boot_mat():
    """Brown suede boots, darker toward the sole (object z)."""
    m = fabric_mat("Boot", BOOT, rough=0.75, sheen=0.6, fuzz_bump=0.2, felt=0.1, sss=0.0)
    nt = m.node_tree
    p = [n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"][0]
    src = p.inputs["Base Color"].links[0].from_socket
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Position"], sep.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.035
    mr.inputs["From Max"].default_value = 0.05
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(mr.outputs[0], mix.inputs["Factor"])
    mix.inputs[6].default_value = srgb("#3f1f10")
    nt.links.new(src, mix.inputs[7])
    nt.links.new(mix.outputs[2], p.inputs["Base Color"])
    return m


# ---------------------------------------------------------------- the character

BUILDS = {
    "balanced": dict(torso=1.0, depth=1.0, limb=1.0, quilt=1.0, collar=1.0, arm_x=0.0, leg_x=0.0, mitt=1.0, armor=False, glow=False, hips=1.0),
    "tank": dict(torso=1.3, depth=1.38, limb=1.32, quilt=2.3, collar=1.45, arm_x=0.1, leg_x=0.05, mitt=1.1, armor=False, glow=False, hips=1.25),
    "anchor": dict(torso=1.05, depth=1.05, limb=1.05, quilt=1.0, collar=1.0, arm_x=0.02, leg_x=0.01, mitt=1.02, armor=True, glow=False, hips=1.03),
    # GLASS CANNON: clearly slimmer (round 2's note: 15-20 % narrower torso, sleeves and legs) and a cool glowing trim
    "glass": dict(torso=0.66, depth=0.7, limb=0.6, quilt=0.7, collar=0.78, arm_x=-0.08, leg_x=-0.05, mitt=0.92, armor=False, glow=True, hips=0.72, trim=True),
}

HEAD_C = np.array([0.0, 0.0, 1.52])
HEAD_S = 0.44   # squircle half size (11 grid units)
HEAD_D = 0.43   # half depth
VISOR = dict(w=0.76, h=0.47, r=0.18, z=1.45)


def squircle_radius_table():
    """Polar radius of the squircle from bot.ts (M16 5c8.5 0 11 2.5 11 11...), normalized to 11."""
    p0, p1, p2, p3 = (0, 11), (8.5, 11), (11, 8.5), (11, 0)
    ang, rad = [], []
    for i in range(401):
        t = i / 400
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
        x = a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0]
        y = a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]
        ang.append(math.atan2(y, x))
        rad.append(math.hypot(x, y) / 11)
    o = np.argsort(ang)
    return np.array(ang)[o], np.array(rad)[o]


class Char:
    pass


def build_character(build="balanced", hair=True):
    global COLL
    P = BUILDS[build]
    ch = Char()
    ch.build = build
    COLL = bpy.data.collections.new("Bot-" + build)
    bpy.context.scene.collection.children.link(COLL)
    ch.coll = COLL
    ch.parts = {}  # name -> (object, weight rule)
    ch.fabric = []  # (object, hair length)
    ch.marks = {}
    ch.faces = {}

    M = dict(
        suit=fabric_mat("Suit"),
        # glowing mitts (GLASS CANNON) are their own fixed color: the glow is the build's cue, not the fighter's color
        mitt=(fabric_mat("Mitt glow", "#ff7a2a", emission="#ff5a00") if P["glow"] else fabric_mat("Mitt", tint_hsv=(-0.025, 1.05, 0.78))),
        fleece=fabric_mat("Fleece", FLEECE, rough=0.95, fuzz_bump=0.6, felt=0.6, scale=0.8, sheen=1.0),
        patch=fabric_mat("Patch", BROWN, rough=0.85, sheen=0.7, fuzz_bump=0.25, felt=0.15, sss=0.0),
        belt=fabric_mat("Belt", "#5e321c", rough=0.6, sheen=0.4, fuzz_bump=0.15, felt=0.05, sss=0.0),
        thread=fabric_mat("Thread", THREAD, rough=0.7, sheen=0.5, fuzz_bump=0.1, felt=0.0, sss=0.0),
        boot=boot_mat(),
        rim=glossy_mat("Rim", None, (0.0, 1.0, 0.97), rough=0.42, coat=0.35, spec=0.4),
        glass=glossy_mat("Visor", GLASS, rough=0.06, coat=1.0, spec=0.7),
        gold=glossy_mat("Buckle", GOLD, rough=0.22, coat=0.8, metal=0.55, spec=0.6),
        led=emit_mat("LED", LED, 3.2),
        led_off=glossy_mat("LED off", "#0f1218", rough=0.7, coat=0.0, spec=0.05),
        ball=emit_mat("Antenna ball", "#fff0c4", 4.0),
        armor=glossy_mat("Armor", None, (-0.01, 1.08, 0.72), rough=0.16, coat=1.0, spec=0.6),
        silver=glossy_mat("Rivet", "#c9cdd4", rough=0.2, coat=0.3, metal=1.0),
        rubber=glossy_mat("Sole", "#2c1a12", rough=0.55, coat=0.0, spec=0.3),
        band=fabric_mat("Headband", "#5c1f1b", rough=0.9, sheen=0.8),
        inner_ear=fabric_mat("Inner ear", "#f3c6b0", rough=0.95, sheen=1.0, fuzz_bump=0.4),
        trim=fabric_mat("Trim", "#9df2ff", rough=0.7, sheen=0.8, fuzz_bump=0.3, emission="#4fd8ff"),
    )
    if P["glow"]:
        # glowing mitts: the stuffing lights up through the fabric
        mt = M["mitt"].node_tree
        pr = [n for n in mt.nodes if n.type == "BSDF_PRINCIPLED"][0]
        pr.inputs["Emission Strength"].default_value = 1.3
    ch.M = M
    stitches = Builder()

    def part(ob, rule, hair_len=None):
        ch.parts[ob.name] = (ob, rule)
        if hair_len:
            ch.fabric.append((ob, hair_len))
        return ob

    # ---- head: squircle front profile, soft front-to-back
    ang, rad = squircle_radius_table()
    d, f = cube_sphere(56 if not QUICK else 32)
    phi = np.arctan2(d[:, 2], d[:, 0])
    fa = np.abs(np.arctan2(np.abs(d[:, 2]), np.abs(d[:, 0])))  # symmetric quadrant angle
    # the squircle, softened toward a circle (a stuffed head rounds out), a little wider than tall
    R = (0.55 * np.interp(fa, ang, rad) + 0.45) * HEAD_S
    R = R / np.sqrt((np.cos(phi) / 1.05) ** 2 + (np.sin(phi) / 0.97) ** 2)
    rho = np.sqrt(d[:, 0] ** 2 + d[:, 2] ** 2)
    q = 2.3
    t = ((rho / R) ** q + (np.abs(d[:, 1]) / HEAD_D) ** q) ** (-1 / q)
    hv = d * t[:, None] + HEAD_C
    head = mesh_obj("Head", hv, f, M["suit"])
    # four plush panels: the seams pinch in (plane x = 0 over the top and back, plane y = 0.02 at the sides)
    def head_pinch(co, n):
        rel = co - HEAD_C
        top_back = (rel[:, 2] > VISOR["h"] / 2 + VISOR["z"] - HEAD_C[2] + 0.03) | (rel[:, 1] > 0)
        dx = np.where(top_back, np.abs(rel[:, 0]), 9)
        dy = np.abs(rel[:, 1] - 0.02)
        pinch = 0.014 * np.exp(-(dx / 0.022) ** 2) + 0.012 * np.exp(-(dy / 0.022) ** 2)
        puff = 0.008 * np.exp(-((np.abs(rel[:, 0]) - 0.2) / 0.12) ** 2)
        return -pinch + puff * 0
    displace(head, head_pinch)
    part(head, ("bone", "head"), 0.013)
    hb = bvh_of(head)
    hs = surf_fn(hb, 0.1)
    vz = VISOR["z"]
    top = HEAD_C[2] + HEAD_S + 0.02
    # seam over the top and down the back
    pts = radial_path(hb, HEAD_C, (0, 1, 0), (0, 0, 1), -0.85, math.pi - math.atan2(vz + VISOR["h"] / 2 + 0.07 - HEAD_C[2], HEAD_D), 160)
    stitch_path(stitches, pts, hs)
    for sx in (1, -1):
        pts = radial_path(hb, HEAD_C + np.array([0, 0.02, 0]), (sx, 0, 0), (0, 0, 1), -0.7, math.pi / 2 - 0.02, 140)
        stitch_path(stitches, pts, hs)

    # ---- visor: outline in the front plane, projected onto the head
    out2 = rounded_rect_2d(VISOR["w"], VISOR["h"], VISOR["r"], 14)
    out2 = resample(out2, 0.008, closed=True)
    rim_p, rim_n = [], []
    for x, z in out2:
        hit = hb.ray_cast(Vector((x, -3, vz + z)), Vector((0, 1, 0)), 6)
        rim_p.append(tuple(hit[0]))
        rim_n.append(tuple(hit[1]))
    rv, rf = sweep(rim_p, rim_n, circle(0.03, 16, rb=0.043, ca=0.013))
    rim = mesh_obj("Visor rim", rv, rf, M["rim"])
    part(rim, ("bone", "head"))
    # glass: concentric loops inside the outline, bulging a little
    K = 12
    gv, gf = [], []
    cen = hb.ray_cast(Vector((0, -3, vz)), Vector((0, 1, 0)), 6)
    gv.append(tuple(cen[0] + cen[1] * 0.024))
    nO = len(out2)
    for k in range(1, K + 1):
        r = k / K
        for x, z in out2:
            hit = hb.ray_cast(Vector((x * r, -3, vz + z * r)), Vector((0, 1, 0)), 6)
            gv.append(tuple(hit[0] + hit[1] * (0.004 + 0.02 * (1 - r ** 2.2))))
    for i in range(nO):
        gf.append([0, 1 + i, 1 + (i + 1) % nO])
    for k in range(K - 1):
        b0, b1 = 1 + k * nO, 1 + (k + 1) * nO
        for i in range(nO):
            j = (i + 1) % nO
            gf.append([b0 + i, b1 + i, b1 + j, b0 + j])
    glass = mesh_obj("Visor glass", gv, gf, M["glass"], recalc=False)
    orient_out(glass, (0, -1, 0))
    part(glass, ("bone", "head"))
    gb = bvh_of(glass)
    # LED grid: lit dots per expression, plus the faint unlit grid
    sp = 0.05
    cols, rows = 13, 7
    on_all = set()
    for name, pat in FACES.items():
        B = Builder()
        for r_, line in enumerate(pat):
            for c_, ch_ in enumerate(line):
                if ch_ == "#":
                    on_all.add((r_, c_))
                    add_led(B, gb, (c_ - (cols - 1) / 2) * sp, vz + ((rows - 1) / 2 - r_) * sp - 0.005, 0.0195)
        ob = B.obj("Face " + name, M["led"])
        part(ob, ("bone", "head"))
        ch.faces[name] = ob
    B = Builder()
    for r_ in range(rows):
        for c_ in range(cols):
            add_led(B, gb, (c_ - (cols - 1) / 2) * sp, vz + ((rows - 1) / 2 - r_) * sp - 0.005, 0.011, lift=0.0008)
    grid = B.obj("LED grid", M["led_off"])
    part(grid, ("bone", "head"))

    # ---- torso: quilted chevrons
    tz = 0.86
    ta, ty = 0.38 * P["torso"], 0.285 * P["depth"]
    tv, tf = superellipsoid(64 if not QUICK else 40, (0, 0, tz), ta, ty, ty * 0.97, 0.31, 0.31, p=2.4, q=2.6)
    torso = mesh_obj("Torso", tv, tf, M["suit"])
    qd = 0.02 * P["quilt"]

    def chevron(co, n, cz=tz, freq=9.0, slope=0.55, depth=qd):
        u = (co[:, 2] - cz) * freq + slope * np.abs(co[:, 0]) * freq
        fr = u - np.floor(u)
        puff = np.sin(np.pi * fr) ** 0.55
        return depth * (puff - 0.6)
    displace(torso, chevron)
    part(torso, ("bone", "torso"), 0.014)

    # ---- hips: quilted rings
    hz = 0.52
    hv, hf = superellipsoid(48 if not QUICK else 32, (0, 0, hz), 0.33 * P["hips"], 0.25 * P["depth"], 0.26 * P["depth"], 0.15, 0.13, p=2.4, q=2.4)
    hips = mesh_obj("Hips", hv, hf, M["suit"])
    displace(hips, lambda co, n: chevron(co, n, cz=hz + 0.02, freq=10, slope=0.35, depth=qd * 0.8))
    part(hips, ("bone", "hips"), 0.014)
    torso_hips_bvh = bvh_of(torso, hips)

    # ---- belt: hugs the torso/hips at its height
    bz = 0.63
    ring_p, ring_n = [], []
    for i in range(160):
        a = 2 * math.pi * i / 160
        dvec = Vector((math.cos(a), math.sin(a), 0))
        hit = torso_hips_bvh.ray_cast(Vector((0, 0, bz)) + dvec * 2, -dvec, 4)
        ring_p.append(tuple(hit[0]))
        ring_n.append(tuple(dvec))
    ring_p = np.array(ring_p)
    # smooth the ring radius (the quilting makes it bumpy)
    rr = np.linalg.norm(ring_p[:, :2], axis=1)
    rr = np.convolve(np.concatenate([rr[-8:], rr, rr[:8]]), np.ones(9) / 9, mode="same")[8:-8] + 0.004
    ang_ = np.arctan2(ring_p[:, 1], ring_p[:, 0])
    ring_p = np.stack([rr * np.cos(ang_), rr * np.sin(ang_), np.full_like(rr, bz)], axis=1)
    belt_prof = [(a, b) for a, b in rounded_rect_2d(0.07, 0.125, 0.022, 5)]
    belt_prof = [(a + 0.012, b) for a, b in belt_prof]
    bv, bf = sweep(ring_p, ring_n, belt_prof)
    belt = mesh_obj("Belt", bv, bf, M["belt"])
    part(belt, ("bone", "hips"))
    bb = bvh_of(belt)
    for dz in (0.042, -0.042):
        pts = [tuple(p + np.array(nn) * 0.06 + np.array([0, 0, dz])) for p, nn in zip(ring_p, ring_n)]
        stitch_path(stitches, pts, surf_fn(bb, 0.1), dash=0.03, gap=0.018, closed=True)
    # buckle at the front
    front = ring_p[np.argmin(ring_p[:, 1])]
    fz = front + np.array([0, -0.052, 0])
    bk = rounded_rect_2d(0.2, 0.15, 0.045, 8)
    bk_p = [(fz[0] + x, fz[1], fz[2] + z) for x, z in bk]
    bk_n = [(0, -1, 0)] * len(bk_p)
    bv, bf = sweep(bk_p, bk_n, rounded_rect_2d(0.03, 0.036, 0.012, 4))
    Bk = Builder()
    Bk.add(bv, bf)
    pv, pf = lathe([(0, 0), (0.0, 0.013), (0.11, 0.013), (0.11, 0)], 12)
    Bk.add(align(pv, (fz[0] - 0.03, fz[1] - 0.006, fz[2] - 0.055), (fz[0] - 0.03, fz[1] - 0.006, fz[2] + 0.055)), pf)
    buckle = Bk.obj("Buckle", M["gold"])
    part(buckle, ("bone", "hips"))

    # ---- collar: a lumpy fleece roll
    cz = 1.105
    cp, cn = [], []
    cr = 0.255 * P["collar"] ** 0.5
    for i in range(140):
        a = 2 * math.pi * i / 140
        cp.append((cr * math.cos(a), cr * 0.9 * math.sin(a), cz))
        cn.append((math.cos(a), math.sin(a), 0))
    cv, cf = sweep(cp, cn, circle(0.088 * P["collar"], 20, rb=0.074 * P["collar"]))
    collar = mesh_obj("Collar", cv, cf, M["fleece"])
    displace(collar, lambda co, n: 0.008 * np.sin(np.arctan2(co[:, 1], co[:, 0]) * 9) * (0.7 + 0.3 * np.cos(co[:, 2] * 50)))
    part(collar, ("bone", "torso"), 0.02)

    # ---- arms (straight at rest: shoulder -> wrist), sleeves deform at the elbow
    lr = P["limb"]
    ch.limb = {}
    for side, sx in (("L", 1), ("R", -1)):
        sh = np.array([sx * (0.35 * P["torso"] + P["arm_x"] * 0.5), 0.0, 0.99])
        wr = np.array([sx * (0.5 * P["torso"] ** 0.6 + P["arm_x"]), -0.02, 0.74])
        el = (sh + wr) / 2 + np.array([0, 0.01, 0])
        L_ = np.linalg.norm(wr - sh)
        prof = [(-0.07, 0)]
        for i in range(17):
            tt = i / 16
            r0 = (0.135 + (0.112 - 0.135) * tt) * lr
            prof.append((-0.05 + tt * (L_ + 0.02), r0))
        prof.append((L_ + 0.04, 0))
        # round the ends
        prof = [(z, r * (1 if 0 < k < len(prof) - 1 else 0)) for k, (z, r) in enumerate(prof)]
        prof[1] = (prof[1][0], prof[1][1] * 0.6)
        prof[-2] = (prof[-2][0], prof[-2][1] * 0.8)
        av, af = lathe(prof, 40)
        av = align(av, sh, wr)
        sleeve = mesh_obj("Sleeve." + side, av, af, M["suit"])
        smooth_mesh(sleeve, 2)
        axis = (wr - sh) / L_
        displace(sleeve, lambda co, n, sh=sh, axis=axis: 0.015 * P["quilt"] * (np.sin(np.pi * (((co - sh) @ axis) * 10 % 1.0)) ** 0.6 - 0.6))
        ch.limb[side + "arm"] = (sh, el, wr)
        part(sleeve, ("limb", "upperarm." + side, "forearm." + side, sh, el, wr), 0.013)
        # cuff
        cc = sh + axis * (L_ * 0.82)
        u = np.cross(axis, (0, 1, 0))
        u /= np.linalg.norm(u)
        w = np.cross(axis, u)
        cp, cn = [], []
        rc = 0.115 * lr + 0.012
        for i in range(64):
            a = 2 * math.pi * i / 64
            dd = u * math.cos(a) + w * math.sin(a)
            cp.append(tuple(cc + dd * rc))
            cn.append(tuple(dd))
        cv, cf = sweep(cp, cn, circle(0.05 * lr ** 0.5, 16, rb=0.042))
        cuff = mesh_obj("Cuff." + side, cv, cf, M["trim"] if P.get("trim") else M["fleece"])
        displace(cuff, lambda co, n, cc=cc: 0.007 * np.sin(np.arctan2(*(((co - cc) @ np.stack([u, w], 1)).T[::-1])) * 9))
        part(cuff, ("bone", "forearm." + side), 0.02)
        # mitt: a padded blob with a thumb (metaballs), hanging below the wrist
        ms = P["mitt"]
        mc = wr + np.array([sx * 0.04, -0.02, -0.17 * ms])
        hx, hy, hz_ = 0.19 * ms, 0.2 * ms, 0.215 * ms
        mitt = metaball_mesh("Mitt." + side, [
            ("ELLIPSOID", (0, 0, 0), 0.32, (1.0, 1.05, 1.15)),
            ("ELLIPSOID", (0, 0, -0.08), 0.26, (1.05, 1.08, 0.9)),
            ("BALL", (-sx * 0.1, -0.15, 0.05), 0.15, None),
        ], res=0.02 if not QUICK else 0.035, bbox=(mc, (hx, hy * 1.06, hz_)))
        mitt.data.materials.append(M["mitt"])
        part(mitt, ("bone", "hand." + side), 0.012)
        mb_ = bvh_of(mitt)
        # the center seam around the mitt, and the thumb seam
        pts = radial_path(mb_, mc, (0, -1, 0), (0, 0, 1), -math.pi * 0.95, math.pi * 0.95, 120)
        stitch_path(stitches, pts, surf_fn(mb_, 0.1), dash=0.03, gap=0.018)
        tc_ = mc + np.array([-sx * 0.075 * ms, -0.11 * ms, 0.02])
        pts = radial_path(mb_, tc_, (sx * 0.0 - sx, 0, 0.0), (0, 0, 1), -1.6, 1.4, 60)
        stitch_path(stitches, pts, surf_fn(mb_, 0.1), dash=0.026, gap=0.016)
        ch.limb[side + "hand"] = (wr, mc)

    # ---- legs (hip -> ankle, straight at rest), knees deform
    for side, sx in (("L", 1), ("R", -1)):
        hp = np.array([sx * (0.18 + P["leg_x"]), 0.0, 0.52])
        an = np.array([sx * (0.215 + P["leg_x"]), 0.0, 0.17])
        kn = (hp + an) / 2 + np.array([0, -0.012, 0])
        L_ = np.linalg.norm(an - hp)
        prof = [(-0.06, 0)]
        for i in range(17):
            tt = i / 16
            prof.append((-0.04 + tt * (L_ + 0.03), (0.158 + (0.142 - 0.158) * tt) * lr))
        prof.append((L_ + 0.05, 0))
        prof[1] = (prof[1][0], prof[1][1] * 0.6)
        av, af = lathe(prof, 40)
        av = align(av, hp, an)
        leg = mesh_obj("Leg." + side, av, af, M["suit"])
        smooth_mesh(leg, 2)
        axis = (an - hp) / L_
        displace(leg, lambda co, n, hp=hp, axis=axis: 0.016 * P["quilt"] * (np.sin(np.pi * (((co - hp) @ axis) * 9 % 1.0)) ** 0.6 - 0.6))
        ch.limb[side + "leg"] = (hp, kn, an)
        part(leg, ("limb", "thigh." + side, "shin." + side, hp, kn, an), 0.014)
        # boot
        bs = 1.12 if P["armor"] else 1.0
        lift = 0.035 if P["armor"] else 0.0
        bc = np.array([sx * (0.225 + P["leg_x"]), -0.05, 0.11 * bs + lift])
        boot = metaball_mesh("Boot." + side, [
            ("ELLIPSOID", (0, -0.05, 0), 0.3, (1.0, 1.35, 0.7)),
            ("ELLIPSOID", (0, 0.06, 0.06), 0.25, (1.0, 1.0, 1.0)),
        ], res=0.02 if not QUICK else 0.035, bbox=(bc, (0.175 * bs, 0.26 * bs, 0.11 * bs)))
        co = get_co(boot)
        floor = lift + 0.0
        co[:, 2] = np.maximum(co[:, 2], floor + (co[:, 2] - floor) * 0.15)  # flat sole
        set_co(boot, co)
        smooth_mesh(boot, 1, 0.3)
        boot.data.materials.append(M["boot"])
        part(boot, ("bone", "foot." + side), 0.006)
        btb = bvh_of(boot)
        # stitch line around the boot, above the sole
        pts = []
        for i in range(120):
            a = 2 * math.pi * i / 120
            dvec = Vector((math.cos(a) * 0.175 * bs, math.sin(a) * 0.26 * bs, 0)).normalized()
            hit = btb.ray_cast(Vector((bc[0], bc[1], lift + 0.07 * bs)) + dvec * 1.0, -dvec, 2)
            if hit[0] is not None:
                pts.append(tuple(hit[0]))
        stitch_path(stitches, pts, surf_fn(btb, 0.1), dash=0.026, gap=0.016, closed=True)
        if P["armor"]:
            # chunky treaded sole
            sv, sf = superellipsoid(32, (bc[0], bc[1] - 0.01, 0.024), 0.178 * bs, 0.265 * bs, 0.25 * bs, 0.026, 0.024, p=2.3, q=3.5)
            sole = mesh_obj("Sole." + side, sv, sf, M["rubber"])
            displace(sole, lambda co, n: -0.012 * (np.sin(co[:, 1] * 90) > 0.3) * (co[:, 2] < 0.012))
            part(sole, ("bone", "foot." + side))
        ch.limb[side + "foot"] = (an, bc)

    legs_bvh = {s: bvh_of(ch.parts["Leg." + s][0]) for s in "LR"}

    # ---- patches: brown, X-stitched
    patches = Builder()
    patch_list = []
    if not P["armor"]:
        for sx in (1, -1):
            s_ = "L" if sx > 0 else "R"
            sh, el, wr = ch.limb[s_ + "arm"]
            c = sh + np.array([0, -0.02, 0.02])
            # the shoulder cap sits where the sleeve meets the torso: cast against both
            patch_list.append(("Patch.sh." + s_, bvh_of(torso, ch.parts["Sleeve." + s_][0]),
                               c, (sx * 0.72, -0.3, 0.62), (0, 0.3, 1), 0.105 * P["limb"] ** 0.5, 0.1, ("bone", "upperarm." + s_)))
    for s, sx in (("L", 1), ("R", -1)):
        if P["armor"]:
            continue
        hp, kn, an = ch.limb[s + "leg"]
        c = kn + np.array([0, -0.05, -0.01])
        patch_list.append(("Patch.kn." + s, ch.parts["Leg." + s][0], c, (0, -1, 0.05), (1, 0, -0.3 * sx), 0.068, 0.064,
                           ("limb", "thigh." + s, "shin." + s, hp, kn, an)))
    for name, target, c, nd, t1, w, h, rule in patch_list:
        tb = target if isinstance(target, BVHTree) else bvh_of(target)
        pv, pf = surface_patch(tb, c, nd, t1, w, h, 0.016, nexp=3.2)
        if pv is None:
            print("patch failed", name)
            continue
        ob = mesh_obj(name, pv, pf, M["patch"], recalc=False)
        orient_out(ob, nd)
        part(ob, rule)
        pb_ = bvh_of(ob)
        # X: two thick threads corner to corner
        nd_v = Vector(nd).normalized()
        t1v = (Vector(t1) - nd_v * Vector(t1).dot(nd_v)).normalized()
        t2v = nd_v.cross(t1v)
        Bx = Builder()
        for d1, d2 in ((1, 1), (1, -1)):
            pts = []
            for i in range(13):
                k = -0.55 + 1.1 * i / 12
                o = Vector(c) + t1v * (w * k * d1) + t2v * (h * k * d2) + nd_v * 1.0
                hit = pb_.ray_cast(o, -nd_v, 2)
                if hit[0] is not None:
                    pts.append((hit[0] + hit[1] * 0.004, hit[1]))
            if len(pts) > 2:
                sv, sf = sweep([p for p, _ in pts], [n for _, n in pts], circle(0.0075, 8, rb=0.0095), closed=False)
                Bx.add(sv, sf)
        xo = Bx.obj(name + ".x", M["thread"])
        if xo:
            part(xo, rule)

    # ---- hips front seam, sleeve seams are the quilting itself
    pts = radial_path(bvh_of(hips), (0, 0, hz + 0.02), (0, -1, 0), (0, 0, 1), -1.2, -0.25, 40)
    stitch_path(stitches, pts, surf_fn(bvh_of(hips), 0.1), dash=0.028, gap=0.016)

    # ---- anchor armor
    if P["armor"]:
        rivets = Builder()
        armor_parts = []

        def plate(name, target, c, nd, t1, w, h, thick, rule, hf=None, riv=()):
            pv, pf = surface_patch(target, c, nd, t1, w, h, thick, nexp=3.5, embed=0.004, bulge=0.25, height_fn=hf)
            if pv is None:
                print("plate failed", name)
                return
            ob = mesh_obj(name, pv, pf, M["armor"], recalc=False)
            orient_out(ob, nd)
            part(ob, rule)
            pb_ = bvh_of(ob)
            nd_v = Vector(nd).normalized()
            t1v = (Vector(t1) - nd_v * Vector(t1).dot(nd_v)).normalized()
            t2v = nd_v.cross(t1v)
            Br = Builder()
            for ku, kv in riv:
                o = Vector(c) + t1v * (w * ku) + t2v * (h * kv) + nd_v * 1.0
                hit = pb_.ray_cast(o, -nd_v, 2)
                if hit[0] is not None:
                    v, f = ellipsoid_unit()
                    tt, nn, bb2 = frame_from(np.array(t1v), np.array(hit[1]))
                    Mx = np.stack([tt * 0.019, bb2 * 0.019, nn * 0.012], axis=1)
                    Br.add(v @ Mx.T + np.array(hit[0]), f)
            ro = Br.obj(name + ".rivets", M["silver"])
            if ro:
                part(ro, rule)

        corners = ((0.72, 0.72), (-0.72, 0.72), (0.72, -0.72), (-0.72, -0.72))
        plate("Armor.chest", torso_hips_bvh, (0, -0.25, 0.86), (0, -1, 0.1), (1, 0, 0), 0.25, 0.2, 0.045, ("bone", "torso"),
              hf=lambda x, y: 0.008 * math.cos((y + 0.7 * abs(x)) * 30), riv=corners)
        for s, sx in (("L", 1), ("R", -1)):
            tb = torso_and_arm(ch, s, torso)
            plate("Armor.sh." + s, tb, (sx * 0.38, -0.02, 1.02), (sx * 0.62, -0.2, 0.76), (0, 1, 0), 0.2, 0.18, 0.075,
                  ("bone", "upperarm." + s), riv=((0.0, 0.6), (0.0, -0.6)))
            hp, kn, an = ch.limb[s + "leg"]
            c = kn + (an - kn) * 0.35 + np.array([0, -0.06, 0])
            plate("Armor.shin." + s, legs_bvh[s], c, (0, -1, 0.0), (1, 0, 0), 0.105, 0.135, 0.04,
                  ("limb", "thigh." + s, "shin." + s, hp, kn, an), riv=((0.0, 0.62), (0.0, -0.6)))

    # ---- head marks
    # antenna: a collar on the head, a stalk, a ring and a glowing ball
    ant = Builder()
    topz = head_top(hb)
    av, af = lathe([(0, 0), (0.0, 0.05), (0.02, 0.045), (0.035, 0.025), (0.035, 0)], 24)
    ant.add(av + np.array([0, 0, topz - 0.025]), af)
    av, af = lathe([(0, 0), (0.0, 0.021), (0.25, 0.021), (0.25, 0)], 16)
    ant.add(av + np.array([0, 0, topz]), af)
    ring_c = np.array([0, 0, topz + 0.31])
    rp = [tuple(ring_c + np.array([0.078 * math.cos(a), 0, 0.078 * math.sin(a)])) for a in np.linspace(0, 2 * math.pi, 48, endpoint=False)]
    rn = [tuple((np.array(p) - ring_c) / 0.078) for p in rp]
    rv, rf = sweep(rp, rn, circle(0.027, 12))
    ant.add(rv, rf)
    ao = ant.obj("Antenna", M["rim"])
    part(ao, ("bone", "antenna"))
    v, f = cube_sphere(10)
    ball = mesh_obj("Antenna ball", v * 0.056 + ring_c + np.array([0, -0.004, 0]), f, M["ball"])
    part(ball, ("bone", "antenna"))
    ch.marks["antenna"] = [ao, ball]
    ch.antenna_base = np.array([0, 0, topz])

    # cat ears: rounded triangular cones with a lighter inner ear
    ears = []
    for s, sx in (("L", 1), ("R", -1)):
        prof = [(0, 0)] + [(z, (0.15 * (1 - z / 0.26) ** 0.9 + 0.012)) for z in np.linspace(0, 0.25, 14)] + [(0.262, 0)]
        ev, ef = lathe(prof, 40)
        ev[:, 1] *= 0.42
        rot = np.array(Euler((0, math.radians(-sx * 24), 0)).to_matrix())
        base = np.array([sx * 0.29, 0.0, 1.83])
        ev = ev @ rot.T + base
        ear = mesh_obj("Ear." + s, ev, ef, M["suit"])
        part(ear, ("bone", "head"), 0.012)
        iv, if_ = lathe([(0, 0)] + [(z, (0.1 * (1 - z / 0.2) ** 0.9 + 0.008)) for z in np.linspace(0, 0.19, 10)] + [(0.2, 0)], 32)
        iv[:, 1] *= 0.25
        iv = iv @ rot.T + base + np.array([sx * 0.0, -0.04, 0.02])
        inner = mesh_obj("Inner ear." + s, iv, if_, M["inner_ear"])
        part(inner, ("bone", "head"), 0.01)
        ears += [ear, inner]
    ch.marks["catears"] = ears

    # headband: a band around the head above the visor, a knot and two tails
    hbz = vz + VISOR["h"] / 2 + 0.105
    hp_, hn_ = [], []
    for i in range(140):
        a = 2 * math.pi * i / 140
        dvec = Vector((math.cos(a), math.sin(a), 0))
        hit = hb.ray_cast(Vector((0, 0, hbz)) + dvec * 2, -dvec, 4)
        hp_.append(tuple(hit[0]))
        hn_.append(tuple(dvec))
    bv, bf = sweep(hp_, hn_, [(a + 0.008, b) for a, b in rounded_rect_2d(0.045, 0.1, 0.018, 4)])
    band = mesh_obj("Headband", bv, bf, M["band"])
    part(band, ("bone", "head"), 0.01)
    # the knot sits on the band at the back-right of the head (snap it to the surface, so it never floats)
    kd = Vector((-0.3, 0.33, 0)).normalized()
    khit = hb.ray_cast(Vector((0, 0, hbz)) + kd * 2, -kd, 4)
    kc = np.array(khit[0] + kd * 0.05) if khit[0] is not None else np.array([-0.3, 0.33, hbz])
    kv, kf = superellipsoid(10, kc, 0.06, 0.05, 0.05, 0.055, 0.055)
    knot = mesh_obj("Headband knot", kv, kf, M["band"])
    part(knot, ("bone", "head"), 0.01)
    tails = []
    for k, (dz, ang_t) in enumerate(((0.03, 0.25), (-0.035, -0.2))):
        pts, nrm = [], []
        for i in range(12):
            tt = i / 11
            # start inside the knot, then flutter out behind the head
            p_ = kc + np.array([-0.01 - 0.36 * tt, 0.01 + 0.13 * tt, dz * min(1, tt * 4) + ang_t * 0.35 * tt + 0.04 * math.sin(tt * 5)])
            pts.append(p_)
            nrm.append((0, 1, 0.3))
        prof = [(a, b) for a, b in rounded_rect_2d(0.014, 0.07, 0.006, 3)]
        tv_, tf_ = sweep(pts, nrm, [(a, b * (1.0)) for a, b in prof], closed=False)
        t_ob = mesh_obj("Headband tail %d" % k, tv_, tf_, M["band"])
        # taper the tail toward its end
        co = get_co(t_ob)
        part(t_ob, ("bone", "head"))
        tails.append(t_ob)
    ch.marks["headband"] = [band, knot] + tails
    build_more_marks(ch, M, part, hb, head, hbz)

    so = stitches.obj("Stitches", M["thread"])
    ch.stitches = so
    ch.stitch_groups = stitches.groups
    ch.parts[so.name] = (so, ("nearest",))

    build_rig(ch)
    if hair:
        add_fuzz(ch)
    set_head(ch, "antenna")
    set_face(ch, "angry")
    return ch


# ---------------------------------------------------------------- more head marks (#85 rollout phase 1)
# The code bots' major marks (src/sim/identity.ts MAJOR_MARKS) on the plush head. Every mark is its own set of
# objects in ch.marks; the sprite pass renders each one as an overlay layer (plush_sprites.py). Body-colored parts
# use the tinted materials (Suit, SuitDark), so the viewer colors them with the fighter.

def taper_tube(pts, radii, seg=16, hint=(0.0, 0.0, 1.0), flat=1.0):
    """A tube along pts with a radius per point, capped at both ends (horns, stems, spikes)."""
    pts = np.asarray(pts, float)
    n = len(pts)
    verts, faces = [], []
    h = np.asarray(hint, float)
    for i in range(n):
        t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        t /= np.linalg.norm(t)
        a = np.cross(t, h)
        if np.linalg.norm(a) < 1e-4:
            a = np.cross(t, (1.0, 0, 0))
        a /= np.linalg.norm(a)
        b = np.cross(t, a)
        for k in range(seg):
            ang = 2 * math.pi * k / seg
            verts.append(pts[i] + radii[i] * (math.cos(ang) * a * flat + math.sin(ang) * b))
    for i in range(n - 1):
        for k in range(seg):
            k1 = (k + 1) % seg
            faces.append([i * seg + k, i * seg + k1, (i + 1) * seg + k1, (i + 1) * seg + k])
    verts.append(pts[0])
    c0 = len(verts) - 1
    for k in range(seg):
        faces.append([c0, (k + 1) % seg, k])
    verts.append(pts[-1])
    c1 = len(verts) - 1
    b0 = (n - 1) * seg
    for k in range(seg):
        faces.append([c1, b0 + k, b0 + (k + 1) % seg])
    return np.array(verts), faces


def build_more_marks(ch, M, part, hb, head, hbz):
    def surf(x, y):
        hit = hb.ray_cast(Vector((x, y, 5)), Vector((0, 0, -1)), 10)
        return np.array(hit[0]), np.array(hit[1])

    topz = head_top(hb)
    mats = dict(
        dark=fabric_mat("SuitDark", tint_hsv=(0.0, 1.0, 0.62)),
        horn=glossy_mat("Horn", "#efe2c2", rough=0.38, coat=0.5, spec=0.5),
        horn_ring=glossy_mat("Horn ring", "#cdb88e", rough=0.5, coat=0.3, spec=0.4),
        gem=glossy_mat("Gem", "#ff3d5e", rough=0.08, coat=1.0, spec=0.8),
        crown=glossy_mat("Crown", "#ffcf3a", rough=0.25, coat=0.8, metal=0.6, spec=0.6),
        prop_cap=fabric_mat("Prop cap", "#3a5bd9", rough=0.9),
        blade_y=glossy_mat("Blade yellow", "#ffd23f", rough=0.3, coat=0.6),
        blade_r=glossy_mat("Blade red", "#ff5a5a", rough=0.3, coat=0.6),
        ink=glossy_mat("Ink", "#20232b", rough=0.4, coat=0.3),
        halo=emit_mat("Halo", "#ffe066", 3.0),
        pom=fabric_mat("Pom", "#f4f1ea", rough=0.95, fuzz_bump=0.7, felt=0.6),
        bow=fabric_mat("Bow", "#ff6fa8", rough=0.55, sheen=0.9, fuzz_bump=0.12, felt=0.05),
        bow_knot=fabric_mat("Bow knot", "#d94a85", rough=0.6, sheen=0.9, fuzz_bump=0.12, felt=0.05),
        leaf=fabric_mat("Leaf", "#6fdc5a", rough=0.8, sheen=0.6, fuzz_bump=0.2),
        stem=fabric_mat("Stem", "#3f9a3a", rough=0.8, sheen=0.5, fuzz_bump=0.2),
        hat=fabric_mat("Top hat", "#1d1f27", rough=0.85, sheen=0.9, fuzz_bump=0.2, felt=0.1),
    )
    ch.M.update(mats)

    # crown: a gold band with five points on the top of the head, a ball on each point, a red gem in front
    N, R0 = 120, 0.2
    vs, fs = [], []
    for i in range(N):
        a = 2 * math.pi * i / N
        x, y = R0 * math.cos(a), R0 * math.sin(a)
        p, _ = surf(x, y)
        z0 = p[2] - 0.03
        # point heights: peaks where the phase is 0 (front, then every 72 degrees)
        u = ((a + math.pi / 2) / (2 * math.pi / 5)) % 1.0
        d = min(u, 1 - u) * 2  # 0 at a peak, 1 between peaks
        h = 0.07 + 0.13 * (1 - d) ** 1.8
        o, ii = np.array([math.cos(a), math.sin(a), 0]), np.array([math.cos(a), math.sin(a), 0]) * -0.026
        flare = 0.03 * (h / 0.2)
        vs += [(x, y, z0), (x + o[0] * flare, y + o[1] * flare, z0 + h), (x + o[0] * flare + ii[0], y + o[1] * flare + ii[1], z0 + h - 0.004),
               (x + ii[0], y + ii[1], z0)]
    for i in range(N):
        j = (i + 1) % N
        for k in range(4):
            k1 = (k + 1) % 4
            fs.append([i * 4 + k, j * 4 + k, j * 4 + k1, i * 4 + k1])
    crown = mesh_obj("Crown", np.array(vs), fs, mats["crown"])
    crown_parts = [part(crown, ("bone", "head"))]
    v, f = cube_sphere(6)
    for k in range(5):
        a = -math.pi / 2 + k * 2 * math.pi / 5
        x, y = R0 * math.cos(a), R0 * math.sin(a)
        p, _ = surf(x, y)
        c = np.array([x * 1.15, y * 1.15, p[2] - 0.03 + 0.2 + 0.018])
        crown_parts.append(part(mesh_obj("Crown ball %d" % k, v * 0.024 + c, f, mats["gem"] if k == 0 else mats["crown"]), ("bone", "head")))
    p, _ = surf(0, -R0)
    gv, gf = superellipsoid(8, (0, -R0 - 0.035, p[2] + 0.03), 0.035, 0.016, 0.01, 0.042, 0.042, p=2.0, q=2.0)
    crown_parts.append(part(mesh_obj("Crown gem", gv, gf, mats["gem"]), ("bone", "head")))
    ch.marks["crown"] = crown_parts

    # horns: two ivory horns from the top corners, curving out and up, with soft growth rings
    horns = []
    for s, sx in (("L", 1), ("R", -1)):
        p0, n0 = surf(sx * 0.27, 0.0)
        base = p0 - n0 * 0.03
        path = [base + np.array([sx * dx, dy, dz]) for dx, dy, dz in
                ((0, 0, 0), (0.06, 0, 0.07), (0.12, -0.01, 0.15), (0.15, -0.02, 0.23), (0.15, -0.03, 0.3), (0.12, -0.04, 0.36), (0.08, -0.05, 0.4))]
        path = resample(path, 0.012)
        nn = len(path)
        radii = [0.085 * (1 - i / (nn - 1)) ** 0.85 + 0.006 for i in range(nn)]
        hv, hf = taper_tube(path, radii, 20, hint=(0, 1, 0))
        horn = part(mesh_obj("Horn." + s, hv, hf, mats["horn"]), ("bone", "head"))
        horns.append(horn)
        horns.append(part(mesh_obj("Horn base." + s, *taper_tube([base - n0 * 0.0, base + n0 * 0.045], [0.1, 0.092], 20, hint=(0, 1, 0)), mats["horn_ring"]), ("bone", "head")))
    ch.marks["horns"] = horns

    # ears: round plush ears (a bear), body colored, a darker inner disc
    ears = []
    for s, sx in (("L", 1), ("R", -1)):
        c = np.array([sx * 0.31, 0.03, 1.86])
        d, f = cube_sphere(12)
        ev = d * np.array([0.14, 0.06, 0.14]) + c
        rot = np.array(Euler((0, math.radians(-sx * 22), 0)).to_matrix())
        ev = (ev - c) @ rot.T + c
        ear = part(mesh_obj("Round ear." + s, ev, f, M["suit"]), ("bone", "head"), 0.012)
        iv = d * np.array([0.085, 0.02, 0.085]) + c + np.array([0, -0.05, 0.01])
        iv = (iv - c) @ rot.T + c
        inner = part(mesh_obj("Round ear inner." + s, iv, f, mats["dark"]), ("bone", "head"))
        ears += [ear, inner]
    ch.marks["ears"] = ears

    # propeller: a blue cap on the top, a short stalk, a yellow and a red blade
    pv, pf = cube_sphere(14)
    pv = pv[:, :] * np.array([0.23, 0.23, 0.13]) + np.array([0, 0, topz - 0.035])
    cap = part(mesh_obj("Prop cap", pv, pf, mats["prop_cap"]), ("bone", "head"), 0.01)
    sv, sf = lathe([(0, 0), (0.0, 0.018), (0.2, 0.018), (0.2, 0)], 12)
    stalk = part(mesh_obj("Prop stalk", sv + np.array([0, 0, topz + 0.05]), sf, mats["ink"]), ("bone", "head"))
    hub_v, hub_f = cube_sphere(6)
    hub = part(mesh_obj("Prop hub", hub_v * 0.03 + np.array([0, 0, topz + 0.25]), hub_f, mats["ink"]), ("bone", "head"))
    blades = []
    for k, (mat, sgn) in enumerate(((mats["blade_y"], 1), (mats["blade_r"], -1))):
        bv, bf = superellipsoid(10, (sgn * 0.15, -0.02, topz + 0.25), 0.13, 0.05, 0.05, 0.012, 0.012, p=2.0, q=2.0)
        rot = np.array(Euler((math.radians(-sgn * 10), 0, math.radians(-30)), "XYZ").to_matrix())
        cc = np.array([0, 0, topz + 0.25])
        bv = (bv - cc) @ rot.T + cc
        blades.append(part(mesh_obj("Prop blade %d" % k, bv, bf, mat), ("bone", "head")))
    ch.marks["propeller"] = [cap, stalk, hub] + blades

    # mohawk: five plush spikes along the middle of the head, the middle ones tallest, body colored (darker)
    spikes = []
    for k, (y, hgt) in enumerate(((-0.27, 0.15), (-0.14, 0.23), (0.0, 0.27), (0.14, 0.24), (0.27, 0.17))):
        p, n = surf(0, y)
        n = n / np.linalg.norm(n)
        axis = n * 0.75 + np.array([0, 0, 1.0]) * 0.25
        axis /= np.linalg.norm(axis)
        path = [p - n * 0.03 + axis * hgt * t for t in np.linspace(0, 1, 10)]
        radii = [0.075 * (1 - t) ** 1.1 + 0.008 for t in np.linspace(0, 1, 10)]
        sv, sf = taper_tube(path, radii, 16, hint=(1, 0, 0), flat=0.55)
        spikes.append(part(mesh_obj("Mohawk %d" % k, sv, sf, mats["dark"]), ("bone", "head"), 0.012))
    ch.marks["mohawk"] = spikes

    # halo: a glowing gold ring floating above the head
    hc = np.array([0, 0.02, topz + 0.2])
    rp = [tuple(hc + np.array([0.2 * math.cos(a), 0.2 * math.sin(a) * 0.95, 0.02 * math.sin(a)])) for a in np.linspace(0, 2 * math.pi, 64, endpoint=False)]
    rn = [tuple((np.array(p) - hc) / 0.2) for p in rp]
    hv, hf = sweep(rp, rn, circle(0.026, 12))
    ch.marks["halo"] = [part(mesh_obj("Halo", hv, hf, mats["halo"]), ("bone", "head"))]

    # beanie: a knit cap over the top of the head down to the headband line, a rolled brim and a pom-pom
    hco = get_co(head)
    import bmesh as _bm
    bv = hco.copy()
    nrm = get_nrm(head)
    bv = bv + nrm * 0.032
    me = bpy.data.meshes.new("Beanie")
    me.from_pydata([tuple(x) for x in bv], [], [list(p.vertices) for p in head.data.polygons])
    bm = _bm.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    _bm.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < hbz - 0.02], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    beanie = bpy.data.objects.new("Beanie", me)
    link(beanie)
    me.materials.append(mats["dark"])
    for p_ in me.polygons:
        p_.use_smooth = True
    part(beanie, ("bone", "head"), 0.012)
    hp_, hn_ = [], []
    for i in range(140):
        a = 2 * math.pi * i / 140
        dvec = Vector((math.cos(a), math.sin(a), 0))
        hit = hb.ray_cast(Vector((0, 0, hbz)) + dvec * 2, -dvec, 4)
        hp_.append(tuple(hit[0]))
        hn_.append(tuple(dvec))
    rv, rf = sweep(hp_, hn_, [(a + 0.03, b) for a, b in rounded_rect_2d(0.05, 0.11, 0.024, 4)])
    brim = part(mesh_obj("Beanie brim", rv, rf, mats["dark"]), ("bone", "head"), 0.012)
    d, f = cube_sphere(10)
    pom = part(mesh_obj("Beanie pom", d * 0.085 + np.array([0, 0, topz + 0.1]), f, mats["pom"]), ("bone", "head"), 0.02)
    ch.marks["beanie"] = [beanie, brim, pom]

    # cape: hangs from the shoulders down the back, flaring out (drawn behind the body)
    rows, cols = 14, 16
    cv, cf = [], []
    for r in range(rows):
        t = r / (rows - 1)
        z = 1.08 - 0.86 * t
        half = 0.34 + 0.4 * t
        back = 0.22 + 0.2 * t + 0.05 * math.sin(t * 2.4)
        for c in range(cols):
            u = c / (cols - 1) * 2 - 1
            x = u * half
            y = back + 0.06 * (1 - u * u) + 0.025 * math.sin(u * 7 + t * 3) * t
            cv.append((x, y, z))
    for r in range(rows - 1):
        for c in range(cols - 1):
            cf.append([r * cols + c, r * cols + c + 1, (r + 1) * cols + c + 1, (r + 1) * cols + c])
    cape = mesh_obj("Cape", np.array(cv), cf, mats["dark"])
    sol = cape.modifiers.new("Thick", "SOLIDIFY")
    sol.thickness = 0.02
    ch.marks["cape"] = [part(cape, ("bone", "torso"), 0.012)]

    # bow: a big pink bow on the top of the head, on the near (camera) side
    bc = surf(-0.17, -0.06)[0] + np.array([0, 0, 0.04])
    bow = []
    for k, sgn in enumerate((1, -1)):
        lv, lf = superellipsoid(12, (sgn * 0.12, 0, 0), 0.12, 0.05, 0.05, 0.085, 0.085, p=2.2, q=2.2)
        # pinch toward the knot: a bow loop is wide at the end, narrow at the middle
        k_ = np.clip(np.abs(lv[:, 0]) / 0.24, 0, 1)
        lv[:, 2] *= 0.45 + 0.55 * k_
        lv[:, 1] *= 0.5 + 0.5 * k_
        rot = np.array(Euler((math.radians(70), 0, math.radians(-40)), "XYZ").to_matrix())
        bow.append(part(mesh_obj("Bow loop %d" % k, lv @ rot.T + bc, lf, mats["bow"]), ("bone", "head"), 0.006))
    kv, kf = superellipsoid(8, (0, 0, 0), 0.04, 0.045, 0.045, 0.045, 0.045, p=2.0, q=2.0)
    bow.append(part(mesh_obj("Bow knot", kv @ np.array(Euler((math.radians(70), 0, math.radians(-40)), "XYZ").to_matrix()).T + bc, kf, mats["bow_knot"]), ("bone", "head")))
    ch.marks["bow"] = bow

    # sprout: a curved stem from the top of the head with two big leaves
    s0 = np.array([0, 0, topz - 0.02])
    path = [s0 + np.array([0.03 * math.sin(t * 2.2), -0.01 * t, 0.26 * t]) for t in np.linspace(0, 1, 14)]
    sv, sf = taper_tube(path, [0.022 - 0.006 * t for t in np.linspace(0, 1, 14)], 10, hint=(0, 1, 0))
    sprout = [part(mesh_obj("Sprout stem", sv, sf, mats["stem"]), ("bone", "head"))]
    tip = path[-1]
    for k, (sgn, lift) in enumerate(((1, 0.0), (-1, 0.04))):
        lv, lf = superellipsoid(10, (sgn * 0.13, 0, 0), 0.13, 0.055, 0.055, 0.016, 0.016, p=2.0, q=2.0)
        # pointed leaf: narrow toward both ends
        k_ = 1 - (np.abs(lv[:, 0] - sgn * 0.13) / 0.13) ** 2
        lv[:, 1] *= np.clip(k_, 0.05, 1) ** 0.6
        lv[:, 2] += 0.08 * (np.abs(lv[:, 0]) / 0.26) ** 2  # curl up
        rot = np.array(Euler((0, math.radians(-sgn * 12), math.radians(-35)), "XYZ").to_matrix())
        sprout.append(part(mesh_obj("Sprout leaf %d" % k, lv @ rot.T + tip + np.array([0, 0, lift - 0.02]), lf, mats["leaf"]), ("bone", "head"), 0.006))
    ch.marks["sprout"] = sprout

    # top hat: a black felt hat with a body-colored band, tipped back a little
    tc = np.array([0, 0.03, topz - 0.04])
    tilt = np.array(Euler((math.radians(8), math.radians(-6), 0), "XYZ").to_matrix())
    bv_, bf_ = lathe([(0, 0), (0.0, 0.31), (0.012, 0.325), (0.03, 0.31), (0.03, 0)], 48)
    crv, crf = lathe([(0.0, 0), (0.0, 0.18), (0.33, 0.195), (0.345, 0.185), (0.35, 0)], 48)
    bnv, bnf = lathe([(0.0, 0), (0.03, 0.188), (0.1, 0.191), (0.1, 0)], 48)
    hat = [part(mesh_obj("Hat brim", bv_ @ tilt.T + tc, bf_, mats["hat"]), ("bone", "head"), 0.006),
           part(mesh_obj("Hat crown", crv @ tilt.T + tc, crf, mats["hat"]), ("bone", "head"), 0.006),
           part(mesh_obj("Hat band", bnv @ tilt.T + tc, bnf, M["suit"]), ("bone", "head"))]
    ch.marks["tophat"] = hat

    # minor marks (details for close-ups; a fighter has at most one, on top of its major mark). The scratch and the
    # bandage are drawn by the viewer on the visor glass (bot.ts drawVisor), so only the bolts and the scarf are here.
    # bolts: a neck bolt low on each side of the head, gunmetal with a darker cap
    bolts = []
    metal = glossy_mat("Bolt metal", "#9aa3b2", rough=0.25, coat=0.5, metal=0.8, spec=0.6)
    cap_m = glossy_mat("Bolt cap", "#5d6472", rough=0.3, coat=0.4, metal=0.8, spec=0.5)
    for sx in (1, -1):
        hit = hb.ray_cast(Vector((sx * 2.0, 0.02, 1.38)), Vector((-sx, 0, 0)), 4)
        p0 = np.array(hit[0]) if hit[0] is not None else np.array([sx * 0.45, 0.02, 1.38])
        nrm = np.array([sx, 0.0, 0.0])
        sv, sf = lathe([(0, 0), (0.0, 0.05), (0.12, 0.05), (0.12, 0)], 16)
        sv = align(sv, p0 - nrm * 0.02, p0 + nrm * 0.1)
        bolts.append(part(mesh_obj("Bolt %d" % sx, sv, sf, metal), ("bone", "head")))
        cv, cf = lathe([(0, 0), (0.0, 0.085), (0.04, 0.085), (0.055, 0.07), (0.055, 0)], 6)
        cv = align(cv, p0 + nrm * 0.09, p0 + nrm * 0.145)
        bolts.append(part(mesh_obj("Bolt cap %d" % sx, cv, cf, cap_m), ("bone", "head")))
    ch.marks["bolts"] = bolts
    # scarf: a plush wrap around the neck (on the collar), a knot at the front side and two tails out the back; a
    # light tint of the body color (SuitLight), like the code bot's scarf
    light = fabric_mat("SuitLight", tint_hsv=(0.0, 0.55, 1.12))
    ch.M["suit_light"] = light
    sp_, sn_ = [], []
    for i in range(72):
        a_ = 2 * math.pi * i / 72
        d_ = np.array([math.cos(a_), math.sin(a_), 0.0])
        sp_.append(tuple(np.array([0, 0.0, 1.1]) + d_ * np.array([0.34, 0.31, 1])))
        sn_.append(tuple(d_))
    wv, wf_ = sweep(sp_, sn_, [(a + 0.0, b) for a, b in rounded_rect_2d(0.09, 0.13, 0.04, 4)])
    scarf = [part(mesh_obj("Scarf wrap", wv, wf_, light), ("bone", "torso"), 0.01)]
    kv, kf = superellipsoid(10, (-0.2, -0.2, 1.08), 0.07, 0.06, 0.06, 0.07, 0.07)
    scarf.append(part(mesh_obj("Scarf knot", kv, kf, light), ("bone", "torso"), 0.01))
    for k, (dz, spread) in enumerate(((0.0, 0.06), (-0.05, -0.04))):
        pts = [np.array([-0.24 - 0.18 * t, -0.1 + 0.4 * t, 1.06 + dz - 0.32 * t * t + spread * t]) for t in np.linspace(0, 1, 12)]
        tv, tf = sweep([tuple(q) for q in pts], [(0, 1, 0.3)] * 12, [(a, b) for a, b in rounded_rect_2d(0.018, 0.085, 0.008, 3)], closed=False)
        scarf.append(part(mesh_obj("Scarf tail %d" % k, tv, tf, light), ("bone", "torso"), 0.008))
    ch.marks["scarf"] = scarf

    # the small marks grow so they read at game size (the bot is ~75 px tall in a View-all match)
    for name, k in (("bow", 1.7), ("propeller", 1.5), ("mohawk", 1.4), ("sprout", 1.6), ("crown", 1.25), ("tophat", 1.15),
                    ("halo", 1.2), ("horns", 1.1)):
        obs = ch.marks[name]
        allc = np.vstack([get_co(o) for o in obs])
        piv = np.array([allc[:, 0].mean(), allc[:, 1].mean(), allc[:, 2].min()])
        if name == "bow":
            piv = allc.mean(0)
        for o in obs:
            set_co(o, (get_co(o) - piv) * k + piv)



FACES = {
    "angry": [
        ".............",
        "##.........##",
        ".###.....###.",
        ".####...####.",
        "..###...###..",
        "...#.....#...",
        ".............",
    ],
    "happy": [
        ".............",
        ".............",
        "..##.....##..",
        ".#..#...#..#.",
        "#....#.#....#",
        ".............",
        ".............",
    ],
    "dizzy": [
        ".............",
        "#...........#",
        ".##.......##.",
        "...#.....#...",
        ".##.......##.",
        "#...........#",
        ".............",
    ],
    "focus": [
        ".............",
        ".##.......##.",
        "####.....####",
        "####.....####",
        ".##.......##.",
        ".............",
        ".............",
    ],
}


def add_led(B, gb, x, z, r, lift=0.0016):
    hit = gb.ray_cast(Vector((x, -3, z)), Vector((0, 1, 0)), 6)
    if hit[0] is None:
        return
    v, f = ellipsoid_unit()
    n = np.array(hit[1])
    if n[1] > 0:
        n = -n
    t, n, b = frame_from(np.array([1.0, 0, 0]), n)
    M = np.stack([t * r, b * r, n * r * 0.3], axis=1)
    B.add(v @ M.T + np.array(hit[0]) + n * lift, f)


def head_top(hb):
    hit = hb.ray_cast(Vector((0, 0, 5)), Vector((0, 0, -1)), 10)
    return hit[0].z


def torso_and_arm(ch, side, torso):
    return bvh_of(torso, ch.parts["Sleeve." + side][0])


# ---------------------------------------------------------------- rig

BONES = [
    # name, head, tail, parent
    ("root", (0, 0, 0), (0, 0.25, 0), None),
    ("hips", (0, 0, 0.5), (0, 0, 0.66), "root"),
    ("torso", (0, 0, 0.66), (0, 0, 1.07), "hips"),
    ("head", (0, 0, 1.07), (0, 0, 1.55), "torso"),
]


def build_rig(ch):
    arm_d = bpy.data.armatures.new("Rig")
    rig = link(bpy.data.objects.new("Rig", arm_d))
    ch.rig = rig
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_d.edit_bones

    def bone(name, h, t, parent, connect=False):
        b = eb.new(name)
        b.head, b.tail = Vector(h), Vector(t)
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
        return b

    for n, h, t, p in BONES:
        bone(n, h, t, p)
    bone("antenna", tuple(ch.antenna_base), tuple(ch.antenna_base + np.array([0, 0, 0.3])), "head")
    for s in "LR":
        sh, el, wr = ch.limb[s + "arm"]
        bone("upperarm." + s, sh, el, "torso")
        bone("forearm." + s, el, wr, "upperarm." + s, True)
        wr2, mc = ch.limb[s + "hand"]
        bone("hand." + s, wr, tuple(mc + (mc - wr)), "forearm." + s, True)
        hp, kn, an = ch.limb[s + "leg"]
        bone("thigh." + s, hp, kn, "hips")
        bone("shin." + s, kn, an, "thigh." + s, True)
        an2, bc = ch.limb[s + "foot"]
        bone("foot." + s, an, (bc[0], bc[1] - 0.2, 0.05), "shin." + s, True)
    bpy.ops.object.mode_set(mode="OBJECT")

    # weights
    named = {}
    for name, (ob, rule) in list(ch.parts.items()):
        if rule[0] == "nearest":
            continue
        named[name] = (ob, rule)
    # build a nearest-part lookup for the stitches
    part_bvh = [(bvh_of(ob), ob, rule) for ob, rule in named.values() if len(ob.data.polygons)]
    for name, (ob, rule) in ch.parts.items():
        ob.parent = rig
        co = get_co(ob)
        groups = {}
        if rule[0] == "bone":
            groups[rule[1]] = np.ones(len(co))
        elif rule[0] == "limb":
            _, b1, b2, a, j, b = rule
            a, j, b = map(np.asarray, (a, j, b))
            axis = b - a
            t = ((co - a) @ axis) / (axis @ axis)
            w2 = np.clip((t - 0.42) / 0.16, 0, 1)
            w2 = w2 * w2 * (3 - 2 * w2)
            groups[b1] = 1 - w2
            groups[b2] = w2
        elif rule[0] == "nearest":
            # per stitch (one Builder group each): the rule of the nearest part
            ws = {}
            for g0, g1 in ch.stitch_groups:
                c = Vector(co[g0:g1].mean(0))
                best, pr = 1e9, ("bone", "torso")
                for bv_, pob, prule in part_bvh:
                    r = bv_.find_nearest(c, min(best, 0.06))
                    if r[0] is not None and r[3] < best:
                        best, pr = r[3], prule
                if pr[0] == "bone":
                    ws.setdefault(pr[1], np.zeros(len(co)))[g0:g1] = 1
                else:
                    _, b1, b2, a, j, b = pr
                    a, b = np.asarray(a), np.asarray(b)
                    axis = b - a
                    t = ((np.array(c) - a) @ axis) / (axis @ axis)
                    w2 = min(max((t - 0.42) / 0.16, 0), 1)
                    w2 = w2 * w2 * (3 - 2 * w2)
                    ws.setdefault(b1, np.zeros(len(co)))[g0:g1] = 1 - w2
                    ws.setdefault(b2, np.zeros(len(co)))[g0:g1] = w2
            groups = ws
        for g, w in groups.items():
            vg = ob.vertex_groups.new(name=g)
            for val in np.unique(np.round(w, 3)):
                if val <= 0:
                    continue
                idx = np.nonzero(np.round(w, 3) == val)[0].tolist()
                vg.add(idx, float(val), "REPLACE")
        mod = ob.modifiers.new("Armature", "ARMATURE")
        mod.object = rig


def add_fuzz(ch):
    """Short particle hair on every fabric part. No hair where another part sits on top."""
    all_obs = [ob for ob, _ in ch.parts.values() if len(ob.data.polygons)]
    dens = 0.25 if QUICK else HAIR
    mark_obs = {o for obs in ch.marks.values() for o in obs}  # marks are overlays: no bald patch under them
    for ob, hl in ch.fabric:
        co = get_co(ob)
        w = np.ones(len(co))
        others = [o for o in all_obs if o is not ob and o not in mark_obs and not o.name.startswith(("Face ", "LED grid"))]
        ob_b = bvh_of(*others)
        lim = hl * 1.4
        for i, c in enumerate(co):
            r = ob_b.find_nearest(Vector(c), lim)
            if r[0] is not None:
                w[i] = (r[3] / lim) ** 2
        vg = ob.vertex_groups.new(name="fuzz")
        for val in np.unique(np.round(w, 2)):
            if val <= 0:
                continue
            idx = np.nonzero(np.round(w, 2) == val)[0].tolist()
            vg.add(idx, float(val), "REPLACE")
        # area -> strand count
        me = ob.data
        area = sum(p.area for p in me.polygons)
        mod = ob.modifiers.new("Fuzz", "PARTICLE_SYSTEM")
        ps = ob.particle_systems[-1]
        s = ps.settings
        s.type = "HAIR"
        s.use_advanced_hair = True
        s.count = max(200, int(area * 9000 * dens))
        s.emit_from = "FACE"
        s.use_even_distribution = True
        s.distribution = "JIT"
        s.hair_length = hl  # sets normal_factor; the random part is not rescaled, so set it relative
        s.factor_random = s.normal_factor * 0.3
        s.hair_step = 3
        s.render_step = 3
        s.display_step = 2
        s.child_type = "INTERPOLATED"
        s.child_percent = 2
        s.rendered_child_count = 12 if not QUICK else 4
        s.clump_factor = 0.15
        s.roughness_1 = 0.004
        s.roughness_1_size = 0.6
        s.roughness_endpoint = hl * 0.25
        s.roughness_end_shape = 1.0
        s.root_radius = 1.0
        s.tip_radius = 0.15
        s.radius_scale = 0.0021
        s.use_close_tip = True
        s.material = 1
        s.display_percentage = 10
        ps.vertex_group_density = "fuzz"
        ps.vertex_group_length = "fuzz"


# ---------------------------------------------------------------- heads, faces, poses

def set_head(ch, name):
    for k, obs in ch.marks.items():
        for ob in obs:
            ob.hide_render = k != name
            ob.hide_viewport = k != name


def set_face(ch, name):
    for k, ob in ch.faces.items():
        ob.hide_render = k != name
        ob.hide_viewport = k != name


def mirror(rot):
    return (rot[0], -rot[1], -rot[2])


POSES = {
    "rest": {},
    "guard": {
        "root": dict(loc=(0, 0, -0.035)),
        "torso": (6, 0, 4),
        "head": (-4, 0, -4),
        "upperarm.L": (-48, 24, -22), "forearm.L": (-92, 0, -18), "hand.L": (-8, 0, 0),
        "upperarm.R": (-38, -22, 18), "forearm.R": (-98, 0, 16), "hand.R": (-8, 0, 0),
        "thigh.L": (-12, -12, 0), "shin.L": (22, 0, 0), "foot.L": (-10, 8, 0),
        "thigh.R": (-2, 14, 0), "shin.R": (18, 0, 0), "foot.R": (-14, -10, 0),
    },
    "run": {
        "root": dict(loc=(0, 0, 0.07)),
        "hips": (0, 0, -10),
        "torso": (14, 0, 12),
        "head": (-10, 0, -6),
        "upperarm.L": (45, -22, 0), "forearm.L": (-60, 0, 0),
        "upperarm.R": (-38, 24, 0), "forearm.R": (-40, 0, 0),
        "thigh.L": (-62, -4, 0), "shin.L": (48, 0, 0), "foot.L": (-10, 0, 0),
        "thigh.R": (38, 4, 0), "shin.R": (82, 0, 0), "foot.R": (20, 0, 0),
        "antenna": (-14, 0, 0),
    },
    "jump": {
        "root": dict(loc=(0, 0, 0.5)),
        "torso": (-4, 0, -6),
        "head": (-10, 0, 6),
        "upperarm.L": (-20, -105, 0), "forearm.L": (0, -25, 0),
        "upperarm.R": (25, 55, 0), "forearm.R": (-40, 0, 0),
        "thigh.L": (-70, -10, 0), "shin.L": (95, 0, 0), "foot.L": (-20, 0, 0),
        "thigh.R": (-30, 8, 0), "shin.R": (70, 0, 0), "foot.R": (10, 0, 0),
        "antenna": (16, 0, 0),
    },
    "punch": {
        "root": dict(loc=(0, 0, -0.06)),
        "hips": (0, 0, 18),
        "torso": (16, 0, 22),
        "head": (-10, 0, -12),
        "upperarm.L": (-48, 24, -22), "forearm.L": (-100, 0, -16), "hand.L": (-10, 0, 0),
        "upperarm.R": (-76, 0, 34), "forearm.R": (-2, 0, 0), "hand.R": (-2, 0, 0),
        "thigh.L": (-28, -22, 0), "shin.L": (30, 0, 0), "foot.L": (0, 20, 0),
        "thigh.R": (22, 18, 0), "shin.R": (14, 0, 0), "foot.R": (-12, -10, 0),
        "antenna": (-10, 0, 0),
    },
    "launched": {
        "root": dict(loc=(0, 0, 0.55), rot=(-32, 0, -10)),
        "torso": (-12, 0, 0),
        "head": (-18, 8, 10),
        "upperarm.L": (-15, -80, 0), "forearm.L": (0, -20, 0),
        "upperarm.R": (10, 70, 0), "forearm.R": (0, 20, 0),
        "thigh.L": (-80, -10, 0), "shin.L": (40, 0, 0),
        "thigh.R": (-20, 14, 0), "shin.R": (70, 0, 0),
        "antenna": (30, 0, 0),
    },
    "victory": {
        "torso": (-6, 0, 0),
        "head": (-12, 0, 0),
        "upperarm.L": (0, -88, 0), "forearm.L": (0, -22, 0),
        "upperarm.R": (0, 88, 0), "forearm.R": (0, 22, 0),
        "thigh.L": (0, -10, 0), "foot.L": (0, 6, 0),
        "thigh.R": (0, 10, 0), "foot.R": (0, -6, 0),
        "antenna": (-8, 0, 0),
    },
}
POSE_FACE = {"rest": "angry", "guard": "angry", "run": "focus", "jump": "focus", "punch": "angry", "launched": "dizzy", "victory": "happy"}
POSE_FRAMES = {k: 1001 + 10 * i for i, k in enumerate(POSES)}


def apply_pose(ch, pose, key_frame=None):
    """Pose the rig from POSES[pose]. A bone's value is an (x, y, z) rotation in degrees (rest-space axes),
    or a dict with any of loc (armature-space offset), rot (degrees) and scl (bone-space scale, for
    squash and stretch)."""
    rig = ch.rig
    spec = POSES[pose]
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
        r = spec.get(pb.name)
        Rb = pb.bone.matrix_local.to_3x3()
        if isinstance(r, dict):
            if "loc" in r:
                pb.location = Rb.inverted() @ Vector(r["loc"])
            if "rot" in r:
                Q = Euler([math.radians(x) for x in r["rot"]], "XYZ").to_matrix()
                pb.rotation_quaternion = (Rb.inverted() @ Q @ Rb).to_quaternion()
            if "scl" in r:
                pb.scale = r["scl"]
        elif r is not None:
            Q = Euler([math.radians(x) for x in r], "XYZ").to_matrix()
            pb.rotation_quaternion = (Rb.inverted() @ Q @ Rb).to_quaternion()
        if key_frame is not None:
            pb.keyframe_insert("rotation_quaternion", frame=key_frame)
            pb.keyframe_insert("location", frame=key_frame)
            pb.keyframe_insert("scale", frame=key_frame)
    set_face(ch, POSE_FACE.get(pose, "angry"))


def key_all_poses(ch):
    for pose, fr in POSE_FRAMES.items():
        apply_pose(ch, pose, fr)
    apply_pose(ch, "rest")


def key_run_cycle(ch, start, frames, period):
    """A run cycle keyed on every frame (loops: frame start+frames == start)."""
    rig = ch.rig
    base = POSES["run"]
    for i in range(frames + 1):
        ph = 2 * math.pi * i / period
        s, c2 = math.sin(ph), math.cos(2 * ph)
        spec = {
            "root": dict(loc=(0, 0, 0.05 + 0.05 * abs(math.cos(ph)))),
            "hips": (0, 0, -12 * s),
            "torso": (14, 0, 14 * s),
            "head": (-10 + 3 * c2, 0, -10 * s),
            "upperarm.L": (42 * s, -24, 0), "forearm.L": (-40 - 10 * s, 0, 0),
            "upperarm.R": (-42 * s, 24, 0), "forearm.R": (-40 + 10 * s, 0, 0),
            "thigh.L": (-50 * s - 8, -4, 0), "shin.L": (40 + 35 * max(0, math.sin(ph + 1.4)), 0, 0), "foot.L": (-10 * s, 0, 0),
            "thigh.R": (50 * s - 8, 4, 0), "shin.R": (40 + 35 * max(0, math.sin(ph + 1.4 + math.pi)), 0, 0), "foot.R": (10 * s, 0, 0),
            "antenna": (-10 + 12 * math.sin(2 * ph - 1.2), 0, 6 * s),
        }
        POSES["_run"] = spec
        apply_pose(ch, "_run", start + i)
    POSES.pop("_run", None)


# ---------------------------------------------------------------- scene, camera, light, render

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    # CPU only, with a fixed thread count: on this Mac mini the Metal path hung for minutes on the hair
    # and wired most of the RAM. Never switch this to the GPU. KB_THREADS overrides the count (default 6).
    sc.cycles.device = "CPU"
    sc.render.threads_mode = "FIXED"
    sc.render.threads = int(os.environ.get("KB_THREADS", 6))
    sc.cycles.use_denoising = True
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.02
    sc.cycles.max_bounces = 8
    sc.cycles.diffuse_bounces = 3
    sc.cycles.glossy_bounces = 3
    sc.cycles.transmission_bounces = 2
    sc.cycles.sample_clamp_indirect = 6
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.render.film_transparent = True
    sc.render.use_persistent_data = False  # lower peak memory; the per-render sync is a few seconds
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.view_settings.view_transform = "AgX"
    for look in ("AgX - Punchy", "Punchy", "AgX - Medium High Contrast", "Medium High Contrast"):
        try:
            sc.view_settings.look = look
            break
        except Exception:
            pass
    w = bpy.data.worlds.new("World")
    sc.world = w
    if w.node_tree is None:
        w.use_nodes = True
    bg = [n for n in w.node_tree.nodes if n.type == "BACKGROUND"]
    if not bg:
        bgn = w.node_tree.nodes.new("ShaderNodeBackground")
        o = w.node_tree.nodes.new("ShaderNodeOutputWorld")
        w.node_tree.links.new(bgn.outputs[0], o.inputs[0])
        bg = [bgn]
    bg[0].inputs["Color"].default_value = srgb("#1c2550")
    bg[0].inputs["Strength"].default_value = 0.35
    return sc


def camera_rig(sc):
    rig = bpy.data.objects.new("CamRig", None)
    sc.collection.objects.link(rig)
    tgt = bpy.data.objects.new("CamTarget", None)
    sc.collection.objects.link(tgt)
    tgt.location = (0, 0, 1.1)
    cam_d = bpy.data.cameras.new("Cam")
    cam_d.lens = 100
    cam = bpy.data.objects.new("Cam", cam_d)
    sc.collection.objects.link(cam)
    cam.parent = rig
    tc = cam.constraints.new("TRACK_TO")
    tc.target = tgt
    tc.track_axis = "TRACK_NEGATIVE_Z"
    tc.up_axis = "UP_Y"
    sc.camera = cam

    def light(name, kind, loc, energy, size, color=(1, 1, 1), track=True):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        if kind == "AREA":
            ld.shape = "DISK"
            ld.size = size
        else:
            ld.shadow_soft_size = size
        lo = bpy.data.objects.new(name, ld)
        sc.collection.objects.link(lo)
        lo.parent = rig
        lo.location = loc
        if track:
            c = lo.constraints.new("TRACK_TO")
            c.target = tgt
            c.track_axis = "TRACK_NEGATIVE_Z"
            c.up_axis = "UP_Y"
        return lo

    light("Key", "AREA", (-4.5, -6.0, 5.5), 1500, 3.0, (1.0, 0.95, 0.88))
    light("Fill", "AREA", (6.0, -4.5, 1.8), 260, 5.0, (0.8, 0.86, 1.0))
    light("Rim L", "AREA", (-4.0, 4.5, 3.6), 1100, 2.2, (0.62, 0.74, 1.0))
    light("Rim R", "AREA", (4.2, 4.0, 3.0), 800, 2.2, (1.0, 0.86, 0.72))
    light("Top", "AREA", (0.0, 0.5, 7.0), 250, 3.0, (1.0, 0.97, 0.94))
    # shadow catcher floor
    me = bpy.data.meshes.new("Floor")
    s = 20
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    fl = bpy.data.objects.new("Floor", me)
    sc.collection.objects.link(fl)
    fl.is_shadow_catcher = True
    return rig, cam, tgt


def frame_camera(cam, tgt, height=2.75, tz=1.1, elev=0.18):
    """Place the camera so `height` units fit the frame vertically at the target."""
    sc = bpy.context.scene
    rx, ry = sc.render.resolution_x, sc.render.resolution_y
    lens = cam.data.lens
    sensor = 36.0
    # sensor fit AUTO: the sensor width maps to the larger dimension
    vert = sensor if ry >= rx else sensor * ry / rx
    fov = 2 * math.atan(vert / 2 / lens)
    dist = (height / 2) / math.tan(fov / 2)
    tgt.location = (0, 0, tz)
    cam.location = (0, -dist * math.cos(elev), tz + dist * math.sin(elev))


def lite_video():
    """Lighter shading for video frames: no subsurface, fewer bounces, cheaper noise, looser adaptive
    threshold. Same look at a glance, several times faster per frame."""
    sc = bpy.context.scene
    sc.cycles.max_bounces = 4
    sc.cycles.diffuse_bounces = 2
    sc.cycles.glossy_bounces = 2
    sc.cycles.adaptive_threshold = 0.05
    for m in bpy.data.materials:
        if not m.node_tree:
            continue
        for n in m.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                n.inputs["Subsurface Weight"].default_value = 0.0
            elif n.type == "TEX_NOISE":
                n.inputs["Detail"].default_value = min(n.inputs["Detail"].default_value, 2.0)


def render_still(path, angle, res=(1200, 1600), samples=256, height=2.75, tz=1.1):
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 35 if QUICK else 100
    sc.cycles.samples = 24 if QUICK else samples
    rig, cam, tgt = (sc.objects["CamRig"], sc.objects["Cam"], sc.objects["CamTarget"])
    rig.rotation_euler = (0, 0, -math.radians(angle))
    frame_camera(cam, tgt, height, tz)
    sc.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    dt = time.time() - t
    print("RENDERED %s %.1fs" % (path, dt), flush=True)
    TIMES.append((os.path.basename(path), dt))
    return dt


TIMES = []
RUN_START, RUN_FRAMES, RUN_PERIOD = 2001, 72, 18   # run cycle keys: 72 frames, 4 strides of 18
_last_stat = [0.0]


def _stats(st, *args):
    """Print Cycles progress every 10 s (background mode prints none), so a slow frame is not mistaken for a hang."""
    t = time.time()
    if t - _last_stat[0] > 10:
        _last_stat[0] = t
        print("  progress:", st if isinstance(st, str) else "", flush=True)


if hasattr(bpy.app.handlers, "render_stats"):
    bpy.app.handlers.render_stats.append(_stats)


def main():
    global QUICK, HAIR
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--only", default="turnaround,colors,heads,poses,turntable,run,builds")
    ap.add_argument("--samples", type=int, default=256)
    ap.add_argument("--video-samples", type=int, default=16)
    ap.add_argument("--no-hair", action="store_true")
    ap.add_argument("--hair", type=float, default=None,
                    help="strand density scale (default 0.35 for stills, 0.15 for a video-only run)")
    ap.add_argument("--heads", default="catears,headband,antenna", help="heads to render")
    ap.add_argument("--colors", default="blue,pink", help="color variants to render")
    ap.add_argument("--poses", default="run,jump,punch,launched,victory", help="poses to render")
    ap.add_argument("--views", default="front,threequarter,side,back", help="turnaround views to render")
    ap.add_argument("--frames", default="", help="START:END video frames to render (turntable/run), for short runs")
    a = ap.parse_args(argv)
    QUICK = a.quick
    only = set(a.only.split(","))
    HAIR = a.hair if a.hair is not None else (0.15 if only <= {"turntable", "run"} else 0.35)
    only = set(a.only.split(","))
    out = os.path.abspath(a.out)
    raw = os.path.join(out, "raw")
    os.makedirs(raw, exist_ok=True)
    os.makedirs(BUILD_DIR, exist_ok=True)
    t0 = time.time()

    def frange(n):
        if not a.frames:
            return 0, n
        x, y = a.frames.split(":")
        return max(0, int(x or 0)), min(n, int(y or n))

    def hero():
        sc = reset_scene()
        camera_rig(sc)
        tb = time.time()
        ch = build_character("balanced", hair=not a.no_hair)
        key_all_poses(ch)
        key_run_cycle(ch, RUN_START, RUN_FRAMES, RUN_PERIOD)
        print("BUILD balanced %.1fs" % (time.time() - tb))
        TIMES.append(("build balanced", time.time() - tb))
        return sc, ch

    need_hero = only & {"turnaround", "colors", "heads", "poses", "turntable", "run", "builds"}
    if need_hero:
        sc, ch = hero()
        if not only <= {"turntable", "run"}:  # video runs build with thin hair: keep the stills model
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD_DIR, "plush-hero.blend"))
        S = a.samples

        def at_pose(p):
            sc.frame_set(POSE_FRAMES[p])
            set_face(ch, POSE_FACE[p])

        if "turnaround" in only:
            at_pose("rest")
            for name, ang in (("front", 0), ("threequarter", 30), ("side", 90), ("back", 180)):
                if name not in a.views.split(","):
                    continue
                render_still(os.path.join(raw, "turn-%s.png" % name), ang, samples=S)
        if "colors" in only:
            at_pose("rest")
            for col in a.colors.split(","):
                set_body_color(COLORS[col])
                render_still(os.path.join(raw, "color-%s.png" % col), 30, samples=S)
            set_body_color(COLORS["orange"])
        if "heads" in only:
            at_pose("guard")
            for hname, col in (("catears", "pink"), ("headband", "orange"), ("antenna", "blue")):
                if hname not in a.heads.split(","):
                    continue
                set_head(ch, hname)
                set_body_color(COLORS[col])
                render_still(os.path.join(raw, "head-%s.png" % hname), 30, samples=S)
            set_head(ch, "antenna")
            set_body_color(COLORS["orange"])
        if "poses" in only:
            for p in a.poses.split(","):
                at_pose(p)
                render_still(os.path.join(raw, "pose-%s.png" % p), float(os.environ.get("KB_POSE_ANGLE", 30)), res=(1400, 1600), samples=S, height=3.3, tz=1.35)
        if "builds" in only:
            at_pose("guard")
            render_still(os.path.join(raw, "build-balanced.png"), 30, samples=S, height=2.9, tz=1.12)
        if only & {"turntable", "run"}:
            lite_video()
        if "turntable" in only:
            at_pose("rest")
            rig = sc.objects["CamRig"]
            sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
            sc.render.resolution_percentage = 35 if QUICK else 100
            sc.cycles.samples = 16 if QUICK else a.video_samples
            sc.render.fps = 30
            frame_camera(sc.objects["Cam"], sc.objects["CamTarget"], 2.75, 1.1)
            n = 30 if QUICK else 180
            tt = time.time()
            d = os.path.join(raw, "turntable")
            os.makedirs(d, exist_ok=True)
            f0, f1 = frange(n)
            for i in range(f0, f1):
                rig.rotation_euler = (0, 0, -2 * math.pi * i / n + math.radians(-30) * 0)
                sc.render.filepath = os.path.join(d, "f%04d.png" % i)
                bpy.ops.render.render(write_still=True)
            TIMES.append(("turntable frames %d-%d" % (f0, f1), time.time() - tt))
        if "run" in only:
            rig_ = ch.rig
            start, frames = RUN_START, RUN_FRAMES
            set_face(ch, "focus")
            sc.render.resolution_x, sc.render.resolution_y = 1080, 1080
            sc.render.resolution_percentage = 35 if QUICK else 100
            sc.cycles.samples = 16 if QUICK else a.video_samples
            sc.objects["CamRig"].rotation_euler = (0, 0, -math.radians(30))
            frame_camera(sc.objects["Cam"], sc.objects["CamTarget"], 2.9, 1.18)
            d = os.path.join(raw, "run")
            os.makedirs(d, exist_ok=True)
            tt = time.time()
            n = 18 if QUICK else frames
            f0, f1 = frange(n)
            for i in range(f0, f1):
                sc.frame_set(start + i)
                sc.render.filepath = os.path.join(d, "f%04d.png" % i)
                bpy.ops.render.render(write_still=True)
            TIMES.append(("run cycle frames %d-%d" % (f0, f1), time.time() - tt))

    if "builds" in only:
        for b in ("tank", "anchor", "glass"):
            sc = reset_scene()
            camera_rig(sc)
            tb = time.time()
            ch = build_character(b, hair=not a.no_hair)
            key_all_poses(ch)
            TIMES.append(("build " + b, time.time() - tb))
            sc.frame_set(POSE_FRAMES["guard"])
            set_face(ch, {"tank": "happy", "anchor": "angry", "glass": "dizzy"}[b] if False else "angry")
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD_DIR, "plush-%s.blend" % b))
            render_still(os.path.join(raw, "build-%s.png" % b), 30, samples=a.samples, height=2.9, tz=1.12)

    with open(os.path.join(out, "times.txt"), "a") as fh:
        for n, dt in TIMES:
            fh.write("%-40s %7.1f s\n" % (n, dt))
        fh.write("%-40s %7.1f s\n" % ("TOTAL (" + a.only + ")", time.time() - t0))
    print("DONE %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
