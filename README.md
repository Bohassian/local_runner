# local_runner

Local-only LLM + MCP setup for using a small model (Cline + Ollama in VS Code) on small projects. Architecture, phasing, and decisions live in `PLAN.md` (local-only, not in source control).

## Phase 1 — infra smoke test

What this gets you: a running Ollama on your GPU + a stub `mcp-memory` server with a `ping` tool, both reachable from Cline. No real retrieval yet.

### Prerequisites (one-time)

```bash
# 1. nvidia-container-toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 2. Verify
docker info | grep -i runtime
docker run --rm --gpus all nvidia/cuda:13.0.0-base-ubuntu22.04 nvidia-smi
```

Also: ensure Node 22 is active (`asdf install nodejs 22.12.0 && asdf reshim`).

### Bring-up

```bash
cp .env.example .env
docker compose up -d ollama
docker compose up -d --build mcp-memory
```

### Verify

```bash
# Ollama answers
curl http://localhost:11434/api/tags

# mcp-memory ping tool, via the MCP inspector
npx @modelcontextprotocol/inspector http://localhost:3939/mcp
```

### Wire up Cline

In VS Code:
1. Install the **Cline** extension.
2. Cline settings → API provider = Ollama → base URL `http://localhost:11434` → model `qwen2.5-coder:7b`.
3. Cline MCP settings → add:
   ```json
   {
     "mcpServers": {
       "memory-server": {
         "url": "http://localhost:3939/mcp"
       }
     }
   }
   ```
4. Open any project in VS Code, ask Cline to "call the ping tool from memory with the message 'hello'." Should round-trip.

## Phase 2 — Godot docs ingestion

Replaces the `ping` tool with a real `lookup_docs(query, k)` tool backed by a `sqlite-vec` index of the Godot manual + tutorials, plus any user-authored markdown you drop in `data/reference/`.

### One-time: clone the Godot docs

```bash
mkdir -p data
git clone --depth 1 https://github.com/godotengine/godot-docs data/godot-docs
```

(Use `--depth 1` to skip ~1.5 GB of history. Re-pull with `git -C data/godot-docs pull` when you want fresher docs.)

### One-time: install host-side ingest deps

The ingest scripts run on the host (not in Docker) so they can read `data/godot-docs/` directly and re-iterate fast.

```bash
cd ingest
yarn install
cd ..
```

### Rebuild mcp-memory and bring it up

The phase-1 image only has the `ping` tool. Rebuild and restart:

```bash
docker compose up -d --build mcp-memory
```

mcp-memory probes Ollama for the embedding model at startup. If `nomic-embed-text` isn't pulled, this fails — `docker compose up -d ollama-pull` first to seed it.

### Run ingest

```bash
cd ingest
yarn ingest:godot        # ~few minutes; depends on GPU + chunk count
yarn ingest:reference    # near-instant if data/reference/ is empty
# or both:
yarn ingest:all
```

Re-running is idempotent: each source's rows are wiped and re-inserted on every run.

### Verify

```bash
# Should now list lookup_docs (not ping):
npx @modelcontextprotocol/inspector http://localhost:3939/mcp

# Or test from Cline: "Use the lookup_docs tool to find chunks about Node2D input handling."
```

Watch container logs (`docker compose logs -f mcp-memory`) to confirm the model is actually calling the tool. The tool description is directive but small models still sometimes skip it.

### Refresh workflow

```bash
git -C data/godot-docs pull           # update upstream docs
cd ingest && yarn ingest:all          # re-embed
```

No live filesystem watcher; refresh is manual on purpose.

## Layout

| Path | What |
|---|---|
| `PLAN.md` | Architecture + phasing (local-only). |
| `docker-compose.yml` | Ollama + mcp-memory services. |
| `mcp-memory/` | TypeScript MCP server (HTTP transport). |
| `ingest/` | Host-side ingest scripts (`tsx`). |
| `data/godot-docs/` | Pre-cloned Godot docs (gitignored). |
| `data/reference/` | User-authored markdown (gitignored). |
| `data/mcp-memory.db` | sqlite-vec store; bind-mounted into mcp-memory. |
| `.env.example` | Config knobs; copy to `.env`. |
