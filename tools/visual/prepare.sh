#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh
runtime="$CITYNAV_EDEN_ROOT/visual"
edition=4.5.17
name="blender-$edition-linux-x64"
release=https://download.blender.org/release/Blender4.5
mirror="${CITYNAV_BLENDER_MIRROR:-$release}"
mkdir -p "$runtime/bin"
if [ ! -x "$runtime/bin/$name/blender" ]; then
  (
    cd "$runtime/bin"
    curl --fail --location --retry 3 "$release/blender-$edition.sha256" -o "blender-$edition.sha256"
    curl --fail --location --retry 3 --continue-at - "$mirror/$name.tar.xz" -o "$name.tar.xz"
    rg -F "$name.tar.xz" "blender-$edition.sha256" | sha256sum -c -
    tar -xJf "$name.tar.xz"
  )
fi
node tools/visual/export-scene.mjs office-09-x05 "$runtime/scenes/office-09"
