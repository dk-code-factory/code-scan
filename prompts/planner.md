Plan a repository bug scan from its structure, in as few turns as possible (put independent tool calls in
the same turn). Use the directory digest above, top-level build/manifest files and `git ls-files <dir>`
listings — never source files. Never edit or create files and never run code-scan commands: instead of
writing the plan to a file and running apply-plan, your final reply IS the plan — exactly one JSON object
of the shape described in INSTRUCTIONS, with no prose around it. code-scan applies it and tells you if it
is rejected.
