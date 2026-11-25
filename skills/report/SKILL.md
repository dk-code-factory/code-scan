---
name: report
description: File code-scan findings as issues in GitHub or Jira, with tunable target, labels, grouping, severity threshold, triage requirement and templates, and persist what was filed so reported/unreported findings can be listed later. Checks for already-filed duplicates first. Use for "file the confirmed bugs to github", "report critical findings to jira project SCYLLADB", "configure bug reporting", "which findings are unreported".
---

# code-scan: report

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI, the CLI is `bin/code-scan.js` two directories above this SKILL.md file.

Filing issues is outward-facing: always show what will be filed and get an explicit yes first.
Never add Claude/Anthropic attribution to issue titles or bodies.

## Configure (once per repo; ask only for what is missing)
`$CS report-config show`. If `target` is unset, ask the user for it (`gh:owner/repo` or
`jira:PROJ`) and set it. Other keys only when the user mentions them:
`labels`, `assignee`, `group_by` (dupe-group default | finding | file | category | type), `min_severity`
(default high), `require_triage` (default confirmed; `any` = open+confirmed), `priority_map`
(JSON), `issue_type`/`components` (Jira), `title_template`, `body_template` (file path; variables
`{{title}} {{severity}} {{severity_upper}} {{type}} {{category}} {{path}} {{basename}} {{line}} {{count}}
{{commit}} {{short_commit}} {{findings}} {{locations}} {{severities}}`), `max_per_run`,
`code_repo` (owner/repo for permalinks), `marker` (yes/no). Set with `$CS report-config set <k> <v>`.
One-off overrides on render: `--target`, `--group-by`, `--min-severity`, `--triage`, `--max`,
`--label`, plus any query filter (`--path`, `--severity`, `--ids`, ...).

## File
1. Avoid refiling: run the tracker matching from `/code-scan:dupes` (sync → match → adjudicate →
   link) unless it was done in this session. Run `$CS dupes` if `group_by` is dupe-group.
2. `$CS render [overrides]` → prints draft count, warnings (e.g. commit not pushed — tell the user;
   permalinks need it on the remote) and a manifest path. 0 drafts → say why (no confirmed
   findings? use `/code-scan:triage`, or `--triage any`).
3. `$CS drafts` and show the user: target, the draft list (titles), and the full body of the first
   draft (read that one body file only). Ask for confirmation.
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
