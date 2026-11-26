"""Local reference editing and persistent EdenLive reference conditioning."""
import argparse
import json
from pathlib import Path
import sys
import time
import traceback

import numpy as np
from PIL import Image
import torch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
torch.set_num_threads(4)
torch.backends.cudnn.benchmark = False


class ReferenceEditor:
    def __init__(self, weights):
        from diffusers import QwenImage21Pipeline

        self.pipe = QwenImage21Pipeline.from_pretrained(weights, dtype=torch.bfloat16, local_files_only=True).to("cuda")
        self.pipe.set_progress_bar_config(disable=True)

    @torch.inference_mode()
    def run(self, job):
        source = Image.open(job["proxy"]).convert("RGB")
        width, height = source.size if source.width >= 1280 else (1280, 704)
        prompt = (
            "Render a completely new finished image from this simulator layout guide. Use the camera "
            "perspective and positions of each object, and build finished realistic objects at those positions. "
            "Replace blocky car and van proxies with full-bodied real vehicles of the corresponding type: "
            "shaped hood and windshield, curved body panels, door seams, wing mirrors, proper tire tread and rims. "
            "Replace simplified figures and props with their fully realized counterparts. Style the whole scene. "
            f"Requested style: {job['style']}\n"
            "Keep the low camera angle, framing, road layout, crossing lines, road-user positions and heading, "
            "and the red or green aspect of each traffic signal. Keep drivable space clear. No HUD or lettering."
        )
        if job.get("environment"):
            prompt = (
                "Photograph this exact empty urban environment from the same camera pose. Preserve the positions and "
                "shapes of the painted roads, kerbs, crosswalk, grass, buildings and posts. Use high-resolution "
                "believable materials, natural exposure and camera optics. Keep the streets and sidewalks entirely empty "
                "of traffic, people, bicycles and robots. Keep the layout from this guide. No HUD or lettering. "
                f"User lighting and material style: {job['style']}"
            )
        frame = self.pipe(
            prompt=prompt, image=source, width=width, height=height, num_inference_steps=32,
            generator=torch.Generator("cuda").manual_seed(job["seed"]),
        ).images[0]
        frame.convert("RGB").save(job["output"])


class EdenReference:
    def __init__(self, root, profile):
        from services.eden.worker import AdaEden

        settings = json.loads((REPO / "services/eden/profiles" / f"{profile}.json").read_text())
        self.model = AdaEden(settings, root / "upstream", root / "models/EdenLive")
        self.active = None
        self.committed_tick = None

    def pixels(self, path):
        with Image.open(path) as image:
            return np.asarray(image.convert("RGB").resize((self.model.width, self.model.height)))

    def run(self, job):
        current = self.pixels(job["proxy"])
        previous = self.pixels(job["previous"])
        anchor = None
        if self.active != job["session"] or self.committed_tick != job["previousTick"]:
            anchor = self.pixels(job["reference"]).copy()
        condition = np.stack([previous, current, current])
        prompt = (
            "Continuous footage from the supplied camera path. Preserve the appearance of the opening "
            "reference throughout. Follow the current structure frames for camera movement, road layout, "
            f"positions of the moving objects and traffic-signal aspects. {job['style']}"
        )
        output, _ = self.model.generate(condition, anchor, prompt, job["seed"])
        # The proxy DINO controls map to frames 0, 4 and 8. The continued chunk
        # decodes three additional tail frames that never leave this adapter.
        image = Image.fromarray(output[8]).resize((1280, 704), Image.Resampling.LANCZOS)
        image.save(job["output"])
        self.active, self.committed_tick = job["session"], job["tick"]


def reply(**fields):
    print("CITYNAV " + json.dumps(fields), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=["editor", "eden"])
    parser.add_argument("runtime", type=Path)
    parser.add_argument("qwen", type=Path)
    parser.add_argument("--profile", default="ada-640x352-24")
    args = parser.parse_args()
    runner = ReferenceEditor(args.qwen) if args.role == "editor" else EdenReference(args.runtime, args.profile)
    reply(ready=True)
    for line in sys.stdin:
        job = json.loads(line)
        begun = time.perf_counter()
        try:
            runner.run(job)
            reply(id=job["id"], ms=(time.perf_counter() - begun) * 1000)
        except Exception as error:
            traceback.print_exc()
            reply(id=job["id"], error=str(error))
