#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh
runtime="${CITYNAV_EDEN_ROOT#"$CITYNAV_PROJECT/"}"
payload=()
for item in browser models references results site-packages upstream; do
  if [ -d "$runtime/$item" ]; then payload+=("$runtime/$item"); fi
done
for item in bin/blender-4.5.17-linux-x64 scenes; do
  if [ -d "$runtime/visual/$item" ]; then payload+=("$runtime/visual/$item"); fi
done
for required in "$EDEN_PY" "$EDEN_WEIGHTS/dit-5b/diffusion_pytorch_model.safetensors"; do
  if [ ! -f "$required" ]; then >&2 echo "Missing $required"; exit 1; fi
done
interpreter="$(dirname "$(dirname "${EDEN_PY#"$CITYNAV_PROJECT/"}")")"
payload+=("$interpreter")

# The tar stream can be piped directly into the destination filesystem.
find . -mindepth 1 -maxdepth 1 ! -name .git ! -name .eden ! -name .DS_Store -print0 |
  tar --create --file=- \
    --exclude='__pycache__' --exclude='*.partial' --exclude='*.ranges' \
    --exclude="./$runtime" --exclude="$runtime/browser/.links" \
    --null --files-from=- "${payload[@]}"
