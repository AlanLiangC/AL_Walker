"""Crop the CC BY Artillery Passage SOG textures to CityNav's playable segment.

Input is the unpacked chunk folders 0_0 through 0_4 from splat-walk's public scene.
Requires NumPy and Pillow. Output preserves the source's quantization and SH3.
"""
import argparse
from io import BytesIO
import json
from pathlib import Path
from zipfile import ZipFile

import numpy as np
from PIL import Image

MAPS = ("means", "scales", "quats", "sh0", "shN")


def unpack_pixels(path, count):
    return np.asarray(Image.open(path).convert("RGBA")).reshape(-1, 4)[:count]


def pack_chunk(source, target, seed):
    meta = json.loads((source / "meta.json").read_text())
    full_count = meta["count"]
    means = meta["means"]
    low, high = (unpack_pixels(source / filename, full_count) for filename in means["files"])
    quantized = low[:, :3].astype(np.uint16) + 256 * high[:, :3].astype(np.uint16)
    minimum, maximum = np.asarray(means["mins"]), np.asarray(means["maxs"])
    log_position = minimum + (maximum - minimum) * (quantized / 65535)
    x, y, z = (np.sign(log_position) * np.expm1(np.abs(log_position))).T
    alpha = unpack_pixels(source / "sh0.webp", full_count)[:, 3]
    inside = (x > -7) & (x < 12) & (y > -17) & (y < 1.3) & (z > -36) & (z < 20)
    # Preserve the ground and storefront along the path at full density.
    near = (x > -.6) & (x < 5.6) & (y > -3.9) & (z > -33) & (z < 5)
    far_end = z > 6
    probability = np.where(near, 1., np.where(far_end, .27, .58))
    probability *= np.clip(alpha.astype(np.float32)/85, .15, 1.)
    indices = np.flatnonzero(inside & (alpha >= 27) & (np.random.default_rng(seed).random(full_count) < probability))
    if not len(indices):
        return
    meta["count"] = len(indices)
    width = 1024
    height = (len(indices) + width - 1) // width
    temporary = target.with_suffix(".sog.part")
    try:
        with ZipFile(temporary, "w") as archive:
            archive.writestr("meta.json", json.dumps(meta, separators=(",", ":")))
            for map_name in MAPS:
                for filename in meta[map_name]["files"]:
                    path = source / filename
                    if filename == "shN_centroids.webp":
                        archive.write(path, filename)
                        continue
                    pixels = np.zeros((height * width, 4), dtype=np.uint8)
                    pixels[:len(indices)] = unpack_pixels(path, full_count)[indices]
                    raw = BytesIO()
                    Image.fromarray(pixels.reshape(height, width, 4)).save(
                        raw, "WEBP", exact=True, lossless=True, method=4
                    )
                    archive.writestr(filename, raw.getvalue())
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(target, len(indices), target.stat().st_size, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for i, source in enumerate(sorted(args.source.glob("0_*"))):
        pack_chunk(source, args.output / f"artillery-{i}.sog", seed=5230 + i)
