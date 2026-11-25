#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source tools/eden/env.sh
export CUDA_VISIBLE_DEVICES="${1:?Pass the target GPU index or UUID}"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export OMP_NUM_THREADS=4
out="$(realpath -m -- "${2:-$CITYNAV_EDEN_ROOT/results/eden/upstream-offline}")"
mode="${3:-few-step}"
case "$mode" in
  few-step)
    profile=wan22_5b_720p_few_step
    frames="${5:-33}"
    overrides=("data.dataset.params.text_mode=global")
    ;;
  bidirectional)
    profile=wan22_5b_720p_bidir
    frames="${5:-121}"
    patch="$CITYNAV_PROJECT/tools/eden/patches/wan-temporal-sdpa.patch"
    if ! git -C "$EDEN_SOURCE" apply --reverse --check "$patch" 2>/dev/null; then
      git -C "$EDEN_SOURCE" apply "$patch"
    fi
    overrides=("model.teacher_forcing_attention_backend=triton" "model.dynamic_prompt.backend=sdpa")
    ;;
  *) >&2 echo "Expected few-step or bidirectional"; exit 2 ;;
esac
if [ "$#" -ge 4 ]; then
  manifest="$(realpath -- "$4")"
  overrides+=("data.dataset.params.path=$manifest" "data.dataset.params.root=$(dirname "$manifest")")
fi
mkdir -p "$out"
cd "$EDEN_SOURCE"
exec "$EDEN_PY" -u -m edenlive.scripts.infer \
  --config "edenlive/configs/$profile.yaml" \
  "model.pretrained_dir=$EDEN_WEIGHTS" \
  "data.dataset.params.max_frames=$frames" \
  "inference.num_frames=$frames" \
  "inference.max_frames=$frames" \
  "inference.max_batches=1" \
  "inference.output_dir=$out" "${overrides[@]}"
