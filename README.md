# code-scan

Repository-wide bug scanning for Claude Code. MIT. Version 1.6.0.

Almost all coordination is done by a deterministic CLI (`bin/code-scan.js`, Node 22.5+, no
dependencies, SQLite via `node:sqlite`), so tokens go to reviewing code rather than orchestrating it.

## Install

```text
/plugin marketplace add dk-code-factory/code-scan
/plugin install code-scan@code-scan
```

## Skills

- `/code-scan:init` — benchmark reviewer models on a sample of the repo (quality, all-in $/100KB and
  $/1k lines, best chunk size per model) and pick the model scans use. Runs automatically before the
  first scan.
- `/code-scan:scan` — start, continue (same commit), restart (new HEAD; unchanged files skipped by
  content hash), stop. Takes a named profile or a free-text review focus, and `--only <dir>` scopes.
- `/code-scan:status` — progress, per-file state.
- `/code-scan:findings` — filter/sort/export findings (severity, category, path, triage, reported, …), read-only SQL.
- `/code-scan:triage` — confirmed / false_positive / fixed / wontfix, with notes.
- `/code-scan:confirm` — confirmation status (confirmed / not_confirmed / unchecked), separate from triage.
- `/code-scan:dupes` — duplicate groups and matching against existing GitHub/Jira issues.
- `/code-scan:auto-triage` — agent-driven triage of chosen findings (ids or filters) in groups of N
  (default 5): each agent checks its findings against the checkout, sets real / false positive / wontfix /
  unsure, corrects severity, estimates the production LOC of a fix (`fix_loc`) and links an existing GitHub
  issue or PR. Never files anything.
- `/code-scan:verify` — double-check one finding (or each of several) in a fresh agent against the upstream
  default branch: reproduce, search for existing reports, file only if real and new, record the outcome.
- `/code-scan:report` — file findings to GitHub (or Jira via the Atlassian MCP), persisting what was filed.
- `/code-scan:profiles` — review prompts: `default` (critical bugs, vulnerabilities, memory handling,
  leaks, panics, correctness), `security`, `memory`, `concurrency`, or your own.

## How a scan runs

1. **Inventory** — git-tracked files at the commit, classified as code or not by path and git
   attributes only; tests, docs, vendored and generated code are excluded.
2. **Plan** — one agent reads a directory digest and top-level build files (never sources) and
   corrects the code set, groups subsystems and gives each a review focus.
3. **Review** — the CLI packs files into chunks (same directory, same-stem files together; a file is
   never split) and a workflow starts one `reviewer` agent per chunk. Each claims a chunk, reviews,
   confirms candidates from the code (it never builds or runs anything) and submits.
4. **Store** — findings, per-file progress and a blob-sha ledger live in
   `~/.cache/code-scan/<repo>/codescan.db` (`CODESCAN_HOME` overrides).

## Spending limits

`--max-usd N` and `--max-5h-pct P` (on `start`/`restart`/`continue`, or `code-scan.js limits`) stop
handing out chunks once crossed; in-flight chunks finish and the scan stops with the reason recorded.
Dollars are list-price estimates summed from the scan's own agent transcripts. The 5-hour
subscription percentage is only exposed to the status line, so `code-scan.js statusline` saves it
(and prints a line, or wraps your existing command after `--`). Use it with a refresh interval so it
stays current while the session waits on background agents:

```json
"statusLine": { "type": "command", "command": "node <plugin>/bin/code-scan.js statusline", "refreshInterval": 30 }
```

A 5-hour limit with no snapshot from the last 15 minutes counts as crossed. Reviewers run in a fixed number of lanes
(10 by default), so after a limit trips at most one short agent per lane starts and gets nothing.
Calibration rounds are separate scans and do not count toward a scan's dollar cap.

## Chunk size

Review quality drops when a reviewer gets too much code at once. The chunk size is calibrated per
repo and model (`code-scan.js calibrate`, run automatically by `/code-scan:scan` the first time a model
scans a repo): a ~200KB sample is reviewed at the medium size, then half of it; if half is clearly
better it keeps halving, otherwise it grows by 1.5x until recall falls more than 0.15 below the best
seen. Recall of a round = severity-weighted share of all distinct issues found across rounds.

The medium default (40KB) comes from a calibration of claude-opus-5-5 on gocql (202KB sample of
the driver's Go code): 80KB → 0.46, 40KB → 0.71, 20KB → 0.56. Calibration cost there: 29 agents,
~1.3M subagent tokens, ~3.5 minutes.

Tests: `test/cli-e2e.sh` (no LLM; simulated reviewers, fake `gh`).

## Token cost

Coordination (the session running the skill, the planner, calibration decisions) is under 3% of a
scan. The rest is reviewers, and two things dominate their non-productive spend:

- **Preamble.** A default workflow agent inherits the parent session's system prompt and every tool,
  skill and MCP listing: 15k–28k tokens before any code, re-read on every turn. Reviewers and the
  planner run as the plugin's own agents (`agents/reviewer.md`, `agents/planner.md`: Bash + Read,
  short prompt): ~5k.
- **Turns.** Each turn re-reads the whole context. `claim --inline` hands over the code directly when
  it fits in one tool result (~24KB) and otherwise lists the files (paged at 1000 lines) for parallel
  Read calls in a single turn; findings for the whole chunk go in one batch `submit`.

Measured on the same 109–118KB of gocql (4–5 agents): 988k → 379k raw tokens, 2,958 → 2,174
price-weighted units per KB reviewed, 6.8 → 5.0 turns per reviewer, preamble share 18–40% → 7%,
with the same bugs found. Files are never split: a file larger than the chunk size is reviewed
alone by one agent.
