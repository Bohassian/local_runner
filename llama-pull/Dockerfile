# One-shot GGUF downloader for the llama service. Built once (needs PyPI),
# then only talks to huggingface.co when the pinned model file is missing.
FROM python:3.12-slim-bookworm

# Pinned. Bump deliberately.
ARG HF_HUB_VERSION=0.35.3
RUN pip install --no-cache-dir "huggingface_hub==${HF_HUB_VERSION}"

COPY pull.sh /usr/local/bin/pull.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/pull.sh"]
