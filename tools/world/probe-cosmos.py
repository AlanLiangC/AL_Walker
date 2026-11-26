"""Benchmark Cosmos3 Sim-Transfer on a CityNav control clip using its native rollout."""
import argparse
from collections.abc import Mapping
import hashlib
import json
import os
from pathlib import Path
import time
from uuid import uuid4

from cosmos_codec import install_lighttae


if __name__ == "__mp_main__" and os.environ.get("CITYNAV_COSMOS_LIGHTTAE"):
    install_lighttae(os.environ["CITYNAV_COSMOS_LIGHTTAE"], os.environ["CITYNAV_COSMOS_EDEN_SOURCE"])


def run(args):
    if project_tmp := os.environ.get("TMPDIR"):
        os.environ.setdefault("VLLM_RPC_BASE_PATH", os.path.relpath(project_tmp))
    if args.lighttae:
        os.environ["CITYNAV_COSMOS_LIGHTTAE"] = str(args.lighttae.resolve())
        os.environ["CITYNAV_COSMOS_EDEN_SOURCE"] = str(args.eden_source.resolve())
    import av
    from diffusers.utils import export_to_video
    import numpy as np
    from vllm_omni.entrypoints.omni import Omni
    from vllm_omni.inputs.data import OmniDiffusionSamplingParams

    with av.open(str(args.depth)) as control:
        fps = float(control.streams.video[0].average_rate)
    params = OmniDiffusionSamplingParams(
        num_frames=args.frames, num_inference_steps=4, frame_rate=fps, guidance_scale=1.0,
        seed=args.seed, output_type="np", extra_args={
            "session_id": uuid4().hex,
            "reset": True,
            "close_session": True,
            "depth": {"control_path": str(args.depth.resolve())},
            "resolution": args.resolution,
            "kv_cache_inference_size": 12,
            "attention_sink_size": 2,
            "emphasize_control_in_prompt": False,
        },
    )
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    omni = Omni(model=str(args.model.resolve()), model_class_name="Cosmos3NanoSimTransferPipeline",
                deploy_config=str(args.deploy.resolve()))
    initialized = time.perf_counter()
    try:
        results = omni.generate({"prompt": args.prompt}, params)
        elapsed = time.perf_counter() - initialized
        video = results[0].images[0]
        if isinstance(video, Mapping):
            video = video["video"]
        video = np.asarray(video)
        while video.ndim > 4 and video.shape[0] == 1:
            video = video[0]
    finally:
        omni.close()
    if video.ndim != 4 or len(video) != args.frames:
        raise ValueError(f"Expected {args.frames} RGB frames, got {video.shape}")
    export_to_video(video, str(args.output / "render.mp4"), fps=fps)
    with args.depth.open("rb") as control:
        digest = hashlib.file_digest(control, "sha256").hexdigest()
    report = dict(frames=len(video), depthSha256=digest, seed=args.seed, prompt=args.prompt,
                  controlFps=fps, resolution=args.resolution, initSeconds=initialized-started,
                  renderSeconds=elapsed, renderedFps=len(video)/elapsed, decoder="LightTAE" if args.lighttae else "WanVAE")
    (args.output / "metrics.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--deploy", type=Path, default=Path(__file__).with_name("cosmos-transfer.yaml"))
    parser.add_argument("--depth", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--frames", type=int, default=65)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--resolution", default="480")
    parser.add_argument("--lighttae", type=Path)
    parser.add_argument("--eden-source", type=Path)
    parser.add_argument("--prompt", default="Photoreal documentary footage from a low street robot camera after rain. "
                        "Natural human-scale cars and delivery vans, wet asphalt, a gray stone sidewalk, "
                        "and cloudy diffuse daylight. Preserve the exact depth and motion of the CityNav scene.")
    options = parser.parse_args()
    if options.lighttae and not options.eden_source:
        parser.error("--lighttae requires --eden-source")
    run(options)
