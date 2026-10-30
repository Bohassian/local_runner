<!-- Template from local_runner/pi/templates/godot/. Copy to a Godot
project's root as AGENTS.md and add project-specific notes. -->

# Godot project

This is a Godot 4 project.

- Docs sources for this project: `godot-api` (class reference) and
  `godot-manual` (manual and tutorials).
- Before using any Godot class, method, property, or signal, confirm its exact
  name and signature with `mcp__memory__lookup_symbol` (sources `["godot-api"]`).
  Do not guess Godot APIs.
- For how-tos and engine concepts, use `mcp__memory__search_docs` (sources
  `["godot-manual", "godot-api"]`).
- Write Godot 4 GDScript, not Godot 3 (e.g. `@export`, `@onready`,
  `signal.connect(callable)`, `super()`).
- Use static typing (`var speed: float = 200.0`, typed function signatures).
- You cannot run the Godot editor or game. Say what the user should test in the
  editor rather than claiming it works.
