"""Bake a rigged glTF pedestrian into a standing pose and a reusable walk cycle."""
import gzip
from pathlib import Path
import runpy
import sys

import bpy
from mathutils import Matrix
import numpy as np


POSES = 8


def select_clip(objects, name):
    strip = None
    for obj in objects:
        animation = obj.animation_data
        if not animation:
            continue
        animation.action = None
        for track in animation.nla_tracks:
            track.mute = track.name.casefold() != name
            if not track.mute and track.strips:
                strip = track.strips[0]
    if strip is None:
        raise ValueError(f"Missing glTF animation {name!r}")
    return strip.frame_start, strip.frame_end


def export(source):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    scene = bpy.context.scene
    objects = sorted(scene.objects, key=lambda obj: obj.name)
    parts = [obj for obj in objects if obj.type == "MESH" and obj.data.materials]
    texture_pixels = runpy.run_path(str(Path(__file__).with_name("export-live-vehicle.py")))["texture_pixels"]
    textures = {}
    for material in {mat for part in parts for mat in part.data.materials}:
        shader = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
        textures[material.name] = texture_pixels(shader)
    transform = Matrix(((-1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    origin, scale = None, None
    for clip, count in (("idle", 1), ("walk", POSES)):
        first, end = select_clip(objects, clip)
        for pose in range(count):
            scene.frame_set(round(first + (end-first)*pose/count))
            evaluated = bpy.context.evaluated_depsgraph_get()
            rows = []
            for part in parts:
                obj = part.evaluated_get(evaluated)
                mesh = obj.to_mesh(preserve_all_data_layers=True, depsgraph=evaluated)
                try:
                    world = transform @ obj.matrix_world
                    normal_matrix = world.to_3x3().inverted().transposed()
                    mesh.calc_loop_triangles()
                    uv = mesh.uv_layers.active
                    result = np.empty((len(mesh.loop_triangles)*3, 12), dtype=np.float32)
                    for i, triangle in enumerate(mesh.loop_triangles):
                        texture = textures[part.data.materials[triangle.material_index].name]
                        for j, index in enumerate(triangle.loops):
                            vertex = mesh.vertices[mesh.loops[index].vertex_index]
                            point = world @ vertex.co
                            normal = (normal_matrix @ mesh.corner_normals[index].vector).normalized()
                            color = (.62, .63, .62)
                            if texture is not None and uv is not None:
                                u, v = uv.data[index].uv
                                h, w = texture.shape[:2]
                                color = np.sqrt(np.clip(texture[int(v*h) % h, int(u*w) % w, :3], 0, 1))
                            result[i*3+j] = (*point, *color, *normal, 17, 0, 0)
                    rows.append(result)
                finally:
                    obj.to_mesh_clear()
            vertices = np.concatenate(rows)
            if origin is None:
                floor, ceiling = vertices[:, 1].min(), vertices[:, 1].max()
                origin = np.array([0, floor, 0], dtype=np.float32)
                scale = 1.78/(ceiling-floor)
            vertices[:, :3] = (vertices[:, :3]-origin)*scale
            yield vertices


if __name__ == "__main__":
    source, output = map(Path, sys.argv[sys.argv.index("--") + 1:])
    frames = np.stack(list(export(source.resolve())))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(gzip.compress(frames.astype("<f4", copy=False).tobytes(), compresslevel=6, mtime=0))
    print(f"{len(frames)} poses with {frames.shape[1]//3} triangles each")
