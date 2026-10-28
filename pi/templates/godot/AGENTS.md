<!-- Template from local_runner/pi/templates/godot/. Copy to a Godot
project's root as AGENTS.md and add project-specific notes. -->

# Godot project

This is a Godot 4 project.

- Call `mcp__memory__lookup_docs` before writing GDScript or referencing any
  Godot class, node, method, signal, or property. Do not guess Godot APIs.
- Write Godot 4 GDScript, not Godot 3 (e.g. `@export`, `@onready`,
  `signal.connect(callable)`, `super()`).
- Use static typing (`var speed: float = 200.0`, typed function signatures).
- You cannot run the Godot editor or game. Say what the user should test in the
  editor rather than claiming it works.
