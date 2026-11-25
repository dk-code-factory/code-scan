---
name: confirm
description: Set the confirmation status of code-scan findings — confirmed (checked and real), not_confirmed (checked, could not confirm) or unchecked — by id or by filter, with a note. Independent of triage (open/fixed/wontfix/...). Use for "mark #12 as confirmed", "#3 and #5 not confirmed", "reset confirmation of 7", "which findings are confirmed".
---

# code-scan: confirm

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI, the CLI is `bin/code-scan.js` two directories above this SKILL.md file.

`$CS confirm <ids, comma or space separated> --set confirmed|not_confirmed|unchecked [--set-severity <sev>] [--note "how it was checked"]`
or with filters instead of ids (same filters as `query`, e.g. `--severity`, `--path`, `--confirmation`).
With filters, run `$CS query <same filters>` first and confirm the count with the user when it is more than 10.

Confirmation answers "did someone check this is real?" and does not touch triage: a finding can be
`open` + `confirmed`, or `fixed` + `not_confirmed`. `unchecked` resets it. The note is appended to the
finding's notes prefixed `[confirmation: <state>]`; give one whenever setting `confirmed`/`not_confirmed`.

Add `--set-severity critical|high|medium|low` when checking showed the severity is wrong: the old
value is recorded in the note (`[severity: old → new]`) and the severity is locked, so later rescans keep it.

Read back: `$CS query --confirmation confirmed` (comma list, or `all`); `$CS show <id>` prints
`confirmation=...`; the table marks `C` / `NC` after the triage state.

If the user asks you to decide whether a finding is real, `$CS show <id>`, read the cited code, decide, then
set the status with a one-line note. For end-to-end verification against upstream use `/code-scan:verify`.
