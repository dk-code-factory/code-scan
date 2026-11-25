# code-scan

Repository-wide bug scanning for agentic coding CLIs: Claude Code, OpenAI Codex CLI, Gemini CLI,
Antigravity (`agy`), GitHub Copilot CLI, Cursor CLI and OpenCode. MIT. Version 1.7.0.

Almost all coordination is done by a deterministic CLI (`bin/code-scan.js`, Node 22.5+, no
dependencies, SQLite via `node:sqlite`), so tokens go to reviewing code rather than orchestrating it.

## Install

Claude Code:

```text
/plugin marketplace add dk-code-factory/code-scan
/plugin install code-scan@code-scan
```

Codex CLI and Copilot CLI read Claude plugin manifests (`.claude-plugin/`) and `${CLAUDE_PLUGIN_ROOT}`:

```text
codex plugin marketplace add dk-code-factory/code-scan      # then: codex plugin add code-scan
copilot plugin install dk-code-factory/code-scan
```

Gemini CLI (Antigravity can import it with `agy plugin import gemini`):

```text
gemini extensions install https://github.com/dk-code-factory/code-scan
```

Any host that reads Agent Skills (Cursor, OpenCode, and the above if their plugin route does not work for
you): clone the repo and render its skills into `~/.agents/skills` (`--project` for `<repo>/.agents/skills`,
`--dir` for another skills directory; `--uninstall` removes them):

```text
git clone https://github.com/dk-code-factory/code-scan && node code-scan/bin/code-scan.js install
```

Outside Claude Code the skills are named `code-scan-scan`, `code-scan-findings`, … instead of
`/code-scan:scan`, `/code-scan:findings`, ….

## Runners

Reviewer, planner and triage agents run either as Claude Code `Workflow` agents (Claude Code with a
Claude model, as before) or as headless processes of an agent CLI started by `code-scan.js run` — which
works from any host, a plain shell or CI. The runner claims work and stores results itself, so these
agents are read-only: they get the code and reply with JSON.

| runner | binary | started as | usage / cost |
|---|---|---|---|
| claude | `claude` | `claude -p --output-format json`, read-only tool allowlist | tokens + reported USD |
| codex | `codex` | `codex exec --json --sandbox read-only` | tokens (priced from the list below) |
| gemini | `gemini` | `gemini -p -o json`, read-only tool allowlist | tokens |
| agy | `agy` | `agy -p --output-format json` | tokens |
| copilot | `copilot` | `copilot -p --output-format=json`, read-only shell allowlist, writes denied | none reported |
| cursor | `cursor-agent` / `agent` | `-p --output-format json` | tokens if reported |
| opencode | `opencode` | `opencode run --format json`, edits denied, read-only bash allowlist | tokens + reported USD |

Which runner a scan uses: `--runner <name>` or `--model <runner>:<model>` (e.g. `codex:gpt-6.2-sol`,
`gemini:gemini-3.1-pro-preview`, `opencode:anthropic/claude-sonnet-5-5`) → the model chosen at init (bare
ids like `opus` are Claude) → `$CODESCAN_RUNNER` → the agent CLI the command runs inside (parent processes,
then the variables hosts set such as `CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE`) → the first CLI
on `PATH`. The choice is saved with the scan; `code-scan.js runners` shows what is installed and what a new
scan would use.

```text
code-scan.js start --runner codex          # prints RUN <cmd> and NEXT {...}
code-scan.js run --detach                  # reviewers in the background (pid + log in `status`)
code-scan.js stop [--now]                  # --now kills the runner and releases claimed chunks
```

`auto-triage run`, `calibrate run`, `init run` and `run-prompt <file>` (one isolated agent, used by verify
outside Claude Code; `--full` gives it the host's unattended full-access mode) work the same way. `init`
can compare models across vendors: `init start --models sonnet,codex:gpt-6.2-sol,gemini:gemini-3.1-pro-preview`.
Extra arguments for one CLI: `CODESCAN_<RUNNER>_ARGS` (e.g. `CODESCAN_CODEX_ARGS="--sandbox workspace-write -c sandbox_workspace_write.network_access=true"`
so triage agents can run `gh`); another binary: `CODESCAN_<RUNNER>_BIN`.

## Skills

- `/code-scan:init` — benchmark reviewer models on a sample of the repo (quality, all-in $/100KB and
  $/1k lines, best chunk size per model) and pick the model scans use. Runs automatically before the
  first scan.
- `/code-scan:scan` — start, continue (same commit), restart (new HEAD; unchanged files skipped by
  content hash), stop. Takes a named profile or a free-text review focus, and `--only <dir>` scopes.
- `/code-scan:status` — progress, per-file state.
- `/code-scan:findings` — filter/sort/export findings (severity, type, category, path, triage, reported, …), read-only SQL.
- `/code-scan:triage` — confirmed / false_positive / fixed / wontfix, with notes; set or classify finding types.
- `/code-scan:confirm` — confirmation status (confirmed / not_confirmed / unchecked), separate from triage.
- `/code-scan:dupes` — duplicate groups and matching against existing GitHub/Jira issues.
- `/code-scan:auto-triage` — agent-driven triage of chosen findings (ids or filters) in groups of N
  (default 5): each agent checks its findings against the checkout, sets real / false positive / wontfix /
  unsure, corrects severity and type, estimates the production LOC of a fix (`fix_loc`) and links an existing GitHub
  issue or PR. Never files anything.
- `/code-scan:verify` — double-check one finding (or each of several) in a fresh agent against the upstream
  default branch: reproduce, search for existing reports, file only if real and new, record the outcome.
- `/code-scan:report` — file findings to GitHub (or Jira via the Atlassian MCP), persisting what was filed.
- `/code-scan:profiles` — review prompts: `default` (critical bugs, vulnerabilities, memory handling,
  leaks, panics, correctness), `security`, `memory`, `concurrency`, or your own.

## Finding types

Every finding has a fixed `type` next to the reviewer's free-form `category` (which stays part of the
finding's fingerprint). Reviewers pick it, auto-triage agents confirm or correct it, and findings without one
get it from their category. A type set by triage or by hand (`retype`, `confirm --set-type`) is locked
against rescans and noted as `[type: old → new]`.

| type | covers |
|---|---|
| `crash` | panic, nil/null dereference, unhandled exception, failed assert, stack overflow |
| `memory-safety` | use-after-free/move, out-of-bounds, uninitialized read, undefined behavior, buffer misuse |
| `leak` | memory/fd/goroutine/permit/resource leak, missing cleanup, unbounded growth |
| `concurrency` | data race, deadlock, atomicity violation, lifecycle/ordering race |
| `data-integrity` | data loss or corruption, wrong data persisted or returned |
| `logic` | wrong result, off-by-one, broken invariant, wrong query or generated code |
| `error-handling` | swallowed/ignored error, wrong error propagation, exception safety |
| `integer` | overflow, underflow, truncation, sign error |
| `validation` | missing input/argument/length checks on untrusted or caller data |
| `security` | injection, authn/authz, TLS verification, path traversal, info leak, XSS |
| `dos` | resource exhaustion, infinite loop, unbounded recursion |
| `other` | anything else |

`query --type crash,leak`, `--sort type`, report `group_by type` and `{{type}}` in templates.

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
Dollars are list-price estimates summed from the scan's own agent transcripts (Workflow) and from
the token usage each runner agent reports (CLI-reported USD when there is one; unknown models are priced at
their vendor's most expensive known model and marked estimated). The copilot runner reports no usage, so
`--max-usd` is refused there; `--max-5h-pct` needs the claude runner. The 5-hour
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

Tests: `test/cli-e2e.sh` (no LLM; simulated reviewers, fake `gh`) and `test/runners-e2e.sh` (every runner,
with `test/fake-runners/fake-agent.js` standing in for each agent CLI).

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
