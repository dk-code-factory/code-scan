---
name: scan
description: Scan a whole git repository for bugs with parallel reviewer agents — critical issues, vulnerabilities, memory handling, leaks, panics, correctness by default, or any review focus the user describes, on any model; several review profiles (types and/or models) can run side by side. Handles start, continue (same commit), restart (new HEAD, unchanged files skipped by content hash), repeat (rerun a past scan exactly), and stop. Use when asked to "scan the repo for bugs", "audit the codebase", "continue/restart/stop the bug scan". Results go to a persistent store read with the code-scan findings/report skills.
---

# code-scan: scan

All bookkeeping is done by the CLI. Your job is ~3 tool calls; spend no tokens on coordination.

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI (Codex, Copilot, …), the plugin root is the directory two levels above this SKILL.md: use its absolute path wherever this file says `${CLAUDE_PLUGIN_ROOT}`.

**Codex:** `$CS` writes its store under `~/.cache/code-scan` and starts agent CLIs that need the network, so the Codex sandbox blocks it. Run every `$CS` command outside the sandbox: request escalation (`sandbox_permissions: "require_escalated"`, proposing the prefix rule `["node", "<plugin root>/bin/code-scan.js"]` so the user approves it once). If escalation is unavailable (approval policy `never`, e.g. `codex exec`), do not work around it: tell the user to rerun Codex with `--sandbox danger-full-access` (or approvals on).

**Hard rules.** Do not read source files, chunk manifests, the database, `tree.txt`, or worker
transcripts. Do not re-verify, summarize or list findings yourself (point the user to
`/code-scan:findings`). Do not narrate. Invoking this skill is the user's explicit opt-in to the
agent fan-out it launches, at whatever size the repo needs.

**Review profiles.** A scan runs a registered review profile (`$CS profile list`): prompt, model and
runner, runner CLI args, chunk size, scope and planner, frozen under a version and hash so every result
traces back to exactly how it ran. Scans never take `--model`, `--runner`, `--prompt-file`, `--chunk-kb`,
`--only`, `--include`, `--exclude`, `--no-plan` — those go into a profile (`/code-scan:profiles`). Without
`--profile`, `start` uses the default profile (set by `init pick` or `$CS profile default <ref>`).

**Runner.** Reviewer agents are either Claude Code `Workflow` agents or headless agent CLI processes
started by code-scan itself (`claude`, `codex`, `gemini`, `agy`, `copilot`, `cursor`, `opencode`); the
profile's model decides which (`codex:…` runs on codex, a bare Claude model on claude). `$CS runners` shows
what is installed.

## 1. Pick the verb from the user's words

- no verb → `continue` if `$CS status` shows a scan `[active]` or `[stopped]`, else `start`
- "start"/"scan" → `start`; if it refuses because that profile already has an open scan, ask the user:
  continue it, or `restart --profile <name>` (new HEAD)
- "continue"/"resume" → `continue` (same commit; `--scan <id|label|profile>` when several are open —
  the CLI lists them)
- "calibrate"/"recalibrate chunk size" → only §2a
- "restart"/"rescan"/"new commit" → `restart` (`--profile p` for one lineage, `--all` for every open one)
- "rerun scan N exactly"/"repeat" → `repeat <N>` (same profile, commit, plan, chunks; prints drift)
- "stop"/"pause" → see §4
- "rescan everything"/"ignore cache" → add `--force`; "re-review src/x" → `--force-path src/x/`

Review profile — map the user's words to registered profiles (`$CS profile list`):
- a registered name → `--profile <name>`; several ("security on opus and on codex", "default and
  concurrency") → `--profile a,b` (one scan each, side by side, sharing one planner run)
- a review focus, model, scope or chunk size with no matching profile ("security with gemini",
  "only src/net", "look only for races in storage") → register one first as in `/code-scan:profiles`
  (prompt from `$CS prompt list` or written from the user's words; `--model`, `--only`, …), show the
  user the registered line, then `--profile <it>`
- nothing said → no flag (the default profile)

`--label <name>` names the scan (one label per profile, or one that gets the profile name appended).

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

Other flags only when asked: `--replan` (restart only), `--new` (start: supersede that profile's open scan).

## 2. Run the verb

`$CS <verb> [flags]` (run it from the repo, or add `-C <repo>` before the verb). Its last lines are one `RUN <command>` per scan and one `NEXT {...}` (the Workflow args covering the
Claude-model scans: `scanId` plus a `follow` list). If `workers` is 0, `plan` is false and there is no
`follow`, report "nothing to review" and stop.

### 2.0 Initialize first (repo without a review profile)

If `start` prints an `INIT` line (exit code 2; nothing was created) and the user named no model: run the
`/code-scan:init` flow (benchmark models, user picks one; `init pick` registers the `default` profile),
then run `start` again. If the user named a model, register a profile for it instead (`/code-scan:profiles`).

### 2a. Calibrate chunk size (a model not covered by init)

When `profile register` notes that the model has no chunk-size calibration in this repo and the user did
not give `--chunk-kb` or say to skip calibration, calibrate before starting the scan. It reviews a ~200KB sample of the repo at several
chunk sizes (starting at the medium default, then smaller, then growing until quality drops) and
stores the best size for this repo + model:

1. `$CS calibrate start --model <id> [--prompt p]` → last line `NEXT {...}`. If it prints
   `DONE chunk_kb=...` instead (repo too small to calibrate), go to step 3.
2. Launch (see §3 for which way): Workflow →
   `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/calibrate.js", args: { ...that NEXT object, scanScript: "${CLAUDE_PLUGIN_ROOT}/workflows/scan.js" } })`;
   otherwise run the printed `RUN` command (`calibrate run <id>`). Tell the user in one line that
   calibration is running. Do not poll.
3. On completion: `$CS calibrate status` (one line to the user: chosen size and why), then register the
   profile again with the same flags — it picks up the calibrated size as a new version — and `start`
   it. If calibration failed, keep the default size.

`$CS calibrate set <model> <kb>` records a size by hand; `calibrate start` again re-calibrates.

## 3. Launch

**Claude Code with the `Workflow` tool, and `"runner":"claude"` in NEXT (or no runner):**
```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/scan.js", args: <the NEXT JSON object, verbatim> })
```
Then `$CS set-run <scanId>[,<follow scanIds>…] <task id from the Workflow result>`. That one Workflow
reviews NEXT's `scanId` and every scan in its `follow` list. Then also run the printed `RUN` line of
every scan NOT covered by NEXT (non-Claude models), exactly as printed.

**Anything else** (another agent CLI, no Workflow tool, or NEXT's runner is not claude): run every
printed `RUN` command exactly as printed (each ends in `--detach`: code-scan starts that scan's reviewer
processes in the background and returns at once with their pid and log file; a scan that adopts another
scan's plan waits for it by itself). Do not start reviewer agents yourself.

Tell the user in one line that the scan is running and that `/code-scan:status` shows progress. Do not
poll. With Workflow, wait for the completion notification; with `RUN`, check `$CS status` when the user
asks (it shows whether the runner process is still running).

When it has finished: run `$CS status` (one block per open scan). If chunks are still pending and a scan
is `[active]` (cap reached or agents failed), run `$CS continue --scan <id>` and launch again the same
way (at most 3 rounds without progress). Finish with one line per scan: files reviewed, findings by
severity, and "see /code-scan:findings"; with several scans, add "compare with /code-scan:compare".

## 4. Stop

`$CS stop` (`--scan s` when several are open, `--all` for all) — workers stop claiming; in-flight
chunks finish and are recorded. If the user wants it stopped immediately: `$CS stop --now` — it kills a
`RUN` runner itself; for a Workflow it prints `TASK <id>`: `TaskStop` that task. Everything unfinished
stays pending for `continue`. "Abandon"/"close" a scan for good: `$CS stop --scan s --close`.

`continue` preserves claims younger than one hour when resuming a stopped scan, including a spending-limit
stop, while it queues other unfinished files. A live `RUN` runner's fresh claims are preserved on active
scans too. A dead `RUN` runner's claims are released immediately.
Use `continue --reclaim` to release all claims when their reviewers have been stopped.
Planning is deferred while chunks remain claimed; remaining heuristic chunks can still proceed.
