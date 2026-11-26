"""Render CityNav step observations with the installed Edge Turbo or SHARP models."""
import argparse
import json
from pathlib import Path
import sys
import time

import numpy as np
from PIL import Image
import torch

from services.eden.alternatives import EdgeTurbo, Sharp, sharp_composite
from services.eden.regen import Regen


def read_image(path, mode, size=None):
    with Image.open(path) as image:
        color = image.convert(mode)
        if size and color.size != size:
            color = color.resize(size, Image.Resampling.LANCZOS)
        return np.array(color)


def reply(**values):
    print("CITYNAV " + json.dumps(values), flush=True)


def main(method, runtime):
    torch.set_num_threads(4)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    model = EdgeTurbo(runtime) if method == "edge-turbo" else Sharp(runtime)
    foreground = None
    scene = None
    scene_id = None
    reply(ready=True)
    with torch.inference_mode():
        for line in sys.stdin:
            job = json.loads(line)
            started = time.perf_counter()
            try:
                rgb = read_image(job["proxy"], "RGB")
                labels = read_image(job["labels"], "L")
                if method == "edge-turbo":
                    pixels = model.render(rgb, labels, job["style"], job["seed"])
                else:
                    height, width = rgb.shape[:2]
                    if scene_id != job["session"]:
                        anchor = read_image(job["sceneReference"], "RGB", (width, height))
                        calibration = json.loads(Path(job["anchorCalibration"]).read_text())
                        scene = model.predict(anchor, calibration)
                        scene_id = job["session"]
                    if foreground is None:
                        foreground = Regen({"width":width, "height":height}, runtime / "regen-native",
                                           runtime / "models/regen/flux.pth")
                    pixels, covered = model.render(scene, job["calibration"], width, height)
                    pixels = sharp_composite(pixels, covered, labels, foreground.pixels(rgb))
                output = (pixels.clamp(0, 1)*255).round().byte().cpu().numpy()
                Image.fromarray(output).save(job["output"], compress_level=1)
                reply(id=job["id"], ms=(time.perf_counter()-started)*1000)
            except (OSError, ValueError, RuntimeError, KeyError) as error:
                reply(id=job["id"], error=str(error))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("method", choices=("edge-turbo", "sharp"))
    parser.add_argument("runtime", type=Path)
    args = parser.parse_args()
    main(args.method, args.runtime)
