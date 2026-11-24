---
name: triage
description: Mark code-scan findings as confirmed, false_positive, fixed, wontfix or open, with notes — by id or by filter (e.g. "all low findings in tests/ are wontfix"); set or classify finding types (crash, leak, logic, ...). Triage state persists across rescans (a fixed finding that reappears is reopened). Use for "mark 12 and 15 false positive", "confirm #3", "these are fixed", "#7 is a leak, not a crash", "classify the findings by type".
---

# code-scan: triage

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

`$CS triage <ids, comma or space separated> --set confirmed|false_positive|fixed|wontfix|open [--note "why"]`
or with filters instead of ids (same filters as `query`: `--severity`, `--path`, `--category`,
`--scan`, `--text`, `--group`, ...). With filters, run `$CS query <same filters>` first and confirm
the count with the user when it is more than 10.

If the user asks you to judge whether a finding is real, `$CS show <id>`, read the cited code,
decide, then triage with a one-line note giving the reason. Only `confirmed` findings are filed
by default (`/code-scan:report`).

Always give the reason with `--note` when marking `false_positive` or `wontfix`: reviewers of later
scans are shown dismissed findings for their files with that note, so they do not report them again.

To have agents check findings in bulk (verdict, severity, fix size, existing issue), use `/code-scan:auto-triage`.

## Types

`$CS retype <ids|filters> --set <type> [--note "why"]` — set the type (locked against rescans). Types:
crash memory-safety leak concurrency data-integrity logic error-handling integer validation security dos other.

"Classify / retype findings": run `$CS retype --auto [filters]` (fills untyped, unlocked findings from their
category; `--force` recomputes all unlocked ones), then `$CS retype --list-other [filters]`, decide each
leftover's type from its category, title and detail (do not read source), and apply with one
`$CS retype <ids> --set <type>` per type. Report the counts per type.

`$CS issues-sync` updates findings from their linked GitHub issues (closed completed → fixed, not planned → wontfix).
