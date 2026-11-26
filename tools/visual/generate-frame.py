"""Run a local generative model with CityNav's same-state geometry controls."""
from collections import OrderedDict
import json
from pathlib import Path
import sys
import time
import traceback

import cv2
import numpy as np
from PIL import Image
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def image_controls(path):
    # Blender exports linear R=depth, G=object class, B=protected material.
    packed = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if packed is None or packed.ndim != 3 or packed.shape[2] != 3:
        raise RuntimeError("CityNav EXR control passes are missing")
    material, objects, depth = np.moveaxis(packed, 2, 0)
    # Fixed metric mapping keeps near/far contrast consistent across the route.
    depth = 255 * np.clip((2 / (np.maximum(depth, 0) + 2) - .025) / .975, 0, 1)
    return Image.fromarray(depth.round().astype("uint8")).convert("RGB"), objects, material


def compose(beauty, generated, objects, material):
    generated = generated.convert("RGB").resize(beauty.size, Image.Resampling.LANCZOS)
    alpha = np.zeros(objects.shape, dtype="float32")
    for pixels, inner, outer in ((objects == 1, 8, 35), (objects >= 2, 5, 24), (material > .5, 1, 9)):
        distance = cv2.distanceTransform((~pixels).astype("uint8"), cv2.DIST_L2, 5)
        weight = np.clip((outer - distance) / (outer - inner), 0, 1)
        alpha = np.maximum(alpha, weight * weight * (3 - 2 * weight))
    mask = Image.fromarray((alpha * 255).round().astype("uint8"))
    return Image.composite(beauty, generated, mask)


def letterbox(image, size):
    width, height = size
    scaled = round(image.height * width / image.width)
    top = (height - scaled) // 2
    image = image.resize((width, scaled), Image.Resampling.LANCZOS)
    pixels = np.pad(np.asarray(image), ((top, height - scaled - top), (0, 0), (0, 0)), mode="edge")
    return Image.fromarray(pixels), (0, top, width, top + scaled)


class Runner:
    def __init__(self, method, runtime, qwen, config):
        style = json.loads(config.read_text())
        self.method, self.style = method, style
        self.options = style["methods"][method]
        self.history = OrderedDict()
        self.weights = runtime / "models/visual"
        self.anchor = None
        if path := self.options.get("anchor"):
            manifest = config.parent / path
            metadata = json.loads(manifest.read_text())
            self.anchor = metadata, Image.open(manifest.parent / metadata["image"]).convert("RGB")
        dtype = torch.bfloat16
        offline = {"local_files_only": True}
        torch.set_num_threads(4)
        torch.backends.cudnn.benchmark = False
        if method == "edenlive":
            from services.eden.worker import AdaEden

            name = self.options["profile"]
            profile_path = Path(__file__).resolve().parents[2] / "services/eden/profiles" / f"{name}.json"
            profile = json.loads(profile_path.read_text())
            self.pipe = AdaEden(profile, runtime / "upstream", runtime / "models/EdenLive")
            return
        if method == "qwen-image":
            from diffusers import QwenImage21Pipeline

            self.pipe = QwenImage21Pipeline.from_pretrained(qwen, torch_dtype=dtype, **offline)
        elif method == "difix":
            from diffusers import loaders
            from diffusers.loaders import FromOriginalModelMixin, PeftAdapterMixin

            root = self.weights / "difix"
            sys.path.insert(0, str(runtime / "visual/difix-source/src"))
            sys.path.insert(0, str(root / "vae"))
            if not hasattr(loaders, "FromOriginalVAEMixin"):
                loaders.FromOriginalVAEMixin = FromOriginalModelMixin
            from autoencoder_kl import AutoencoderKL
            from pipeline_difix import DifixPipeline

            # Upstream's VAE used a Diffusers version with adapter support on ModelMixin.
            class DifixVAE(AutoencoderKL, PeftAdapterMixin):
                pass

            vae = DifixVAE.from_pretrained(root / "vae", torch_dtype=torch.float32, **offline)
            self.pipe = DifixPipeline.from_pretrained(root, vae=vae, torch_dtype=torch.float32, **offline)
        elif method == "sdxl-depth":
            from diffusers import ControlNetModel, StableDiffusionXLControlNetImg2ImgPipeline

            params = {"torch_dtype": torch.float16, "variant": "fp16", **offline}
            control = ControlNetModel.from_pretrained(self.weights / "sdxl-depth", **params)
            self.pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
                self.weights / "sdxl", controlnet=control, add_watermarker=False, **params,
            )
        else:
            from diffusers import AutoencoderKLWan, WanVACEPipeline
            from transformers import UMT5EncoderModel

            root = self.weights / "wan-vace"
            text = UMT5EncoderModel.from_pretrained(runtime / "models/EdenLive/umt5/text_encoder",
                                                     torch_dtype=dtype, **offline)
            vae = AutoencoderKLWan.from_pretrained(root / "vae", torch_dtype=torch.float32, **offline)
            self.pipe = WanVACEPipeline.from_pretrained(root, text_encoder=text, vae=vae,
                                                        torch_dtype=dtype, **offline)
        self.pipe.to("cuda")
        self.pipe.set_progress_bar_config(disable=True)

    def reference(self, job):
        if self.anchor is None:
            return None
        from services.eden.session import aligned_camera

        meta, photo = self.anchor
        context = job.get("context", {})
        if (job["tick"] == meta["simTick"]
                and all(context.get(k) == meta[k] for k in ("episodeId", "robotId", "seed", "weather"))
                and aligned_camera(meta["camera"], context.get("camera"))):
            return photo

    def recent(self, job, beauty, depth, count, reference=None):
        key, tick = job["stream"], job["tick"]
        # A large navigation step can move several meters or switch traffic phases.
        # Discard the old control clip when it would cross that discontinuity.
        frames = [frame for frame in self.history.get(key, []) if 0 < tick - frame[0] <= 4 * count]
        frames = (frames + [(tick, beauty, depth, reference)])[-count:]
        self.history[key] = frames
        self.history.move_to_end(key)
        if len(self.history) > 6:
            self.history.popitem(last=False)
        return [frames[0]] * (count - len(frames)) + frames

    @torch.inference_mode()
    def run(self, job):
        beauty = Image.open(job["rgb"]).convert("RGB")
        depth, objects, material = image_controls(job["controls"])
        if depth.size != beauty.size:
            raise RuntimeError("CityNav controls and RGB must have matching geometry")
        style = self.style
        prompt = self.options.get("prompt", style["prompt"])
        generator = torch.Generator("cuda").manual_seed(style["seed"])
        if self.method == "edenlive":
            frames = self.recent(job, beauty, depth, 3, self.reference(job))
            size = (self.pipe.width, self.pipe.height)
            condition = np.stack([np.asarray(frame[1].resize(size)) for frame in frames])
            anchor = np.asarray(frames[0][3].resize(size)).copy() if frames[0][3] else condition[0].copy()
            pixels, _ = self.pipe.generate(condition, anchor, style["prompt"], style["seed"])
            result = Image.fromarray(pixels[8])
        elif self.method == "difix":
            result = self.pipe("remove degradation", image=beauty, timesteps=[199], num_inference_steps=1,
                               guidance_scale=0.0, generator=generator).images[0]
        elif self.method == "qwen-image":
            condition, crop = letterbox(beauty, (960, 544))
            result = self.pipe(
                prompt="Edit the supplied image. " + prompt, image=condition,
                width=960, height=544, num_inference_steps=self.options["steps"], generator=generator,
            ).images[0].crop(crop)
        elif self.method == "sdxl-depth":
            size = (960, 528)
            result = self.pipe(
                prompt=prompt, negative_prompt=style["negative"], image=beauty.resize(size),
                control_image=depth.resize(size), strength=self.options["strength"], guidance_scale=5,
                controlnet_conditioning_scale=.8, num_inference_steps=self.options["steps"], generator=generator,
            ).images[0]
        else:
            size = (832, 464)
            frames = self.recent(job, beauty, depth, 5, self.reference(job))
            control = 2 if self.options.get("control") == "depth" else 1
            padded = [letterbox(item[control], size) for item in frames]
            video = [image for image, _ in padded]
            masks = [Image.new("L", size)] * len(video)
            reference = frames[0][3] or frames[0][1]
            result = self.pipe(
                prompt=prompt, negative_prompt=style["negative"], video=video, mask=masks,
                reference_images=[letterbox(reference, size)[0]], conditioning_scale=self.options["controlScale"],
                width=size[0], height=size[1], num_frames=len(video), guidance_scale=4.5,
                num_inference_steps=self.options["steps"], output_type="pil", generator=generator,
            ).frames[0][-1].crop(padded[-1][1])
        compose(beauty, result, objects, material).save(job["output"], format="PNG")


def reply(**value):
    print("CITYNAV " + json.dumps(value), flush=True)


if __name__ == "__main__":
    method, runtime, qwen, config = sys.argv[1:]
    runner = Runner(method, Path(runtime), Path(qwen), Path(config))
    reply(ready=True)
    for line in sys.stdin:
        job = json.loads(line)
        started = time.perf_counter()
        try:
            runner.run(job)
            reply(id=job["id"], ms=(time.perf_counter() - started) * 1000)
        except Exception as error:
            traceback.print_exc()
            reply(id=job["id"], error=str(error))
