# Multi-stage. Bookworm-slim (not alpine) because better-sqlite3 has reliable
# prebuilt binaries for glibc x64; alpine/musl often forces a from-source build.
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Build tools as a fallback in case the prebuilt better-sqlite3 binary doesn't
# match the host architecture. On x64 glibc the prebuild is picked up and these
# are unused but cheap to have.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Yarn is the image's bundled classic release (1.22.22 in node:24-bookworm-slim
# as of 2026-10-30), matching the host. No corepack, so the build doesn't
# download a package manager.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
EXPOSE 3939
CMD ["node", "dist/index.js"]
