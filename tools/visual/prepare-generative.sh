#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh

case "${1:-all}" in
  all|qwen-image)
    revision=16eb5cc4fd8262fd33b3c9119a12977c25cc4985
    target="$CITYNAV_EDEN_ROOT/visual/python"
    if [ ! -f "$target/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py" ]; then
      archive="$CITYNAV_EDEN_ROOT/tmp/qwen-diffusers-$revision.tar.gz"
      if [ ! -f "$archive" ]; then
        curl -fL --retry 3 "https://codeload.github.com/huggingface/diffusers/tar.gz/$revision" -o "$archive.partial"
        mv -- "$archive.partial" "$archive"
      fi
      uv pip install --python "$EDEN_PY" --target "$target" "transformers==5.17.0" "$archive"
    fi
    ;;
esac
case "${1:-all}" in
  all|difix)
    revision=c76edc595586e16732c91ddee82f3a6d83a8a9cc
    target="$CITYNAV_EDEN_ROOT/visual/difix-source"
    if [ ! -d "$CITYNAV_EDEN_ROOT/visual/difix-python/peft" ]; then
      uv pip install --python "$EDEN_PY" --no-deps --target "$CITYNAV_EDEN_ROOT/visual/difix-python" "peft==0.18.1"
    fi
    if [ ! -f "$target/src/pipeline_difix.py" ] && [ ! -d "$target/.git" ]; then
      git clone https://github.com/nv-tlabs/Difix3D.git "$target"
    fi
    if [ -d "$target/.git" ]; then
      git -C "$target" checkout --detach "$revision"
    fi
    ;;
esac
exec "$EDEN_PY" tools/visual/download-models.py "${1:-all}" --jobs "${CITYNAV_MODEL_DOWNLOAD_JOBS:-48}"
