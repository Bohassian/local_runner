# local_runner

Local-only LLM + MCP setup for using a small model (Pi + Ollama, sandboxed in Docker) on small projects. Architecture, phasing, and decisions live in `PLAN.md` (local-only, not in source control).

## Phase 1 — infra smoke test

What this gets you: a running Ollama on your GPU + a stub `mcp-memory` server with a `ping` tool, both reachable on localhost. No real retrieval yet. The agent harness is Pi — see [Pi (sandboxed)](#pi-sandboxed) below.

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

## Docs lookup (mcp-memory)

mcp-memory serves local documentation to Pi through four tools: `list_docs`, `search_docs` (hybrid keyword + semantic search), `lookup_symbol` (exact API names) and `read_doc` (whole pages). The index is `data/docs.db`, built on the host by the ingest scripts from the sources in `ingest/sources.json`:

| Source | What | From |
|---|---|---|
| `godot-manual` | Godot 4 manual + tutorials | `data/godot-docs/` (RST) |
| `godot-api` | Godot 4 class reference, ~27k symbols | `data/godot-docs/classes/` (RST) |
| `reference` | Your own markdown notes | `data/reference/` (optional) |

### One-time: clone the Godot docs

```bash
mkdir -p data
git clone --depth 1 https://github.com/godotengine/godot-docs data/godot-docs
```

(Use `--depth 1` to skip ~1.5 GB of history. Re-pull with `git -C data/godot-docs pull` when you want fresher docs.)

### One-time: install host-side ingest deps

The ingest scripts run on the host (not in Docker) so they can read `data/` directly and re-iterate fast.

```bash
cd ingest
yarn install
cd ..
```

### Run ingest

Ingest embeds through Ollama, so it needs to be up (`pibox` stops it on exit).

```bash
docker compose up -d ollama
cd ingest
yarn ingest --all                     # or specific sources: yarn ingest godot-api
```

Roughly 2 minutes for both Godot sources on the 4070. Each run replaces that source's rows entirely, and embeds before writing, so a failed run leaves the previous copy intact.

To add a source, add an entry to `ingest/sources.json` (`format`: `rst`, `godot-classref` or `markdown`; `path` under `data/`; `include` path prefixes) and run `yarn ingest <id>`. The tools pick it up without a restart.

### Rebuild mcp-memory

```bash
docker compose up -d --build mcp-memory
```

mcp-memory probes Ollama for the embedding model at startup. If `nomic-embed-text` isn't pulled, this fails — `docker compose up -d ollama-pull` first to seed it.

### Verify

```bash
# Want: list_docs, search_docs, lookup_symbol, read_doc
docker compose --profile pi run --rm --no-deps pi mcp list
```

Or from Pi (`pibox`, see below): "Use lookup_symbol to get the signature of Tween.tween_property." Watch `docker compose logs -f mcp-memory` to confirm the model is actually calling the tools.

### Measure retrieval

`ingest/eval/godot.json` holds 31 Godot questions with their expected pages. `yarn eval` reports hit@5 (right page in the top 5) per question kind for each search mode. Run it after changing readers, chunking or search to see whether retrieval got better or worse.

```bash
cd ingest
yarn eval                    # all modes
yarn eval godot 5 hybrid     # one mode
```

### Refresh workflow

```bash
git -C data/godot-docs pull           # update upstream docs
docker compose up -d ollama           # if pibox stopped it
cd ingest && yarn ingest --all        # re-embed
```

No live filesystem watcher; refresh is manual on purpose.

## llama.cpp (chat model)

Pi's chat model is served by `llama-server` in the `llama` service. Ollama stays up for `nomic-embed-text` embeddings only. The MoE experts mostly live in system RAM (`--n-cpu-moe`), and attention + shared weights stay on the GPU.

`LLAMA_PRESET` in `.env` picks the model from `llama/presets/`. All three share the same 80B-A3B architecture (Q4_K_M, ~45 GB each), so memory, speed and tuning carry over:

| Preset | Model | Use |
|---|---|---|
| `instruct` | Qwen3-Next-80B-A3B-Instruct | General; no thinking |
| `coder-next` | Qwen3-Coder-Next | Coding-agent tuned; no thinking |
| `thinking` | Qwen3-Next-80B-A3B-Thinking | Always thinks first; slower per step, better on hard problems |

Each preset pins its GGUF (repo + revision) and sets that model's recommended sampling. `llama/start.sh` holds the server flags shared by all of them.

`llama` and `llama-pull` are in the `llama` and `pi` profiles, so `docker compose up` won't start them. `pibox` starts them on demand.

### One-time

```bash
docker compose --profile llama build llama-pull     # needs PyPI once
docker compose --profile llama run --rm llama-pull  # current preset, ~45 GB from huggingface.co
# Pre-fetch another preset without switching to it:
LLAMA_PRESET=coder-next docker compose --profile llama run --rm llama-pull
```

### Switching models

1. Set `LLAMA_PRESET` in `.env`.
2. `docker compose --profile llama up -d llama` (or just start `pibox`). If that preset isn't downloaded yet, llama-pull fetches it first.
3. `pibox` starts Pi on the matching model automatically (`--model llama/<ALIAS>`). If you switch presets while Pi is already open, use `/model` in Pi. llama-server ignores the model id in requests, so a mismatch still works, but Pi then uses the wrong entry's settings (thinking display, output limit).

To add a preset, copy one in `llama/presets/`, change the pin, alias and sampling, and add a matching model entry to `pi/agent/models.json`.

### Run + verify

```bash
docker compose --profile llama up -d llama
docker compose logs -f llama           # wait for "server is listening"
curl -s http://localhost:8080/health   # want: {"status":"ok"}
```

Tool-call check: `tool_calls` should be populated and `content` empty. If `content` contains raw `<tool_call>` text instead, the chat template isn't being parsed.

```bash
curl -s http://localhost:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "messages": [{"role":"user","content":"How do I handle input in a Node2D? Look it up first."}],
  "tools": [{"type":"function","function":{"name":"search_docs","description":"Search local docs. CALL THIS BEFORE writing code against a documented API.","parameters":{"type":"object","properties":{"query":{"type":"string"},"k":{"type":"integer"}},"required":["query"]}}}]
}' | jq '.choices[0].message | {content, tool_calls}'
```

### Tuning

`LLAMA_N_CPU_MOE` (in `.env`) is the main speed knob. Lower it and restart `llama` until `nvidia-smi` shows VRAM nearly full. For speed numbers without Pi in the loop, run `llama-bench` from the full image against the same file.

`pibox` stops it when Pi exits. If you started it by hand, stop it when done, since it holds the weights in RAM: `docker compose stop llama`.

## Pi (sandboxed)

[Pi](https://pi.dev) runs in a container that can see **only** the project folder you hand it, and sits on an internal Docker network that reaches `llama` and `mcp-memory` and nothing else (no internet, no LAN, no host ports). Pi has no approval prompts by design — this is what keeps it from wandering your filesystem.

Config lives in `pi/agent/` (models → `http://llama:8080/v1`, MCP → `http://mcp-memory:3939/mcp` with the docs tools exposed directly). `pi/agent/AGENTS.md` holds project-neutral instructions. Pi also reads an `AGENTS.md` in the workspace (and its parents), so per-project rules go there: for a Godot project, copy `pi/templates/godot/AGENTS.md` to its root. Sessions land in `pi/agent/sessions/` (gitignored). The image pins `@earendil-works/pi-coding-agent@1.0.2`; bump `PI_VERSION` in `pi/Dockerfile` deliberately.

### One-time

```bash
docker compose up -d                       # recreates ollama + mcp-memory
docker compose --profile pi build pi       # needs internet once: node image, apt, npm
```

Add a launcher to `~/.zshrc`:

```zsh
pibox() {
  local ws
  ws="$(realpath "${1:-$PWD}")" || return 1
  case "$ws" in
    /|/home|"$HOME") echo "pibox: refusing to mount $ws" >&2; return 1 ;;
  esac
  local root=~/work/unabridged/local_runner
  local compose=(docker compose -f "$root/docker-compose.yml" --profile pi)
  # Start Pi on the model matching the running llama preset (LLAMA_PRESET in
  # .env; Pi's model id is the preset's ALIAS).
  local preset model
  preset="$(sed -n 's/^LLAMA_PRESET=//p' "$root/.env" | tail -1)"
  model="$(sed -n 's/^ALIAS=//p' "$root/llama/presets/${preset:-instruct}.env")" || return 1
  # `always` runs even if the session is interrupted. Stops the whole stack
  # (llama, ollama, mcp-memory), so it also ends any other pibox session.
  {
    PI_WORKSPACE="$ws" "${compose[@]}" run --rm pi --model "llama/$model" "${@:2}"
  } always {
    echo "pibox: stopping containers..." >&2
    "${compose[@]}" stop >/dev/null 2>&1
  }
}
```

Then `pibox` (current dir) or `pibox ~/work/unabridged/godot_test`. Commit before each session — the mounted folder (including `.git`) is fully writable.

Each launch starts llama, ollama and mcp-memory, and exiting Pi stops them all. That frees the ~37 GB of RAM llama holds, but each launch has to reload the model (~10–60 s, depending on whether it's still in the page cache). Running two `pibox` sessions at once doesn't work well: when either exits, the other loses its model server. To stop only llama and leave the small services up, change the cleanup to `stop llama`.

### Verify the sandbox

```bash
cd ~/work/unabridged/local_runner
# MCP reachable (want: list_docs, search_docs, lookup_symbol, read_doc)
docker compose --profile pi run --rm pi mcp list
# Internet blocked (want: blocked: EAI_AGAIN or similar, never LEAK)
docker compose --profile pi run --rm --entrypoint node pi -e "fetch('https://pi.dev').then(()=>console.log('LEAK'),e=>console.log('blocked:',e.cause?.code))"
# llama reachable (want: {"status":"ok"})
docker compose --profile pi run --rm --entrypoint node pi -e "fetch('http://llama:8080/health').then(r=>r.text()).then(console.log)"
```

## Layout

| Path | What |
|---|---|
| `PLAN.md` | Architecture + phasing (local-only). |
| `docker-compose.yml` | Ollama, llama.cpp, mcp-memory + Pi services. |
| `llama/` | llama-server start script + model presets. |
| `llama-pull/` | One-shot GGUF downloader image for the llama service. |
| `mcp-memory/` | TypeScript MCP server (HTTP transport). |
| `ingest/` | Host-side ingest (`yarn ingest`), source registry (`sources.json`) and retrieval eval (`yarn eval`). |
| `pi/` | Sandboxed Pi image (`Dockerfile`), its config (`agent/`), and per-project `AGENTS.md` templates (`templates/`). |
| `data/godot-docs/` | Pre-cloned Godot docs (gitignored). |
| `data/reference/` | User-authored markdown (gitignored). |
| `data/docs.db` | Docs store (sqlite-vec + FTS5); bind-mounted into mcp-memory. |
| `.env.example` | Config knobs; copy to `.env`. |
