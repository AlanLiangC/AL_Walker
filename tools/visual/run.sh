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
if [ ! -s "$scene" ]; then
  node tools/visual/export-scene.mjs office-09-x05 "$(dirname "$scene")"
fi
export BLENDER_USER_RESOURCES="$runtime/cache/blender"
export OPTIX_CACHE_PATH="$XDG_CACHE_HOME/optix"
mkdir -p "$BLENDER_USER_RESOURCES" "$OPTIX_CACHE_PATH"
exec bash tools/eden/run.sh passthrough --port 8771 --photo-blender "$blender" \
  --photo-scene "$scene" --photo-style assets/visual/office-day.json "$@"
