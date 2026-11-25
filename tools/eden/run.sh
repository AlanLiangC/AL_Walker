#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh
if [ ! -x "$EDEN_PY" ] || [ ! -d "$PYTHONPATH/aiortc" ]; then
  >&2 echo "Prepare the project runtime with bash tools/eden/prepare.sh env"
  exit 1
fi
profile="${1:-passthrough}"
if [ "$#" -gt 0 ]; then shift; fi
if [ "$profile" = passthrough ]; then
  exec "$EDEN_PY" -u -m services.eden.server --profile "$profile" "$@"
fi
if [ "$#" -eq 0 ]; then
  >&2 echo "Pass --gpu INDEX or --gpu GPU-UUID for each model worker"
  exit 2
fi
for file in dit-5b/diffusion_pytorch_model.safetensors vae-5b/Wan2.2_VAE.pth decoder-5b/lighttaew2_2.pth umt5/text_encoder/model.safetensors vision-encoder/backbone/model.safetensors vision-encoder/projection.safetensors; do
  if [ ! -s "$EDEN_WEIGHTS/$file" ]; then
    >&2 echo "Missing $EDEN_WEIGHTS/$file"
    exit 1
  fi
done
exec "$EDEN_PY" -u -m services.eden.server --profile "$profile" \
  --source "$EDEN_SOURCE" --weights "$EDEN_WEIGHTS" "$@"
