---
name: status
description: Show progress of the code-scan repo scan — files reviewed/pending, chunks, findings by severity, unreported count — or list all past scans, or list which files are pending/reviewed/excluded under a directory. Use for "scan status", "how far is the bug scan", "which files weren't reviewed in src/x", "why was file y skipped".
---

# code-scan: status

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI, the CLI is `bin/code-scan.js` two directories above this SKILL.md file.

- Progress: `$CS status` — the open scan, or one block per open scan when several run side by side
  (`--scan <id|label|profile>` for one; `--all` or `$CS scans [--profile p] [--status s]` for the list).
- File-level questions: `$CS files [--scan s] [--state pending|in_progress|partial|reviewed|excluded|unchanged] [--path dir/|glob|file]`.
  The `reason` column explains exclusions (test, generated/vendored, docs, unknown-ext, plan: …).

Relay the output in 1–3 lines. Do not read the database or source files.
