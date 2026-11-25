#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh
edition=2ea01626e6eaa32592a3b466d99d9739ceca35b0

case "${1:-all}" in
  env|weights|bidir|browser|all) ;;
  *) >&2 echo "Usage: tools/eden/prepare.sh [env|weights|bidir|browser|all]"; exit 2 ;;
esac

if [ ! -d "$EDEN_SOURCE/.git" ]; then
  git clone --filter=blob:none https://github.com/VAST-AI-Research/EdenLive.git "$EDEN_SOURCE"
fi
if [ "$(git -C "$EDEN_SOURCE" rev-parse HEAD)" != "$edition" ]; then
  git -C "$EDEN_SOURCE" fetch origin "$edition"
  git -C "$EDEN_SOURCE" checkout --detach "$edition"
fi
install_runtime() {
  if [ ! -x "$EDEN_PY" ]; then
    uv python install --no-bin 3.12.13
  fi
  uv pip install --no-deps --python "$EDEN_PY" --target "$PYTHONPATH" \
    --index https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match \
    -r services/eden/requirements.lock
  "$EDEN_PY" - <<'PY'
from importlib.metadata import version
import torch
for name in ("torch", "torchvision", "transformers", "diffusers", "av", "aiohttp", "aiortc", "playwright"):
    print(name, version(name))
print("CUDA driver access:", torch.cuda.is_available())
PY
}

download() {
  python3 tools/eden/download.py "$EDEN_WEIGHTS" --jobs "${CITYNAV_EDEN_DOWNLOAD_JOBS:-48}" \
    --mirror "${CITYNAV_EDEN_DOWNLOAD_MIRROR:-https://huggingface.co}" "$@"
}

browser() {
  if [ ! -x "$EDEN_PY" ] || [ ! -d "$PYTHONPATH/playwright" ]; then install_runtime; fi
  "$EDEN_PY" -m playwright install --only-shell chromium
}

case "${1:-all}" in
  env) install_runtime ;;
  weights) download ;;
  bidir) download --bidirectional-only ;;
  browser) browser ;;
  all)
    install_runtime
    download
    browser
    ;;
esac
