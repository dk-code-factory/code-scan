---
name: auto-triage
description: Triage code-scan findings with agents — split the chosen findings into groups of N (default 5), one agent per group checks each finding against the current checkout, decides real / false positive / wontfix / unsure, corrects the severity and type, estimates the production LOC of a fix and looks for an existing GitHub issue or PR, then records it all in the store. The user picks which findings (ids or filters). Use for "auto-triage the high findings", "validate findings 12 15 18", "triage everything unchecked in src/net in groups of 3". For marking states by hand use /code-scan:triage; for reproducing and filing one finding use /code-scan:verify.
---

# code-scan: auto-triage

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI (Codex, Copilot, …), the plugin root is the directory two levels above this SKILL.md: use its absolute path wherever this file says `${CLAUDE_PLUGIN_ROOT}`.

**Codex:** `$CS` writes its store under `~/.cache/code-scan` and starts agent CLIs that need the network, so the Codex sandbox blocks it. Run every `$CS` command outside the sandbox: request escalation (`sandbox_permissions: "require_escalated"`, proposing the prefix rule `["node", "<plugin root>/bin/code-scan.js"]` so the user approves it once). If escalation is unavailable (approval policy `never`, e.g. `codex exec`), do not work around it: tell the user to rerun Codex with `--sandbox danger-full-access` (or approvals on).

Agents only read code and search GitHub; nothing is built, run or filed. Invoking this skill is the user's
opt-in to the agent fan-out it launches. Do not read source files or findings yourself.

## 1. Selection

From the user's words build the selection, then preview it:

`$CS auto-triage plan <selection> [--group-size N]`

- ids: `12 15 18` or `12,15,18` → exactly those findings.
- filters (same as `query`): `--severity high+`, `--path src/net/`, `--category leak`, `--text ...`,
  `--scan N`, `--unit u`, `--group g`, ... Already-checked findings (confirmed/not_confirmed, false_positive,
  wontfix, fixed, linked to an issue) are skipped; "re-check"/"again" → add `--recheck`.
- nothing given → every open, unchecked finding.
- "groups of 3" → `--group-size 3` (default 5). Findings of the same file and of one dupe group stay together.

Show the user the group listing the command prints (it lists every finding id). If it selects more than 10
findings and the user did not already name the ids, ask them to confirm before starting.

## 2. Repository for the issue search

`gh repo view --json nameWithOwner,parent` in the repo: the upstream is `parent` (owner/name) if the checkout is a
fork, else `nameWithOwner`. If `gh` is unavailable or the repo is not on GitHub, start without `--repo` (the
issue search is skipped).

## 3. Start and launch

`$CS auto-triage start <same selection> [--group-size N] --repo <owner/name> [--concurrency N] [--model m] [--runner r] [--effort e]`
(`--concurrency` 1–32 agents at once, default 10; `--effort` reasoning effort — claude `low…max`, codex
`minimal…xhigh`, opencode any — only if the user asks, change it later with `auto-triage continue <run> --effort e`;
`--model`/`--runner` only if the user names one — the runner
otherwise is the agent CLI you are running in, as for scans). Its last lines are `RUN ...` and `NEXT {...}`.

With the `Workflow` tool and `"runner":"claude"` in NEXT:
```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/auto-triage.js", args: <the NEXT JSON object, verbatim> })
```
then `$CS auto-triage set-run <runId> <task id from the Workflow result>`. Otherwise run the printed `RUN`
command (it detaches and returns at once). Tell the user in one line which run is going and that
`$CS auto-triage status <runId>` shows progress. Do not poll.

When the completion notification arrives: `$CS auto-triage status <runId>`. If groups are still pending
(agents failed), `$CS auto-triage continue <runId>` and launch again the same way (at most 2 more rounds). Finish with the status output's verdict line plus the per-finding lines for `real` ones, and
point to `$CS query --ids <ids> --triage all --sort fix_loc` / `/code-scan:report` for filing.

## Stop

`$CS auto-triage stop [run]` — agents stop claiming; groups in progress finish. `--now` also kills a `RUN`
runner and releases its groups. `continue` resumes.

## What gets recorded per finding

| verdict | confirmation | triage |
|---|---|---|
| real | confirmed | confirmed (if it was open) |
| false_positive | not_confirmed | false_positive |
| wontfix | confirmed | wontfix |
| unsure | not_confirmed | unchanged |

A corrected severity or type is locked against rescans with a `[severity: old → new]` / `[type: old → new]` note; `fix_loc` (estimated
production lines of a fix) is stored and sortable/filterable (`--sort fix_loc`, `--max-fix-loc N`); an existing
issue or PR is linked as `linked_existing`; the agent's reason is appended to the note as
`[auto-triage run R: verdict] ...` (dismissed findings' notes are shown to future reviewers).
`$CS auto-triage status --all` lists runs.
