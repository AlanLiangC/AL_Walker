"""Render read-only CityNav states in one persistent Blender process."""
import json
import math
from pathlib import Path
import sys
import time

import bpy
from mathutils import Matrix, Vector
import numpy as np


def rgb_linear(value):
    return np.where(value <= .04045, value / 12.92, ((value + .055) / 1.055) ** 2.4)


def axis(values):
    x, y, z = values
    return (x, -z, y)


def material(number, images, directory):
    mat = bpy.data.materials.new(f"CityNav material {number}")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = nodes.get("Principled BSDF")
    vertex = nodes.new("ShaderNodeVertexColor")
    vertex.layer_name = "CityColor"
    links.new(vertex.outputs["Color"], shader.inputs["Base Color"])
    shader.inputs["Roughness"].default_value = {7: .69, 8: .13, 9: .28, 10: .32, 12: .18}.get(number, .80)
    shader.inputs["Metallic"].default_value = {8: .20, 9: .22, 10: .72}.get(number, 0)
    if number == 8:
        shader.inputs["Coat Weight"].default_value = .65
    if number == 9:
        shader.inputs["Coat Weight"].default_value = .38
        shader.inputs["Coat Roughness"].default_value = .20
    if number == 12:
        shader.inputs["Transmission Weight"].default_value = .65
    if number == 14:
        links.new(vertex.outputs["Color"], shader.inputs["Emission Color"])
        shader.inputs["Emission Strength"].default_value = .8
    if images:
        texcoord = nodes.new("ShaderNodeTexCoord")
        scale = nodes.new("ShaderNodeVectorMath")
        scale.operation = "SCALE"
        scale.inputs["Scale"].default_value = 1 / images["meters"]
        links.new(texcoord.outputs["UV"], scale.inputs[0])
        for kind, color_space in (("diff", "sRGB"), ("nor_gl", "Non-Color"), ("rough", "Non-Color")):
            tex = nodes.new("ShaderNodeTexImage")
            tex.image = bpy.data.images.load(str(directory / f"{images['asset']}_{kind}.jpg"), check_existing=True)
            tex.image.colorspace_settings.name = color_space
            links.new(scale.outputs["Vector"], tex.inputs["Vector"])
            if kind == "diff":
                mix = nodes.new("ShaderNodeMixRGB")
                mix.blend_type = "MULTIPLY"
                mix.inputs[0].default_value = images["tint"]
                links.new(tex.outputs["Color"], mix.inputs[1])
                links.new(vertex.outputs["Color"], mix.inputs[2])
                links.new(mix.outputs["Color"], shader.inputs["Base Color"])
            elif kind == "rough":
                links.new(tex.outputs["Color"], shader.inputs["Roughness"])
            else:
                normal = nodes.new("ShaderNodeNormalMap")
                normal.inputs["Strength"].default_value = .75
                links.new(tex.outputs["Color"], normal.inputs["Color"])
                links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    return mat


def mesh_from(path, materials):
    vertices = np.fromfile(path, dtype="<f4").reshape(-1, 12)
    positions = vertices[:, (0, 2, 1)].copy()
    positions[:, 1] *= -1
    faces = np.arange(len(vertices)).reshape(-1, 3)[:, (0, 2, 1)]
    mesh = bpy.data.meshes.new(path.stem)
    mesh.from_pydata(positions, [], faces)
    for mat in materials:
        mesh.materials.append(mat)
    mesh.polygons.foreach_set("material_index", vertices[::3, 9].astype(np.int32))
    colors = mesh.color_attributes.new(name="CityColor", type="FLOAT_COLOR", domain="POINT")
    rgba = np.ones((len(vertices), 4), np.float32)
    rgba[:, :3] = rgb_linear(vertices[:, 3:6])
    colors.data.foreach_set("color", rgba.ravel())
    uv = mesh.uv_layers.new(name="WorldXY")
    uvs = positions[faces.ravel(), :2].copy()
    uv.uv.foreach_set("vector", uvs.ravel())
    mesh.update()
    return mesh


def add_object(name, data):
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def load_actor_asset(path, yaw):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    bpy.context.view_layer.update()
    imported = set(bpy.context.scene.objects) - before
    meshes = [obj for obj in imported if obj.type == "MESH"]
    parents = imported - set(meshes)
    rotation = Matrix.Rotation(math.radians(yaw), 4, "Z")
    transforms = {obj: rotation @ obj.matrix_world for obj in meshes}
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        obj.data = obj.data.copy()
        obj.data.transform(transforms[obj])
        obj.select_set(True)
    target = meshes[0]
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()
    mesh = target.data
    for obj in parents:
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.objects.remove(target, do_unlink=True)
    return mesh


def dimensions(mesh):
    coords = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", coords)
    coords = coords.reshape(-1, 3)
    return coords.min(axis=0), coords.max(axis=0)


def paint_actor_asset(mesh, reference, css_color, slot_name):
    lower, upper = dimensions(mesh)
    target_low, target_high = dimensions(reference)
    center = (lower + upper) / 2
    center[2] = lower[2]
    scale = (target_high - target_low) / (upper - lower)
    mesh = mesh.copy()
    mesh.transform(Matrix.Diagonal((*scale, 1)) @ Matrix.Translation(-Vector(center)))
    index = next(i for i, mat in enumerate(mesh.materials) if mat.name == slot_name)
    paint = mesh.materials[index].copy()
    rgb = rgb_linear(np.array([int(css_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]))
    paint.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (*rgb, 1)
    mesh.materials[index] = paint
    return mesh


def lens_material(name, value):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*value, 1)
    shader.inputs["Emission Color"].default_value = (*value, 1)
    shader.inputs["Emission Strength"].default_value = 3
    return mat


class CityRender:
    def __init__(self, manifest, style_path, compute):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        self.bundle = json.loads(manifest.read_text())
        self.style = style = json.loads(style_path.read_text())
        directory = style_path.parent
        scene = self.scene
        scene.render.engine = "CYCLES"
        scene.render.resolution_x, scene.render.resolution_y = style["width"], style["height"]
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGB"
        scene.render.use_persistent_data = True
        scene.cycles.samples = style["samples"]
        scene.cycles.use_denoising = True
        scene.cycles.max_bounces = 6
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.exposure = style["exposure"]
        if compute != "CPU":
            preferences = bpy.context.preferences.addons["cycles"].preferences
            preferences.compute_device_type = compute
            preferences.refresh_devices()
            active = [device for device in preferences.devices if device.type == compute]
            if not active:
                raise RuntimeError(f"No {compute} render device")
            for device in preferences.devices:
                device.use = device in active
            scene.cycles.device = "GPU"
            if compute == "OPTIX":
                scene.cycles.denoiser = "OPTIX"
        scene.world = world = bpy.data.worlds.new("CityNav daylight")
        world.use_nodes = True
        env = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(str(directory / style["sky"]))
        background = world.node_tree.nodes.get("Background")
        world.node_tree.links.new(env.outputs["Color"], background.inputs["Color"])
        background.inputs["Strength"].default_value = style["skyStrength"]
        sun = add_object("Sun", bpy.data.lights.new("Sun", type="SUN"))
        sun.rotation_euler = (.51, -.34, 2.5)
        sun.data.energy, sun.data.angle = style["sunStrength"], math.radians(4.5)
        self.camera = add_object("CityNav robot camera", bpy.data.cameras.new("Robot"))
        self.camera.data.sensor_fit = "HORIZONTAL"
        self.camera.data.clip_start = .055
        scene.camera = self.camera
        mats = [material(n, style["textures"].get(str(n)), directory) for n in range(16)]
        mats[7].pass_index = 1  # Road paint, including crossings
        root = manifest.parent
        add_object("CityNav static scene", mesh_from(root / self.bundle["world"], mats))
        if self.bundle.get("signs"):
            add_object("CityNav signs", mesh_from(root / self.bundle["signs"], mats)).pass_index = 3
        self.meshes = {key: mesh_from(root / file, mats) for key, file in self.bundle["actors"].items()}
        models = style.get("models", {})
        replacements = {kind: load_actor_asset(directory / asset["file"], asset["yawDegrees"])
                        for kind, asset in models.items()}
        for key, reference in self.meshes.copy().items():
            kind, color = key.split(":", 1)
            if kind in replacements:
                self.meshes[key] = paint_actor_asset(replacements[kind], reference, color, models[kind]["paint"])
        self.legs = [mesh_from(root / file, mats) for file in self.bundle["legs"]]
        self.actors = {}
        self.lenses = []
        red = lens_material("Stop", (1, .016, .011))
        green = lens_material("Walk", (.011, 1, .31))
        off = lens_material("Unlit", (.027, .030, .031))
        off.node_tree.nodes.get("Principled BSDF").inputs["Emission Strength"].default_value = 0
        for post in self.bundle["posts"]:
            for (dx, dz), angle in [((.151,0), math.pi/2),((-.151,0), math.pi/2),((0,.151),0),((0,-.151),0)]:
                for walk, height in ((False, 2.505), (True, 2.285)):
                    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=1,
                                                       location=axis((post["x"]+dx,height,post["z"]+dz)))
                    lamp = bpy.context.object
                    lamp.pass_index = 2
                    lamp.scale = (.083, .041, .072)
                    lamp.rotation_euler.z = angle
                    lamp.data.materials.append(off)
                    self.lenses.append((post["crossing"], walk, lamp, green if walk else red))
        self.off = off
        self.control_output = None

    def controls(self, directory):
        scene = self.scene
        layer = scene.view_layers[0]
        layer.use_pass_z = layer.use_pass_object_index = layer.use_pass_material_index = True
        scene.use_nodes = True
        if self.control_output is not None:
            self.control_output.base_path = str(directory)
            return
        tree = scene.node_tree
        tree.nodes.clear()
        source = tree.nodes.new("CompositorNodeRLayers")
        composite = tree.nodes.new("CompositorNodeComposite")
        output = tree.nodes.new("CompositorNodeOutputFile")
        self.control_output = output
        output.base_path = str(directory)
        output.format.file_format = "OPEN_EXR"
        output.format.color_depth = "32"
        output.format.color_mode = "RGB"
        output.file_slots[0].path = "controls-"
        channels = tree.nodes.new("CompositorNodeCombRGBA")
        for name, index in (("Depth", 0), ("IndexOB", 1), ("IndexMA", 2)):
            tree.links.new(source.outputs[name], channels.inputs[index])
        tree.links.new(channels.outputs[0], output.inputs[0])
        tree.links.new(source.outputs["Image"], composite.inputs["Image"])

    def render(self, state, output, controls=False):
        camera = state["camera"]
        self.camera.location = axis(camera["eye"])
        direction = Vector(axis(camera["target"])) - Vector(self.camera.location)
        self.camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        self.camera.data.lens = self.camera.data.sensor_width / (2 * math.tan(math.radians(camera["fov"]) / 2))
        self.camera.data.clip_end = camera["far"]
        for objects in self.actors.values():
            for obj in objects:
                obj.hide_render = True
        for row in state["actors"]:
            if row["id"] not in self.actors:
                body = add_object(row["id"], self.meshes[row["mesh"]])
                legs = [add_object(row["id"] + f"/leg{side}", self.legs[2]) for side in (-1, 1)] if "stride" in row else []
                for obj in (body, *legs):
                    obj.pass_index = 1
                self.actors[row["id"]] = [body, *legs]
            body, *legs = self.actors[row["id"]]
            body.data = self.meshes[row["mesh"]]
            body.location = axis((row["x"], row["y"], row["z"]))
            body.rotation_euler.z = -row["yaw"]
            body.hide_render = False
            for side, leg in zip((-1, 1), legs):
                leg.data = self.legs[2+side*row["stride"]]
                leg.location = axis((row["x"]+side*.11*math.cos(row["yaw"]),row["y"],
                                     row["z"]+side*.11*math.sin(row["yaw"])))
                leg.rotation_euler.z = -row["yaw"]
                leg.hide_render = False
        for crossing, walk, obj, light in self.lenses:
            obj.data.materials[0] = light if state["signals"][crossing] == walk else self.off
        layer = self.scene.view_layers[0]
        layer.use_pass_z = layer.use_pass_object_index = layer.use_pass_material_index = False
        self.scene.use_nodes = False
        if controls:
            self.controls(Path(output).parent)
        self.scene.render.filepath = output
        bpy.ops.render.render(write_still=True)


def reply(value):
    print("CITYNAV " + json.dumps(value, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    manifest, style, compute = sys.argv[sys.argv.index("--") + 1:]
    renderer = CityRender(Path(manifest), Path(style), compute)
    reply({"ready": True, "scene": renderer.bundle["scene"]})
    for line in sys.stdin:
        job = json.loads(line)
        started = time.perf_counter()
        try:
            renderer.render(job["state"], job["output"], job.get("controls", False))
            reply({"id": job["id"], "ms": (time.perf_counter() - started) * 1000})
        except Exception as error:
            reply({"id": job["id"], "error": str(error)})
