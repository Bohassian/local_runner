#!/bin/sh
# Downloads the GGUF for the preset named by LLAMA_PRESET (see
# llama/presets/) into /models/<repo>/<revision>/. Keyed by revision so
# bumping the pin pulls a fresh copy instead of silently reusing an old one.
set -e

preset="/llama/presets/${LLAMA_PRESET}.env"
if [ ! -f "$preset" ]; then
  echo "llama-pull: unknown LLAMA_PRESET '${LLAMA_PRESET}' (no $preset)" >&2
  exit 1
fi
. "$preset"

dest="/models/${MODEL_REPO}/${MODEL_REVISION}"

if [ -f "${dest}/${MODEL_FILE}" ]; then
  echo "Present, skipping download: ${dest}/${MODEL_FILE}"
  exit 0
fi

echo "Downloading ${MODEL_REPO}@${MODEL_REVISION}: ${MODEL_FILE}"
hf download "${MODEL_REPO}" "${MODEL_FILE}" \
  --revision "${MODEL_REVISION}" \
  --local-dir "${dest}"
echo "Model pull complete."
