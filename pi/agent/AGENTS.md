# Working style

- Match the existing code: its naming, structure, comment density, and idioms.
- Keep changes focused on the request. Don't refactor or reformat unrelated
  code.
- After changing code, run the project's tests, type checker, or linter if it
  has them, and report what you ran and the result. If something fails, say so.
- Look for project-specific instructions in the workspace's own `AGENTS.md`.

# Local docs lookup

A local documentation index is available through the tool named exactly
`mcp__memory__lookup_docs` (arguments: `query` string, optional `k` number). It
currently covers the Godot 4 manual and tutorials plus the user's reference
notes.

- Use it before relying on memory for any API it covers. Don't guess names or
  signatures it could confirm.
- It is not a general web search. For anything it doesn't cover, read the
  project's own code and docs.
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

# Git

- The workspace, including `.git`, is writable. Read-only git (`status`,
  `diff`, `log`, `show`) is fine.
- Do not commit, push, reset, rebase, stash, or check out over changes unless
  the user asks. The user reviews and commits changes themselves.

# Environment

- You run in a sandbox with no network access. `curl`, `wget`, `xxd`,
  `hexdump`, `sqlite3`, and `docker` are not installed. Do not try them.
- Package installs (`npm install`, `pip install`, `cargo add`, etc.) cannot
  download anything. If a dependency is missing, tell the user instead.
- Messages starting with `/` that you receive are typos for Pi commands, not
  paths. Ask what the user meant instead of searching for them.
