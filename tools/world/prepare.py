"""Stage the SolarRenderer model from shared H3 weights and verified local repairs."""
import argparse
from hashlib import file_digest
import json
import os
from pathlib import Path
import subprocess
import sys

from huggingface_hub import HfApi, snapshot_download


H3 = "MiniMaxAI/MiniMax-H3"
H3_REVISION = "12253298adb81e36757eabebb81d2ba1c0cc70cc"
SOLAR = "Enderfga/SolarRenderer"
SOLAR_REVISION = "c5512be825f297ed8db390cbeda0289fb0c24779"
ASSETS = ("transformer_ref/", "text_encoder/", "vae/", "audio_vae/", "processor/", "tokenizer/",
          "audio_scheduler/", "scheduler/", "modular_model_index.json", "LICENSE")


def checksum(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def stage(root, public, download):
    source = public / "MiniMax-H3"
    target = root / "models/h3"
    target.mkdir(parents=True, exist_ok=True)
    info = HfApi().model_info(H3, revision=H3_REVISION, files_metadata=True)
    missing, borrowed, repaired = [], [], []
    for item in info.siblings:
        name = item.rfilename
        if not name.startswith(ASSETS):
            continue
        shared, local = source / name, target / name
        if name == "modular_model_index.json":
            if shared.is_file() and shared.stat().st_size == item.size:
                local.write_bytes(shared.read_bytes())
            elif not local.is_file():
                missing.append(name)
            continue
        if (local.is_file() and not local.is_symlink() and local.stat().st_size == item.size
                and (not item.lfs or checksum(local) == item.lfs.sha256)):
            repaired.append(name)
        elif (shared.is_file() and shared.stat().st_size == item.size
              and (not item.lfs or not Path(str(shared) + ".aria2").exists()
                   or checksum(shared) == item.lfs.sha256)):
            local.parent.mkdir(parents=True, exist_ok=True)
            if local.is_symlink() and local.resolve() != shared:
                local.unlink()
            if not local.exists():
                local.symlink_to(shared)
            borrowed.append(name)
        else:
            missing.append(name)
    if missing and download:
        for name in missing:
            local = target / name
            if local.is_symlink():
                local.unlink()
        snapshot_download(H3, revision=H3_REVISION, local_dir=target, allow_patterns=missing, max_workers=3)
        return stage(root, public, False)
    if missing:
        raise RuntimeError("H3 shards need repair: " + ", ".join(missing))
    subprocess.run([sys.executable, str(root / "SolarRenderer/scripts/prepare_h3.py"), "--skip-download",
                    "--dir", str(target)], check=True)
    (target / "ready.json").write_text(json.dumps({
        "revision": H3_REVISION, "public": str(source), "borrowed": borrowed, "repaired": repaired,
    }, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="fetch only absent or unverified shards plus Solar LoRAs")
    args = parser.parse_args()
    root = Path(os.environ["CITYNAV_EDEN_ROOT"]) / "world"
    public = Path(os.getenv("CITYNAV_PUBLIC_MODELS", "/inspire/hdd/global_public/public_models")).resolve()
    stage(root, public, args.download)
    if args.download:
        snapshot_download(SOLAR, revision=SOLAR_REVISION, local_dir=root / "models/solar",
                          allow_patterns=["config.json", "LICENSE", "NOTICE", "solarrenderer_causal_*"], max_workers=2)
