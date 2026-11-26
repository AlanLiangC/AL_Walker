"""Measure installed renderers on the same CityNav observations and calibrated camera path."""
import argparse
import json
import math
import os
from pathlib import Path
from statistics import median
import sys
import time

import numpy as np
from PIL import Image
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def load_regen(runtime, args, truth):
    from services.eden.regen import Regen

    model = Regen(truth, runtime / "regen-native", runtime / "models/regen" / f"{args.regen_style}.pth")

    def render(rgb, _row, _filename):
        return model.pixels(rgb), {}

    return render


def load_edge_turbo(runtime, args, _truth):
    from services.eden.alternatives import EdgeTurbo

    model = EdgeTurbo(runtime)

    def render(rgb, _row, filename):
        labels = None
        if args.label_edges:
            with Image.open(args.layout / "labels" / filename) as label_image:
                labels = np.asarray(label_image)
        return model.render(rgb, labels, args.style, args.seed), {}

    return render


def load_sharp(runtime, args, truth):
    from services.eden.alternatives import Sharp, sharp_composite

    model = Sharp(runtime)
    from sharp.utils.gaussians import save_ply

    if args.reference is None:
        raise ValueError("SHARP requires a reference image from the opening CityNav camera")
    width, height = truth["width"], truth["height"]
    first = truth["frames"][0]["calibration"]
    with Image.open(args.reference) as image:
        reference = np.asarray(image.convert("RGB").resize((width, height), Image.Resampling.LANCZOS))
    focal = first["intrinsics"][0][0]
    started = time.perf_counter()
    scene = model.predict(reference, first)
    splats, _ = scene
    torch.cuda.synchronize()
    prediction_ms = (time.perf_counter()-started)*1000
    print(f"SHARP predicted {splats.mean_vectors.shape[1]:,} splats in {prediction_ms:.0f} ms", flush=True)
    save_ply(splats, focal, (height, width), args.output / "reference.ply")

    def render(_rgb, row, filename):
        pixels, covered = model.render(scene, row["calibration"], width, height)
        if args.foreground:
            with Image.open(args.layout / "labels" / filename) as image:
                labels = np.asarray(image)
            with Image.open(args.foreground / filename) as image:
                current = torch.as_tensor(np.array(image.convert("RGB")), device="cuda") / 255
            pixels = sharp_composite(pixels, covered, labels, current)
        return pixels, {
            "coverage": covered.float().mean().item(),
            "translationMetres": math.dist(row["camera"]["eye"], truth["frames"][0]["camera"]["eye"]),
        }

    render.prediction_ms = prediction_ms
    return render


def benchmark(args):
    runtime = Path(os.environ["CITYNAV_EDEN_ROOT"]) / "world/alternatives"
    truth = json.loads((args.layout / "truth.json").read_text())
    loaders = {"regen": load_regen, "edge-turbo": load_edge_turbo, "sharp": load_sharp}
    args.output.mkdir(parents=True, exist_ok=True)
    rows = []
    torch.backends.cudnn.allow_tf32 = True
    torch.backends.cuda.matmul.allow_tf32 = True
    with torch.inference_mode():
        started = time.perf_counter()
        render = loaders[args.method](runtime, args, truth)
        load_ms = (time.perf_counter()-started)*1000
        frames = truth["frames"][::args.stride]
        if args.frames:
            frames = frames[:args.frames]
        for row in frames:
            filename = f"{row['frame']:06}.png"
            with Image.open(args.layout / "rgb" / filename) as image:
                rgb = np.array(image.convert("RGB"))
            if not rows:
                print(f"Warming {args.method}", flush=True)
                for _ in range(4):
                    render(rgb, row, filename)
                torch.cuda.synchronize()
            started = time.perf_counter()
            pixels, extra = render(rgb, row, filename)
            rgb = (pixels.clamp(0, 1)*255).round().byte().cpu().numpy()
            rows.append({"frame": row["frame"], "tick": row["tick"],
                         "renderMs": (time.perf_counter()-started)*1000, **extra})
            Image.fromarray(rgb).save(args.output / filename, compress_level=1)
    times = [row["renderMs"] for row in rows]
    report = {"method":args.method, "width":truth["width"], "height":truth["height"],
              "camera":truth["view"], "frames":len(rows), "loadMs":load_ms,
              "medianMs":median(times), "p95Ms":float(np.percentile(times, 95)), "framesPerSecond":1000/(sum(times)/len(times)),
              "gpu":torch.cuda.get_device_name(), "rows":rows}
    if args.method == "sharp":
        report["scenePredictionMs"] = render.prediction_ms
        report["compositedForeground"] = args.foreground is not None
    (args.output / "metrics.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key:value for key,value in report.items() if key != "rows"}, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--method", choices=("regen", "edge-turbo", "sharp"), required=True)
    parser.add_argument("--layout", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--foreground", type=Path, help="Use per-frame RGB with SHARP and a static reference")
    parser.add_argument("--style", default="Real documentary photograph from a low sidewalk camera, cloudy daylight, detailed pavement and realistic vehicles")
    parser.add_argument("--regen-style", choices=("cityscapes", "flux"), default="cityscapes")
    parser.add_argument("--frames", type=int)
    parser.add_argument("--stride", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--label-edges", action="store_true")
    benchmark(parser.parse_args())
