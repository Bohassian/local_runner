# local_runner

Local-only LLM + MCP setup for coding with the [Pi](https://pi.dev) agent, sandboxed in Docker. Nothing leaves the machine at runtime; the only network access is the one-time image builds and model and docs downloads. Architecture, phasing and decisions live in `PLAN.md` (local-only, not in source control).

| Service | What |
|---|---|
| `llama` | llama.cpp `llama-server` serving the chat model (Qwen3-Next 80B-A3B family; presets below). MoE experts live in system RAM, attention + shared weights on the GPU. |
| `ollama` | Embeddings only (`nomic-embed-text`), used by mcp-memory and the ingest scripts. |
| `mcp-memory` | MCP server for local docs and API lookup (`list_docs`, `search_docs`, `lookup_symbol`, `read_doc`). |
| `pi` | The Pi coding agent, on an internal network that reaches only `llama` and `mcp-memory`. |

Setup order: [prerequisites](#prerequisites) → [base services](#base-services-ollama--mcp-memory) → [chat model](#llamacpp-chat-model) → [docs](#docs-lookup-mcp-memory) → [Pi](#pi-sandboxed).

Commands assume your user can run `docker`. If it can't, prefix them with `sudo` (including inside the `pibox` function below).

## Prerequisites

- An NVIDIA GPU with at least 12 GB of VRAM and roughly 48 GB+ of system RAM; llama holds ~37 GB of weights in RAM. The numbers in this README come from a 12 GB RTX 4070.
- Docker with the NVIDIA container toolkit:

  ```bash
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt update && sudo apt install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker

  # Verify
  docker info | grep -i runtime
  docker run --rm --gpus all nvidia/cuda:13.0.0-base-ubuntu22.04 nvidia-smi
  ```

- Node (version in `.tool-versions`) and Yarn on the host, for the ingest scripts.

## Base services (ollama + mcp-memory)

```bash
cp .env.example .env
docker compose up -d --build   # ollama, ollama-pull (fetches nomic-embed-text), mcp-memory
```

mcp-memory probes Ollama for the embedding model at startup and exits if it's missing; `ollama-pull` seeds it on first run. The tools return nothing useful until the docs are ingested (below).

```bash
curl http://localhost:11434/api/tags                       # Ollama answers, lists nomic-embed-text
npx @modelcontextprotocol/inspector http://localhost:3939/mcp   # optional: poke the tools by hand
```

## llama.cpp (chat model)

Pi's chat model is served by `llama-server` in the `llama` service. `LLAMA_PRESET` in `.env` picks the model from `llama/presets/`. All three share the same 80B-A3B architecture (Q4_K_M, ~45 GB each), so memory, speed and tuning carry over:

| Preset | Model | Use |
|---|---|---|
| `instruct` | Qwen3-Next-80B-A3B-Instruct | General; no thinking |
| `coder-next` | Qwen3-Coder-Next | Coding-agent tuned; no thinking |
| `thinking` | Qwen3-Next-80B-A3B-Thinking | Always thinks first; slower per step, better on hard problems |

Each preset pins its GGUF (repo + revision) and sets that model's recommended sampling. `llama/start.sh` holds the server flags shared by all of them (128k context, q8_0 KV cache, flash attention, `--jinja` for tool calls).

`llama` and `llama-pull` are in the `llama` and `pi` profiles, so `docker compose up` won't start them. `pibox` starts them on demand. The container is capped at `LLAMA_MEM_LIMIT` and marked as the kernel's first OOM victim, so it can share a machine you're also working on.

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

To add a preset, copy one in `llama/presets/`, change the pin, alias and sampling, and add a matching model entry to `pi/agent/models.json` (and its compaction settings in `pi/agent/settings.json`).

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

`LLAMA_N_CPU_MOE` (in `.env`) is the main speed knob: the number of the 48 MoE expert layers kept in system RAM. Lower it and restart `llama` to put more on the GPU; stop while `nvidia-smi` still shows some VRAM free. On a 12 GB card, 43 leaves ~2 GB headroom at 128k context and runs at roughly 220 tok/s prompt processing and 31–35 tok/s generation. For speed numbers without Pi in the loop, run `llama-bench` from the full image against the same file.

`LLAMA_CONTEXT_LENGTH` is cheap to raise on this architecture (KV cache on only 12 of 48 layers); keep the `contextWindow` values in `pi/agent/models.json` in sync.

`pibox` stops llama when Pi exits. If you started it by hand, stop it when done, since it holds the weights in RAM: `docker compose stop llama`.

## Docs lookup (mcp-memory)

mcp-memory serves local documentation to Pi through four tools: `list_docs`, `search_docs` (hybrid keyword + semantic + symbol search), `lookup_symbol` (exact API names, with a class's member list) and `read_doc` (whole pages or one section). The index is `data/docs.db`, built on the host by the ingest scripts from the sources in `ingest/sources.json`:

| Source | What | From |
|---|---|---|
| `godot-manual` | Godot 4 manual + tutorials | `data/godot-docs/` (RST) |
| `godot-api` | Godot 4 class reference, ~27k symbols | `data/godot-docs/classes/` (RST) |
| `rails~7.1`, `rails~8.1` | Rails API reference + Rails Guides | `data/devdocs/` (DevDocs bundles) |
| `ruby~3.2`, `ruby~4.0` | Ruby core + standard library | `data/devdocs/` (DevDocs bundles) |
| `pi` | Pi's own docs (settings, skills, extensions, providers, ...) | `data/pi-docs/` (markdown, copied from the Pi image) |
| `reference` | Your own markdown notes | `data/reference/` (optional) |

Several versions of a stack coexist. Each project's `AGENTS.md` names the sources matching its versions, and Pi passes them as `sources` (templates in `pi/templates/`).

### One-time: get the docs

```bash
mkdir -p data
# Godot (--depth 1 skips ~1.5 GB of history)
git clone --depth 1 https://github.com/godotengine/godot-docs data/godot-docs
# Rails + Ruby from DevDocs (~45 MB from devdocs.io)
cd ingest && yarn install && yarn fetch-docs rails~7.1 ruby~3.2 rails~8.1 ruby~4.0
```

Pi's docs ship inside the npm package, so they're copied out of the built Pi image (no network; build it first, see [Pi](#pi-sandboxed)):

```bash
mkdir -p data/pi-docs && docker compose --profile pi run --rm --no-deps -T --entrypoint sh pi \
  -c 'cd "$(npm root -g)/@earendil-works/pi-coding-agent" && tar -cf - README.md docs' | tar -x -C data/pi-docs
```

The clone and `fetch-docs` are the only networked steps for docs; ingest and search read local files. `fetch-docs` re-downloads only bundles that changed upstream. Other DevDocs slugs are listed at https://devdocs.io/docs.json (e.g. `react`, `typescript`, `postgresql~16`).

### Run ingest

The ingest scripts run on the host (not in Docker) so they can read `data/` directly and iterate fast. They embed through Ollama, so it needs to be up (`pibox` stops it on exit).

```bash
docker compose up -d ollama
cd ingest
yarn ingest --all                     # or specific sources: yarn ingest godot-api
```

Roughly 2 minutes for both Godot sources and about 40 s per Rails/Ruby bundle on the reference GPU; all six sources come to ~63k chunks and a ~350 MB `docs.db`. Each run replaces that source's rows entirely, and embeds before writing, so a failed run leaves the previous copy intact. The tools pick up new or re-ingested sources without a restart.

To add a source, add an entry to `ingest/sources.json` (`format`: `rst`, `godot-classref`, `markdown` or `devdocs`; `path` under `data/`; optional `include` path prefixes) and run `yarn ingest <id>`. For a DevDocs bundle, `yarn fetch-docs <slug>` first and use `"path": "devdocs/<slug>"`.

### Verify

```bash
# Want: list_docs, search_docs, lookup_symbol, read_doc
docker compose --profile pi run --rm --no-deps pi mcp list
```

Or from Pi (`pibox`, see below): "Use lookup_symbol to get the signature of Tween.tween_property." Watch `docker compose logs -f mcp-memory` to see what the model looks up: each tool call logs one line with the tool, its arguments, the result size and the time taken. After changing mcp-memory's code, rebuild it with `docker compose up -d --build mcp-memory`.

### Measure retrieval

`ingest/eval/godot.json` (41 questions) and `ingest/eval/rails.json` (24, limited to `rails~7.1` + `ruby~3.2`) hold questions with their expected pages. `yarn eval` reports hit@5 (right page in the top 5) and MRR per question kind for each search mode. Run both sets after changing readers, chunking or search to see whether retrieval got better or worse.

```bash
cd ingest
yarn eval                    # godot set, all modes
yarn eval rails 5 hybrid     # one set, one mode
```

The search code lives in both `ingest/src/util/search.ts` and `mcp-memory/src/search.ts`; keep them in sync so the eval measures what the server does.

### Refresh

```bash
git -C data/godot-docs pull           # update Godot docs
docker compose up -d ollama           # if pibox stopped it
cd ingest
yarn fetch-docs rails~7.1 ruby~3.2 rails~8.1 ruby~4.0   # update DevDocs bundles
yarn ingest --all                     # re-embed
```

After bumping `PI_VERSION`, rebuild the Pi image, delete `data/pi-docs/`, repeat the copy above and run `yarn ingest pi`, so the `pi` source matches the Pi you run (also update its `version` in `ingest/sources.json`).

No live filesystem watcher; refresh is manual on purpose.

## Pi (sandboxed)

[Pi](https://pi.dev) runs in a container that can see **only** the project folder you hand it, and sits on an internal Docker network that reaches `llama` and `mcp-memory` and nothing else (no internet, no LAN, no host ports). Pi has no approval prompts by design — this is what keeps it from wandering your filesystem.

Config lives in `pi/agent/`: models → `http://llama:8080/v1`, MCP → `http://mcp-memory:3939/mcp` with the docs tools exposed directly. `pi/agent/AGENTS.md` holds project-neutral instructions. Pi also reads an `AGENTS.md` in the workspace (and its parents), so per-project rules go there: copy `pi/templates/godot/AGENTS.md` or `pi/templates/rails/AGENTS.md` to the project's root (for Rails, set the versions and sources to match the app). Sessions land in `pi/agent/sessions/` (gitignored). The image pins `@earendil-works/pi-coding-agent@1.0.2`; bump `PI_VERSION` in `pi/Dockerfile` deliberately, and refresh the `pi` docs source when you do (see [Refresh](#refresh)).

### One-time

```bash
docker compose --profile pi build pi       # needs internet once: node image, apt, npm
```

Add a launcher to your shell config (`~/.zshrc`; it uses zsh's `always` block). Set `root` to where you cloned this repo:

```zsh
pibox() {
  local ws
  ws="$(realpath "${1:-$PWD}")" || return 1
  case "$ws" in
    /|/home|"$HOME") echo "pibox: refusing to mount $ws" >&2; return 1 ;;
  esac
  local root=/path/to/local_runner
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

Then `pibox` (current dir) or `pibox /path/to/project`. Extra arguments go to Pi. Commit before each session — the mounted folder (including `.git`) is fully writable.

Each launch starts llama, ollama and mcp-memory, and exiting Pi stops them all. That frees the ~37 GB of RAM llama holds, but each launch has to reload the model (~10–60 s, depending on whether it's still in the page cache). Running two `pibox` sessions at once doesn't work well: when either exits, the other loses its model server. To stop only llama and leave the small services up, change the cleanup to `stop llama`.

### Verify the sandbox

From the repo root:

```bash
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
| `PLAN.md` | Architecture + phasing (local-only, gitignored). |
| `docker-compose.yml` | Ollama, llama.cpp, mcp-memory + Pi services. |
| `.env.example` | Config knobs; copy to `.env`. |
| `llama/` | llama-server start script (`start.sh`) + model presets (`presets/`). |
| `llama-pull/` | One-shot GGUF downloader image for the llama service. |
| `mcp-memory/` | TypeScript MCP server (HTTP transport) with the docs tools. |
| `ingest/` | Host-side scripts: `yarn fetch-docs`, `yarn ingest`, `yarn eval`; source registry (`sources.json`); readers per doc format (`src/readers/`); eval sets (`eval/`). |
| `pi/` | Sandboxed Pi image (`Dockerfile`), its config (`agent/`), and per-project `AGENTS.md` templates (`templates/`). |
| `data/` | Gitignored. `godot-docs/` (cloned), `devdocs/` (fetched bundles), `reference/` (your notes), `docs.db` (sqlite-vec + FTS5 store, bind-mounted into mcp-memory). |
