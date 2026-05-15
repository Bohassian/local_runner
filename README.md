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
docker compose exec ollama ollama pull qwen2.5-coder:7b
docker compose exec ollama ollama pull nomic-embed-text
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

## Layout

| Path | What |
|---|---|
| `PLAN.md` | Architecture + phasing (local-only). |
| `docker-compose.yml` | Ollama + mcp-memory services. |
| `mcp-memory/` | TypeScript MCP server (HTTP transport). |
| `.env.example` | Config knobs; copy to `.env`. |
| `data/`, `ingest/` | Phase 2: ingested artifacts and ingest pipeline. Not present yet. |
