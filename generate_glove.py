"""
棒球手套 3D 模型生成腳本
用法: blender --background --python generate_glove.py -- --output /path/to/glove.glb
"""
import bpy
import bmesh
import math
import sys
import os

# ── 取得輸出路徑 ──────────────────────────────────────────────────────────
argv = sys.argv
output_path = None
if "--" in argv:
    args = argv[argv.index("--") + 1:]
    for i, a in enumerate(args):
        if a == "--output" and i + 1 < len(args):
            output_path = args[i + 1]
if not output_path:
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "glove.glb")

print(f"[Glove] 輸出路徑: {output_path}")

# ── 清空場景 ──────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for col in list(bpy.data.collections):
    bpy.data.collections.remove(col)

# ── 建立材質 ──────────────────────────────────────────────────────────────
def make_mat(name, rgb, roughness=0.80, metallic=0.04):
    m = bpy.data.materials.new(name=name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Metallic"].default_value = metallic
    return m

MAT = {
    "back":     make_mat("GloveBack",    (0.757, 0.604, 0.419)),
    "palm":     make_mat("GlovePalm",    (0.757, 0.604, 0.419)),
    "web":      make_mat("GloveWeb",     (0.361, 0.188, 0.063)),
    "binding":  make_mat("GloveBinding", (0.831, 0.627, 0.090), roughness=0.65),
    "laces":    make_mat("GloveLaces",   (0.757, 0.604, 0.419)),
    "stitching":make_mat("GloveStitch",  (0.545, 0.416, 0.079)),
}

# ── 輔助函式：平滑物件 ────────────────────────────────────────────────────
def smooth(obj):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.shade_smooth()
    obj.select_set(False)

def add_subsurf(obj, levels=2):
    mod = obj.modifiers.new("Subd", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels

def apply_all(obj):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for mod in obj.modifiers:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)

# ── 1. 手掌本體 ────────────────────────────────────────────────────────────
bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=(0, 0, -0.45), segments=48, ring_count=32)
palm = bpy.context.active_object
palm.name = "Palm"
palm.scale = (1.02, 0.38, 1.54)
bpy.ops.object.transform_apply(scale=True, location=False)
palm.data.materials.append(MAT["back"])
add_subsurf(palm, 1)
smooth(palm)

# ── 2. 手腕 ───────────────────────────────────────────────────────────────
bpy.ops.mesh.primitive_cylinder_add(radius=0.58, depth=0.42, location=(0, 0, -2.12), vertices=24)
wrist = bpy.context.active_object
wrist.name = "Wrist"
wrist.scale = (1.0, 0.48, 1.0)
bpy.ops.object.transform_apply(scale=True, location=False)
wrist.data.materials.append(MAT["back"])
smooth(wrist)

# 手腕 binding 環
bpy.ops.mesh.primitive_torus_add(
    major_radius=0.58, minor_radius=0.055,
    major_segments=32, minor_segments=8,
    location=(0, 0, -1.98)
)
wb = bpy.context.active_object
wb.name = "WristBand"
wb.scale = (1.0, 0.48, 1.0)
bpy.ops.object.transform_apply(scale=True, location=False)
wb.data.materials.append(MAT["binding"])

# ── 3. 連接段（手掌→手腕） ───────────────────────────────────────────────
bpy.ops.mesh.primitive_cylinder_add(radius=0.56, depth=0.40, location=(0, 0, -1.85), vertices=24)
conn = bpy.context.active_object
conn.name = "PalmWristConn"
conn.scale = (1.0, 0.44, 1.0)
bpy.ops.object.transform_apply(scale=True, location=False)
conn.data.materials.append(MAT["back"])
smooth(conn)

# ── 4. 四根手指 ───────────────────────────────────────────────────────────
# [cx, tipY, radius, name]
FINGERS = [
    (-0.72, 2.28, 0.152, "Pinky"),
    (-0.28, 2.62, 0.168, "Ring"),
    ( 0.16, 2.84, 0.185, "Middle"),
    ( 0.60, 2.64, 0.170, "Index"),
]
BASE_Y = 0.90

for cx, tipY, r, fname in FINGERS:
    length = tipY - BASE_Y
    cz = BASE_Y + length / 2

    # 指管
    bpy.ops.mesh.primitive_cylinder_add(
        radius=r, depth=length,
        location=(cx, 0.0, cz),
        vertices=14
    )
    fobj = bpy.context.active_object
    fobj.name = f"Finger_{fname}"
    fobj.scale = (1.0, 0.85, 1.0)
    bpy.ops.object.transform_apply(scale=True, location=False)
    fobj.data.materials.append(MAT["back"])
    add_subsurf(fobj, 1)
    smooth(fobj)

    # 指尖球形帽
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=r * 0.98, location=(cx, 0.0, tipY),
        segments=14, ring_count=10
    )
    cap = bpy.context.active_object
    cap.name = f"FingerCap_{fname}"
    cap.scale = (1.0, 0.85, 1.0)
    bpy.ops.object.transform_apply(scale=True, location=False)
    cap.data.materials.append(MAT["back"])
    smooth(cap)

    # binding 環
    bpy.ops.mesh.primitive_torus_add(
        major_radius=r + 0.008, minor_radius=0.028,
        major_segments=18, minor_segments=6,
        location=(cx, 0.0, tipY - 0.08)
    )
    br = bpy.context.active_object
    br.name = f"FingerBand_{fname}"
    br.scale = (1.0, 0.85, 1.0)
    bpy.ops.object.transform_apply(scale=True, location=False)
    br.data.materials.append(MAT["binding"])

# ── 5. 拇指 ───────────────────────────────────────────────────────────────
bpy.ops.mesh.primitive_cylinder_add(
    radius=0.236, depth=1.42,
    location=(1.20, 0.0, 0.28),
    vertices=14
)
thumb = bpy.context.active_object
thumb.name = "Thumb"
thumb.scale = (1.0, 0.82, 1.0)
# 旋轉讓拇指斜向右下
thumb.rotation_euler = (0.0, math.radians(38), 0.0)
bpy.ops.object.transform_apply(scale=True, rotation=True, location=False)
thumb.data.materials.append(MAT["back"])
add_subsurf(thumb, 1)
smooth(thumb)

# 拇指尖
tip_x = 1.20 + math.sin(math.radians(38)) * 0.71
tip_z = 0.28 - math.cos(math.radians(38)) * 0.71
bpy.ops.mesh.primitive_uv_sphere_add(
    radius=0.232, location=(tip_x, 0.0, tip_z),
    segments=14, ring_count=10
)
tcap = bpy.context.active_object
tcap.name = "ThumbCap"
tcap.scale = (1.0, 0.82, 1.0)
bpy.ops.object.transform_apply(scale=True, location=False)
tcap.data.materials.append(MAT["back"])
smooth(tcap)

# 拇指 binding
bpy.ops.mesh.primitive_torus_add(
    major_radius=0.244, minor_radius=0.028,
    major_segments=18, minor_segments=6,
    location=(tip_x, 0.0, tip_z + 0.10)
)
tbr = bpy.context.active_object
tbr.name = "ThumbBand"
tbr.scale = (1.0, 0.82, 1.0)
tbr.rotation_euler = (0.0, math.radians(38), 0.0)
bpy.ops.object.transform_apply(scale=True, rotation=True, location=False)
tbr.data.materials.append(MAT["binding"])

# ── 6. 虎口邊框條（thumb-index bridge，不含 web 條：web 由 Three.js 程式生成） ──
# 留一條薄框讓 web 有視覺基底
bpy.ops.mesh.primitive_cube_add(location=(0.88, 0.0, 0.55))
bridge = bpy.context.active_object
bridge.name = "WebBridge"
bridge.scale = (0.042, 0.10, 0.30)
bpy.ops.object.transform_apply(scale=True, location=False)
bridge.rotation_euler = (0.0, math.radians(-10), 0.0)
bpy.ops.object.transform_apply(rotation=True, location=False)
bridge.data.materials.append(MAT["binding"])

# ── 7. 指縫綁繩小球 ──────────────────────────────────────────────────────
lace_positions = [
    (-0.50, 1.22), (-0.50, 1.06),
    (-0.06, 1.24), (-0.06, 1.08),
    ( 0.38, 1.22), ( 0.38, 1.06),
]
for i, (lx, lz) in enumerate(lace_positions):
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=0.050, location=(lx, 0.0, lz),
        segments=8, ring_count=6
    )
    ld = bpy.context.active_object
    ld.name = f"Lace_{i}"
    ld.data.materials.append(MAT["laces"])

# ── 8. 掌心皮（palm leather） ────────────────────────────────────────────
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.78, location=(-0.04, 0.38, -0.46), segments=24, ring_count=16)
palmL = bpy.context.active_object
palmL.name = "PalmLeather"
palmL.scale = (1.0, 0.04, 0.95)
bpy.ops.object.transform_apply(scale=True, location=False)
palmL.data.materials.append(MAT["palm"])
smooth(palmL)

# ── 選取全部、放在 collection ─────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')

# ── 匯出 GLB ──────────────────────────────────────────────────────────────
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    export_materials='EXPORT',
    export_normals=True,
    export_apply=True,
    use_selection=False,
)
print(f"[Glove] 完成！GLB 已輸出至: {output_path}")
