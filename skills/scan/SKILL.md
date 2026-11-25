---
name: scan
description: Scan a whole git repository for bugs with parallel reviewer agents — critical issues, vulnerabilities, memory handling, leaks, panics, correctness by default, or any review focus the user describes. Handles start, continue (same commit), restart (new HEAD, unchanged files skipped by content hash), and stop. Use when asked to "scan the repo for bugs", "audit the codebase", "continue/restart/stop the bug scan". Results go to a persistent store read with the code-scan findings/report skills.
---

# code-scan: scan

All bookkeeping is done by the CLI. Your job is ~3 tool calls; spend no tokens on coordination.

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI, the CLI is `bin/code-scan.js` two directories above this SKILL.md file.

**Hard rules.** Do not read source files, chunk manifests, the database, `tree.txt`, or worker
transcripts. Do not re-verify, summarize or list findings yourself (point the user to
`/code-scan:findings`). Do not narrate. Invoking this skill is the user's explicit opt-in to the
agent fan-out it launches, at whatever size the repo needs.

**Runner.** Reviewer agents are either Claude Code `Workflow` agents or headless agent CLI processes
started by code-scan itself (`claude`, `codex`, `gemini`, `agy`, `copilot`, `cursor`, `opencode`). The CLI
picks the runner: `--runner <name>` or a `--model <runner>:<model>` → the model chosen at init → the agent
CLI this command runs inside → the first one installed. `$CS runners` shows what it would pick and why.
Pass `--runner` only if the user names a tool ("scan with codex"); a model like "gpt-6.2-sol" →
`--model codex:gpt-6.2-sol`, "gemini 3.1 pro" → `--model gemini:gemini-3.1-pro-preview`.

## 1. Pick the verb from the user's words

- no verb → `continue` if `$CS status` shows a scan `[active]` or `[stopped]`, else `start`
- "start"/"scan" → `start`; if it refuses because a scan is open, ask the user: continue it, or
  `restart` (new HEAD)
- "continue"/"resume" → `continue --model <id>` (same commit)
- "calibrate"/"recalibrate chunk size" → only §2a
- "restart"/"rescan"/"new commit" → `restart`
- "stop"/"pause" → see §4
- "rescan everything"/"ignore cache" → add `--force`; "re-review src/x" → `--force-path src/x/`

Review focus:
- a named profile ("security", "memory", "concurrency", or one the user saved) → `--profile <name>`
- free text ("look only for races in the storage layer") → write it, expanded into a clear
  reviewer instruction list in the style of `${CLAUDE_PLUGIN_ROOT}/profiles/default.md`, to
  `$TMPDIR/code-scan-focus.md` and pass `--prompt-file` that file. Mention a path restriction
  with `--include`/`--exclude` only if the user asked for it.
- nothing said → default profile

Scope: "only src/x and lib/y" → `--only src/x/ --only lib/y/` (restricts the scan; repeatable).
`--include <glob>` instead *adds* non-code files to the code set; `--exclude <glob>` drops files.
On `restart`, scope flags replace the previous scan's scope entirely; "whole repo again" →
`restart --reset-scope`.

Spending limits (on `start`/`restart`/`continue`, or later with `$CS limits`): "stop at $20" →
`--max-usd 20`; "stop when the 5-hour subscription window is 80% used" → `--max-5h-pct 80`. Once a
limit is crossed, workers get no new chunks, in-flight ones finish, and the scan stops with the
reason in `$CS status`; `continue` resumes when it clears. Dollars are list-price estimates from the
scan's own agents' token usage (the copilot runner reports none, so `--max-usd` is refused there).
`--max-5h-pct` works only with the claude runner. The 5-hour percentage needs the Claude Code status
line: if `$CS limits` reports it unknown, tell the user to set `statusLine` to
`{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js statusline","refreshInterval":30}`
(or `... statusline -- <their existing command>` to keep their own line), and do not start without it.

Concurrency: "run 4 at a time" → `--concurrency 4` (1–32 reviewers at once; default 10; the Workflow
harness caps a workflow at 16). A running run keeps its count: to change it, `$CS stop`, wait for the
run to end, then `$CS continue --concurrency N` and launch again.

Other flags only when asked: `--include-tests`, `--chunk-kb N` (skips calibration), `--include <glob>`, `--exclude <glob>`,
`--no-plan` (skip planner), `--replan` (restart only).

## 2. Run the verb

`$CS <verb> [flags]` (run it from the repo, or add `-C <repo>` before the verb). Reviewers use the
repo's model chosen at init (and its chunk size); pass `--model <id or opus|sonnet|haiku|fable>` only
if the user names one. Its last lines are `RUN <command>` and `NEXT {...}`. If `workers` is 0 and `plan` is false,
report "nothing to review" and stop.

### 2.0 Initialize first (repo without a chosen model)

If the output contains an `INIT` line and the user did not name a model or `--chunk-kb`: run the
`/code-scan:init` flow (benchmark models, user picks one), then `$CS continue --model <picked>` —
it re-chunks the pending scan for that model and prints a fresh `NEXT`. Use that in step 3.

### 2a. Calibrate chunk size (a named model not covered by init)

If the output contains a `CALIBRATE` line and the user did not pass `--chunk-kb` or say to skip
calibration, calibrate before launching the scan. It reviews a ~200KB sample of the repo at several
chunk sizes (starting at the medium default, then smaller, then growing until quality drops) and
stores the best size for this repo + model:

1. `$CS calibrate start --model <id> [--profile p]` → last line `NEXT {...}`. If it prints
   `DONE chunk_kb=...` instead (repo too small to calibrate), skip to step 3's `continue`.
2. Launch (see §3 for which way): Workflow →
   `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/calibrate.js", args: { ...that NEXT object, scanScript: "${CLAUDE_PLUGIN_ROOT}/workflows/scan.js" } })`;
   otherwise run the printed `RUN` command (`calibrate run <id>`). Tell the user in one line that
   calibration is running. Do not poll.
3. On completion: `$CS calibrate status` (one line to the user: chosen size and why), then
   `$CS continue --model <id>` — it re-chunks the pending scan with the calibrated size and prints
   a fresh `NEXT`. Use that `NEXT` in step 3. If calibration failed, continue with the default.

`$CS calibrate set <model> <kb>` records a size by hand; `calibrate start` again re-calibrates.

## 3. Launch

**Claude Code with the `Workflow` tool, and `"runner":"claude"` in NEXT (or no runner):**
```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/scan.js", args: <the NEXT JSON object, verbatim> })
```
Then `$CS set-run <scanId> <task id from the Workflow result>`.

**Anything else** (another agent CLI, no Workflow tool, or a non-claude runner): run the printed `RUN`
command exactly as printed (it ends in `--detach`: code-scan starts the reviewer processes in the
background and returns at once with their pid and log file). Do not start reviewer agents yourself.

Tell the user in one line that the scan is running and that `/code-scan:status` shows progress. Do not
poll. With Workflow, wait for the completion notification; with `RUN`, check `$CS status` when the user
asks (it shows whether the runner process is still running).

When it has finished: run `$CS status`. If chunks are still pending and the scan is `[active]` (cap
reached or agents failed), run `$CS continue` and launch again the same way (at most 3 rounds without
progress). Finish with one line: files reviewed, findings by severity, and "see /code-scan:findings".

## 4. Stop

`$CS stop` — workers stop claiming; in-flight chunks finish and are recorded. If the user wants it
stopped immediately: `$CS stop --now` — it kills a `RUN` runner itself; for a Workflow it prints
`TASK <id>`: `TaskStop` that task. Everything unfinished stays pending for `continue`.
