#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh

runtime="$CITYNAV_EDEN_ROOT/world/alternatives"
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"
export TORCH_EXTENSIONS_DIR="$CITYNAV_EDEN_ROOT/cache/torch-extensions"
export PYTHONPATH="$CITYNAV_EDEN_ROOT/visual/python:$PYTHONPATH:$runtime/sharp-python:$runtime/python"
export PATH="$runtime/sharp-python/bin:$CUDA_HOME/bin:$PATH"
export MAX_JOBS="${MAX_JOBS:-8}"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
exec "$EDEN_PY" -u tools/world/benchmark-alternatives.py "$@"
