#!/bin/sh
# Downloads LLAMA_MODEL_FILE from LLAMA_MODEL_REPO at LLAMA_MODEL_REVISION into
# /models/<repo>/<revision>/. Keyed by revision so bumping the pin pulls a
# fresh copy instead of silently reusing an old one.
set -e

dest="/models/${LLAMA_MODEL_REPO}/${LLAMA_MODEL_REVISION}"

if [ -f "${dest}/${LLAMA_MODEL_FILE}" ]; then
  echo "Present, skipping download: ${dest}/${LLAMA_MODEL_FILE}"
  exit 0
fi

echo "Downloading ${LLAMA_MODEL_REPO}@${LLAMA_MODEL_REVISION}: ${LLAMA_MODEL_FILE}"
hf download "${LLAMA_MODEL_REPO}" "${LLAMA_MODEL_FILE}" \
  --revision "${LLAMA_MODEL_REVISION}" \
  --local-dir "${dest}"
echo "Model pull complete."
