---
name: report
description: File code-scan findings as issues in GitHub or Jira, with tunable target, labels, grouping, severity threshold, triage requirement and templates, and persist what was filed so reported/unreported findings can be listed later. Checks for already-filed duplicates first. Use for "file the confirmed bugs to github", "report critical findings to jira project SCYLLADB", "configure bug reporting", "which findings are unreported".
---

# code-scan: report

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI (Codex, Copilot, …), the plugin root is the directory two levels above this SKILL.md: use its absolute path wherever this file says `${CLAUDE_PLUGIN_ROOT}`.

**Codex:** `$CS` writes its store under `~/.cache/code-scan` and starts agent CLIs that need the network, so the Codex sandbox blocks it. Run every `$CS` command outside the sandbox: request escalation (`sandbox_permissions: "require_escalated"`, proposing the prefix rule `["node", "<plugin root>/bin/code-scan.js"]` so the user approves it once). If escalation is unavailable (approval policy `never`, e.g. `codex exec`), do not work around it: tell the user to rerun Codex with `--sandbox danger-full-access` (or approvals on).

Filing issues is outward-facing: always show what will be filed and get an explicit yes first.
Never add Claude/Anthropic attribution to issue titles or bodies.

## Configure (once per repo; ask only for what is missing)
`$CS report-config show`. If `target` is unset, ask the user for it (`gh:owner/repo` or
`jira:PROJ`) and set it. Other keys only when the user mentions them:
`labels`, `assignee`, `group_by` (dupe-group default | finding | file | category | type), `min_severity`
(default high), `require_triage` (default confirmed; `any` = open+confirmed), `priority_map`
(JSON), `issue_type`/`components` (Jira), `title_template`, `body_template` (file path; variables
`{{title}} {{severity}} {{severity_upper}} {{type}} {{category}} {{path}} {{basename}} {{line}} {{count}}
{{commit}} {{short_commit}} {{findings}} {{locations}} {{severities}}`), `max_per_run`, `dedupe_trackers` (comma list a finding must have been searched in, e.g. `gh:o/r,jira:PROJ`),
`code_repo` (owner/repo for permalinks), `marker` (yes/no). Set with `$CS report-config set <k> <v>`.
One-off overrides on render: `--target`, `--group-by`, `--min-severity`, `--triage`, `--max`,
`--label`, plus any query filter (`--path`, `--severity`, `--ids`, ...).

## File
1. Avoid refiling: findings are checked for an existing report by the auto-triage agent that validates
   them (`/code-scan:auto-triage --repo … [--jira …]`). `render` files only findings whose triager reported a
   successful (`done`) search of every tracker in `dedupe_trackers` (default: the target); the rest are listed
   as HELD. Run `$CS dupes` if `group_by` is dupe-group.
2. `$CS render [overrides]` → prints draft count, HELD findings, warnings (e.g. commit not pushed — tell the
   user; permalinks need it on the remote) and a manifest path. HELD findings: re-triage them with the command
   it prints; never pass `--allow-unsearched` unless the user explicitly says to file without a duplicate check.
   0 drafts → say why (no confirmed findings? use `/code-scan:triage`, or `--triage any`).
3. `$CS drafts` and show the user: target, the draft list (titles), and the full body of the first
   draft (read that one body file only). Ask for confirmation — every time, even if the user asked earlier
   to "publish" or "file": filing is public and hard to undo, and the drafts are what they approve.
4. On yes:
   - GitHub: `$CS file-gh` (or `--drafts d-..,d-..` for a subset). It creates the issues and records them.
   - Jira: for each draft in the manifest, create the issue with the Atlassian MCP create-issue
     tool (project from target, summary = title, description = body file contents (markdown; pass it as markdown, not wiki markup), issue type,
     labels, components, priority from the manifest), then
     `$CS record-filing <draft> jira:PROJ <KEY> <url>` right after each creation.
5. Report: number filed, links to the first few. Reported state is persisted:
   `$CS query --reported` / `--unreported` lists them later.

Manual bookkeeping: `$CS link <id|gN> <tracker> <key> --kind filed|linked_existing|skipped`,
`$CS unlink <id> [tracker] [key]`.
