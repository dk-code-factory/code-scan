---
name: triage
description: Mark code-scan findings as confirmed, false_positive, fixed, wontfix or open, with notes — by id or by filter (e.g. "all low findings in tests/ are wontfix"). Triage state persists across rescans (a fixed finding that reappears is reopened). Use for "mark 12 and 15 false positive", "confirm #3", "these are fixed".
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
