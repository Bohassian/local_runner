# Godot docs lookup

A local Godot 4 documentation index is available through the tool named exactly
`mcp__memory__lookup_docs` (arguments: `query` string, optional `k` number).

- Call it before writing GDScript or referencing any Godot class, node, method,
  signal, or property. Do not guess Godot APIs.
- Always use the full tool name `mcp__memory__lookup_docs`. There is no tool
  named `lookup_docs`.

# Editing files

- Before every `edit`, `read` the exact lines you are changing. Copy `oldText`
  from that output; never retype it from memory.
- Keep `oldText` short and unique: one line, or a few lines, when possible.
  Make one edit per call.
- `edits` is a JSON array of objects, e.g.
  `[{"oldText": "...", "newText": "..."}]`. Never pass it as a string.
- To remove or replace a large block, use several small edits, or `write` the
  whole file if it is short.
- If an edit fails with "Could not find the exact text", re-`read` the lines
  and inspect whitespace with `cat -A` or `od -c`, then retry with a shorter
  `oldText`.

# Searching

- Search with `rg` (it skips `.gitignore`d paths like `node_modules`), e.g.
  `rg -n -i "pattern"`. Do not use `find` or `grep -r` over the whole tree.
- List files with `rg --files` or `fd`.

# Environment

- You run in a sandbox with no network access. `curl`, `wget`, `xxd`,
  `hexdump`, `sqlite3`, and `docker` are not installed. Do not try them.
- Messages starting with `/` that you receive are typos for Pi commands, not
  paths. Ask what the user meant instead of searching for them.
