#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh

world="$CITYNAV_EDEN_ROOT/world"
mkdir -p "$world" "$CITYNAV_EDEN_ROOT/tmp/omni_pre"
if [ ! -x "$EDEN_PY" ] || [ ! -d "$CITYNAV_EDEN_ROOT/visual/python" ]; then
  >&2 echo "Run tools/eden/prepare.sh env and tools/visual/prepare-generative.sh qwen-image first."
  exit 1
fi

checkout() {
  local url="$1" target="$2" revision="$3"
  if [ ! -d "$target/.git" ]; then
    if [ -f "$target/.citynav-source-revision" ] && [ "$(cat "$target/.citynav-source-revision")" = "$revision" ]; then
      return
    fi
    git init --quiet "$target"
    git -C "$target" remote add origin "$url"
  fi
  if [ "$(git -C "$target" rev-parse --verify HEAD 2>/dev/null || true)" != "$revision" ]; then
    git -C "$target" fetch --depth 1 origin "$revision"
    git -C "$target" checkout --quiet --detach FETCH_HEAD
  fi
  printf '%s\n' "$revision" > "$target/.citynav-source-revision"
}

checkout https://github.com/Enderfga/SolarRenderer.git "$world/SolarRenderer" 0ca4f5e45b062cc9e9aee506de46aabdc22e4c3d
checkout https://github.com/inclusionAI/CodeWorldModel.git "$world/CodeWorldModel" 88fc349a260b691214e932cb37f6a080e07fb1ff

uv pip install --python "$EDEN_PY" --target "$world/solar-python" --no-deps \
  accelerate==1.14.0 diffusers==0.40.0 imageio==2.37.4 imageio-ffmpeg==0.6.0 \
  peft==0.20.0 tokenizers==0.22.2 transformers==5.14.1
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"
export HF_HUB_DOWNLOAD_TIMEOUT="${HF_HUB_DOWNLOAD_TIMEOUT:-180}"
export PYTHONPATH="$world/solar-python:$CITYNAV_EDEN_ROOT/visual/python:$PYTHONPATH"
exec "$EDEN_PY" tools/world/prepare.py "$@"
