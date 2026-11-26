"""Render identical CityNav snapshots and measure changes inside locked pixels."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

os.environ["OPENCV_IO_ENABLE_OPENEXR"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


labels = {
    "cycles": "Blender Cycles", "edenlive": "EdenLive 5B", "qwen-image": "Qwen-Image 2.1",
    "difix": "Difix3D+", "sdxl-depth": "SDXL Depth ControlNet", "wan-vace": "Wan2.1 VACE 1.3B",
}


def worker(command, jobs, log):
    with log.open("w") as output:
        process = subprocess.run(command, text=True, input="".join(json.dumps(job) + "\n" for job in jobs),
                                 stdout=output, stderr=subprocess.STDOUT, check=False)
    results = {}
    for line in log.read_text().splitlines():
        if line.startswith("CITYNAV "):
            record = json.loads(line[8:])
            if "id" in record:
                results[record["id"]] = record
    if process.returncode or len(results) != len(jobs) or any("error" in result for result in results.values()):
        raise RuntimeError(f"Render failed. See {log}")
    return results


def metrics(baseline, rendered, channels):
    mask = (channels[:, :, 0] > .5) | (channels[:, :, 1] > .5)
    lamps = channels[:, :, 1] == 2
    changed = np.any(baseline != rendered, axis=-1)
    return {"lockedPixels": int(mask.sum()), "changedLockedPixels": int((changed & mask).sum()),
            "signalLensPixels": int(lamps.sum()), "changedSignalLensPixels": int((changed & lamps).sum()),
            "changedOutsideFraction": float(changed[~mask].mean())}


def montage(folder, tick):
    tiles = [(label, folder / f"{method}.png") for method, label in labels.items()
             if (folder / f"{method}.png").is_file()]
    if not tiles:
        raise FileNotFoundError(folder)
    width, height, caption, gap = 640, 352, 36, 12
    rows = (len(tiles) + 1) // 2
    sheet = Image.new("RGB", (width * 2 + gap * 3, (height + caption + gap) * rows + gap), "#11171c")
    draw, font = ImageDraw.Draw(sheet), ImageFont.load_default(size=19)
    for index, (label, path) in enumerate(tiles):
        x, y = gap + (width + gap) * (index % 2), gap + (height + caption + gap) * (index // 2)
        draw.text((x, y + 4), f"{label}  |  tick {tick}", font=font, fill="white")
        with Image.open(path) as frame:
            sheet.paste(frame.resize((width, height), Image.Resampling.LANCZOS), (x, y + caption))
    sheet.save(folder / "comparison.png")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--capture", action="store_true", help="Bake matching Cycles RGB and EXR controls first")
    parser.add_argument("--method", choices=list(labels)[1:])
    parser.add_argument("--style", type=Path, default=Path("assets/visual/generative.json"))
    parser.add_argument("--montage", action="store_true", help="Collect completed frames into labeled image grids")
    parser.add_argument("states", nargs="+", type=Path)
    args = parser.parse_args()
    root = Path(os.environ["CITYNAV_EDEN_ROOT"])
    for name, directory in (("BLENDER_USER_RESOURCES", root / "visual/cache/blender"),
                            ("OPTIX_CACHE_PATH", root / "cache/optix")):
        directory.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(directory)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    shots = {}
    for path in args.states:
        state = json.loads(path.read_text())
        state = {"episodeId": "office-09-x05", "robotId": "go2", "seed": 59213517, **state}
        key = str(state["tick"])
        folder = out / f"tick-{key}"
        folder.mkdir(exist_ok=True)
        shots[key] = state, folder
    if args.capture:
        command = [str(root / "visual/bin/blender-4.5.17-linux-x64/blender"), "--background", "--factory-startup",
                   "--threads", "4", "--python-exit-code", "1", "--python", "tools/visual/cycles-worker.py",
                   "--", str(root / "visual/scenes/office-09/scene.json"), "assets/visual/office-day.json", "OPTIX"]
        worker(command, [{"id": key, "state": state, "output": str(folder / "cycles.png"), "controls": True}
                         for key, (state, folder) in shots.items()], out / "cycles.log")
    if args.method:
        overlay = {"qwen-image": "python", "difix": "difix-python"}.get(args.method)
        if overlay:
            python = str(root / "visual" / overlay)
            os.environ["PYTHONPATH"] = python + os.pathsep + os.environ.get("PYTHONPATH", "")
        public = Path(os.environ.get("CITYNAV_PUBLIC_MODELS", "/inspire/hdd/global_public/public_models"))
        qwen = root / "models/visual/qwen-image-21"
        if not qwen.is_dir():
            qwen = public / "Qwen-Image-2.1"
        command = [sys.executable, "-u", "tools/visual/generate-frame.py", args.method, str(root), str(qwen),
                   str(args.style)]
        jobs = [{"id": key, "tick": state["tick"], "stream": "comparison", "context": state,
                 "rgb": str(folder / "cycles.png"), "controls": str(folder / "controls-0001.exr"),
                 "output": str(folder / f"{args.method}.png")} for key, (state, folder) in shots.items()]
        results = worker(command, jobs, out / f"{args.method}.log")
        for meta, job in zip(results.values(), jobs, strict=True):
            channels = cv2.imread(job["controls"], cv2.IMREAD_UNCHANGED)
            with Image.open(job["rgb"]) as base, Image.open(job["output"]) as result:
                meta.update(metrics(np.asarray(base), np.asarray(result), channels))
        (out / f"{args.method}.json").write_text(json.dumps(list(results.values()), indent=2) + "\n")
        if any(meta["changedLockedPixels"] or meta["changedOutsideFraction"] < .01 for meta in results.values()):
            raise RuntimeError(f"Failed protected-pixel or generation check for {args.method}")
        print(args.method, list(results.values()))
    if args.montage:
        for tick, (_, folder) in shots.items():
            montage(folder, tick)
