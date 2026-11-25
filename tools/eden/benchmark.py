"""Benchmark the upstream 5B streaming sampler on its recorded sample."""
import argparse
import csv
import json
from pathlib import Path
import time

import av
import numpy as np
from PIL import Image, ImageOps

from services.eden.server import load_profile
from services.eden.worker import initialize, generate, warm, reset


def sample_frames(path, width, height):
    with av.open(str(path)) as container:
        for frame in container.decode(video=0):
            image = frame.to_image()
            yield np.array(ImageOps.fit(image, (width, height), Image.Resampling.BILINEAR))


def run(args):
    profile = load_profile(args.profile)
    width, height = profile["width"], profile["height"]
    base = args.source / "examples" / "samples"
    with (base / "manifest.csv").open() as file:
        sample = next(row for row in csv.DictReader(file) if row["id"] == args.sample)
    prompt = sample["prompt"]
    with Image.open(base / sample["first_frame"]) as image:
        reference = np.array(ImageOps.fit(image.convert("RGB"), (width, height), Image.Resampling.BILINEAR))
    args.output.mkdir(parents=True, exist_ok=True)
    config = {"profile": profile, "sample": args.sample, "gpu": args.gpu, "seed": args.seed, "prompt": prompt}
    report = {**config, "chunks": []}
    report_path = args.output / ("benchmark-" + args.profile + ".json")
    begun = time.perf_counter()
    initialize(args.gpu, profile, args.source, args.weights)
    report["loadSeconds"] = time.perf_counter()-begun
    report["prewarm"] = warm() if not args.skip_prewarm else None
    reset()
    frames = sample_frames(base / sample["proxy_video"], width, height)
    output_path = args.output / ("upstream-" + args.profile + ".mp4")
    begin = time.perf_counter()
    with av.open(str(output_path), mode="w") as output:
        stream = output.add_stream("libx264", rate=24)
        stream.width, stream.height, stream.pix_fmt = width*2, height, "yuv420p"
        stream.options = {"preset":"veryfast","crf":"18"}
        for chunk in range(args.chunks):
            count = 9 if not chunk else 12
            batch = []
            for _ in range(count):
                if (frame := next(frames, None)) is not None:
                    batch.append(frame)
            if len(batch) < count:
                break
            output_frames, stats = generate(np.stack(batch[::4]), reference if not chunk else None, prompt, args.seed)
            if not chunk:
                report["firstChunkMs"] = (time.perf_counter()-begin)*1000
            report["chunks"].append({"index":chunk,"frames":len(output_frames),**stats})
            for left,right in zip(batch,output_frames,strict=True):
                packed = np.concatenate([left,right],axis=1)
                for packet in stream.encode(av.VideoFrame.from_ndarray(packed,format="rgb24")):
                    output.mux(packet)
            print(json.dumps(report["chunks"][-1]),flush=True)
        for packet in stream.encode():
            output.mux(packet)
    report["frames"] = sum(c["frames"] for c in report["chunks"])
    steady = report["chunks"][1:]
    report["steadyFps"] = sum(c["frames"] for c in steady)*1000 / sum(c["workerMs"] for c in steady) if steady else None
    report["peakMiB"] = max(c["gpuPeakMiB"] for c in report["chunks"])
    report["video"] = output_path.name
    report_path.write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!="chunks"},ensure_ascii=False),flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile",required=True)
    parser.add_argument("--gpu",required=True)
    parser.add_argument("--source",type=Path,required=True)
    parser.add_argument("--weights",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--sample",default="cryo-crossing",choices=("cryo-crossing","pulse-skirmish"))
    parser.add_argument("--chunks",type=int,default=10)
    parser.add_argument("--seed",type=int,default=2026092901)
    parser.add_argument("--skip-prewarm",action="store_true")
    run(parser.parse_args())
