#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh
runtime="${CITYNAV_EDEN_ROOT#"$CITYNAV_PROJECT/"}"
payload=()
for item in browser models references results site-packages upstream; do
  if [ -d "$runtime/$item" ]; then payload+=("$runtime/$item"); fi
done
for item in bin/blender-4.5.17-linux-x64 scenes python difix-python difix-source/src difix-source/LICENSE.txt; do
  if [ -d "$runtime/visual/$item" ]; then payload+=("$runtime/visual/$item"); fi
  if [ -f "$runtime/visual/$item" ]; then payload+=("$runtime/visual/$item"); fi
done
for item in SolarRenderer CodeWorldModel solar-python models/h3 models/solar; do
  if [ -d "$runtime/world/$item" ]; then payload+=("$runtime/world/$item"); fi
done
for item in regen-native img2img-turbo ml-sharp python sharp-python models/regen models/edge-turbo models/sharp; do
  if [ -d "$runtime/world/alternatives/$item" ]; then payload+=("$runtime/world/alternatives/$item"); fi
done
for item in python cosmos-python vllm-omni; do
  if [ -d "$runtime/realtime/$item" ]; then payload+=("$runtime/realtime/$item"); fi
done
if [ -f "$runtime/realtime/cosmos-ticks-ready.json" ]; then payload+=("$runtime/realtime/cosmos-ticks-ready.json"); fi
for required in "$EDEN_PY" "$EDEN_WEIGHTS/dit-5b/diffusion_pytorch_model.safetensors"; do
  if [ ! -f "$required" ]; then >&2 echo "Missing $required"; exit 1; fi
done
interpreter="$(dirname "$(dirname "${EDEN_PY#"$CITYNAV_PROJECT/"}")")"
payload+=("$interpreter")

# The tar stream can be piped directly into the destination filesystem.
find . -mindepth 1 -maxdepth 1 ! -name .git ! -name .eden ! -name .DS_Store -print0 |
  tar --create --file=- \
    --exclude="__pycache__" --exclude='*.partial' --exclude='*.part' --exclude='*.ranges' --exclude='*.incomplete' \
    --exclude="./$runtime" --exclude="$runtime/browser/.links" \
    --exclude="$runtime/world/*/.git" --exclude="$runtime/world/models/*/.cache" \
    --exclude="$runtime/world/alternatives/*/.git" --exclude="$runtime/world/alternatives/models/*/base/.cache" \
    --exclude="$runtime/realtime/vllm-omni/.git" \
    --null --files-from=- "${payload[@]}"
