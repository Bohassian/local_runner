# Sandboxed Pi coding agent. Runs on the compose `sandbox` network, which is
# internal (no route off the host): it can reach ollama and mcp-memory and
# nothing else. Only the project folder in PI_WORKSPACE is mounted.
FROM node:24-bookworm-slim

# git for diffs/history, ripgrep + fd so Pi never tries to download them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates git ripgrep fd-find \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# Pinned. Reviewed 2026-10-04 (1.0.2). Bump deliberately after re-reviewing.
# --ignore-scripts matches Pi's own containerization docs; none of the
# dependency install scripts are needed at runtime.
ARG PI_VERSION=1.0.2
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}

WORKDIR /workspace
ENTRYPOINT ["pi"]
