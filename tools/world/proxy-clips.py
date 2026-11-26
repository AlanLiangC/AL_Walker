"""File bridges to the published SolarRenderer and Invoker-Render runtimes."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import av
import numpy as np
from PIL import Image


def proxy_clip(job, target, size, frames):
    """Emit only CityNav frames already observed, with the final state held at the end."""
    paths = (job["opening"], job["previous"], job["proxy"])
    pixels = [np.asarray(Image.open(path).convert("RGB").resize(size, Image.Resampling.NEAREST))
              for path in paths]
    with av.open(str(target), "w") as container:
        stream = container.add_stream("ffv1", rate=24)
        stream.width, stream.height = size
        stream.pix_fmt = "bgr0"
        for index in range(frames):
            position = 0 if index < 5 else 1 if index < frames // 2 else 2
            frame = av.VideoFrame.from_ndarray(pixels[position], format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def extract_last(source, output, expected):
    with av.open(str(source)) as video:
        count, last = 0, None
        for last in video.decode(video=0):
            count += 1
        if count != expected or last is None:
            raise RuntimeError(f"world renderer returned {count} frames for {expected} proxy frames")
        last.to_image().convert("RGB").save(output)


class InvokerClips:
    def __init__(self, root):
        self.root = root / "world"
        self.bundle = Path(os.environ["CITYNAV_INVOKER_BUNDLE"])
        self.artifact = Path(os.environ["CITYNAV_INVOKER_ARTIFACT"])
        self.uri = os.environ["CITYNAV_INVOKER_WS"]
        self.python = os.environ["CITYNAV_INVOKER_PYTHON"]
        manifest = json.loads((self.bundle / "native-runtime.json").read_text())
        if manifest.get("model_name") != "invoker-render" or manifest.get("recipe_selection", {}).get("name") != "cwm":
            raise ValueError("Invoker requires a Code World Model 2.0 bundle")
        self.prompt = json.loads(self.artifact.read_text())["encoders"]["recipe"]["system_prompt"]
        self.canvas = manifest["canvas"]

    def run(self, job):
        count = 39
        with tempfile.TemporaryDirectory(prefix="invoker-", dir=self.root) as work:
            directory = Path(work)
            video, reference, prompt = directory / "proxy.mkv", directory / "reference.png", directory / "prompt.txt"
            output = directory / "out"
            canvas = self.canvas
            proxy_clip(job, video, (canvas["proxy_width"], canvas["proxy_height"]), count)
            with Image.open(job["reference"]) as anchor:
                anchor.convert("RGB").resize((canvas["width"], canvas["height"]), Image.Resampling.LANCZOS).save(reference)
            # The published CWM checkpoint uses a fixed system prompt. The look is
            # already in the user's RGB reference. Use the matching deployment prompt.
            prompt.write_text(self.prompt, encoding="utf-8")
            repo = self.root / "CodeWorldModel"
            env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
            subprocess.run([self.python, str(repo / "invoker_render.py"), "infer",
                            "--model-path", str(self.bundle), "--artifact", str(self.artifact), "--uri", self.uri,
                            "--first-image", str(reference), "--proxy-video", str(video), "--prompt-file", str(prompt),
                            "--seed", str(job["seed"]), "--output-dir", str(output), "--timeout", "480"],
                           cwd=repo, env=env, check=True)
            receipt = json.loads((output / "inference.json").read_text())
            if receipt["output_frames"] != count or not receipt["native_eos"] or not receipt["native_close_confirmed"]:
                raise RuntimeError("Invoker did not confirm the last source observation")
            extract_last(output / "video.mp4", job["output"], count)


def load_solar_source(root):
    import importlib.util

    scripts = root / "SolarRenderer/scripts"
    spec = importlib.util.spec_from_file_location("solarrenderer_native", scripts / "render.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    return native


def solar_encoder(native, h3, device):
    """Distribute the released encoder over the two visible Ada GPUs."""
    import torch
    from diffusers import ComponentsManager, ModularPipeline
    from diffusers.modular_pipelines import SequentialPipelineBlocks
    from diffusers.modular_pipelines.minimax_h3.modular_pipeline import MiniMaxH3ModularPipeline
    import omni_preencode as pre

    origin = str(h3)
    os.environ["H3_REF_ROOT"] = origin
    pre.ROOT = origin
    index = h3 / "modular_model_index.json"
    config = json.loads(index.read_text())
    components = [value[2] for value in config.values()
                  if isinstance(value, list) and len(value) == 3 and isinstance(value[2], dict)]
    if any(component.get("pretrained_model_name_or_path") != origin for component in components):
        for component in components:
            component["pretrained_model_name_or_path"] = origin
        with tempfile.NamedTemporaryFile(mode="w", dir=h3, delete=False) as updated:
            json.dump(config, updated, indent=2)
        Path(updated.name).replace(index)
    # One full causal window uses 22 VAE-aligned frames. H3's public clip UI
    # imposes a longer duration floor than its encoder needs for this window.
    MiniMaxH3ModularPipeline.min_duration = property(lambda self: 22 / self.fps)
    blocks = ModularPipeline.from_pretrained(origin).blocks
    manager = ComponentsManager()

    def chain(workflow, names):
        sub = blocks.get_workflow(workflow).sub_blocks
        return SequentialPipelineBlocks.from_blocks_dict({name: sub[name] for name in names}).init_pipeline(
            origin, components_manager=manager,
        )

    conditioned = chain("ref2va", ("before_encode", "text_encoder", "vae_encoder"))
    conditioned.load_components(dtype=torch.bfloat16, device_map={"text_encoder": "balanced"},
                                max_memory={"text_encoder": {0: "35GiB", 1: "39GiB", "cpu": "70GiB"}})
    for name in conditioned.pretrained_component_names:
        module = getattr(conditioned, name, None)
        if isinstance(module, torch.nn.Module) and not getattr(module, "hf_device_map", None):
            module.to(device)
    loaded = {name: getattr(conditioned, name) for name in conditioned.pretrained_component_names}
    latents = chain("ref2va", ("before_encode", "vae_encoder"))
    text = chain("t2va", ("text_encoder",))
    for pipe in (latents, text):
        pipe.update_components(**{k: v for k, v in loaded.items() if k in pipe.pretrained_component_names})
    return pre, (conditioned, latents, text)


@contextmanager
def solar_ada():
    """Use PyTorch SDPA for the stock segment attention and split the DiT by layer."""
    import torch
    from solarwm.backends.minimax_h3 import inference, omni_causal, optional

    def attend(q, k, v):
        return torch.nn.functional.scaled_dot_product_attention(
            q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2),
        ).transpose(1, 2)

    def segment(query, key, value, plan, layer):
        if query.shape[1] != plan.sequence_length:
            raise ValueError("Solar attention rows do not match the causal plan")
        rows = []
        for start, stop, spans, cached, commit in plan.segments:
            keys, values = [key[:, a:b] for a, b in spans], [value[:, a:b] for a, b in spans]
            for chunk in cached:
                k, v = plan.cache.get(layer, chunk)
                keys.append(k)
                values.append(v)
            rows.append(attend(query[:, start:stop], torch.cat(keys, dim=1), torch.cat(values, dim=1)))
            if commit is not None:
                plan.cache.put(layer, commit, key[:, start:stop], value[:, start:stop])
        return torch.cat(rows, dim=1)

    original_segment, original_load = omni_causal.segment_attention, optional.load_transformer
    original_conditioners, original_decode = optional.load_conditioners, inference.decode_h3_latents

    def chunk_feed_forward(forward):
        def apply(hidden_states):
            return torch.cat([forward(rows) for rows in hidden_states.split(2048, dim=1)], dim=1)
        return apply

    def load(config, *, device):
        modules = original_load({**config, "attention_backend": "native", "transformer_device_map": "balanced"},
                                device=device)

        def return_to_sampler(_module, _inputs, output):
            return output.to(device)

        # Packed indices belong to the sampler GPU. Accelerate can place the
        # two output projections beside the final blocks on the second GPU.
        modules.transformer.proj_out.register_forward_hook(return_to_sampler)
        modules.transformer.audio_proj_out.register_forward_hook(return_to_sampler)
        for block in modules.transformer.transformer_blocks:
            block.ff.forward = chunk_feed_forward(block.ff.forward)
        return modules

    def load_conditioners(config, *, device, **options):
        torch.cuda.empty_cache()
        return original_conditioners(config, device=torch.device("cpu"), **options)

    def decode(vae, latents, *, device):
        torch.cuda.empty_cache()
        decode_device = torch.device("cuda:1")
        return original_decode(vae.to(decode_device), latents, device=decode_device)

    omni_causal.segment_attention, optional.load_transformer = segment, load
    optional.load_conditioners, inference.decode_h3_latents = load_conditioners, decode
    try:
        yield
    finally:
        omni_causal.segment_attention, optional.load_transformer = original_segment, original_load
        optional.load_conditioners, inference.decode_h3_latents = original_conditioners, original_decode


class SolarClips:
    def __init__(self, runtime):
        self.root = runtime / "world"
        self.h3 = self.root / "models/h3"
        self.adapters = self.root / "models/solar"
        self.native = load_solar_source(self.root)

    def run(self, job):
        count, device = 22, "cuda:0"
        style = job["style"]
        prompt = (
            "1. Structure: low-detail grey-box video from the CityNav simulator.\n"
            "2. Composition: a ground robot camera; preserve the proxy perspective, streets and crossings.\n"
            "3. Motion: follow the exact camera and traffic motion in the supplied sequence.\n"
            "4. Consistency: keep object layouts and traffic signal colors from the controls.\n"
            f"5. Visual style: {style}. Match the opening reference throughout.\n"
            "6. Lighting and details: natural exposure, coherent shadows, no HUD or subtitles."
        )
        with tempfile.TemporaryDirectory(prefix="solar-", dir=self.root) as work, solar_ada():
            directory = Path(work)
            video, member, output = directory / "proxy.mkv", directory / "encoded.safetensors", directory / "out.mp4"
            proxy_clip(job, video, (1344, 768), count)
            encoder = solar_encoder(self.native, self.h3, device)
            self.native.encode_sample(encoder, self.native.sample_of("CityNav", prompt, str(video), job["reference"]),
                                      str(member), count)
            del encoder
            self.native.free_cuda()
            renderer = self.native.load_renderer(
                str(self.h3), str(self.adapters / "solarrenderer_causal_control_lora.safetensors"),
                str(self.adapters / "solarrenderer_causal_4step_lora.safetensors"), device, causal=True, frames=count,
            )
            self.native.render_member(renderer, str(member), str(output), job["seed"], forwards=4, keep=count)
            del renderer
            self.native.free_cuda()
            extract_last(output, job["output"], count)


if __name__ == "__main__":
    import time
    import traceback

    type_, runtime = sys.argv[1:]
    runner = (SolarClips if type_ == "solar" else InvokerClips)(Path(runtime))
    print('CITYNAV {"ready":true}', flush=True)
    for line in sys.stdin:
        job = json.loads(line)
        started = time.perf_counter()
        try:
            runner.run(job)
            response = {"id": job["id"], "ms": (time.perf_counter() - started) * 1000}
        except Exception as error:
            traceback.print_exc()
            response = {"id": job["id"], "error": str(error)}
        print("CITYNAV " + json.dumps(response), flush=True)
