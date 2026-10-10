# Blender scene: light pulses (bits) travelling through the glass fibres of an
# undersea internet cable. Fully procedural (no external assets), rendered
# headless with Eevee:
#
#   Blender -b --factory-startup --python scripts/blender/fiber_packets.py -- <config.json>
#
# config: {"out": dir, "width", "height", "fps", "seconds", "samples", "seed",
#          "colors": {"bg", "primary", "accent", "secondary", "jacket"}}
# Writes <out>/frame_####.png. Deterministic for a given config.
import json
import math
import random
import sys

import bmesh
import bpy
from mathutils import Vector

cfg = json.load(open(sys.argv[sys.argv.index("--") + 1]))
rnd = random.Random(cfg.get("seed", 7))
W, H, FPS = cfg["width"], cfg["height"], cfg["fps"]
FRAMES = int(cfg["seconds"] * FPS)
VERTICAL = H > W


def hex_rgb(h, a=1.0):
    h = h.lstrip("#")
    srgb = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, a)


C = {k: hex_rgb(v) for k, v in cfg["colors"].items()}

# ---------- scene ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        pass
print("ENGINE", scene.render.engine)
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.resolution_percentage = 100
scene.render.fps = FPS
scene.frame_start, scene.frame_end = 1, FRAMES
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = cfg["out"].rstrip("/") + "/frame_"
scene.render.film_transparent = False
ee = scene.eevee
for attr, val in (("taa_render_samples", cfg.get("samples", 24)), ("use_gtao", True), ("use_bloom", True), ("bloom_intensity", 0.08)):
    if hasattr(ee, attr):
        setattr(ee, attr, val)
scene.render.use_motion_blur = cfg.get("motionBlur", True)
try:
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    try:
        scene.view_settings.view_transform = "Filmic"
    except Exception:
        pass

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wn["Background"].inputs["Color"].default_value = C["bg"]
wn["Background"].inputs["Strength"].default_value = 1.0


def material(name, base=(0.1, 0.1, 0.1, 1), emit=None, strength=0.0, rough=0.4, alpha=1.0, metallic=0.0, rim=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = base
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metallic
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = emit
        bsdf.inputs["Emission Strength"].default_value = strength
    if alpha < 1 or rim:
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            if hasattr(m, attr):
                try:
                    setattr(m, attr, val)
                except Exception:
                    pass
        if hasattr(m, "use_transparency_overlap"):
            m.use_transparency_overlap = True
        if rim:
            # Glassy rim: alpha rises at grazing angles (fresnel), so the
            # cladding reads as a glass tube without raytraced refraction.
            lw = nt.nodes.new("ShaderNodeLayerWeight")
            lw.inputs["Blend"].default_value = rim
            mul = nt.nodes.new("ShaderNodeMath")
            mul.operation = "MULTIPLY_ADD"
            mul.inputs[1].default_value = 0.85
            mul.inputs[2].default_value = alpha
            nt.links.new(lw.outputs["Facing"], mul.inputs[0])
            nt.links.new(mul.outputs[0], bsdf.inputs["Alpha"])
        else:
            bsdf.inputs["Alpha"].default_value = alpha
    return m


def cylinder(name, radius, length, mat, verts=48, x=0.0, y=0.0, z=0.0, caps=True):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=length, location=(x, y, z), rotation=(0, math.pi / 2, 0), end_fill_type="NGON" if caps else "NOTHING")
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return o


L = 60.0
# Cable jacket with a cut-away so the fibres inside are visible.
jacket_mat = material("jacket", base=tuple(min(1, c * 2.2) for c in C["jacket"][:3]) + (1,), rough=0.45)
inner_mat = material("jacket_inner", base=(0.02, 0.025, 0.05, 1), rough=0.8)
bm = bmesh.new()
segs, R1, R2 = 64, 1.75, 2.05
ring_verts = []
for i in range(segs + 1):
    a = math.radians(70) + (math.radians(290) * i / segs)  # leave a 70 degree window open on top
    for x in (-L / 2, L / 2):
        for r in (R1, R2):
            ring_verts.append(bm.verts.new((x, r * math.cos(a), r * math.sin(a))))
bm.verts.ensure_lookup_table()
idx = lambda i, end, outer: i * 4 + end * 2 + outer
for i in range(segs):
    for outer in (0, 1):
        bm.faces.new([bm.verts[idx(i, 0, outer)], bm.verts[idx(i, 1, outer)], bm.verts[idx(i + 1, 1, outer)], bm.verts[idx(i + 1, 0, outer)]])
    for end in (0, 1):
        bm.faces.new([bm.verts[idx(i, end, 0)], bm.verts[idx(i + 1, end, 0)], bm.verts[idx(i + 1, end, 1)], bm.verts[idx(i, end, 1)]])
for i in (0, segs):
    for end in (0,):
        bm.faces.new([bm.verts[idx(i, 0, 0)], bm.verts[idx(i, 0, 1)], bm.verts[idx(i, 1, 1)], bm.verts[idx(i, 1, 0)]])
mesh = bpy.data.meshes.new("jacket")
bm.to_mesh(mesh)
jacket = bpy.data.objects.new("jacket", mesh)
scene.collection.objects.link(jacket)
jacket.data.materials.append(jacket_mat)
for p in jacket.data.polygons:
    p.use_smooth = True

# Steel armour wires (a ring of thin cylinders) between jacket and fibres.
steel = material("steel", base=(0.55, 0.57, 0.62, 1), rough=0.25, metallic=1.0)
for i in range(18):
    a = math.radians(80) + math.radians(270) * i / 17
    cylinder(f"armour{i}", 0.09, L, steel, verts=16, y=1.55 * math.cos(a), z=1.55 * math.sin(a))

# Seven fibres: glass cladding + glowing core.
clad = material("cladding", base=(0.6, 0.85, 1.0, 1), rough=0.05, alpha=0.08, rim=0.35)
core_mat = material("core", base=(0.04, 0.08, 0.12, 1), emit=C["accent"], strength=0.04, rough=0.1)
fibres = [(0.0, 0.0)] + [(0.82 * math.cos(math.tau * k / 6 + 0.3), 0.82 * math.sin(math.tau * k / 6 + 0.3)) for k in range(6)]
for i, (y, z) in enumerate(fibres):
    cylinder(f"clad{i}", 0.34, L, clad, y=y, z=z)
    cylinder(f"core{i}", 0.085, L, core_mat, verts=24, y=y, z=z)

def clipped_emitter(name, col, strength):
    """Emissive material that vanishes past the cable's cut end (world X > L/2),
    so pulses never fly out into open water."""
    m = material(name, base=col, emit=col, strength=strength, alpha=0.999)
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    lt = nt.nodes.new("ShaderNodeMath")
    lt.operation = "LESS_THAN"
    lt.inputs[1].default_value = L / 2 - 0.05
    nt.links.new(geo.outputs["Position"], sep.inputs[0])
    nt.links.new(sep.outputs["X"], lt.inputs[0])
    nt.links.new(lt.outputs[0], bsdf.inputs["Alpha"])
    return m


# Packets: trains of light pulses travelling +X. A "1" bit is a bright
# segment, a "0" a gap. Spread along the whole cable so every part of the
# camera move has traffic in view.
packet_colors = [C["primary"], C["accent"], C["secondary"]]
bit_len, bit_gap = 0.34, 0.16
SPEED = 6.5  # units per second, slightly faster than the camera
for i, (y, z) in enumerate(fibres):
    col_offset = i % 3
    x = -L / 2 - 30 + rnd.random() * 8
    n = 0
    while x < L / 2 + 6:
        col = packet_colors[(col_offset + n) % 3]
        bit_mat = clipped_emitter(f"bit{i}_{n}", col, 14.0)
        bits = [1] + [rnd.choice([0, 1, 1]) for _ in range(rnd.randint(6, 11))] + [1]
        parent = bpy.data.objects.new(f"packet{i}_{n}", None)
        scene.collection.objects.link(parent)
        for b, on in enumerate(bits):
            if on:
                seg = cylinder(f"b{i}_{n}_{b}", 0.1, bit_len, bit_mat, verts=16, x=-b * (bit_len + bit_gap))
                seg.parent = parent
        parent.location = (x, y, z)
        parent.keyframe_insert("location", index=0, frame=1)
        parent.location.x = x + SPEED * cfg["seconds"]
        parent.keyframe_insert("location", index=0, frame=FRAMES)
        for fc in getattr(parent.animation_data.action, "fcurves", []):
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        x += 9 + rnd.random() * 7
        n += 1

# Drifting particles for depth (seabed silt), deterministic.
dust_mat = material("dust", base=(0.6, 0.7, 1, 1), emit=(0.5, 0.6, 1, 1), strength=1.2)
for k in range(140):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.025 + rnd.random() * 0.04, location=(rnd.uniform(-L / 2, L / 2), rnd.uniform(-9, 9), rnd.uniform(-5, 7)))
    bpy.context.active_object.data.materials.append(dust_mat)

# Seabed far below.
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -2.6))
bed = bpy.context.active_object
bed.data.materials.append(material("seabed", base=(0.05, 0.06, 0.1, 1), rough=0.95))

# Lights: cool key from above, warm rim from behind.
def light(kind, loc, energy, color, size=4.0):
    d = bpy.data.lights.new(kind + "L", kind)
    d.energy = energy
    d.color = color[:3]
    if kind == "AREA":
        d.size = size
    o = bpy.data.objects.new(kind, d)
    o.location = loc
    scene.collection.objects.link(o)
    o.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return o

light("AREA", (2, -4, 7), 900, (0.75, 0.85, 1.0), 6)
light("AREA", (-6, 6, 3), 500, (1.0, 0.75, 0.5), 4)
light("AREA", (L / 2 - 10, -6, 6), 1400, (0.55, 0.65, 1.0), 12)
light("POINT", (L / 2 + 3, 0, 0.5), 80, (0.5, 0.9, 1.0))
light("AREA", (0, 0, -1.5), 300, (0.3, 0.5, 1.0), 30)

# Camera: start on the cut end (seven glowing fibre ends), arc round to the
# side and travel with the pulses, ending on a wide three-quarter view.
target = bpy.data.objects.new("target", None)
scene.collection.objects.link(target)
cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 32 if VERTICAL else 42
cam_data.dof.use_dof = True
cam_data.dof.focus_object = target
cam_data.dof.aperture_fstop = 4.0
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
tc = cam.constraints.new("TRACK_TO")
tc.target = target
tc.track_axis, tc.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
end_x = L / 2
# Establishing three-quarter view -> track alongside the pulses -> swing
# round the cut end to reveal the seven glowing fibre ends.
keys = [
    (1, (end_x - 30, 11.0, 6.5), (end_x - 22, 0, -0.3)),
    (int(FRAMES * 0.35), (end_x - 17, 6.0, 3.2), (end_x - 12, 0, 0.0)),
    (int(FRAMES * 0.7), (end_x - 4, 4.6, 2.2), (end_x - 1, 0, 0.0)),
    (FRAMES, (end_x + 6.5, 2.4, 1.6), (end_x - 0.5, 0, 0.0)),
]
if VERTICAL:
    keys = [(f, (x, y * 0.8, z * 1.15), t) for f, (x, y, z), t in keys]
for f, loc, tgt in keys:
    cam.location = loc
    cam.keyframe_insert("location", frame=f)
    target.location = tgt
    target.keyframe_insert("location", frame=f)

# Bloom: compositor fog glow on the emissive pulses (Blender 4.4+ node API).
try:
    tree = bpy.data.node_groups.new("Glow", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = tree.nodes.new("CompositorNodeRLayers")
    gl = tree.nodes.new("CompositorNodeGlare")
    for v in ("Fog Glow", "FOG_GLOW", "Bloom", "BLOOM"):
        try:
            gl.inputs["Type"].default_value = v
            break
        except Exception:
            pass
    for name, val in (("Threshold", 0.7), ("Strength", 0.9), ("Size", 0.6), ("Quality", "High")):
        try:
            gl.inputs[name].default_value = val
        except Exception:
            pass
    out = tree.nodes.new("NodeGroupOutput")
    tree.links.new(rl.outputs["Image"], gl.inputs["Image"])
    tree.links.new(gl.outputs["Image"], out.inputs[0])
    scene.compositing_node_group = tree
    print("GLOW on")
except Exception as e:
    print("GLOW unavailable:", e)

print("SCENE_READY", FRAMES, "frames")
if cfg.get("only"):
    for f in cfg["only"]:
        scene.frame_set(f)
        scene.render.filepath = cfg["out"].rstrip("/") + f"/frame_{f:04d}.png"
        bpy.ops.render.render(write_still=True)
        print(f"Saved: frame_{f:04d}.png")
else:
    bpy.ops.render.render(animation=True)
print("RENDER_DONE")
