"""Convert a credited glTF vehicle to CityNav's compact raster mesh format."""
from pathlib import Path
import gzip
import runpy
import sys

import bpy
import numpy as np


def texture_pixels(shader):
    base = shader.inputs["Base Color"]
    if not base.links:
        return None
    node = base.links[0].from_node
    if node.type != "TEX_IMAGE" or node.image is None:
        return None
    w, h = node.image.size
    pixels = np.empty(w * h * 4, dtype=np.float32)
    node.image.pixels.foreach_get(pixels)
    return pixels.reshape(h, w, 4)


def export(source, output, kind, yaw):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    helpers = runpy.run_path(str(Path(__file__).with_name("cycles-worker.py")))
    mesh = helpers["load_actor_asset"](source, yaw)
    lower, upper = helpers["dimensions"](mesh)
    half_width, height, half_length = (1.02, 2.16, 2.33) if kind == "van" else (.92, 1.48, 2.01)
    scale = np.array([2 * half_width, 2 * half_length, height]) / (upper - lower)
    center = (upper + lower) * .5
    center[2] = lower[2]
    mesh.calc_loop_triangles()
    uv = mesh.uv_layers.active
    surface = []
    for mat in mesh.materials:
        shader = next((node for node in mat.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None) if mat.use_nodes else None
        name = mat.name.casefold()
        category = (10 if any(word in name for word in ("rim", "metal", "disc", "mirror")) else
                    8 if any(word in name for word in ("glass", "window")) else
                    16 if any(word in name for word in ("paint", "coachwork")) else 0)
        color = np.array(shader.inputs["Base Color"].default_value[:3] if shader else mat.diffuse_color[:3])
        if category == 16:
            color = np.ones(3) * .75
        elif category == 8:
            color = np.array([.026, .040, .055])
        surface.append((category, color, texture_pixels(shader) if shader and category not in (8, 16) else None))
    output.parent.mkdir(parents=True, exist_ok=True)
    result = np.empty((len(mesh.loop_triangles), 3, 12), dtype=np.float32)
    for i, triangle in enumerate(mesh.loop_triangles):
        category, factor, texture = surface[triangle.material_index]
        for j, index in enumerate(triangle.loops):
            loop = mesh.loops[index]
            point = (np.array(mesh.vertices[loop.vertex_index].co) - center) * scale
            normal = np.array(mesh.corner_normals[index].vector) / scale
            normal /= max(np.linalg.norm(normal), 1.e-9)
            color = factor
            if uv and texture is not None:
                u, v = uv.data[index].uv
                h, w = texture.shape[:2]
                color = color * texture[int(v*h) % h, int(u*w) % w, :3]
            x, z, y = point
            nx, nz, ny = normal
            material = category if category == 16 else 17 + category
            result[i, j] = (x, y, -z, *np.sqrt(np.clip(color, 0, 1)), nx, ny, -nz, material, 0, 0)
    output.write_bytes(gzip.compress(result.astype("<f4", copy=False).tobytes(), compresslevel=6, mtime=0))
    print(kind, len(result), "triangles", output)


if __name__ == "__main__":
    source, output, kind, yaw = sys.argv[sys.argv.index("--") + 1:]
    export(Path(source).resolve(), Path(output), kind, float(yaw))
