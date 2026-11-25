---
name: compare
description: Compare code-scan scans — different review profiles or models on the same commit (what each found, what only one found, severity/type disagreements, quality vs cost), or the same profile at two commits (new, gone, still there); list, show, label, repeat and remove stored scans. Use for "compare opus and codex", "which model found more", "what did the security scan find that the default didn't", "what changed since last week's scan", "rerun scan 12 exactly", "list past scans", "delete scan 7".
---

# code-scan: compare

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI, the CLI is `bin/code-scan.js` two directories above this SKILL.md file.

Do not read source files or the database; relay CLI output.

A scan ref is a scan id, a label, or a profile (`name` = its latest scan, `name@N` / `#id` / hash = that
version's latest scan; `compare` prefers finished scans).

## Find the scans

`$CS scans [--profile p] [--model m] [--commit rev] [--status done] [--label l]` — id, label, profile@version
and hash, model, commit, status, files, findings, $. `$CS scans show <ref>` — profile spec, commit, run-time
knobs, run record (plugin version/commit, node, runner binary + version + exact argv, host), drift.

## Compare

`$CS compare <ref> <ref> [<ref> …] [--severity high+] [--type t] [--path p] [--list none|diff|all] [--limit n] [--json]`

- **Same commit** (e.g. two profiles started together): compared on the files every scan reviewed. Shows
  which spec fields differ, a quality-vs-cost table (findings, unique, severity-weighted share of
  everything any of them found, confirmed / false-positive counts and precision from triage, $ and
  $/100KB), found-by-all / only-X counts by severity, and severity/type/line disagreements.
  `--list diff` (default) lists only-X findings and disagreements; `all` also the shared ones.
- **Same profile, different commits**: new (and whether on code the earlier scan also reviewed), gone
  (on re-reviewed changed files), still there (found again, or on unchanged files that were skipped).

Show the summary and table as printed; for long lists use `--limit` or `--json --out`-style redirection
and give the user counts. Precision needs triage — suggest `/code-scan:auto-triage` on the
`only X` findings (`$CS query --scan A --not-seen-by B`) when the user wants to know who is right.

## Store

- `$CS scans label <ref> <label>` · `$CS repeat <ref> [--commit same|<rev>] [--label l]` — same profile,
  commit, plan, chunks and dismissed-findings context; prints any drift in runner/plugin versions, then
  `RUN`/`NEXT`: launch as in `/code-scan:scan` §3.
- `$CS scans rm <ref> [--dry-run]` — ask first. Deletes findings only that scan reported unless they were
  triaged, confirmed or filed (those stay).

Per-finding: `$CS show <id>` lists every scan that reported it with its own severity, type, line and title.
