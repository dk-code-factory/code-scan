---
name: findings
description: Browse code-scan results — filter, sort and export findings by severity, category, directory or file, triage state, reported/unreported, scan, staleness, confidence or text; show one finding in full; run arbitrary read-only SQL over the store. Use for "show critical bugs", "what did the scan find in src/net", "unreported memory issues sorted by file", "export findings as csv", "details of #42".
---

# code-scan: findings

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

Translate the request into flags; run once; relay. Don't read source to re-check findings unless
the user asks you to investigate a specific one.

`$CS query` flags (all combinable):
- `--severity critical,high` or `--severity high+` · `--category memory,leak` (substring)
- `--path src/net/` (dir) · `--path 'src/**/*.cc'` (glob) · `--path src/a.cc` (file)
- `--triage open,confirmed` (default) · `--triage all` · `--triage false_positive`
- `--confirmation confirmed|not_confirmed|unchecked` (comma list; default: any) — table marks `C` / `NC`
- `--reported [--tracker gh|jira:PROJ]` · `--unreported`
- `--scan N` · `--latest` (found in latest scan) · `--stale` / `--no-stale` (file changed since)
- `--gone` / `--include-gone`: findings not re-reported when their changed file was re-reviewed
  (likely fixed) are hidden by default
- `--min-confidence 0.7` · `--text "use after free"` · `--unit <planner unit>`
- `--group G` · `--dupe-of ID` · `--primary-only` (one per duplicate group) · `--ids 1,2,3`
- `--sort severity:desc,path,line` (fields: severity path line confidence created updated category triage id title unit; `-field` = desc)
- `--limit N` · `--format table|md|json|csv` · `--out file`

Details: `$CS show <id>` (detail, evidence, filings, duplicate group, tracker candidates).
Anything else: `$CS sql "SELECT ..."` (read-only). Tables: findings, seen(finding_id,scan_id),
files(scan_id,path,state,...), scans, filings(finding_id,tracker,key,url,kind), dupe_groups,
tracker_issues, match_candidates. Use `$CS sql "PRAGMA table_info(findings)"` for columns.

Output: the table output is already compact — show it as is. For md/json/csv exports or more than
~50 rows, use `--out <file>` and give the user the path and count. For `/fix-findings`, export
`--format md --out <file>` and hand that file over.
