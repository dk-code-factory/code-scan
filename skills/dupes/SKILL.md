---
name: dupes
description: Find duplicate code-scan findings (same bug reported twice, or the same bug pattern repeated across files) and match findings against existing GitHub or Jira issues so already-known bugs are linked rather than refiled. Also finds findings in a given directory or file. Use for "dedupe findings", "group duplicates", "which findings are already filed", "match against jira", "is this already reported".
---

# code-scan: dupes

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI, the CLI is `bin/code-scan.js` two directories above this SKILL.md file.

## Local duplicates (deterministic, no agents)
- `$CS dupes [filters]` → clusters open/confirmed findings (same file + nearby lines + similar
  title; or same category + similar title + same code shape across files). Manual groups are kept.
- `$CS dupes list`, `$CS dupes show <g>`; fix mistakes with `$CS dupes merge <ids>` /
  `$CS dupes split <ids>` (split findings are never auto-grouped again).
- `$CS query --primary-only` gives one finding per group.

## Match against tracker issues
1. Refresh the cache:
   - GitHub: `$CS tracker-sync gh [--repo owner/name] [--search "label:bug"]`
   - Jira: search with the Atlassian MCP tool (JQL such as `project = PROJ AND (labels = code-scan OR text ~ "<keywords>")`,
     fields key, summary, status, description); write the returned issues as a JSON array of
     `{key, summary, status, description, url}` to a temp file and run `$CS tracker-import jira --file <f>`.
   Issues created by `/code-scan:report` carry a `code-scan:fp=` marker and are linked automatically on sync.
2. `$CS match [filters]` → scores unreported findings against cached issues.
3. `$CS match export --out <f>` → candidates with score ≥ 3. If it has entries, spawn ONE agent per
   20 entries (model `haiku` is enough) with: "For each finding in <f> entries [i..j], decide whether
   any candidate issue describes the same bug (same code location/root cause, not just same area).
   Return JSON [{finding, tracker, key}] for matches only." Do not read the file yourself.
4. For each match: `$CS link <finding> <tracker> <key>` (kind linked_existing). Report counts.

## Findings in a directory/file
`$CS query --path <dir/|glob|file> [other filters]`.
