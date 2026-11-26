"""Fetch versioned diffusion weights inside the CityNav project runtime."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from fnmatch import fnmatch
from itertools import zip_longest
import os
from pathlib import Path
import sys
from urllib.parse import quote

from huggingface_hub import HfApi, snapshot_download
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eden"))
from download import RangedFile


metadata = ["*.json", "*.txt", "*.model", "LICENSE*", "NOTICE"]
weights = {
    "difix": [("difix", "nvidia/difix", "2b0c6fb5797c26b01154dfdeb19d36e5e2eaf388", ["*.safetensors"])],
    "sdxl-depth": [
        ("sdxl", "stabilityai/stable-diffusion-xl-base-1.0", "462165984030d82259a11f4367a4eed129e94a7b",
         ["text_encoder/*.fp16.safetensors", "text_encoder_2/*.fp16.safetensors",
          "unet/*.fp16.safetensors", "vae/*.fp16.safetensors"]),
        ("sdxl-depth", "diffusers/controlnet-depth-sdxl-1.0-small", "daf3835d036574dff7c158882e8e77b75b024ee5",
         ["*.fp16.safetensors"]),
    ],
    "wan-vace": [("wan-vace", "Wan-AI/Wan2.1-VACE-1.3B-diffusers", "ec4d2cb062b548996b179d493fdd05340de702a1",
                  ["transformer/*.safetensors", "vae/*.safetensors"])],
}


def prepare(spec):
    name, model, revision, patterns = spec
    root = Path(os.environ["CITYNAV_EDEN_ROOT"]) / "models/visual"
    files_to_fetch = metadata + ["vae/autoencoder_kl.py"] if name == "difix" else metadata
    snapshot_download(model, revision=revision, local_dir=root / name,
                      allow_patterns=files_to_fetch, max_workers=4)
    files = HfApi().model_info(model, revision=revision, files_metadata=True).siblings
    mirrors = {}
    if name in {"sdxl", "wan-vace"} and not os.getenv("CITYNAV_VISUAL_HF_ONLY"):
        try:
            response = requests.get(f"https://modelscope.cn/api/v1/models/{model}/repo/files",
                                    params={"Revision": "master", "Recursive": "true"}, timeout=8)
            response.raise_for_status()
            mirrors = {f["Path"]: f.get("Sha256") for f in (response.json().get("Data") or {}).get("Files", [])}
        except (requests.RequestException, ValueError):
            pass
    return [
        RangedFile(root / name, {"path": file.rfilename, "size": file.size, "lfs": {"oid": file.lfs.sha256}},
                   "https://huggingface.co", repo=model, revision=revision,
                   download_url=f"https://modelscope.cn/models/{model}/resolve/master/{quote(file.rfilename)}"
                   if mirrors.get(file.rfilename) == file.lfs.sha256 else None)
        for file in files if file.lfs and any(fnmatch(file.rfilename, pattern) for pattern in patterns)
    ]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("method", choices=["all", "qwen-image", *weights])
    parser.add_argument("--jobs", type=int, default=48)
    args = parser.parse_args()
    specs = [model for entry in weights.values() for model in entry] if args.method == "all" else weights.get(
        args.method, [],
    )
    files = [file for spec in specs for file in prepare(spec)]
    schedules = [[(file, offset) for offset in file.setup()] for file in files]
    remaining = dict(zip(files, map(len, schedules)))
    with ThreadPoolExecutor(max_workers=args.jobs) as executor, ThreadPoolExecutor(max_workers=2) as verify:
        jobs = {executor.submit(file.fetch, offset): file for row in zip_longest(*schedules)
                for file, offset in filter(None, row)}
        verified = [verify.submit(file.finish) for file in files if not remaining[file]]
        for i, job in enumerate(as_completed(jobs), 1):
            job.result()
            file = jobs[job]
            remaining[file] -= 1
            if not remaining[file]:
                verified.append(verify.submit(file.finish))
            if i % 25 == 0:
                print(f"{i}/{len(jobs)} ranges saved", flush=True)
        for job in verified:
            job.result()
