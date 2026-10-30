# Sandboxed Pi coding agent. Runs on the compose `sandbox` network, which is
# internal (no route off the host): it can reach llama and mcp-memory and
# nothing else. Only the project folder in PI_WORKSPACE is mounted.
FROM node:24-bookworm-slim

# git for diffs/history, ripgrep + fd so Pi never tries to download them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates git ripgrep fd-find \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# Pi's version is pinned in package.json (reviewed 2026-10-04, 1.0.2) and its
# whole dependency tree, with integrity hashes, in package-lock.json. Bump
# deliberately after re-reviewing, and regenerate the lockfile (README).
# --ignore-scripts matches Pi's own containerization docs; none of the
# dependency install scripts are needed at runtime.
WORKDIR /opt/pi
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
ENV PATH=/opt/pi/node_modules/.bin:$PATH

WORKDIR /workspace
ENTRYPOINT ["pi"]
