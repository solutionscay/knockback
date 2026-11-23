"""
(#85) round 3: the plush Skipper brawler in action and with weapons. Headless Blender.

    tools/art/render-action.sh OUT_DIR       (the one command; see that file)
    Blender -b --factory-startup --python tools/art/plush_action.py -- --out DIR
            [--stills rocket,bat,rifle] [--loop NAME --frames A:B] [--quick] [--hair H]

Builds on plush_bot.py (the character, materials, rig, render setup) and adds:

- Animation loops at 24 fps, keyed on every frame from eased key poses: IDLE (guard bob), RUN,
  PUNCH (jab and back to guard), LAUNCHED (hit, tumble, land, recover), and one loop per weapon
  (hold, fire or swing, recoil, recover). Squash and stretch is bone scale (root for the whole body,
  torso for the reach), so the plush squashes on landings and stretches on launches and jabs. The
  antenna is a damped spring driven by the head's pitch, roll and vertical acceleration, simulated
  over three cycles so the loop closes.
- Three weapons, one per class in src/sim/constants.ts: ROCKET (heavy, shoulder launcher), BAT
  (melee), RIFLE (precision). Same toy language as the bot: plush fabric bodies with stitched
  seams, glossy vinyl parts, gold rivets.
- The mitt socket: every weapon carries a stitched brown-leather cuff ring (the brawler's belt
  leather) on a vinyl bracket. The mitt slots into the ring, the ring hugs the middle of the mitt,
  and the weapon rides on top. The mitts stay mitts: no fingers, no grip pose. In the rig the weapon
  is bone-parented to hand.R, the near hand at the three-quarter camera.
- Effects as emissive geometry with keyed visibility and scale: muzzle flashes, the rocket's back
  blast and projectile, cotton-ball smoke puffs, the rifle tracer, the bat's swing trail (ribbons
  built from the bat tip's path, fading by age).

Weapon local frame (all weapon geometry): origin at the mitt center, +y along the forearm (the
barrel when the forearm points forward), +z up when the forearm is level, +x outward.
"""
import argparse
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plush_bot as pb  # noqa: E402

FPS = 24
ANGLE = 55  # three-quarter: the bot faces screen right, its right (weapon) hand is the near hand (#85 game-size
#             pass: 55 rather than 45, with the side-mounted weapons, keeps the visor clear)
SPRITE = False  # sprite renders: LAUNCHED keeps the body in place and upright (the game moves and spins it)

LOOPS = {
    # name: (start frame, frame count, camera framing height, target z, weapon)
    "idle": (3001, 24, 2.9, 1.12, None),
    "run": (3101, 24, 3.0, 1.18, None),
    "punch": (3201, 24, 3.0, 1.12, None),
    "launched": (3301, 40, 3.7, 1.45, None),
    "rocket": (3401, 36, 3.2, 1.2, "rocket"),
    "bat": (3501, 32, 3.6, 1.3, "bat"),
    "rifle": (3601, 24, 3.1, 1.15, "rifle"),
    # rollout phase 1: the game's other moments
    "jump": (3701, 16, 3.2, 1.2, None),
    "flinch": (3801, 12, 3.0, 1.12, None),
    "ko": (3901, 24, 3.0, 1.0, None),
    "celebrate": (4001, 24, 3.2, 1.25, None),
    # phase 2 weapons
    "shotgun": (4101, 24, 3.1, 1.15, "shotgun"),
    "sniper": (4201, 28, 3.4, 1.15, "sniper"),
    "crossbow": (4301, 24, 3.1, 1.15, "crossbow"),
    "railgun": (4401, 28, 3.2, 1.15, "railgun"),
    "hammer": (4501, 32, 3.6, 1.3, "hammer"),
    "flamethrower": (4601, 24, 3.1, 1.15, "flamethrower"),
    "lightning": (4701, 24, 3.1, 1.15, "lightning"),
    "grenade": (4801, 24, 3.4, 1.2, "grenade"),
    "mine": (4901, 24, 3.2, 1.0, "mine"),
    "grapple": (5001, 24, 3.1, 1.15, "grapple"),
}
# sprite renders: the head turns this many degrees toward the camera, so the visor (and the LED face drawn on it)
# faces the viewer at the game's 55 degree three-quarter angle
HEAD_TURN = 34
BUILD = "balanced"  # the build being keyed (build() sets it): BUILD_POSE adds its own offsets
# sprite renders, per build: offsets on every loop (arm clearance for the build's proportions), and on the idle loop
# (the guard mitt lower, so it stays below the visor and the LED face drawn on it)
BUILD_POSE = {
    "balanced": {},
    "tank": {"upperarm.L": (0, -7, 0), "upperarm.R": (0, 7, 0), "thigh.L": (0, -3, 0), "thigh.R": (0, 3, 0)},
    "anchor": {"upperarm.L": (0, -3, 0), "upperarm.R": (0, 3, 0)},
    "glass": {"upperarm.L": (0, 3, 0), "upperarm.R": (0, -3, 0)},
}
IDLE_GUARD = {"upperarm.R": (10, 0, 0), "forearm.R": (14, 0, 0)}

LEATHER = "#5e321c"


# ---------------------------------------------------------------- small helpers

def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def ease_in(x):
    x = min(max(x, 0.0), 1.0)
    return x ** 3


EASES = {"smooth": smooth, "out": ease_out, "in": ease_in, "lin": lambda x: min(max(x, 0.0), 1.0)}


def _norm(v):
    """A spec value -> dict(loc, rot, scl)."""
    if v is None:
        return {}
    if isinstance(v, dict):
        return v
    return {"rot": v}


def lerp_spec(a, b, w):
    out = {}
    for k in set(a) | set(b):
        va, vb = _norm(a.get(k)), _norm(b.get(k))
        d = {}
        for key, dflt in (("loc", (0, 0, 0)), ("rot", (0, 0, 0)), ("scl", (1, 1, 1))):
            if key in va or key in vb:
                x, y = np.array(va.get(key, dflt), float), np.array(vb.get(key, dflt), float)
                d[key] = tuple(x + (y - x) * w)
        out[k] = d
    return out


def add_spec(base, extra):
    """Add rotations/locations of extra onto base; multiply scales."""
    out = {k: dict(_norm(v)) for k, v in base.items()}
    for k, v in extra.items():
        e = _norm(v)
        d = out.setdefault(k, {})
        for key in ("loc", "rot"):
            if key in e:
                d[key] = tuple(np.array(d.get(key, (0, 0, 0)), float) + np.array(e[key], float))
        if "scl" in e:
            d["scl"] = tuple(np.array(d.get("scl", (1, 1, 1)), float) * np.array(e["scl"], float))
    return out


def timeline(keys, i):
    """keys: [(frame, spec, ease_into_this_key)], sorted. Returns the spec at frame i."""
    if i <= keys[0][0]:
        return keys[0][1]
    for (f0, s0, _), (f1, s1, e) in zip(keys, keys[1:]):
        if f0 <= i <= f1:
            w = (i - f0) / max(1e-9, f1 - f0)
            return lerp_spec(s0, s1, EASES[e](w))
    return keys[-1][1]


def squash(s):
    """Volume-keeping scale for the root bone: s < 1 squashes, s > 1 stretches (vertical)."""
    k = 1 / math.sqrt(s)
    return (k, k, s)


def stretch_y(s):
    """Volume-keeping scale along a bone's own axis (torso: vertical)."""
    k = 1 / math.sqrt(s)
    return (k, s, k)


POSE = pb.POSES
GUARD = POSE["guard"]


def about_center(rot_deg, center=(0, 0, 0.8)):
    """Root location offset that makes a root rotation turn about `center` instead of the feet."""
    R = Euler([math.radians(a) for a in rot_deg], "XYZ").to_matrix()
    c = Vector(center)
    return tuple(c - R @ c)


# ---------------------------------------------------------------- loops (spec per frame)

def spec_idle(i, n):
    t = i / n
    ph = 2 * math.pi * t
    bob = 0.5 - 0.5 * math.cos(ph)  # 0 at top, 1 at the bottom
    return add_spec(GUARD, {
        "root": dict(loc=(0, 0, -0.03 * bob), scl=squash(1 - 0.04 * bob)),
        "torso": (2 * math.sin(ph - 0.4), 0, 1.5 * math.sin(ph * 0.5 * 2)),
        "head": (3 * math.sin(ph - 1.0), 0, 0),
        "upperarm.L": (4 * math.sin(ph - 0.8), 0, 0), "upperarm.R": (4 * math.sin(ph - 1.1), 0, 0),
        "forearm.L": (-3 * math.sin(ph - 1.2), 0, 0), "forearm.R": (-3 * math.sin(ph - 1.5), 0, 0),
        "thigh.L": (-4 * bob, 0, 0), "shin.L": (8 * bob, 0, 0), "foot.L": (-4 * bob, 0, 0),
        "thigh.R": (-4 * bob, 0, 0), "shin.R": (8 * bob, 0, 0), "foot.R": (-4 * bob, 0, 0),
    })


def spec_run(i, n):
    ph = 2 * math.pi * i / n  # one full cycle (two strides) per loop
    s, c2 = math.sin(ph), math.cos(2 * ph)
    up = abs(math.cos(ph))  # 1 at the top of a stride, 0 at foot contact
    return {
        "root": dict(loc=(0, 0, 0.03 + 0.09 * up), scl=squash(0.93 + 0.12 * up)),
        "hips": (0, 0, -12 * s),
        "torso": dict(rot=(16, 0, 14 * s), scl=stretch_y(0.97 + 0.05 * up)),
        "head": (-12 + 4 * c2, 0, -10 * s),
        "upperarm.L": (46 * s, -24, 0), "forearm.L": (-42 - 12 * s, 0, 0),
        "upperarm.R": (-46 * s, 24, 0), "forearm.R": (-42 + 12 * s, 0, 0),
        "thigh.L": (-52 * s - 8, -4, 0), "shin.L": (38 + 42 * max(0, math.sin(ph + 1.4)), 0, 0), "foot.L": (-12 * s, 0, 0),
        "thigh.R": (52 * s - 8, 4, 0), "shin.R": (38 + 42 * max(0, math.sin(ph + 1.4 + math.pi)), 0, 0), "foot.R": (12 * s, 0, 0),
    }


def spec_punch(i, n):
    wind = add_spec(GUARD, {
        "root": dict(loc=(0, 0.03, -0.04), scl=squash(0.92)),
        "hips": (0, 0, -6), "torso": (0, 0, -10), "head": (2, 0, 6),
        "upperarm.R": (12, 0, -6), "forearm.R": (-14, 0, 0),
        "thigh.L": (-6, 0, 0), "shin.L": (10, 0, 0), "thigh.R": (-6, 0, 0), "shin.R": (10, 0, 0),
    })
    jab = {
        "root": dict(loc=(0, -0.07, -0.05), scl=squash(1.05)),
        "hips": (0, 0, 7),
        "torso": dict(rot=(16, 0, 9), scl=stretch_y(1.07)),
        "head": (-10, 0, -6),
        "upperarm.L": (-48, 24, -22), "forearm.L": (-100, 0, -16), "hand.L": (-10, 0, 0),
        "upperarm.R": (-86, 0, 12), "forearm.R": (-2, 0, 0), "hand.R": dict(rot=(-2, 0, 0), scl=(1.12, 1.12, 1.12)),
        "thigh.L": (-30, -22, 0), "shin.L": (30, 0, 0), "foot.L": (0, 20, 0),
        "thigh.R": (24, 18, 0), "shin.R": (14, 0, 0), "foot.R": (-12, -10, 0),
    }
    settle = add_spec(jab, {"torso": dict(rot=(-3, 0, -4), scl=stretch_y(0.96)), "root": dict(scl=squash(0.97)),
                            "hand.R": dict(scl=(0.92, 0.92, 0.92))})
    over = add_spec(GUARD, {"root": dict(loc=(0, 0, -0.045), scl=squash(0.95)), "torso": (3, 0, 4), "upperarm.R": (-4, 0, 0)})
    keys = [(0, GUARD, "smooth"), (5, wind, "smooth"), (8, jab, "out"), (11, settle, "smooth"),
            (17, over, "smooth"), (24, GUARD, "smooth")]
    return timeline(keys, i)


def spec_launched(i, n):
    hit = add_spec(GUARD, {
        "root": dict(loc=(0, 0.06, -0.06), scl=squash(0.8)),
        "torso": (-22, 0, -8), "head": (-24, 6, 8),
        "upperarm.L": (20, -30, 0), "upperarm.R": (20, 30, 0),
    })
    keys = [(0, GUARD, "smooth"), (2, GUARD, "smooth"), (4, hit, "out")]
    # flight: frames 5..24, a back-flip about the body center, drifting back (+Y) and up
    if i <= 4:
        return timeline(keys, i)
    land_f, rec_f = 24, 40
    if i <= land_f:
        u = (i - 4) / (land_f - 4)
        h = 4 * u * (1 - u) * 0.75
        flip = -360 * smooth(min(1, u * 1.05))
        rot = (flip, 0, -12 * math.sin(math.pi * u))
        if SPRITE:
            rot, h, u_drift = (-18 * math.sin(math.pi * u), 0, -8 * math.sin(math.pi * u)), 0.0, 0.0
        off = about_center(rot)
        st = 1 + 0.16 * max(0, 1 - u * 4) - 0.05 * max(0, (u - 0.85) / 0.15)
        tuck = math.sin(math.pi * u)
        return {
            "root": dict(loc=(off[0], (0.06 + 0.42 * u) * (0 if SPRITE else 1) + off[1], h + off[2]), rot=rot, scl=squash(st)),
            "torso": (-10 + 24 * tuck, 0, 0), "head": (-16 + 10 * tuck, 8, 10),
            "upperarm.L": (-15, -80 + 40 * tuck, 0), "forearm.L": (0, -20, 0),
            "upperarm.R": (10, 70 - 40 * tuck, 0), "forearm.R": (0, 20, 0),
            "thigh.L": (-60 - 40 * tuck, -10, 0), "shin.L": (40 + 60 * tuck, 0, 0),
            "thigh.R": (-20 - 60 * tuck, 14, 0), "shin.R": (70 + 40 * tuck, 0, 0),
        }
    # land: a big squash, a rebound, back to guard and back to the start spot
    land = add_spec(GUARD, {"root": dict(loc=(0, 0 if SPRITE else 0.48, -0.05), scl=squash(0.82)), "torso": (14, 0, 0), "head": (6, 0, 0),
                            "upperarm.L": (-30, -30, 0), "upperarm.R": (-30, 30, 0),
                            "thigh.L": (-40, 0, 0), "shin.L": (70, 0, 0), "foot.L": (-30, 0, 0),
                            "thigh.R": (-40, 0, 0), "shin.R": (70, 0, 0), "foot.R": (-30, 0, 0)})
    rebound = add_spec(GUARD, {"root": dict(loc=(0, 0 if SPRITE else 0.3, 0 if SPRITE else 0.1), scl=squash(1.08)), "torso": (-6, 0, 0), "head": (-8, 0, 0)})
    shake = add_spec(GUARD, {"root": dict(loc=(0, 0 if SPRITE else 0.1, -0.02), scl=squash(0.96)), "head": (0, 0, 14), "torso": (0, 0, -6)})
    keys2 = [(land_f, land, "out"), (land_f + 3, land, "smooth"), (land_f + 7, rebound, "out"),
             (land_f + 11, shake, "smooth"), (rec_f, GUARD, "smooth")]
    return timeline(keys2, i)


ROCKET_HOLD = {
    "root": dict(loc=(0, 0, -0.03)),
    "torso": (4, 0, -8), "head": (-6, 0, 6),
    "upperarm.R": (-68, 0, 20), "forearm.R": (-24, 0, 0), "hand.R": (0, 0, 0),
    "upperarm.L": (-60, 30, -40), "forearm.L": (-80, 0, -20), "hand.L": (-8, 0, 0),
    "thigh.L": (-16, -12, 0), "shin.L": (24, 0, 0), "foot.L": (-8, 8, 0),
    "thigh.R": (4, 14, 0), "shin.R": (16, 0, 0), "foot.R": (-18, -10, 0),
}


def spec_rocket(i, n):
    fire = add_spec(ROCKET_HOLD, {"root": dict(loc=(0, 0.1, -0.06), scl=squash(0.86)), "torso": (-12, 0, -4),
                                  "head": (-8, 0, 0), "upperarm.R": (-4, 0, 0), "forearm.R": (2, 0, 0)})
    kick = add_spec(ROCKET_HOLD, {"root": dict(loc=(0, 0.13, -0.02), scl=squash(1.04)), "torso": (-6, 0, -2), "upperarm.R": (-7, 0, 0)})
    over = add_spec(ROCKET_HOLD, {"root": dict(loc=(0, 0.02, -0.05), scl=squash(0.97)), "torso": (3, 0, 0), "upperarm.R": (3, 0, 0)})
    keys = [(0, ROCKET_HOLD, "smooth"), (5, ROCKET_HOLD, "smooth"), (7, fire, "out"), (10, kick, "out"),
            (18, over, "smooth"), (26, ROCKET_HOLD, "smooth"), (36, ROCKET_HOLD, "smooth")]
    sp = timeline(keys, i)
    t = 2 * math.pi * i / n  # a small breathing bob through the whole loop
    return add_spec(sp, {"root": dict(loc=(0, 0, -0.008 * (1 - math.cos(t))))})


BAT_READY = {
    "root": dict(loc=(0, 0, -0.04)),
    "hips": (0, 0, -10), "torso": (2, 0, -16), "head": (-6, 0, 14),
    # the bat held up at chest height, the mitt below the visor (it covered the face at the 55 degree camera)
    "upperarm.R": (-72, 0, 30), "forearm.R": (-44, 0, 0), "hand.R": (0, 0, 0),
    "upperarm.L": (-48, 24, -22), "forearm.L": (-92, 0, -18), "hand.L": (-8, 0, 0),
    "thigh.L": (-14, -14, 0), "shin.L": (22, 0, 0), "foot.L": (-8, 8, 0),
    "thigh.R": (0, 16, 0), "shin.R": (20, 0, 0), "foot.R": (-14, -10, 0),
}


def bat_specs():
    wind = add_spec(BAT_READY, {"root": dict(loc=(0, 0.04, -0.03), scl=squash(0.9)), "hips": (0, 0, -8),
                                "torso": (0, 0, -14), "upperarm.R": (-12, 0, 10), "head": (0, 0, 6)})
    swing = {
        "root": dict(loc=(0, -0.08, -0.06), scl=squash(1.04)),
        "hips": (0, 0, 6), "torso": dict(rot=(16, 0, 8), scl=stretch_y(1.06)), "head": (-8, 0, -4),
        "upperarm.R": (-32, 0, 10), "forearm.R": (-6, 0, 0), "hand.R": (-4, 0, 0),
        "upperarm.L": (-40, 24, -10), "forearm.L": (-80, 0, -10), "hand.L": (-8, 0, 0),
        "thigh.L": (-30, -22, 0), "shin.L": (30, 0, 0), "foot.L": (0, 20, 0),
        "thigh.R": (24, 18, 0), "shin.R": (14, 0, 0), "foot.R": (-12, -10, 0),
    }
    follow = add_spec(swing, {"hips": (0, 0, 3), "torso": dict(rot=(6, 0, 4), scl=stretch_y(0.95)),
                              "upperarm.R": (18, 0, 0), "hand.R": (8, 0, 0), "root": dict(scl=squash(0.95))})
    return wind, swing, follow


def spec_bat(i, n):
    wind, swing, follow = bat_specs()
    keys = [(0, BAT_READY, "smooth"), (3, BAT_READY, "smooth"), (8, wind, "smooth"), (11, swing, "in"),
            (14, follow, "out"), (20, follow, "smooth"), (32, BAT_READY, "smooth")]
    return timeline(keys, i)


RIFLE_HOLD = {
    "root": dict(loc=(0, 0, -0.035)),
    "torso": (6, 0, -6), "head": (-2, 0, 4),
    "upperarm.R": (-66, 0, 22), "forearm.R": (-24, 0, 0), "hand.R": (0, 0, 0),
    "upperarm.L": (-70, 20, -50), "forearm.L": (-60, 0, -30), "hand.L": (-8, 0, 0),
    "thigh.L": (-14, -12, 0), "shin.L": (22, 0, 0), "foot.L": (-10, 8, 0),
    "thigh.R": (-2, 14, 0), "shin.R": (18, 0, 0), "foot.R": (-14, -10, 0),
}


def spec_rifle(i, n):
    fire = add_spec(RIFLE_HOLD, {"root": dict(loc=(0, 0.05, -0.05), scl=squash(0.93)), "torso": (-6, 0, -3),
                                 "upperarm.R": (-9, 0, 0), "forearm.R": (-4, 0, 0), "head": (-3, 0, 0)})
    over = add_spec(RIFLE_HOLD, {"root": dict(loc=(0, 0.0, -0.04), scl=squash(0.98)), "upperarm.R": (2, 0, 0)})
    keys = [(0, RIFLE_HOLD, "smooth"), (3, RIFLE_HOLD, "smooth"), (5, fire, "out"), (12, over, "smooth"),
            (18, RIFLE_HOLD, "smooth"), (24, RIFLE_HOLD, "smooth")]
    sp = timeline(keys, i)
    t = 2 * math.pi * i / n
    return add_spec(sp, {"root": dict(loc=(0, 0, -0.006 * (1 - math.cos(t))))})


def spec_jump(i, n):
    """Takeoff (crouch, stretch) then the air tuck; the game moves the sprite, so the feet stay put."""
    crouch = add_spec(GUARD, {"root": dict(loc=(0, 0, -0.1), scl=squash(0.86)), "torso": (10, 0, 0), "head": (-8, 0, 0),
                              "upperarm.L": (30, -10, 0), "upperarm.R": (30, 10, 0),
                              "thigh.L": (-50, 0, 0), "shin.L": (90, 0, 0), "foot.L": (-40, 0, 0),
                              "thigh.R": (-50, 0, 0), "shin.R": (90, 0, 0), "foot.R": (-40, 0, 0)})
    takeoff = {"root": dict(loc=(0, 0, 0.04), scl=squash(1.16)), "torso": (-8, 0, 0), "head": (-14, 0, 0),
               "upperarm.L": (50, -25, 0), "forearm.L": (-20, 0, 0), "upperarm.R": (50, 25, 0), "forearm.R": (-20, 0, 0),
               "thigh.L": (-6, 0, 0), "shin.L": (6, 0, 0), "foot.L": (30, 0, 0), "thigh.R": (-2, 0, 0), "shin.R": (4, 0, 0), "foot.R": (34, 0, 0)}
    tuck = dict(pb.POSES["jump"])
    tuck["root"] = dict(loc=(0, 0, 0.12), scl=squash(1.02))
    hang = add_spec(tuck, {"upperarm.L": (-10, 10, 0), "upperarm.R": (10, -10, 0), "thigh.L": (10, 0, 0), "thigh.R": (10, 0, 0),
                           "root": dict(scl=squash(0.99))})
    keys = [(0, crouch, "smooth"), (3, takeoff, "out"), (7, tuck, "smooth"), (15, hang, "smooth")]
    return timeline(keys, i)


def spec_flinch(i, n):
    """A grounded hit: snapped back and squashed, the head jolts, then back to guard."""
    hit = add_spec(GUARD, {"root": dict(loc=(0, 0.08, -0.07), scl=squash(0.82)), "hips": (0, 0, 6),
                           "torso": (-20, 0, -10), "head": (-4, 6, 6),
                           "upperarm.L": (24, -40, 0), "forearm.L": (40, 0, 0), "upperarm.R": (24, 40, 0), "forearm.R": (40, 0, 0),
                           "thigh.L": (-10, 0, 0), "shin.L": (24, 0, 0), "thigh.R": (-14, 0, 0), "shin.R": (28, 0, 0)})
    sway = add_spec(GUARD, {"root": dict(loc=(0, 0.03, -0.04), scl=squash(1.04)), "torso": (6, 0, 4), "head": (2, -4, -6)})
    keys = [(0, GUARD, "smooth"), (2, hit, "out"), (6, sway, "smooth"), (12, GUARD, "smooth")]
    return timeline(keys, i)


def spec_ko(i, n):
    """Knocked out: a hard hit, a wobble, the knees go, and it slumps down sitting, head and arms hanging."""
    hit = add_spec(GUARD, {"root": dict(loc=(0, 0.06, -0.05), scl=squash(0.84)), "torso": (-24, 0, -8), "head": (-28, 6, 10),
                           "upperarm.L": (10, -60, 0), "upperarm.R": (10, 60, 0)})
    wobble = add_spec(GUARD, {"root": dict(loc=(0, 0.02, -0.02), rot=(0, 8, 0)), "torso": (-6, 0, 10), "head": (-6, 14, -10),
                              "upperarm.L": (40, -30, 0), "forearm.L": (10, 0, 0), "upperarm.R": (40, 30, 0), "forearm.R": (10, 0, 0)})
    buckle = {"root": dict(loc=(0, 0.02, -0.22), scl=squash(0.92)), "torso": (6, 0, 0), "head": (2, -8, 0),
              "upperarm.L": (30, -12, 0), "forearm.L": (-10, 0, 0), "upperarm.R": (30, 12, 0), "forearm.R": (-10, 0, 0),
              "thigh.L": (-60, -8, 0), "shin.L": (110, 0, 0), "foot.L": (-40, 0, 0),
              "thigh.R": (-60, 8, 0), "shin.R": (110, 0, 0), "foot.R": (-40, 0, 0)}
    # sitting, leaning back, the face up toward the camera (the dizzy KO face shows), arms flopped out
    slump = {"root": dict(loc=(0, 0.04, -0.42), scl=squash(0.96)), "torso": (-22, 0, 0), "head": (-16, 10, 0),
             "upperarm.L": (10, -50, 0), "forearm.L": (-10, 0, 0), "hand.L": (10, 0, 0),
             "upperarm.R": (10, 50, 0), "forearm.R": (-10, 0, 0), "hand.R": (10, 0, 0),
             "thigh.L": (-84, -18, 0), "shin.L": (14, 0, 0), "foot.L": (20, 0, 0),
             "thigh.R": (-84, 18, 0), "shin.R": (14, 0, 0), "foot.R": (20, 0, 0),
             "antenna": (-30, 0, 0)}
    settle = add_spec(slump, {"root": dict(loc=(0, 0, 0.012), scl=squash(1.02)), "head": (4, 0, 0)})
    keys = [(0, GUARD, "smooth"), (2, hit, "out"), (8, wobble, "smooth"), (14, buckle, "in"), (19, slump, "out"), (23, settle, "smooth")]
    return timeline(keys, i)


def spec_celebrate(i, n):
    """The winner's loop: fists pumping overhead, a bounce on every beat (the game adds the hops)."""
    ph = 2 * math.pi * i / n
    up = 0.5 + 0.5 * math.cos(2 * ph)  # two beats per loop
    v = {k: x for k, x in pb.POSES["victory"].items() if not k.startswith(("upperarm", "forearm"))}
    pump = 18 * math.sin(2 * ph)
    return add_spec(v, {
        "root": dict(loc=(0, 0, -0.04 * (1 - up)), scl=squash(0.9 + 0.14 * up)),
        "torso": (0, 0, 8 * math.sin(ph)), "head": (-4 * up, 0, -6 * math.sin(ph)),
        "upperarm.L": (-125 - pump, -30, 0), "forearm.L": (-30 - 20 * up, 0, 0),
        "upperarm.R": (125 + pump, 30, 0), "forearm.R": (30 + 20 * up, 0, 0),
        "thigh.L": (-20 * (1 - up), 0, 0), "shin.L": (40 * (1 - up), 0, 0), "foot.L": (-20 * (1 - up), 0, 0),
        "thigh.R": (-20 * (1 - up), 0, 0), "shin.R": (40 * (1 - up), 0, 0), "foot.R": (-20 * (1 - up), 0, 0),
    })


SPECS = {"grenade": lambda i, n: spec_grenade(i, n), "mine": lambda i, n: spec_mine(i, n),
         "grapple": lambda i, n: spec_grapple(i, n),
         "hammer": lambda i, n: spec_hammer(i, n), "flamethrower": lambda i, n: spec_flamethrower(i, n),
         "lightning": lambda i, n: spec_lightning(i, n),
         "shotgun": lambda i, n: spec_shotgun(i, n), "sniper": lambda i, n: spec_sniper(i, n),
         "crossbow": lambda i, n: spec_crossbow(i, n), "railgun": lambda i, n: spec_railgun(i, n),
         "jump": spec_jump, "flinch": spec_flinch, "ko": spec_ko, "celebrate": spec_celebrate,
         "idle": spec_idle, "run": spec_run, "punch": spec_punch, "launched": spec_launched,
         "rocket": spec_rocket, "bat": spec_bat, "rifle": spec_rifle}
FACES = {
    "idle": lambda i: "angry", "run": lambda i: "focus",
    "punch": lambda i: "angry",
    "launched": lambda i: "dizzy" if 4 <= i < 34 else "angry",
    "rocket": lambda i: "focus", "bat": lambda i: "angry", "rifle": lambda i: "focus",
    "jump": lambda i: "focus", "flinch": lambda i: "dizzy", "ko": lambda i: "dizzy", "celebrate": lambda i: "happy",
    "shotgun": lambda i: "angry", "sniper": lambda i: "focus", "crossbow": lambda i: "focus", "railgun": lambda i: "angry",
    "hammer": lambda i: "angry", "flamethrower": lambda i: "angry", "lightning": lambda i: "angry",
    "grenade": lambda i: "angry", "mine": lambda i: "focus", "grapple": lambda i: "focus",
}


# ---------------------------------------------------------------- antenna follow-through

def _rot(sp, bone, ax):
    v = _norm(sp.get(bone))
    return v.get("rot", (0, 0, 0))[ax]


def antenna_track(fn, n):
    """Damped spring: the antenna lags the head's pitch and roll and whips on vertical accelerations."""
    pitch = np.array([sum(_rot(fn(i % n, n), b, 0) for b in ("root", "hips", "torso", "head")) for i in range(n)])
    roll = np.array([sum(_rot(fn(i % n, n), b, 1) for b in ("root", "torso", "head")) +
                     0.5 * sum(_rot(fn(i % n, n), b, 2) for b in ("hips", "torso")) for i in range(n)])
    z = np.array([(_norm(fn(i % n, n).get("root")).get("loc", (0, 0, 0))[2]) for i in range(n)])
    dt = 1 / FPS
    zacc = (np.roll(z, -1) - 2 * z + np.roll(z, 1)) / dt ** 2
    w, zeta, sub = 2 * math.pi * 2.6, 0.28, 8
    A = np.array([pitch[0], roll[0]])
    V = np.zeros(2)
    out = np.zeros((n, 2))
    for cyc in range(3):
        for i in range(n):
            tgt0 = np.array([pitch[i], roll[i]])
            tgt1 = np.array([pitch[(i + 1) % n], roll[(i + 1) % n]])
            if cyc == 2:
                out[i] = A - tgt0
            for k in range(sub):
                tg = tgt0 + (tgt1 - tgt0) * (k / sub)
                acc = w * w * (tg - A) - 2 * zeta * w * V + np.array([-0.9 * zacc[i], 0.0])
                V += acc * dt / sub
                A += V * dt / sub
    return np.clip(out * 1.3, -40, 40)


# ---------------------------------------------------------------- weapon building

class WFrame:
    """The weapon frame on the near (right) mitt at rest: origin = mitt center."""

    def __init__(self, rig, bone="hand.R"):
        b = rig.data.bones[bone]
        head, tail = Vector(b.head_local), Vector(b.tail_local)
        self.bone = bone
        F = (tail - head).normalized()
        U0 = Vector((0, -1, 0))  # the forward direction at rest becomes "up" when the forearm is level
        U = (U0 - F * F.dot(U0)).normalized()
        S = F.cross(U)
        self.O = (head + tail) / 2
        self.M = Matrix(((S.x, F.x, U.x, self.O.x), (S.y, F.y, U.y, self.O.y), (S.z, F.z, U.z, self.O.z), (0, 0, 0, 1)))
        self.rest_parent = b.matrix_local @ Matrix.Translation((0, b.length, 0))

    def attach(self, ob, rig, origin=(0, 0, 0)):
        """Bone-parent ob to the hand; its mesh is in weapon coordinates relative to `origin`."""
        ob.parent = rig
        ob.parent_type = "BONE"
        ob.parent_bone = self.bone
        ob.matrix_parent_inverse = self.rest_parent.inverted()
        ob.matrix_basis = self.M @ Matrix.Translation(origin)
        return ob


def wobj(name, v, f, mat, wf, rig, origin=(0, 0, 0), smooth=True):
    v = np.asarray(v, float) - np.asarray(origin, float)
    ob = pb.mesh_obj(name, v, f, mat, smooth=smooth)
    wf.attach(ob, rig, origin)
    return ob


def tube(p0, p1, prof, seg=40):
    """A lathe along p0->p1. prof: [(t in 0..1, r)], ends closed."""
    L = float(np.linalg.norm(np.subtract(p1, p0)))
    pr = [(prof[0][0] * L, 0)] + [(t * L, r) for t, r in prof] + [(prof[-1][0] * L, 0)]
    v, f = pb.lathe(pr, seg)
    return pb.align(v, p0, p1), f


def ring(center, axis, R, prof, n=64):
    """A swept ring around `axis` through `center`, radius R; prof is the 2D cross-section."""
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    u = np.cross(axis, (0, 0, 1) if abs(axis[2]) < 0.9 else (1, 0, 0))
    u /= np.linalg.norm(u)
    w = np.cross(axis, u)
    P, N = [], []
    for i in range(n):
        a = 2 * math.pi * i / n
        d = u * math.cos(a) + w * math.sin(a)
        P.append(np.asarray(center) + d * R)
        N.append(d)
    return pb.sweep(P, N, prof)


def soft_box(c, hx, hy, hz, p=3.2, n=20):
    return pb.superellipsoid(n, c, hx, hy, hy, hz, hz, p=p, q=p)


def bvh_local(*parts):
    vs, fs, off = [], [], 0
    for v, f in parts:
        vs.extend(map(tuple, v))
        fs.extend([[i + off for i in fc] for fc in f])
        off += len(v)
    tris = []
    for fc in fs:
        for k in range(1, len(fc) - 1):
            tris.append((fc[0], fc[k], fc[k + 1]))
    return BVHTree.FromPolygons(vs, tris)


def ring_stitch(B, bvh, center, axis, R, n=120, **kw):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    u = np.cross(axis, (0, 0, 1) if abs(axis[2]) < 0.9 else (1, 0, 0))
    u /= np.linalg.norm(u)
    w = np.cross(axis, u)
    pts = [tuple(np.asarray(center) + (u * math.cos(2 * math.pi * i / n) + w * math.sin(2 * math.pi * i / n)) * R) for i in range(n)]
    pb.stitch_path(B, pts, pb.surf_fn(bvh, 0.3), closed=True, **kw)  # 0.3: the ring may sit well off the surface


def line_stitch(B, bvh, a, b, n=60, **kw):
    pts = [tuple(np.asarray(a) + (np.asarray(b) - np.asarray(a)) * (i / n)) for i in range(n + 1)]
    # snapped to the nearest surface (0.3: the guide line may sit well off it; at 0.08 most weapon seams came out empty)
    pb.stitch_path(B, pts, pb.surf_fn(bvh, 0.3), **kw)


def flash_mesh(length=0.55, radius=0.2, spikes=7, seed=1):
    """A toy muzzle flash: a round core, a long forward spike, and a ring of shorter spikes (along +y)."""
    rng = np.random.default_rng(seed)
    B = pb.Builder()
    v, f = pb.ellipsoid_unit()
    B.add(v * np.array([radius * 0.7, radius * 0.8, radius * 0.7]), f)
    cone = [(0.0, radius * 0.45), (0.5, radius * 0.28), (1.0, 0.004)]
    tv, tf = tube((0, 0, 0), (0, length, 0), cone, 16)
    B.add(tv, tf)
    for k in range(spikes):
        a = 2 * math.pi * k / spikes + rng.uniform(-0.2, 0.2)
        d = np.array([math.cos(a), 0.55 + rng.uniform(0, 0.4), math.sin(a)])
        d /= np.linalg.norm(d)
        L = length * rng.uniform(0.45, 0.7)
        tv, tf = tube((0, 0, 0), tuple(d * L), [(0.0, radius * 0.3), (0.6, radius * 0.16), (1.0, 0.003)], 12)
        B.add(tv, tf)
    return np.array(B.v), B.f


def puff_mesh(r, seed):
    """A cotton-ball smoke puff: a few overlapping spheres."""
    rng = np.random.default_rng(seed)
    B = pb.Builder()
    v, f = pb.ellipsoid_unit()
    for k in range(5):
        c = rng.normal(0, r * 0.45, 3)
        s = r * rng.uniform(0.55, 0.85)
        B.add(v * s + c, f)
    return np.array(B.v), B.f


def socket(name, wf, rig, M, B, top_z, side_x=None):
    """The mitt socket: a stitched leather cuff ring around the mitt's middle, a vinyl bracket to the weapon, and a
    gold snap rivet. The bracket goes up to local z = top_z, or (side_x set) out to the side to local x = side_x, so
    the weapon rides beside the mitt at mitt height, below the visor."""
    R = 0.205
    prof = pb.rounded_rect_2d(0.055, 0.105, 0.022, 4)
    rv, rf = ring((0, 0, 0), (0, 1, 0), R, prof, 72)
    ob = wobj(name + " socket", rv, rf, M["leather"], wf, rig)
    bv = bvh_local((rv, rf))
    SB = pb.Builder()  # its own stitches: the socket stays on the mitt when a weapon is moved
    for dy in (-0.036, 0.036):
        ring_stitch(SB, bv, (0, dy, 0), (0, 1, 0), R + 0.06, dash=0.024, gap=0.014, width=0.009, height=0.006)
    so_ = SB.obj(name + " socket stitches", M["thread"])
    if so_ is not None:
        wf.attach(so_, rig)
    sv, sf = pb.ellipsoid_unit()
    if side_x is None:
        # bracket: from the ring's top to the weapon's underside; the snap on the outer side
        z0 = R + 0.02
        hz = max(0.03, (top_z - z0) / 2 + 0.02)
        kv, kf = soft_box((0, 0, z0 + hz - 0.02), 0.06, 0.07, hz, p=3.0, n=12)
        wobj(name + " snap", sv * np.array([0.018, 0.03, 0.03]) + np.array([R + 0.03, 0, 0.0]), sf, M["gold"], wf, rig)
    else:
        # bracket: from the ring's outer side to the weapon's inner side; the snap on top
        x0 = R + 0.015
        hx = max(0.03, (side_x - x0) / 2 + 0.025)
        kv, kf = soft_box((x0 + hx - 0.02, 0, 0), hx, 0.07, 0.06, p=3.0, n=12)
        wobj(name + " snap", sv * np.array([0.03, 0.03, 0.018]) + np.array([0, 0, R + 0.03]), sf, M["gold"], wf, rig)
    wobj(name + " bracket", kv, kf, M["accent"], wf, rig)
    return ob


def emit_two(name, inner, outer, strength):
    """Emission that is hot in the middle and colored at the edges (facing ratio)."""
    m, nt, out = pb.node_mat(name)
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.45
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = pb.srgb(inner)
    mix.inputs[7].default_value = pb.srgb(outer)
    nt.links.new(lw.outputs["Facing"], mix.inputs["Factor"])
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Strength"].default_value = strength
    nt.links.new(mix.outputs[2], e.inputs["Color"])
    nt.links.new(e.outputs[0], out.inputs["Surface"])
    return m


def trail_mat(name, color, strength):
    """Emissive ribbon that fades with age (UV u: 0 = newest, 1 = oldest)."""
    m, nt, out = pb.node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["UV"], sep.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.0
    mr.inputs["From Max"].default_value = 1.0
    mr.inputs["To Min"].default_value = 1.0
    mr.inputs["To Max"].default_value = 0.0
    nt.links.new(sep.outputs["X"], mr.inputs["Value"])
    pw = nt.nodes.new("ShaderNodeMath")
    pw.operation = "POWER"
    pw.inputs[1].default_value = 1.6
    nt.links.new(mr.outputs[0], pw.inputs[0])
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = pb.srgb(color)
    e.inputs["Strength"].default_value = strength
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(pw.outputs[0], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(e.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    try:
        m.blend_method = "BLEND"
    except Exception:
        pass
    return m


class Weapon:
    def __init__(self, name):
        self.name = name
        self.parts = []   # always visible while the weapon is shown
        self.fx = []      # (object, keyer(frame_index) -> (visible, scale))


def weapon_mats():
    return dict(
        leather=pb.fabric_mat("W leather", LEATHER, rough=0.6, sheen=0.4, fuzz_bump=0.15, felt=0.05, sss=0.0),
        thread=pb.fabric_mat("W thread", pb.THREAD, rough=0.7, sheen=0.5, fuzz_bump=0.1, felt=0.0, sss=0.0),
        red_thread=pb.fabric_mat("W red thread", "#c8322a", rough=0.7, sheen=0.5, fuzz_bump=0.1, felt=0.0, sss=0.0),
        gold=pb.glossy_mat("W gold", pb.GOLD, rough=0.22, coat=0.8, metal=0.55, spec=0.6),
        accent=pb.glossy_mat("W bracket", "#2a2e38", rough=0.25, coat=0.9, spec=0.5),
        olive=pb.fabric_mat("W olive", "#6f8a3c", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        red_vinyl=pb.glossy_mat("W red vinyl", "#d6352b", rough=0.2, coat=1.0, spec=0.6),
        yellow_vinyl=pb.glossy_mat("W yellow vinyl", "#f2b623", rough=0.22, coat=1.0, spec=0.6),
        cream=pb.fabric_mat("W cream", "#efe2c4", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.25),
        black_vinyl=pb.glossy_mat("W black vinyl", "#1a1c22", rough=0.3, coat=1.0, spec=0.5),
        teal=pb.fabric_mat("W teal", "#2f6b78", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        gunmetal=pb.glossy_mat("W gunmetal", "#2e333d", rough=0.18, coat=1.0, metal=0.3, spec=0.6),
        lens=pb.emit_mat("W lens", "#5ef0ff", 6.0),
        sight=pb.emit_mat("W sight", "#ff3b30", 8.0),
        flash=emit_two("W flash", "#fff6d8", "#ff8a1c", 26.0),
        blast=emit_two("W blast", "#ffe9b0", "#ff5a14", 18.0),
        tracer=pb.emit_mat("W tracer", "#ffe7a0", 30.0),
        smoke=pb.fabric_mat("W smoke", "#d9d6e2", rough=0.95, sheen=1.0, fuzz_bump=0.5, felt=0.5, sss=0.0),
        trail=trail_mat("W trail", "#e4f8ff", 16.0),
        exhaust=emit_two("W exhaust", "#fff0c0", "#ff7a1a", 20.0),
        brick=pb.fabric_mat("W brick", "#b5452f", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        walnut=pb.fabric_mat("W walnut", "#8a5330", rough=0.85, sheen=0.7, fuzz_bump=0.25, felt=0.15),
        navy=pb.fabric_mat("W navy", "#33427a", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        tan=pb.fabric_mat("W tan", "#c9995c", rough=0.9, sheen=0.8, fuzz_bump=0.3, felt=0.2),
        green_vinyl=pb.glossy_mat("W green vinyl", "#62c43c", rough=0.22, coat=1.0, spec=0.6),
        white_plush=pb.fabric_mat("W white plush", "#eef0f4", rough=0.92, sheen=1.0, fuzz_bump=0.35, felt=0.25),
        coil=pb.emit_mat("W coil", "#68dcff", 5.0),
        orange=pb.fabric_mat("W orange", "#f0902e", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        yellow_plush=pb.fabric_mat("W yellow plush", "#efc23a", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        pilot=pb.emit_mat("W pilot", "#5ab8ff", 6.0),
        lavender=pb.fabric_mat("W lavender", "#e3dcff", rough=0.88, sheen=1.0, fuzz_bump=0.3, felt=0.2),
        bolt=pb.emit_mat("W bolt", "#a77bff", 12.0),
        pink=pb.fabric_mat("W pink", "#e8649e", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
        mine_light=pb.emit_mat("W mine light", "#ff7cc0", 8.0),
        sky=pb.fabric_mat("W sky", "#4f9fe0", rough=0.9, sheen=0.9, fuzz_bump=0.3, felt=0.2),
    )


# side mount (#85 game-size pass): the rocket and rifle ride beside the mitt at mitt height (below the visor),
# shifted outward (+x, toward the camera) and down from where they were built (on top of the mitt)
ROCKET_SHIFT = (0.22, 0.0, -0.3)
RIFLE_SHIFT = (0.34, 0.0, -0.3)


def shift_weapon(W, wf, off):
    """Move a weapon's parts and effects by `off` in the mitt frame (children of other weapon objects follow)."""
    T = wf.M @ Matrix.Translation(off) @ wf.M.inverted()
    for ob in list(W.parts) + [o for o, _ in W.fx]:
        if ob is None or ob.parent_type == "OBJECT":
            continue
        ob.matrix_basis = T @ ob.matrix_basis


def build_rocket(wf, rig, M):
    W = Weapon("rocket")
    B = pb.Builder()
    zt, r = 0.42, 0.145
    xo = 0.2  # outward, so the tube clears the head
    y0, y1 = -0.42, 0.74
    prof = [(0.0, r * 0.9), (0.03, r)] + [(t, r * (1 + 0.035 * math.sin(math.pi * t))) for t in np.linspace(0.06, 0.94, 18)] + [(0.97, r), (1.0, r * 0.9)]
    tv, tf = tube((xo, y0, zt), (xo, y1, zt), prof, 48)
    # quilted rings along the tube
    yy = tv[:, 1]
    rad = np.linalg.norm(tv[:, [0, 2]] - np.array([xo, zt]), axis=1)
    sc_ = 1 - 0.035 * np.clip(np.cos((yy - y0) * 2 * math.pi / 0.16), 0.5, 1) * (rad > r * 0.5)
    tv[:, 0] = xo + (tv[:, 0] - xo) * sc_
    tv[:, 2] = zt + (tv[:, 2] - zt) * sc_
    W.parts.append(wobj("Rocket tube", tv, tf, M["olive"], wf, rig))
    bvt = bvh_local((tv, tf))
    line_stitch(B, bvt, (xo, y0 + 0.04, zt + r + 0.05), (xo, y1 - 0.04, zt + r + 0.05), dash=0.03, gap=0.018)
    line_stitch(B, bvt, (xo, y0 + 0.04, zt - r - 0.05), (xo, y1 - 0.04, zt - r - 0.05), dash=0.03, gap=0.018)
    # vinyl bands and the muzzle and rear bell
    for yb, mat, w in ((y1 - 0.01, "red_vinyl", 0.06), (0.4, "yellow_vinyl", 0.05), (-0.16, "yellow_vinyl", 0.05)):
        rv, rf = ring((xo, yb, zt), (0, 1, 0), r + 0.012, pb.rounded_rect_2d(0.04, w, 0.016, 4), 64)
        W.parts.append(wobj("Rocket band %.2f" % yb, rv, rf, M[mat], wf, rig))
    bell = [(0.0, r * 0.95), (0.4, r * 1.08), (1.0, r * 1.32)]
    bv_, bf_ = tube((xo, y0 + 0.02, zt), (xo, y0 - 0.12, zt), bell, 48)
    W.parts.append(wobj("Rocket bell", bv_, bf_, M["red_vinyl"], wf, rig))
    # the rocket's nose peeking out of the muzzle
    nv, nf = tube((xo, y1 - 0.06, zt), (xo, y1 + 0.13, zt), [(0.0, r * 0.7), (0.35, r * 0.68), (0.75, r * 0.45), (1.0, 0.01)], 32)
    W.parts.append(wobj("Rocket nose", nv, nf, M["red_vinyl"], wf, rig))
    # sight box with a red dot, on the inner top
    sv, sf = soft_box((xo - 0.07, 0.3, zt + r + 0.05), 0.035, 0.06, 0.04, n=10)
    W.parts.append(wobj("Rocket sight", sv, sf, M["black_vinyl"], wf, rig))
    dv, df = pb.ellipsoid_unit()
    W.parts.append(wobj("Rocket sight dot", dv * 0.016 + np.array([xo - 0.07, 0.36, zt + r + 0.055]), df, M["sight"], wf, rig))
    # rear grip under the tube
    gv, gf = soft_box((xo, 0.42, zt - r - 0.08), 0.045, 0.05, 0.09, n=12)
    W.parts.append(wobj("Rocket rear grip", gv, gf, M["leather"], wf, rig))
    # socket under the front of the tube; the bracket leans out to the tube's x offset
    socket("Rocket", wf, rig, M, B, zt - r, side_x=ROCKET_SHIFT[0] + xo - r)
    add_builder(W, B, "Rocket stitches", M["thread"], wf, rig)
    # FX: front flash, back blast, a flying rocket, cotton smoke at the rear
    fv, ff = flash_mesh(0.7, 0.24, 8, seed=3)
    fo = wobj("Rocket flash", fv, ff, M["flash"], wf, rig)
    fo.matrix_basis = wf.M @ Matrix.Translation((xo, y1 + 0.14, zt))
    W.fx.append((fo, "rflash"))
    bv2, bf2 = flash_mesh(0.6, 0.26, 7, seed=5)
    bv2 = bv2 * np.array([1, -1, 1])
    bob = wobj("Rocket blast", bv2, bf2, M["blast"], wf, rig)
    bob.matrix_basis = wf.M @ Matrix.Translation((xo, y0 - 0.16, zt))
    W.fx.append((bob, "rblast"))
    # projectile
    P = pb.Builder()
    pv, pf = tube((0, -0.14, 0), (0, 0.16, 0), [(0.0, 0.07), (0.6, 0.075), (0.85, 0.05), (1.0, 0.005)], 24)
    P.add(pv, pf)
    proj = wobj("Rocket projectile", np.array(P.v), P.f, M["red_vinyl"], wf, rig)
    proj.matrix_basis = wf.M @ Matrix.Translation((xo, y1 + 0.05, zt))
    W.fx.append((proj, "rproj"))
    ev, ef = flash_mesh(0.3, 0.09, 5, seed=7)
    ex = wobj("Rocket exhaust", ev * np.array([1, -1, 1]) + np.array([0, -0.15, 0]), ef, M["exhaust"], wf, rig)
    ex.parent = proj
    ex.parent_type = "OBJECT"
    ex.matrix_parent_inverse = Matrix.Identity(4)
    ex.matrix_basis = Matrix.Identity(4)
    W.fx.append((ex, "rexhaust"))
    for k in range(4):
        sv_, sf_ = puff_mesh(0.11 + 0.03 * k, seed=11 + k)
        so = wobj("Rocket smoke %d" % k, sv_, sf_, M["smoke"], wf, rig)
        so.matrix_basis = wf.M @ Matrix.Translation((xo + 0.06 * (k - 1.5), y0 - 0.25 - 0.14 * k, zt + 0.05 * k))
        W.fx.append((so, "rsmoke%d" % k))
    shift_weapon(W, wf, ROCKET_SHIFT)
    return W


def build_bat(wf, rig, M):
    W = Weapon("bat")
    B = pb.Builder()
    R = 0.205
    zb = R + 0.06  # knob sits on the bracket
    z_h, z_t = zb + 0.32, zb + 1.2
    # grip: black vinyl with a spiral wrap
    gv, gf = tube((0, 0, zb), (0, 0, z_h + 0.04), [(0.0, 0.055), (0.5, 0.052), (1.0, 0.056)], 28)
    ang = np.arctan2(gv[:, 1], gv[:, 0])
    gz = gv[:, 2]
    sc_ = 1 + 0.08 * (np.sin(ang + gz * 70) > 0.6)
    gv[:, 0] *= sc_
    gv[:, 1] *= sc_
    W.parts.append(wobj("Bat grip", gv, gf, M["black_vinyl"], wf, rig))
    kv, kf = tube((0, 0, zb - 0.04), (0, 0, zb + 0.03), [(0.0, 0.06), (0.4, 0.075), (1.0, 0.05)], 28)
    W.parts.append(wobj("Bat knob", kv, kf, M["black_vinyl"], wf, rig))
    # padded cream barrel, swelling to the end
    prof = [(0.0, 0.06), (0.15, 0.08), (0.4, 0.12), (0.7, 0.15), (0.92, 0.155), (0.98, 0.13), (1.0, 0.08)]
    bv, bf = tube((0, 0, z_h), (0, 0, z_t), prof, 40)
    W.parts.append(wobj("Bat barrel", bv, bf, M["cream"], wf, rig))
    bvb = bvh_local((bv, bf))
    # baseball-style red stitched seams: two wavy lines up the barrel, two rings near the end
    for side in (1, -1):
        pts = []
        for i in range(80):
            t = i / 79
            z = z_h + 0.18 + t * (z_t - z_h - 0.24)
            a = side * math.pi / 2 + 0.5 * math.sin(t * 6 * math.pi)
            pts.append((math.cos(a) * 0.32, math.sin(a) * 0.32, z))
        # project from outside onto the barrel
        proj_ = []
        for p_ in pts:
            hit = bvb.ray_cast(Vector(p_), (Vector((0, 0, p_[2])) - Vector(p_)).normalized(), 1.0)
            if hit[0] is not None:
                proj_.append(tuple(hit[0]))
        pb.stitch_path(B, proj_, pb.surf_fn(bvb, 0.05), dash=0.028, gap=0.018, width=0.011, height=0.007)
    redB = pb.Builder()
    for zr in (z_t - 0.12, z_t - 0.2):
        ring_stitch(redB, bvb, (0, 0, zr), (0, 0, 1), 0.18, dash=0.026, gap=0.016, width=0.011, height=0.007)
    socket("Bat", wf, rig, M, B, zb - 0.04)
    add_builder(W, B, "Bat stitches", M["thread"], wf, rig)
    add_builder(W, redB, "Bat red stitches", M["red_thread"], wf, rig)
    W.tip = (0, 0, z_t - 0.04)
    W.mid = (0, 0, z_h + 0.12)
    return W


def build_rifle(wf, rig, M):
    W = Weapon("rifle")
    B = pb.Builder()
    zr = 0.36  # receiver center height
    # receiver: plush teal body
    rv, rf = pb.superellipsoid(24, (0, 0.13, zr), 0.085, 0.27, 0.27, 0.1, 0.09, p=3.4, q=3.0)
    W.parts.append(wobj("Rifle receiver", rv, rf, M["teal"], wf, rig))
    bvr = bvh_local((rv, rf))
    for sx in (1, -1):
        line_stitch(B, bvr, (sx * 0.2, -0.1, zr + 0.06), (sx * 0.2, 0.37, zr + 0.06), dash=0.026, gap=0.016)
        line_stitch(B, bvr, (sx * 0.2, -0.1, zr - 0.06), (sx * 0.2, 0.37, zr - 0.06), dash=0.026, gap=0.016)
    # stock: back over the forearm, plush, with a leather butt pad
    sv, sf = pb.superellipsoid(20, (0, -0.32, zr + 0.01), 0.07, 0.2, 0.2, 0.085, 0.1, p=3.0, q=2.6)
    W.parts.append(wobj("Rifle stock", sv, sf, M["teal"], wf, rig))
    bvs = bvh_local((sv, sf))
    line_stitch(B, bvs, (0, -0.5, zr + 0.2), (0, -0.14, zr + 0.2), dash=0.026, gap=0.016)
    pv, pf = soft_box((0, -0.53, zr), 0.075, 0.03, 0.105, n=12)
    W.parts.append(wobj("Rifle butt pad", pv, pf, M["leather"], wf, rig))
    # barrel: glossy vinyl, with a muzzle brake
    bv, bf = tube((0, 0.36, zr + 0.02), (0, 0.98, zr + 0.02), [(0.0, 0.05), (0.1, 0.045), (0.9, 0.04), (1.0, 0.04)], 28)
    W.parts.append(wobj("Rifle barrel", bv, bf, M["gunmetal"], wf, rig))
    mv, mf = tube((0, 0.94, zr + 0.02), (0, 1.06, zr + 0.02), [(0.0, 0.058), (0.5, 0.064), (1.0, 0.058)], 28)
    W.parts.append(wobj("Rifle muzzle", mv, mf, M["black_vinyl"], wf, rig))
    hv, hf = tube((0, 0.38, zr + 0.02), (0, 0.66, zr + 0.02), [(0.0, 0.07), (0.15, 0.078), (0.85, 0.078), (1.0, 0.07)], 28)
    W.parts.append(wobj("Rifle handguard", hv, hf, M["teal"], wf, rig))
    bvh_ = bvh_local((hv, hf))
    for yb in (0.42, 0.62):
        ring_stitch(B, bvh_, (0, yb, zr + 0.02), (0, 1, 0), 0.2, dash=0.022, gap=0.014, width=0.009, height=0.006)
    # scope: vinyl tube with a glowing lens, on two mounts
    cv, cf = tube((0, -0.06, zr + 0.2), (0, 0.32, zr + 0.2), [(0.0, 0.058), (0.12, 0.05), (0.85, 0.05), (1.0, 0.066)], 28)
    W.parts.append(wobj("Rifle scope", cv, cf, M["black_vinyl"], wf, rig))
    lv, lf = pb.ellipsoid_unit()
    W.parts.append(wobj("Rifle lens", lv * np.array([0.05, 0.012, 0.05]) + np.array([0, 0.325, zr + 0.2]), lf, M["lens"], wf, rig))
    for ym in (0.02, 0.24):
        kv, kf = soft_box((0, ym, zr + 0.13), 0.03, 0.025, 0.04, n=10)
        W.parts.append(wobj("Rifle mount %.2f" % ym, kv, kf, M["gunmetal"], wf, rig))
    # magazine: a plush block forward of the socket
    gv, gf = soft_box((0, 0.3, zr - 0.15), 0.05, 0.05, 0.1, n=12)
    W.parts.append(wobj("Rifle magazine", gv, gf, M["leather"], wf, rig))
    # gold rivets on the receiver
    dv, df = pb.ellipsoid_unit()
    for yv in (-0.06, 0.32):
        W.parts.append(wobj("Rifle rivet %.2f" % yv, dv * np.array([0.012, 0.018, 0.018]) + np.array([0.086, yv, zr]), df, M["gold"], wf, rig))
    socket("Rifle", wf, rig, M, B, zr - 0.09, side_x=RIFLE_SHIFT[0] - 0.085)
    add_builder(W, B, "Rifle stitches", M["thread"], wf, rig)
    fv, ff = flash_mesh(0.42, 0.13, 7, seed=21)
    fo = wobj("Rifle flash", fv, ff, M["flash"], wf, rig)
    fo.matrix_basis = wf.M @ Matrix.Translation((0, 1.08, zr + 0.02))
    W.fx.append((fo, "flash"))
    tv, tf = tube((0, 0.0, 0), (0, 2.6, 0), [(0.0, 0.004), (0.1, 0.014), (0.9, 0.014), (1.0, 0.004)], 10)
    to = wobj("Rifle tracer", tv, tf, M["tracer"], wf, rig)
    to.matrix_basis = wf.M @ Matrix.Translation((0, 1.25, zr + 0.02))
    W.fx.append((to, "tracer"))
    shift_weapon(W, wf, RIFLE_SHIFT)
    return W


# ---------------------------------------------------------------- phase 2: shotgun, sniper, crossbow, railgun
# The same toy line as rocket, bat and rifle: plush bodies with stitched seams, glossy vinyl parts, the leather mitt
# socket and a side mount (beside the mitt, below the visor). No effect meshes: the game draws the flash, the shot and
# the projectile in code, anchored to the muzzle (plush_sprites BARREL).

SHOTGUN_SHIFT = (0.34, 0.0, -0.3)
SNIPER_SHIFT = (0.32, 0.0, -0.3)
CROSSBOW_SHIFT = (0.33, 0.0, -0.3)
RAILGUN_SHIFT = (0.38, 0.0, -0.3)


def build_shotgun(wf, rig, M):
    W = Weapon("shotgun")
    B = pb.Builder()
    zr = 0.36
    rv, rf = pb.superellipsoid(24, (0, 0.08, zr), 0.095, 0.22, 0.22, 0.105, 0.1, p=3.4, q=3.0)
    W.parts.append(wobj("Shotgun receiver", rv, rf, M["brick"], wf, rig))
    bvr = bvh_local((rv, rf))
    for sx in (1, -1):
        line_stitch(B, bvr, (sx * 0.2, -0.1, zr + 0.06), (sx * 0.2, 0.27, zr + 0.06), dash=0.026, gap=0.016)
    sv, sf = pb.superellipsoid(20, (0, -0.3, zr - 0.02), 0.075, 0.2, 0.2, 0.095, 0.11, p=3.0, q=2.6)
    W.parts.append(wobj("Shotgun stock", sv, sf, M["walnut"], wf, rig))
    bvs = bvh_local((sv, sf))
    line_stitch(B, bvs, (0, -0.48, zr + 0.2), (0, -0.14, zr + 0.2), dash=0.026, gap=0.016)
    pv, pf = soft_box((0, -0.51, zr - 0.02), 0.08, 0.03, 0.115, n=12)
    W.parts.append(wobj("Shotgun butt pad", pv, pf, M["black_vinyl"], wf, rig))
    # a fat barrel over the magazine tube, a stitched red pump grip, a flared muzzle
    bv, bf = tube((0, 0.28, zr + 0.04), (0, 0.86, zr + 0.04), [(0.0, 0.062), (1.0, 0.058)], 28)
    W.parts.append(wobj("Shotgun barrel", bv, bf, M["gunmetal"], wf, rig))
    mv, mf = tube((0, 0.28, zr - 0.06), (0, 0.8, zr - 0.06), [(0.0, 0.045), (1.0, 0.045)], 24)
    W.parts.append(wobj("Shotgun tube", mv, mf, M["black_vinyl"], wf, rig))
    gv, gf = tube((0, 0.44, zr - 0.04), (0, 0.66, zr - 0.04), [(0.0, 0.07), (0.2, 0.085), (0.8, 0.085), (1.0, 0.07)], 28)
    W.parts.append(wobj("Shotgun pump", gv, gf, M["red_vinyl"], wf, rig))
    bvp = bvh_local((gv, gf))
    for yb in (0.49, 0.61):
        ring_stitch(B, bvp, (0, yb, zr - 0.04), (0, 1, 0), 0.2, dash=0.022, gap=0.014, width=0.009, height=0.006)
    fv, ff = tube((0, 0.84, zr + 0.04), (0, 0.93, zr + 0.04), [(0.0, 0.066), (0.6, 0.08), (1.0, 0.084)], 28)
    W.parts.append(wobj("Shotgun muzzle", fv, ff, M["black_vinyl"], wf, rig))
    # three shells on the stock's side: red plush with brass caps
    for k in range(3):
        y = -0.36 + k * 0.075
        cv, cf = tube((0.08, y, zr - 0.06), (0.08, y, zr + 0.05), [(0.0, 0.026), (1.0, 0.026)], 14)
        W.parts.append(wobj("Shotgun shell %d" % k, cv, cf, M["red_vinyl"], wf, rig))
        hv, hf = tube((0.08, y, zr - 0.07), (0.08, y, zr - 0.04), [(0.0, 0.028), (1.0, 0.028)], 14)
        W.parts.append(wobj("Shotgun shell cap %d" % k, hv, hf, M["gold"], wf, rig))
    socket("Shotgun", wf, rig, M, B, zr - 0.1, side_x=SHOTGUN_SHIFT[0] - 0.095)
    add_builder(W, B, "Shotgun stitches", M["thread"], wf, rig)
    shift_weapon(W, wf, SHOTGUN_SHIFT)
    return W


def build_sniper(wf, rig, M):
    W = Weapon("sniper")
    B = pb.Builder()
    zr = 0.36
    rv, rf = pb.superellipsoid(24, (0, 0.1, zr), 0.075, 0.26, 0.26, 0.085, 0.08, p=3.4, q=3.0)
    W.parts.append(wobj("Sniper receiver", rv, rf, M["navy"], wf, rig))
    bvr = bvh_local((rv, rf))
    for sx in (1, -1):
        line_stitch(B, bvr, (sx * 0.2, -0.12, zr + 0.05), (sx * 0.2, 0.34, zr + 0.05), dash=0.026, gap=0.016)
    # stock with a raised cheek rest and a leather pad
    sv, sf = pb.superellipsoid(20, (0, -0.34, zr - 0.02), 0.065, 0.22, 0.22, 0.08, 0.12, p=3.0, q=2.6)
    W.parts.append(wobj("Sniper stock", sv, sf, M["navy"], wf, rig))
    cv, cf = pb.superellipsoid(14, (0, -0.32, zr + 0.08), 0.06, 0.12, 0.12, 0.035, 0.03, p=2.6, q=2.4)
    W.parts.append(wobj("Sniper cheek", cv, cf, M["leather"], wf, rig))
    pv, pf = soft_box((0, -0.57, zr - 0.02), 0.07, 0.03, 0.12, n=12)
    W.parts.append(wobj("Sniper butt pad", pv, pf, M["leather"], wf, rig))
    # a long slim barrel and a big muzzle brake
    bv, bf = tube((0, 0.34, zr + 0.01), (0, 1.36, zr + 0.01), [(0.0, 0.04), (0.2, 0.034), (1.0, 0.03)], 24)
    W.parts.append(wobj("Sniper barrel", bv, bf, M["gunmetal"], wf, rig))
    mv, mf = soft_box((0, 1.4, zr + 0.01), 0.045, 0.06, 0.045, n=12)
    W.parts.append(wobj("Sniper muzzle", mv, mf, M["black_vinyl"], wf, rig))
    hv, hf = tube((0, 0.36, zr + 0.01), (0, 0.62, zr + 0.01), [(0.0, 0.06), (0.15, 0.066), (0.85, 0.066), (1.0, 0.06)], 24)
    W.parts.append(wobj("Sniper handguard", hv, hf, M["navy"], wf, rig))
    # the big scope with a red glowing lens
    sc_v, sc_f = tube((0, -0.12, zr + 0.2), (0, 0.42, zr + 0.2), [(0.0, 0.078), (0.12, 0.06), (0.8, 0.06), (1.0, 0.085)], 28)
    W.parts.append(wobj("Sniper scope", sc_v, sc_f, M["black_vinyl"], wf, rig))
    lv, lf = pb.ellipsoid_unit()
    W.parts.append(wobj("Sniper lens", lv * np.array([0.068, 0.012, 0.068]) + np.array([0, 0.425, zr + 0.2]), lf, M["sight"], wf, rig))
    for ym in (0.0, 0.28):
        kv, kf = soft_box((0, ym, zr + 0.12), 0.03, 0.025, 0.045, n=10)
        W.parts.append(wobj("Sniper mount %.2f" % ym, kv, kf, M["gunmetal"], wf, rig))
    # the folded bipod under the barrel
    for sx in (1, -1):
        lgv, lgf = tube((sx * 0.025, 0.66, zr - 0.05), (sx * 0.025, 1.0, zr - 0.05), [(0.0, 0.014), (1.0, 0.012)], 10)
        W.parts.append(wobj("Sniper bipod %d" % sx, lgv, lgf, M["black_vinyl"], wf, rig))
    socket("Sniper", wf, rig, M, B, zr - 0.09, side_x=SNIPER_SHIFT[0] - 0.075)
    add_builder(W, B, "Sniper stitches", M["thread"], wf, rig)
    shift_weapon(W, wf, SNIPER_SHIFT)
    return W


def build_crossbow(wf, rig, M):
    W = Weapon("crossbow")
    B = pb.Builder()
    zr = 0.36
    sv, sf = pb.superellipsoid(24, (0, 0.04, zr - 0.01), 0.07, 0.5, 0.5, 0.075, 0.085, p=3.2, q=2.8)
    W.parts.append(wobj("Crossbow stock", sv, sf, M["tan"], wf, rig))
    bvs = bvh_local((sv, sf))
    for sx in (1, -1):
        line_stitch(B, bvs, (sx * 0.2, -0.4, zr + 0.03), (sx * 0.2, 0.48, zr + 0.03), dash=0.026, gap=0.016)
    # the prod: two glossy green limbs from the front, turned upright (they read from the side at the game camera)
    tips = []
    for sz in (1, -1):
        path = [np.array([0.0, 0.52 - 0.12 * t * t, zr + sz * (0.03 + 0.3 * t)]) for t in np.linspace(0, 1, 14)]
        radii = [0.036 - 0.018 * t for t in np.linspace(0, 1, 14)]
        lv, lf = pb.taper_tube(path, radii, 14, hint=(1, 0, 0), flat=0.6)
        W.parts.append(wobj("Crossbow limb %d" % sz, lv, lf, M["green_vinyl"], wf, rig))
        tips.append(path[-1])
    nv, nf = soft_box((0, 0.52, zr), 0.05, 0.05, 0.06, n=12)
    W.parts.append(wobj("Crossbow riser", nv, nf, M["black_vinyl"], wf, rig))
    # the string: from each limb tip back to the nock
    nock = np.array([0.0, 0.08, zr + 0.06])
    for k, tp in enumerate(tips):
        stv, stf = tube(tuple(tp), tuple(nock), [(0.0, 0.007), (1.0, 0.007)], 8)
        W.parts.append(wobj("Crossbow string %d" % k, stv, stf, M["cream"], wf, rig))
    # the loaded bolt: a cream shaft, a red vinyl tip, green fletching (gone after the shot, back on the reload)
    bolt = []
    shv, shf = tube((0, 0.06, zr + 0.07), (0, 0.86, zr + 0.07), [(0.0, 0.013), (1.0, 0.013)], 10)
    bolt.append(wobj("Crossbow bolt", shv, shf, M["cream"], wf, rig))
    tv, tf = tube((0, 0.85, zr + 0.07), (0, 0.97, zr + 0.07), [(0.0, 0.028), (0.4, 0.022), (1.0, 0.002)], 12)
    bolt.append(wobj("Crossbow bolt tip", tv, tf, M["red_vinyl"], wf, rig))
    for k, a in enumerate((0, 2.1, 4.2)):
        d = np.array([math.cos(a), 0, math.sin(a)])
        fv, ff = soft_box(tuple(np.array([0, 0.12, zr + 0.07]) + d * 0.025), 0.012 + 0.012 * abs(d[0]), 0.05, 0.012 + 0.012 * abs(d[2]), n=8)
        bolt.append(wobj("Crossbow fletch %d" % k, fv, ff, M["green_vinyl"], wf, rig))
    W.parts.extend(bolt)
    W.bolt = bolt
    socket("Crossbow", wf, rig, M, B, zr - 0.09, side_x=CROSSBOW_SHIFT[0] - 0.07)
    add_builder(W, B, "Crossbow stitches", M["thread"], wf, rig)
    shift_weapon(W, wf, CROSSBOW_SHIFT)
    return W


def build_railgun(wf, rig, M):
    W = Weapon("railgun")
    B = pb.Builder()
    zr = 0.36
    rv, rf = pb.superellipsoid(24, (0, 0.02, zr), 0.1, 0.3, 0.3, 0.12, 0.11, p=3.4, q=3.0)
    W.parts.append(wobj("Railgun body", rv, rf, M["white_plush"], wf, rig))
    bvr = bvh_local((rv, rf))
    for sx in (1, -1):
        line_stitch(B, bvr, (sx * 0.2, -0.24, zr + 0.07), (sx * 0.2, 0.28, zr + 0.07), dash=0.026, gap=0.016)
        line_stitch(B, bvr, (sx * 0.2, -0.24, zr - 0.07), (sx * 0.2, 0.28, zr - 0.07), dash=0.026, gap=0.016)
    # twin rails, glowing coils around them, a yellow battery on the side
    for sz in (1, -1):
        bv, bf = soft_box((0, 0.66, zr + sz * 0.065), 0.035, 0.38, 0.02, p=4.0, n=16)
        W.parts.append(wobj("Railgun rail %d" % sz, bv, bf, M["gunmetal"], wf, rig))
    for k, y in enumerate((0.38, 0.54, 0.7, 0.86)):
        cv, cf = ring((0, y, zr), (0, 1, 0), 0.085, pb.rounded_rect_2d(0.022, 0.03, 0.009, 3), 40)
        W.parts.append(wobj("Railgun coil %d" % k, cv, cf, M["coil"], wf, rig))
    tv, tf = soft_box((0, 1.05, zr), 0.05, 0.035, 0.09, n=12)
    W.parts.append(wobj("Railgun muzzle", tv, tf, M["black_vinyl"], wf, rig))
    av, af = soft_box((0.1, -0.06, zr - 0.03), 0.035, 0.12, 0.07, n=12)
    W.parts.append(wobj("Railgun battery", av, af, M["yellow_vinyl"], wf, rig))
    sv, sf = pb.superellipsoid(18, (0, -0.4, zr - 0.02), 0.07, 0.14, 0.14, 0.09, 0.1, p=3.0, q=2.6)
    W.parts.append(wobj("Railgun stock", sv, sf, M["white_plush"], wf, rig))
    gv, gf = pb.ellipsoid_unit()
    W.parts.append(wobj("Railgun light", gv * np.array([0.02, 0.03, 0.02]) + np.array([0, 0.2, zr + 0.125]), gf, M["coil"], wf, rig))
    socket("Railgun", wf, rig, M, B, zr - 0.11, side_x=RAILGUN_SHIFT[0] - 0.1)
    add_builder(W, B, "Railgun stitches", M["thread"], wf, rig)
    shift_weapon(W, wf, RAILGUN_SHIFT)
    return W


def gun_spec(i, kick, fire_f, settle_f, end_f, hold=None, charge=0.0):
    """A gun loop: hold, (charge squash), fire on fire_f with `kick` (0..1.5), settle, back to the hold."""
    hold = hold or RIFLE_HOLD
    pre = add_spec(hold, {"root": dict(loc=(0, -0.01, -0.03 - 0.02 * charge), scl=squash(1 - 0.06 * charge)), "torso": (2 * charge, 0, 0)})
    fire = add_spec(hold, {"root": dict(loc=(0, 0.05 + 0.06 * kick, -0.04 - 0.02 * kick), scl=squash(1 - 0.08 * kick)),
                           "torso": (-6 * kick, 0, -3 * kick), "upperarm.R": (-9 * kick, 0, 0), "forearm.R": (-4 * kick, 0, 0),
                           "head": (-3 * kick, 0, 0)})
    over = add_spec(hold, {"root": dict(loc=(0, 0.0, -0.04), scl=squash(0.98)), "upperarm.R": (2, 0, 0)})
    keys = [(0, hold, "smooth"), (max(1, fire_f - 3), pre, "smooth"), (fire_f, fire, "out"), (settle_f, over, "smooth"),
            (end_f - 4, hold, "smooth"), (end_f, hold, "smooth")]
    sp = timeline(keys, i)
    t = 2 * math.pi * i / end_f
    return add_spec(sp, {"root": dict(loc=(0, 0, -0.006 * (1 - math.cos(t))))})


def spec_shotgun(i, n):
    return gun_spec(i, 1.3, 5, 12, n)


def spec_sniper(i, n):
    return gun_spec(i, 1.0, 6, 14, n)


def spec_crossbow(i, n):
    return gun_spec(i, 0.6, 5, 11, n)


def spec_railgun(i, n):
    return gun_spec(i, 1.4, 8, 16, n, charge=1.0)


# ---------------------------------------------------------------- phase 2: hammer, flamethrower, lightning

FLAME_SHIFT = (0.34, 0.0, -0.3)
LIGHTNING_SHIFT = (0.3, 0.0, -0.3)


def build_hammer(wf, rig, M):
    """A toy mallet on the bracket like the bat: a leather-wrapped handle, a plush orange head with red vinyl caps."""
    W = Weapon("hammer")
    B = pb.Builder()
    R = 0.205
    zb = R + 0.06
    z_t = zb + 0.95
    gv, gf = tube((0, 0, zb), (0, 0, z_t - 0.08), [(0.0, 0.05), (0.5, 0.046), (1.0, 0.05)], 24)
    W.parts.append(wobj("Hammer handle", gv, gf, M["leather"], wf, rig))
    bvh_ = bvh_local((gv, gf))
    pts = [(0.06 * math.cos(t * 9), 0.06 * math.sin(t * 9), zb + 0.05 + t * 0.4) for t in np.linspace(0, 2.0, 90)]
    pts = [p for p in pts if p[2] < z_t - 0.15]
    pb.stitch_path(B, pts, pb.surf_fn(bvh_, 0.05), dash=0.022, gap=0.014, width=0.009, height=0.006)
    kv, kf = tube((0, 0, zb - 0.04), (0, 0, zb + 0.03), [(0.0, 0.058), (0.4, 0.07), (1.0, 0.05)], 24)
    W.parts.append(wobj("Hammer knob", kv, kf, M["black_vinyl"], wf, rig))
    # the head: across the top of the handle, along the weapon's y (it reads side-on at the game camera)
    hy = 0.26
    hv, hf = tube((0, -hy, z_t), (0, hy, z_t), [(0.0, 0.15), (0.08, 0.17), (0.5, 0.18), (0.92, 0.17), (1.0, 0.15)], 40)
    W.parts.append(wobj("Hammer head", hv, hf, M["orange"], wf, rig))
    bvh_h = bvh_local((hv, hf))
    for yb in (-0.12, 0.12):
        ring_stitch(B, bvh_h, (0, yb, z_t), (0, 1, 0), 0.3, dash=0.026, gap=0.016, width=0.011, height=0.007)
    for sy in (1, -1):
        cv, cf = tube((0, sy * (hy - 0.02), z_t), (0, sy * (hy + 0.07), z_t), [(0.0, 0.17), (0.5, 0.18), (1.0, 0.15)], 40)
        W.parts.append(wobj("Hammer cap %d" % sy, cv, cf, M["red_vinyl"], wf, rig))
    bv, bf = tube((0, 0, z_t - 0.2), (0, 0, z_t - 0.13), [(0.0, 0.07), (1.0, 0.07)], 24)
    W.parts.append(wobj("Hammer collar", bv, bf, M["gold"], wf, rig))
    socket("Hammer", wf, rig, M, B, zb - 0.04)
    add_builder(W, B, "Hammer stitches", M["thread"], wf, rig)
    return W


def build_flamethrower(wf, rig, M):
    """A red vinyl fuel tank under a yellow plush gun body, a hose, a long nozzle with a blue pilot light."""
    W = Weapon("flamethrower")
    B = pb.Builder()
    zr = 0.36
    rv, rf = pb.superellipsoid(24, (0, 0.06, zr), 0.09, 0.24, 0.24, 0.1, 0.1, p=3.2, q=3.0)
    W.parts.append(wobj("Flamer body", rv, rf, M["yellow_plush"], wf, rig))
    bvr = bvh_local((rv, rf))
    for sx in (1, -1):
        line_stitch(B, bvr, (sx * 0.2, -0.14, zr + 0.06), (sx * 0.2, 0.26, zr + 0.06), dash=0.026, gap=0.016)
    tv, tf = tube((0, -0.3, zr - 0.13), (0, 0.22, zr - 0.13), [(0.0, 0.07), (0.1, 0.095), (0.9, 0.095), (1.0, 0.07)], 32)
    W.parts.append(wobj("Flamer tank", tv, tf, M["red_vinyl"], wf, rig))
    for yb in (-0.18, 0.1):
        bv_, bf_ = ring((0, yb, zr - 0.13), (0, 1, 0), 0.098, pb.rounded_rect_2d(0.02, 0.03, 0.008, 3), 40)
        W.parts.append(wobj("Flamer band %.2f" % yb, bv_, bf_, M["gunmetal"], wf, rig))
    # the hose: from the tank's back curling up into the body
    path = [np.array([0.0, -0.3 - 0.08 * math.sin(t * math.pi), zr - 0.13 + 0.16 * t]) for t in np.linspace(0, 1, 16)]
    hv, hf = pb.taper_tube(path, [0.026] * 16, 12, hint=(1, 0, 0))
    W.parts.append(wobj("Flamer hose", hv, hf, M["black_vinyl"], wf, rig))
    nv, nf = tube((0, 0.28, zr + 0.02), (0, 0.86, zr + 0.02), [(0.0, 0.05), (0.85, 0.04), (1.0, 0.055)], 24)
    W.parts.append(wobj("Flamer nozzle", nv, nf, M["gunmetal"], wf, rig))
    mv, mf = tube((0, 0.84, zr + 0.02), (0, 0.92, zr + 0.02), [(0.0, 0.06), (1.0, 0.07)], 24)
    W.parts.append(wobj("Flamer tip", mv, mf, M["black_vinyl"], wf, rig))
    pv, pf = pb.ellipsoid_unit()
    W.parts.append(wobj("Flamer pilot", pv * np.array([0.022, 0.03, 0.022]) + np.array([0, 0.9, zr - 0.05]), pf, M["pilot"], wf, rig))
    gv, gf = soft_box((0, 0.34, zr - 0.1), 0.03, 0.04, 0.08, n=10)
    W.parts.append(wobj("Flamer grip", gv, gf, M["black_vinyl"], wf, rig))
    socket("Flamer", wf, rig, M, B, zr - 0.1, side_x=FLAME_SHIFT[0] - 0.09)
    add_builder(W, B, "Flamer stitches", M["thread"], wf, rig)
    shift_weapon(W, wf, FLAME_SHIFT)
    return W


def build_lightning(wf, rig, M):
    """A toy sword: a lavender plush blade with a glowing violet bolt sewn down it, a gold guard, a leather grip."""
    W = Weapon("lightning")
    B = pb.Builder()
    zr = 0.36
    gv, gf = tube((0, -0.2, zr), (0, 0.06, zr), [(0.0, 0.045), (1.0, 0.045)], 20)
    W.parts.append(wobj("Sword grip", gv, gf, M["leather"], wf, rig))
    pv, pf = pb.ellipsoid_unit()
    W.parts.append(wobj("Sword pommel", pv * 0.065 + np.array([0, -0.24, zr]), pf, M["gold"], wf, rig))
    cv, cf = soft_box((0, 0.09, zr), 0.06, 0.035, 0.2, p=3.0, n=14)
    W.parts.append(wobj("Sword guard", cv, cf, M["gold"], wf, rig))
    # the blade: flat (thin in x), wide in z, pointed; plush with a stitched edge
    bv, bf = pb.superellipsoid(28, (0, 0.6, zr), 0.035, 0.5, 0.5, 0.1, 0.1, p=2.2, q=3.0)
    t = np.clip((bv[:, 1] - 0.6) / 0.5, -1, 1)
    bv[:, 2] = zr + (bv[:, 2] - zr) * np.where(t > 0.55, np.clip((1 - t) / 0.45, 0.02, 1) ** 0.8, 1)
    W.parts.append(wobj("Sword blade", bv, bf, M["lavender"], wf, rig))
    bvb = bvh_local((bv, bf))
    for sz in (1, -1):
        line_stitch(B, bvb, (0.2, 0.14, zr + sz * 0.075), (0.2, 0.95, zr + sz * 0.02), dash=0.024, gap=0.016)
    # the bolt down the blade, both faces: an emissive zigzag
    zz = [(0.16, 0.0), (0.32, 0.05), (0.46, -0.045), (0.62, 0.045), (0.78, -0.03), (0.94, 0.0)]
    for sx in (1, -1):
        pts = [np.array([sx * 0.037, y, zr + z]) for y, z in zz]
        pts = pb.resample(pts, 0.01)
        zv, zf = pb.taper_tube(pts, [0.02] * len(pts), 8, hint=(1, 0, 0))
        W.parts.append(wobj("Sword bolt %d" % sx, zv, zf, M["bolt"], wf, rig))
    socket("Sword", wf, rig, M, B, zr - 0.05, side_x=LIGHTNING_SHIFT[0] - 0.045)
    add_builder(W, B, "Sword stitches", M["thread"], wf, rig)
    shift_weapon(W, wf, LIGHTNING_SHIFT)
    return W


HAMMER_READY = add_spec(BAT_READY, {"upperarm.R": (8, 0, 0), "forearm.R": (4, 0, 0)})  # the mitt below the visor


def spec_hammer(i, n):
    """An overhead slam: ready, a big wind-up, the slam down in front (hit on frames 11-13), a squash, recover."""
    wind = add_spec(HAMMER_READY, {"root": dict(loc=(0, 0.05, 0.0), scl=squash(1.08)), "torso": (-14, 0, -8), "head": (-6, 0, 4),
                                   "upperarm.R": (-60, 0, 10), "forearm.R": (-10, 0, 0)})
    slam = {"root": dict(loc=(0, -0.1, -0.12), scl=squash(0.84)), "hips": (0, 0, 4), "torso": dict(rot=(28, 0, 6), scl=stretch_y(0.95)),
            "head": (-14, 0, -4), "upperarm.R": (-12, 0, 6), "forearm.R": (-4, 0, 0), "hand.R": (30, 0, 0),
            "upperarm.L": (-40, 24, -10), "forearm.L": (-80, 0, -10), "hand.L": (-8, 0, 0),
            "thigh.L": (-44, -18, 0), "shin.L": (60, 0, 0), "foot.L": (-16, 14, 0),
            "thigh.R": (-30, 18, 0), "shin.R": (50, 0, 0), "foot.R": (-20, -10, 0)}
    hold = add_spec(slam, {"root": dict(scl=squash(1.02 / 0.84 * 0.9))})
    keys = [(0, HAMMER_READY, "smooth"), (3, HAMMER_READY, "smooth"), (9, wind, "smooth"), (12, slam, "in"),
            (16, hold, "out"), (22, hold, "smooth"), (32, HAMMER_READY, "smooth")]
    return timeline(keys, i)


def spec_flamethrower(i, n):
    """The spray: the hold with a shake and a small kick that loops (the game plays it while the flame runs)."""
    ph = 2 * math.pi * i / n
    base = add_spec(RIFLE_HOLD, {"root": dict(loc=(0, 0.03, -0.045), scl=squash(0.96)), "torso": (-3, 0, -2)})
    return add_spec(base, {"root": dict(loc=(0.004 * math.sin(ph * 6), 0.01 * math.sin(ph * 4), 0.006 * math.sin(ph * 5))),
                           "upperarm.R": (2.5 * math.sin(ph * 6), 0, 1.5 * math.sin(ph * 4)), "head": (1.5 * math.sin(ph * 3), 0, 0)})


SWORD_HOLD = add_spec(RIFLE_HOLD, {"upperarm.R": (6, 0, 0), "upperarm.L": (20, -10, 10), "forearm.L": (30, 0, 0)})


def spec_lightning(i, n):
    """A thrust: pull back, lunge forward with the blade (the bolt or the hit on frame 6), recover."""
    pull = add_spec(SWORD_HOLD, {"root": dict(loc=(0, 0.04, -0.04), scl=squash(0.94)), "torso": (-6, 0, -10), "upperarm.R": (10, 0, -6)})
    lunge = add_spec(SWORD_HOLD, {"root": dict(loc=(0, -0.09, -0.06), scl=squash(1.05)), "hips": (0, 0, 6),
                                  "torso": dict(rot=(14, 0, 8), scl=stretch_y(1.05)), "upperarm.R": (-14, 0, 8), "forearm.R": (8, 0, 0),
                                  "thigh.L": (-28, -20, 0), "shin.L": (30, 0, 0), "thigh.R": (20, 16, 0), "shin.R": (14, 0, 0)})
    keys = [(0, SWORD_HOLD, "smooth"), (3, pull, "smooth"), (6, lunge, "out"), (11, lunge, "smooth"), (24, SWORD_HOLD, "smooth")]
    return timeline(keys, i)


# ---------------------------------------------------------------- phase 2: grenade, mine, grapple

GRAPPLE_SHIFT = (0.36, 0.0, -0.3)


def build_grenade(wf, rig, M):
    """A plush olive grenade in a cup on the socket bracket: quilted panels, a yellow vinyl lever, a gold pin ring."""
    W = Weapon("grenade")
    B = pb.Builder()
    R = 0.205
    c = np.array([0.0, 0.0, R + 0.25])
    gv, gf = pb.superellipsoid(24, tuple(c), 0.13, 0.15, 0.15, 0.15, 0.14, p=2.2, q=2.2)
    body = wobj("Grenade body", gv, gf, M["olive"], wf, rig)
    bvg = bvh_local((gv, gf))
    for z in (-0.06, 0.03):
        ring_stitch(B, bvg, tuple(c + np.array([0, 0, z])), (0, 0, 1), 0.16, dash=0.022, gap=0.014, width=0.009, height=0.006)
    for a in (0.0, math.pi / 2):
        pts = [tuple(c + np.array([math.cos(a) * 0.3 * math.cos(t), math.sin(a) * 0.3 * math.cos(t), 0.3 * math.sin(t)])) for t in np.linspace(-1.2, 1.2, 40)]
        pts = [bvg.ray_cast(Vector(p), (Vector(tuple(c)) - Vector(p)).normalized(), 1)[0] for p in pts]
        pb.stitch_path(B, [tuple(p) for p in pts if p is not None], pb.surf_fn(bvg, 0.05), dash=0.022, gap=0.014, width=0.009, height=0.006)
    tv, tf = tube(tuple(c + np.array([0, 0, 0.12])), tuple(c + np.array([0, 0, 0.2])), [(0.0, 0.05), (1.0, 0.045)], 20)
    top = wobj("Grenade top", tv, tf, M["gunmetal"], wf, rig)
    lv, lf = soft_box(tuple(c + np.array([0.0, 0.07, 0.16])), 0.025, 0.09, 0.014, p=3.0, n=10)
    lever = wobj("Grenade lever", lv, lf, M["yellow_vinyl"], wf, rig)
    rv, rf = ring(tuple(c + np.array([0, -0.06, 0.22])), (1, 0, 0), 0.04, pb.circle(0.009, 8), 32)
    pin = wobj("Grenade pin", rv, rf, M["gold"], wf, rig)
    cv, cf = tube((0, 0, R + 0.04), (0, 0, R + 0.11), [(0.0, 0.07), (1.0, 0.1)], 24)
    cup = wobj("Grenade cup", cv, cf, M["accent"], wf, rig)
    W.parts += [body, top, lever, pin, cup]
    socket("Grenade", wf, rig, M, B, R + 0.05)
    B_ob = B.obj("Grenade stitches", M["thread"])
    if B_ob is not None:
        wf.attach(B_ob, rig)
        W.parts.append(B_ob)
    W.held = [o for o in (body, top, lever, pin, B_ob) if o is not None]  # thrown on the release frame, a new one in the cup on the reload
    return W


def build_mine(wf, rig, M):
    """A plush pink mine puck on the socket bracket: a stitched rim, a black vinyl dome with a glowing button."""
    W = Weapon("mine")
    B = pb.Builder()
    R = 0.205
    c = np.array([0.0, 0.0, R + 0.15])
    mv, mf = pb.superellipsoid(24, tuple(c), 0.2, 0.2, 0.2, 0.06, 0.06, p=2.2, q=3.2)
    body = wobj("Mine body", mv, mf, M["pink"], wf, rig)
    bvm = bvh_local((mv, mf))
    ring_stitch(B, bvm, tuple(c), (0, 0, 1), 0.215, dash=0.024, gap=0.016, width=0.01, height=0.007)
    dv, df = pb.superellipsoid(16, tuple(c + np.array([0, 0, 0.06])), 0.1, 0.1, 0.1, 0.05, 0.01, p=2.0, q=2.0)
    dome = wobj("Mine dome", dv, df, M["black_vinyl"], wf, rig)
    bv, bf = pb.ellipsoid_unit()
    button = wobj("Mine button", bv * np.array([0.035, 0.035, 0.02]) + c + np.array([0, 0, 0.11]), bf, M["mine_light"], wf, rig)
    studs = []
    for k in range(6):
        a = 2 * math.pi * k / 6
        studs.append(wobj("Mine stud %d" % k, bv * 0.02 + c + np.array([0.16 * math.cos(a), 0.16 * math.sin(a), 0.045]), bf, M["gold"], wf, rig))
    W.parts += [body, dome, button] + studs
    socket("Mine", wf, rig, M, B, R + 0.05)
    B_ob = B.obj("Mine stitches", M["thread"])
    if B_ob is not None:
        wf.attach(B_ob, rig)
        W.parts.append(B_ob)
    W.held = [o for o in (body, dome, button, B_ob) if o is not None] + studs
    return W


def build_grapple(wf, rig, M):
    """A toy grappling gun: a blue plush body, a rope coil, a gunmetal three-prong hook in front (it flies on the shot)."""
    W = Weapon("grapple")
    B = pb.Builder()
    zr = 0.36
    rv, rf = pb.superellipsoid(24, (0, 0.06, zr), 0.095, 0.24, 0.24, 0.1, 0.1, p=3.2, q=3.0)
    W.parts.append(wobj("Grapple body", rv, rf, M["sky"], wf, rig))
    bvr = bvh_local((rv, rf))
    for sx in (1, -1):
        line_stitch(B, bvr, (sx * 0.2, -0.14, zr + 0.06), (sx * 0.2, 0.26, zr + 0.06), dash=0.026, gap=0.016)
    # the rope coil on the outer side
    cv, cf = ring((0.11, 0.0, zr), (1, 0, 0), 0.075, pb.circle(0.03, 10), 40)
    W.parts.append(wobj("Grapple coil", cv, cf, M["cream"], wf, rig))
    bv, bf = tube((0, 0.28, zr), (0, 0.5, zr), [(0.0, 0.06), (1.0, 0.05)], 24)
    W.parts.append(wobj("Grapple barrel", bv, bf, M["gunmetal"], wf, rig))
    gv, gf = soft_box((0, -0.24, zr - 0.02), 0.06, 0.08, 0.09, n=12)
    W.parts.append(wobj("Grapple stock", gv, gf, M["leather"], wf, rig))
    # the hook: a shaft and three curved prongs
    hook = []
    sv, sf = tube((0, 0.48, zr), (0, 0.64, zr), [(0.0, 0.02), (1.0, 0.02)], 12)
    hook.append(wobj("Grapple hook shaft", sv, sf, M["gunmetal"], wf, rig))
    for k in range(3):
        a = 2 * math.pi * k / 3 + math.pi / 2
        d = np.array([math.cos(a), 0, math.sin(a)])
        path = [np.array([0, 0.64, zr]) + d * 0.09 * math.sin(t * 1.4) + np.array([0, -0.12 * (1 - math.cos(t * 1.4)) + 0.04 * t, 0]) for t in np.linspace(0, 1.3, 12)]
        pv, pf = pb.taper_tube(path, [0.018 - 0.008 * (i / 11) for i in range(12)], 10, hint=(0, 1, 0))
        hook.append(wobj("Grapple prong %d" % k, pv, pf, M["gunmetal"], wf, rig))
    W.parts.extend(hook)
    W.held = hook
    socket("Grapple", wf, rig, M, B, zr - 0.1, side_x=GRAPPLE_SHIFT[0] - 0.095)
    add_builder(W, B, "Grapple stitches", M["thread"], wf, rig)
    shift_weapon(W, wf, GRAPPLE_SHIFT)
    return W


THROW_HOLD = add_spec(RIFLE_HOLD, {"upperarm.R": (22, 0, -6), "forearm.R": (-6, 0, 0)})  # held low, below the visor


def spec_grenade(i, n):
    """The throw: hold at the chest, wind back, an overhand throw (released on frame 8), follow through, a new one."""
    wind = add_spec(THROW_HOLD, {"root": dict(loc=(0, 0.04, -0.03), scl=squash(0.95)), "torso": (-8, 0, -18), "head": (-4, 0, 8),
                                 "upperarm.R": (80, 0, 24), "forearm.R": (-70, 0, 0)})
    throw = add_spec(THROW_HOLD, {"root": dict(loc=(0, -0.08, -0.05), scl=squash(1.05)), "hips": (0, 0, 8),
                                  "torso": dict(rot=(16, 0, 12), scl=stretch_y(1.05)), "head": (-6, 0, -4),
                                  "upperarm.R": (-56, 0, 10), "forearm.R": (34, 0, 0),
                                  "thigh.L": (-28, -20, 0), "shin.L": (30, 0, 0), "thigh.R": (20, 16, 0), "shin.R": (14, 0, 0)})
    follow = add_spec(throw, {"upperarm.R": (30, 0, 0), "torso": (6, 0, 4), "root": dict(scl=squash(0.97))})
    keys = [(0, THROW_HOLD, "smooth"), (2, THROW_HOLD, "smooth"), (6, wind, "smooth"), (8, throw, "in"),
            (12, follow, "out"), (18, THROW_HOLD, "smooth"), (24, THROW_HOLD, "smooth")]
    return timeline(keys, i)


def spec_mine(i, n):
    """The place: hold, crouch and set it down in front (released on frame 8), stand back up, a new one."""
    crouch = add_spec(THROW_HOLD, {"root": dict(loc=(0, -0.04, -0.2), scl=squash(0.9)), "torso": (26, 0, 4), "head": (-10, 0, 0),
                                   "upperarm.R": (10, 0, 6), "forearm.R": (30, 0, 0),
                                   "thigh.L": (-60, -12, 0), "shin.L": (90, 0, 0), "foot.L": (-30, 0, 0),
                                   "thigh.R": (-50, 12, 0), "shin.R": (80, 0, 0), "foot.R": (-30, 0, 0)})
    rise = add_spec(THROW_HOLD, {"root": dict(loc=(0, 0, 0.0), scl=squash(1.04)), "torso": (-4, 0, 0)})
    keys = [(0, THROW_HOLD, "smooth"), (2, THROW_HOLD, "smooth"), (8, crouch, "smooth"), (10, crouch, "smooth"),
            (15, rise, "out"), (19, THROW_HOLD, "smooth"), (24, THROW_HOLD, "smooth")]
    return timeline(keys, i)


def spec_grapple(i, n):
    return gun_spec(i, 0.8, 5, 11, n)


def add_builder(W, B, name, mat, wf, rig):
    ob = B.obj(name, mat)
    if ob is None:
        print("WARNING: no geometry for", name)
        return
    wf.attach(ob, rig)
    W.parts.append(ob)


def key_vis(ob, frame, vis, scale=None):
    ob.hide_render = not vis
    ob.hide_viewport = not vis
    ob.keyframe_insert("hide_render", frame=frame)
    ob.keyframe_insert("hide_viewport", frame=frame)
    if scale is not None:
        ob.scale = scale if hasattr(scale, "__len__") else (scale, scale, scale)
        ob.keyframe_insert("scale", frame=frame)


# ---------------------------------------------------------------- keying

def key_loops(ch, weapons, socket_objs):
    rig = ch.rig
    for name, (start, n, _, _, wname) in LOOPS.items():
        fn = SPECS[name]
        ant = antenna_track(fn, n)
        for i in range(n + 1):
            sp = fn(i % n, n) if i < n else fn(0, n)
            a = ant[i % n]
            sp = add_spec(sp, {"antenna": (float(a[0]), float(a[1]), 0)})
            if SPRITE:
                sp = add_spec(sp, {"head": (0, 0, -HEAD_TURN)})
                sp = add_spec(sp, BUILD_POSE.get(BUILD, {}))
                if name == "idle":
                    sp = add_spec(sp, IDLE_GUARD)
            pb.POSES["_k"] = sp
            pb.apply_pose(ch, "_k", start + i)
            face = FACES[name](i % n)
            for k, ob in ch.faces.items():
                key_vis(ob, start + i, k == face)
    pb.POSES.pop("_k", None)
    # weapon visibility: each weapon only inside its own loop's frames
    for wname, W in weapons.items():
        start, n = LOOPS[wname][0], LOOPS[wname][1]
        obs = W.parts + socket_objs[wname]
        for ob in obs:
            key_vis(ob, 1, False)
            key_vis(ob, start, True)
            key_vis(ob, start + n + 1, False)
        for ob, kind in W.fx:
            key_vis(ob, 1, False, 1.0)
            for i in range(n + 1):
                vis, s = fx_state(kind, i)
                key_vis(ob, start + i, vis, s)
            key_vis(ob, start + n + 1, False, 1.0)
            if kind == "rproj":
                for i in range(n + 1):
                    d = 0.0 if i < 7 else (i - 6) ** 1.6 * 0.35
                    base = Matrix(W.M_proj)
                    ob.matrix_basis = base @ Matrix.Translation((0, d, 0))
                    ob.keyframe_insert("location", frame=start + i)
    # bat trail ribbons
    if "bat" in weapons:
        build_trails(ch, weapons["bat"])


def fx_state(kind, i):
    """(visible, scale) of an effect at loop frame i."""
    if kind == "rflash":
        return {7: (True, 0.8), 8: (True, 1.15), 9: (True, 0.6)}.get(i, (False, 0.3))
    if kind == "rblast":
        return {7: (True, 0.9), 8: (True, 1.2), 9: (True, 0.85), 10: (True, 0.45)}.get(i, (False, 0.3))
    if kind == "rproj":
        return (7 <= i <= 12, 1.0)
    if kind == "rexhaust":
        return (7 <= i <= 12, 1.0 + 0.2 * (i % 2))
    if kind.startswith("rsmoke"):
        k = int(kind[-1])
        a = i - 8 - k
        if a < 0 or a > 16:
            return (False, 0.2)
        sc_ = (0.35 + 0.65 * smooth(a / 6)) * (1 - smooth((a - 10) / 6))
        return (sc_ > 0.15, max(0.15, sc_))  # hide a puff once it is too small to read as smoke
    if kind == "flash":
        return {5: (True, 1.15), 6: (True, 0.65)}.get(i, (False, 0.3))
    if kind == "tracer":
        return (i == 5, 1.0)
    return (False, 1.0)


def build_trails(ch, W):
    """Ribbons from the bat tip's path: one per swing frame, each the last few frames of the path."""
    sc = bpy.context.scene
    rig = ch.rig
    start = LOOPS["bat"][0]
    wf = W.wf
    tip_e = bpy.data.objects.new("Bat tip", None)
    pb.COLL.objects.link(tip_e)
    wf.attach(tip_e, rig, W.tip)
    mid_e = bpy.data.objects.new("Bat mid", None)
    pb.COLL.objects.link(mid_e)
    wf.attach(mid_e, rig, W.mid)
    samples = {}
    for f10 in range(7 * 4, 17 * 4 + 1):
        f = f10 / 4
        sc.frame_set(start + int(f), subframe=f - int(f))
        samples[f10] = (np.array(tip_e.matrix_world.translation), np.array(mid_e.matrix_world.translation))
    sc.frame_set(start)
    for i in range(10, 17):
        pts = [samples[k] for k in range(max(7 * 4, (i - 3) * 4), i * 4 + 1)]
        pts = pts[::-1]  # newest first
        m = len(pts)
        verts, faces, uvs = [], [], []
        for k, (tp, md) in enumerate(pts):
            age = k / max(1, m - 1)
            inner = md + (tp - md) * (0.55 + 0.3 * age)  # the outer part of the bat only, narrowing toward the tail
            verts += [tuple(tp), tuple(inner)]
        for k in range(m - 1):
            faces.append([2 * k, 2 * k + 1, 2 * k + 3, 2 * k + 2])
        me = bpy.data.meshes.new("Bat trail %d" % i)
        me.from_pydata(verts, [], faces)
        uv = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                uv.data[li].uv = ((vi // 2) / max(1, m - 1), vi % 2)
        me.materials.append(W.M["trail"])
        ob = bpy.data.objects.new("Bat trail %d" % i, me)
        pb.COLL.objects.link(ob)
        ob.visible_shadow = False
        key_vis(ob, 1, False)
        key_vis(ob, start + i, True)
        key_vis(ob, start + i + 1, False)


# ---------------------------------------------------------------- scene

def build(hair, build_name="balanced"):
    global BUILD
    BUILD = build_name
    sc = pb.reset_scene()
    pb.camera_rig(sc)
    ch = pb.build_character(build_name, hair=hair)
    pb.key_all_poses(ch)
    wf = WFrame(ch.rig)
    M = weapon_mats()
    weapons, socket_objs = {}, {}
    for name, fn in (("rocket", build_rocket), ("bat", build_bat), ("rifle", build_rifle), ("shotgun", build_shotgun),
                     ("sniper", build_sniper), ("crossbow", build_crossbow), ("railgun", build_railgun),
                     ("hammer", build_hammer), ("flamethrower", build_flamethrower), ("lightning", build_lightning),
                     ("grenade", build_grenade), ("mine", build_mine), ("grapple", build_grapple)):
        before = set(bpy.data.objects)
        W = fn(wf, ch.rig, M)
        W.wf, W.M = wf, M
        new = [o for o in bpy.data.objects if o not in before]
        known = set(W.parts) | {o for o, _ in W.fx}
        socket_objs[name] = [o for o in new if o not in known and o.type == "MESH"]
        for ob, kind in W.fx:
            ob.visible_shadow = False
            if kind == "rproj":
                W.M_proj = ob.matrix_basis.copy()
        weapons[name] = W
    key_loops(ch, weapons, socket_objs)
    return sc, ch, weapons


def frame_for(sc, height, tz, angle=ANGLE):
    rig, cam, tgt = sc.objects["CamRig"], sc.objects["Cam"], sc.objects["CamTarget"]
    rig.rotation_euler = (0, 0, -math.radians(angle))
    pb.frame_camera(cam, tgt, height, tz)


TIMES = []


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--stills", default="", help="weapon hero stills: rocket,bat,rifle")
    ap.add_argument("--loop", default="", help="a loop to render: " + ",".join(LOOPS))
    ap.add_argument("--frames", default="", help="START:END loop frames")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--hair", type=float, default=None)
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--video-samples", type=int, default=16)
    ap.add_argument("--preview", default="", help="quick: N evenly spaced frames of every loop (or loop:i,j,..;loop2:...)")
    ap.add_argument("--pick", default="", help="loop frames to render (comma list), instead of --frames")
    ap.add_argument("--res", type=int, default=1080, help="loop frame size (square)")
    ap.add_argument("--angle", type=float, default=ANGLE, help="camera azimuth in degrees (45 = three-quarter)")
    ap.add_argument("--still-pct", type=int, default=100, help="still resolution percentage")
    ap.add_argument("--lite", action="store_true", help="lite shading for the stills too")
    ap.add_argument("--tag", default="", help="suffix for still file names")
    ap.add_argument("--save", action="store_true", help="save tools/art/build/plush-action.blend")
    a = ap.parse_args(argv)
    pb.QUICK = a.quick
    stills = [s for s in a.stills.split(",") if s]
    pb.HAIR = a.hair if a.hair is not None else (0.25 if stills else 0.15)
    out = os.path.abspath(a.out)
    raw = os.path.join(out, "raw")
    os.makedirs(raw, exist_ok=True)
    t0 = time.time()
    sc, ch, weapons = build(hair=pb.HAIR > 0)
    TIMES.append(("build (character, weapons, keys)", time.time() - t0))
    print("BUILD %.1fs" % (time.time() - t0), flush=True)
    if a.save:
        os.makedirs(pb.BUILD_DIR, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(pb.BUILD_DIR, "plush-action.blend"))
    if stills and a.lite:
        pb.lite_video()
    for w in stills:
        start, n, h, tz, _ = LOOPS[w]
        sc.frame_set(start)
        sc.render.resolution_x, sc.render.resolution_y = 1400, 1600
        sc.render.resolution_percentage = 35 if a.quick else a.still_pct
        sc.cycles.samples = 24 if a.quick else a.samples
        frame_for(sc, h * 1.08, tz, a.angle)
        p = os.path.join(raw, "weapon-%s%s.png" % (w, a.tag))
        sc.render.filepath = p
        t = time.time()
        bpy.ops.render.render(write_still=True)
        TIMES.append(("weapon-%s.png" % w, time.time() - t))
        print("RENDERED %s %.1fs" % (p, time.time() - t), flush=True)
    if a.loop:
        start, n, h, tz, _ = LOOPS[a.loop]
        pb.lite_video()
        sc.render.resolution_x = sc.render.resolution_y = a.res
        sc.render.resolution_percentage = 35 if a.quick else 100
        sc.cycles.samples = 12 if a.quick else a.video_samples
        sc.render.fps = FPS
        frame_for(sc, h, tz, a.angle)
        f0, f1 = 0, n
        if a.frames:
            x, y = a.frames.split(":")
            f0, f1 = max(0, int(x or 0)), min(n, int(y or n))
        d = os.path.join(raw, "loop-" + a.loop)
        os.makedirs(d, exist_ok=True)
        t = time.time()
        idx = [int(x) for x in a.pick.split(",")] if a.pick else range(f0, f1)
        for i in idx:
            sc.frame_set(start + i)
            sc.render.filepath = os.path.join(d, "f%04d.png" % i)
            bpy.ops.render.render(write_still=True)
        TIMES.append(("loop %s frames %s" % (a.loop, a.pick or "%d-%d" % (f0, f1)), time.time() - t))
        print("LOOP %s %d-%d %.1fs" % (a.loop, f0, f1, time.time() - t), flush=True)
    if a.preview:
        pb.lite_video()
        sc.render.resolution_x = sc.render.resolution_y = 1080
        sc.render.resolution_percentage = 30
        sc.cycles.samples = 10
        plan = {}
        if a.preview.isdigit():
            k = int(a.preview)
            for name, (start, n, h, tz, _) in LOOPS.items():
                plan[name] = sorted({round(j * n / k) for j in range(k)})
        else:
            for part_ in a.preview.split(";"):
                name, ids = part_.split(":")
                plan[name] = [int(x) for x in ids.split(",")]
        for name, ids in plan.items():
            start, n, h, tz, _ = LOOPS[name]
            frame_for(sc, h, tz)
            d = os.path.join(raw, "preview-" + name)
            os.makedirs(d, exist_ok=True)
            for i in ids:
                sc.frame_set(start + i)
                sc.render.filepath = os.path.join(d, "f%04d.png" % i)
                bpy.ops.render.render(write_still=True)
        print("PREVIEW done", flush=True)
    with open(os.path.join(out, "times.txt"), "a") as fh:
        for n_, dt in TIMES:
            fh.write("%-40s %7.1f s\n" % (n_, dt))
    print("DONE %.1fs" % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
