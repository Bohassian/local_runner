#!/bin/sh
# Entrypoint for the llama service: loads the model preset named by
# LLAMA_PRESET (llama/presets/<name>.env) and starts llama-server with it.
# Hardware knobs (context, MoE offload) come from .env and apply to every preset.
set -e

preset="/llama/presets/${LLAMA_PRESET}.env"
if [ ! -f "$preset" ]; then
  echo "llama: unknown LLAMA_PRESET '${LLAMA_PRESET}' (no $preset)" >&2
  exit 1
fi
. "$preset"
echo "llama: preset ${LLAMA_PRESET} -> ${MODEL_REPO}/${MODEL_FILE}"

set -- -m "/models/${MODEL_REPO}/${MODEL_REVISION}/${MODEL_FILE}"
set -- "$@" --host 0.0.0.0 --port 8080
# Name Pi sends as the model id (see pi/agent/models.json).
set -- "$@" --alias "$ALIAS"
# Default CORS reflects any origin, so any web page open in a browser on this
# box could read responses from the server. Pi and curl send no Origin header
# and are unaffected.
set -- "$@" --cors-origins localhost
# One slot: context isn't split across parallel requests, and every Pi turn
# reuses the same prompt cache.
set -- "$@" -c "$LLAMA_CONTEXT_LENGTH" -np 1
# All layers on GPU, then push the MoE experts of the first N layers back to
# system RAM. Lower N until VRAM is nearly full (watch nvidia-smi) for speed.
set -- "$@" -ngl 999 --n-cpu-moe "$LLAMA_N_CPU_MOE"
# Flash attention is required for KV cache quantization; q8_0 roughly halves
# KV memory with minimal quality cost.
set -- "$@" -fa on --cache-type-k q8_0 --cache-type-v q8_0
# Use the GGUF's chat template so tool calls come back as structured
# `tool_calls` rather than raw text.
set -- "$@" --jinja
set -- "$@" --temp "$TEMP" --top-p "$TOP_P" --top-k "$TOP_K" --min-p "$MIN_P"
# EXTRA_ARGS is deliberately unquoted so it splits into separate arguments.
# shellcheck disable=SC2086
set -- "$@" $EXTRA_ARGS

exec /app/llama-server "$@"
