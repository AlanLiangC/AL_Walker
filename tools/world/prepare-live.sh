#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh

source_dir="$CITYNAV_EDEN_ROOT/realtime/SageAttention"
overlay="$CITYNAV_EDEN_ROOT/realtime/python"
revision=eb615cf6cf4d221338033340ee2de1c37fbdba4a
mkdir -p "$overlay"
if [ ! -d "$source_dir/.git" ]; then
  git clone --quiet --depth 1 --branch v2.2.0 https://github.com/thu-ml/SageAttention.git "$source_dir"
fi
test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
uv pip install --python "$EDEN_PY" --target "$overlay" --no-deps wheel==0.45.1
export PYTHONPATH="$overlay:$PYTHONPATH"
export TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-8.9}"
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"
export MAX_JOBS="${MAX_JOBS:-10}"
exec uv pip install --python "$EDEN_PY" --target "$overlay" --no-build-isolation --no-deps "$source_dir"
