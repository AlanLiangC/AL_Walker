#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh
runtime="$CITYNAV_EDEN_ROOT/visual"
blender="$runtime/bin/blender-4.5.17-linux-x64/blender"
scene="$runtime/scenes/office-09/scene.json"
if [ ! -x "$blender" ]; then
  >&2 echo "Install Blender 4.5.17 under $runtime/bin"
  exit 1
fi
if [ ! -s "$scene" ] || [ "$scene" -ot tools/visual/export-scene.mjs ]; then
  node tools/visual/export-scene.mjs office-09-x05 "$(dirname "$scene")"
fi
export BLENDER_USER_RESOURCES="$runtime/cache/blender"
export OPTIX_CACHE_PATH="$XDG_CACHE_HOME/optix"
mkdir -p "$BLENDER_USER_RESOURCES" "$OPTIX_CACHE_PATH"
profile="${CITYNAV_VISUAL_PROFILE:-}"
if [ -z "$profile" ]; then
  if [ -d "$CITYNAV_EDEN_ROOT/realtime/python/sageattention" ]; then profile=ada-live-864-fast
  else profile=ada-live-fp8
  fi
fi
args=("$@")
if [[ "$profile" != passthrough && " $* " != *" --gpu "* && " $* " != *" --gpu="* ]]; then
  args+=(--gpu "${CITYNAV_VISUAL_STREAM_GPU:-3}")
fi
if [ -s "$CITYNAV_EDEN_ROOT/world/alternatives/models/regen/flux.pth" ] &&
   [[ " $* " != *" --regen-gpu "* && " $* " != *" --regen-gpu="* ]]; then
  args+=(--regen-gpu "${CITYNAV_REGEN_GPU:-1}")
fi
export CITYNAV_COSMOS_GPU="${CITYNAV_COSMOS_GPU:-2}"
exec bash tools/eden/run.sh "$profile" --port 8771 --photo-blender "$blender" \
  --photo-scene "$scene" --photo-style assets/visual/office-day.json \
  --photo-generative assets/visual/generative.json --reference-world \
  --public-models "${CITYNAV_PUBLIC_MODELS:-/inspire/hdd/global_public/public_models}" "${args[@]}"
