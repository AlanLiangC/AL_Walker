# Source from the CityNav repository before using the Eden tools.
if [ "${CITYNAV_EDEN_ROOT:-}" = "${CITYNAV_PROJECT:-}/.eden" ]; then
  unset CITYNAV_EDEN_ROOT
fi
CITYNAV_PROJECT="$(pwd -P)"
if [ ! -f "$CITYNAV_PROJECT/services/eden/requirements.lock" ]; then
  >&2 echo "Source tools/eden/env.sh from the CityNav project root"
  return 1
fi
CITYNAV_EDEN_ROOT="${CITYNAV_EDEN_ROOT:-$CITYNAV_PROJECT/.eden}"
CITYNAV_EDEN_ROOT="$(realpath -m -- "$CITYNAV_EDEN_ROOT")"
case "$CITYNAV_EDEN_ROOT/" in
  "$CITYNAV_PROJECT/"?*) ;;
  *) >&2 echo "CityNav Eden runtime must be inside $CITYNAV_PROJECT"; return 1 ;;
esac
export CITYNAV_PROJECT CITYNAV_EDEN_ROOT
export TMPDIR="$CITYNAV_EDEN_ROOT/tmp"
export XDG_CACHE_HOME="$CITYNAV_EDEN_ROOT/cache"
export XDG_CONFIG_HOME="$CITYNAV_EDEN_ROOT/config"
export XDG_DATA_HOME="$CITYNAV_EDEN_ROOT/data"
export UV_CACHE_DIR="$XDG_CACHE_HOME/uv"
export PIP_CACHE_DIR="$XDG_CACHE_HOME/pip"
export UV_PYTHON_INSTALL_DIR="$CITYNAV_EDEN_ROOT/python"
export UV_PYTHON_BIN_DIR="$CITYNAV_EDEN_ROOT/bin"
export HF_HOME="$XDG_CACHE_HOME/huggingface"
export HF_HUB_CACHE="$HF_HOME/hub"
export HF_XET_CACHE="$HF_HOME/xet"
export CUDA_CACHE_PATH="$XDG_CACHE_HOME/nvidia"
export TORCH_HOME="$XDG_CACHE_HOME/torch"
export TORCHINDUCTOR_CACHE_DIR="$XDG_CACHE_HOME/inductor"
export TRITON_CACHE_DIR="$XDG_CACHE_HOME/triton"
export PLAYWRIGHT_BROWSERS_PATH="$CITYNAV_EDEN_ROOT/browser"
export MPLCONFIGDIR="$XDG_CACHE_HOME/matplotlib"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONNOUSERSITE=1
export PYTHONPATH="$CITYNAV_EDEN_ROOT/site-packages"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$CITYNAV_EDEN_ROOT/results"
EDEN_PY="$UV_PYTHON_INSTALL_DIR/cpython-3.12.13-linux-$(uname -m)-gnu/bin/python3.12"
EDEN_SOURCE="$CITYNAV_EDEN_ROOT/upstream"
EDEN_WEIGHTS="$CITYNAV_EDEN_ROOT/models/EdenLive"
