"""Keep a Cosmos3 depth-conditioned rollout open across CityNav steps."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import traceback

import numpy as np
from PIL import Image

from cosmos_codec import install_lighttae

if __name__ == "__mp_main__" and os.environ.get("CITYNAV_COSMOS_LIGHTTAE"):
    install_lighttae(os.environ["CITYNAV_COSMOS_LIGHTTAE"], os.environ["CITYNAV_COSMOS_EDEN_SOURCE"])


class CosmosWorld:
    def __init__(self, model, deploy, resolution, hint):
        from vllm_omni.entrypoints.omni import Omni
        from vllm_omni.inputs.data import OmniDiffusionSamplingParams

        self.engine = Omni(model=str(model.resolve()), model_class_name="Cosmos3NanoSimTransferPipeline",
                           deploy_config=str(deploy.resolve()))
        self.parameters = OmniDiffusionSamplingParams
        self.resolution = resolution
        self.hint = hint
        self.session = None

    def render(self, job):
        opening = job.get("opening") is True
        if not opening and (job["session"] != self.session or job["previousTick"] != self.tick):
            raise ValueError("The Cosmos3 rollout no longer has this CityNav session and previous tick")
        with Image.open(job["depth"] if self.hint == "depth" else job["control"]) as image:
            control = np.asarray(image.convert("RGB"))
        frames = np.stack([control if opening else self.previous_control, control, control, control, control])
        params = self.parameters(num_frames=5, frame_rate=24, guidance_scale=1.0, num_inference_steps=4,
                                 seed=job["seed"], output_type="np", extra_args={
                                     "citynav_live": True,
                                     "session_id": job["session"],
                                     "reset": opening,
                                     "control_hint": self.hint,
                                     "control_video": frames,
                                     "resolution": self.resolution,
                                     "aspect_ratio": "16,9",
                                     "kv_cache_inference_size": 12,
                                     "attention_sink_size": 2,
                                     "emphasize_control_in_prompt": False,
                                 })
        prompt = (
            f"{job['style']}. Photoreal low robot camera. Preserve the simulator's roads, buildings, open areas, "
            "positions of vehicles, people, crossings and poles. Maintain the same materials and lighting."
        )
        output = self.engine.generate({"prompt": prompt}, params, use_tqdm=False)[0].images[0]
        video = np.asarray(output)
        while video.ndim > 4 and video.shape[0] == 1:
            video = video[0]
        expected = 5 if opening else 4
        if video.ndim != 4 or video.shape[0] != expected or video.shape[-1] != 3:
            raise ValueError(f"Expected {expected} RGB frames, received {video.shape}")
        pixels = video[-1]
        if pixels.dtype != np.uint8:
            pixels = np.rint(np.clip(pixels, 0, 1) * 255).astype(np.uint8)
        Image.fromarray(pixels).save(job["output"])
        self.session, self.tick, self.previous_control = job["session"], job["tick"], control


def reply(**values):
    print("CITYNAV " + json.dumps(values), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("--deploy", type=Path, default=Path(__file__).with_name("cosmos-transfer.yaml"))
    parser.add_argument("--resolution", choices=("256", "480", "704"), default="480")
    parser.add_argument("--hint", choices=("depth", "blur"), default="depth",
                        help="Type of precomputed control supplied in each request")
    args = parser.parse_args()
    if project_tmp := os.environ.get("TMPDIR"):
        os.environ.setdefault("VLLM_RPC_BASE_PATH", os.path.relpath(project_tmp))
    world = CosmosWorld(args.model, args.deploy, args.resolution, args.hint)
    reply(ready=True)
    try:
        for line in sys.stdin:
            job = json.loads(line)
            start = time.perf_counter()
            try:
                world.render(job)
                reply(id=job["id"], ms=(time.perf_counter()-start)*1000)
            except (RuntimeError, OSError, ValueError) as error:
                traceback.print_exc()
                reply(id=job["id"], error=str(error))
    finally:
        world.engine.close()
