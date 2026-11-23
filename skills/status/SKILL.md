---
name: status
description: Show progress of the code-scan repo scan — files reviewed/pending, chunks, findings by severity, unreported count — or list all past scans, or list which files are pending/reviewed/excluded under a directory. Use for "scan status", "how far is the bug scan", "which files weren't reviewed in src/x", "why was file y skipped".
---

# code-scan: status

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

- Progress of the open/latest scan: `$CS status` (`--scan N` for another, `--all` for the list).
- File-level questions: `$CS files [--state pending|in_progress|partial|reviewed|excluded|unchanged] [--path dir/|glob|file]`.
  The `reason` column explains exclusions (test, generated/vendored, docs, unknown-ext, plan: …).

Relay the output in 1–3 lines. Do not read the database or source files.
