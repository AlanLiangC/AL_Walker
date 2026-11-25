"""Replay one EdenLive autoregressive configuration against a recorded RGB input."""
import argparse
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import sys
import time

import av
import numpy as np
from PIL import Image

from services.eden.server import load_profile
from services.eden.worker import AdaEden


def run(args):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    profile = load_profile(args.profile)
    width, height = profile["width"], profile["height"]
    resolution = (width, height)
    args.output.mkdir(parents=True, exist_ok=True)
    metadata = json.loads((args.recording / "prompts.json").read_text())
    if args.prompt:
        metadata["staticPrompt"] = args.prompt
    sys.path.insert(0, str(args.source.resolve()))
    from edenlive.data.recording_manifest import prompt_schedule

    schedule = prompt_schedule(metadata, args.frames, dynamic=args.events)
    source = args.recording / "recording.mp4"
    anchor_path = args.recording / args.anchor
    with Image.open(anchor_path) as image:
        anchor = np.array(image.convert("RGB").resize(resolution, Image.Resampling.LANCZOS))
    start = time.perf_counter()
    worker = AdaEden(profile, args.source.resolve(), args.weights.resolve())
    init_seconds = time.perf_counter() - start
    print(f"Model ready in {init_seconds:.1f}s", flush=True)
    chunks = []
    start = time.perf_counter()
    with av.open(str(source)) as original, av.open(str(args.output / "render.mp4"), "w") as output:
        inputs = original.decode(video=0)
        stream = output.add_stream("libx264", rate=24)
        stream.width, stream.height = resolution
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": "14", "preset": "fast"}
        for index, item in enumerate(schedule):
            count = 9 if index == 0 else 12
            clip = list(islice(inputs, count))
            if len(clip) != count:
                raise ValueError(f"Expected {count} condition frames at chunk {index}")
            controls = np.stack([frame.reformat(width=width, height=height, format="rgb24").to_ndarray()
                                 for frame in clip[::4]])
            begun = time.perf_counter()
            frames, stages = worker.generate(controls, anchor if index == 0 else None, item["prompt"], args.seed)
            elapsed = time.perf_counter() - begun
            for pixels in frames:
                for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
                    output.mux(packet)
            chunks.append({"index": index, "frames": len(frames), "inferenceMs": elapsed * 1000, **stages, **item})
            if index % 5 == 0:
                print(f"Chunk {index + 1}/{len(schedule)}  {elapsed:.2f}s", flush=True)
        for packet in stream.encode():
            output.mux(packet)
    elapsed = time.perf_counter() - start
    frames = sum(row["frames"] for row in chunks)
    with source.open("rb") as file:
        input_hash = hashlib.file_digest(file, "sha256").hexdigest()
    with anchor_path.open("rb") as file:
        anchor_hash = hashlib.file_digest(file, "sha256").hexdigest()
    result = {
        "profile": args.profile, "decoder": profile["decoder"], "width": width, "height": height,
        "frames": frames, "sourceFps": 24, "seed": args.seed, "anchor": args.anchor, "events": args.events,
        "inputSha256": input_hash, "anchorSha256": anchor_hash,
        "initSeconds": init_seconds, "loopSeconds": elapsed, "loopFps": frames / elapsed,
        "inferenceFps": frames * 1000 / sum(row["inferenceMs"] for row in chunks),
        "gpuPeakMiB": max(row["gpuPeakMiB"] for row in chunks), "chunks": chunks,
    }
    (args.output / "metrics.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"{frames} frames in {elapsed:.2f}s ({frames / elapsed:.2f} FPS including I/O)", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recording", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile", default="ada-720p")
    parser.add_argument("--anchor", default="cover.png")
    parser.add_argument("--prompt")
    parser.add_argument("--events", action="store_true")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--frames", type=int, default=477)
    args = parser.parse_args()
    if args.frames < 9 or (args.frames - 9) % 12:
        parser.error("--frames must be 9 + a multiple of 12")
    run(args)
