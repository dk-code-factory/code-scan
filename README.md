# code-scan

Repository-wide bug scanning for agentic coding CLIs: Claude Code, OpenAI Codex CLI, Gemini CLI,
Antigravity (`agy`), GitHub Copilot CLI, Cursor CLI and OpenCode. MIT. Version 2.0.0.

Almost all coordination is done by a deterministic CLI (`bin/code-scan.js`, Node 22.5+, no
dependencies, SQLite via `node:sqlite`), so tokens go to reviewing code rather than orchestrating it.

## Install

Claude Code:

```text
/plugin marketplace add dk-code-factory/code-scan
/plugin install code-scan@code-scan
```

Codex CLI (native manifests: `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`):

```text
codex plugin marketplace add dk-code-factory/code-scan
codex plugin add code-scan@code-scan
```

In Codex the skills are `code-scan:scan`, `code-scan:findings`, …. code-scan keeps its store in
`~/.cache/code-scan` and starts `codex exec` reviewers that need the network, which the Codex sandbox
blocks, so the skills run `code-scan.js` outside the sandbox through an escalation request (approve the
`node …/bin/code-scan.js` prefix once). With approvals off (`codex exec`, approval policy `never`) start
Codex with `--sandbox danger-full-access` instead.

Copilot CLI reads the Claude plugin manifest (`.claude-plugin/`):

```text
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

Which runner a scan uses is fixed by its review profile's model (see below): `<runner>:<model>` (e.g.
`codex:gpt-6.2-sol`, `gemini:gemini-3.1-pro-preview`, `opencode:anthropic/claude-sonnet-5-5`) runs on that
CLI, bare ids like `opus` on Claude. Auto-triage, calibration and `run-prompt` still pick with `--runner` /
`--model` → the model chosen at init → `$CODESCAN_RUNNER` → the agent CLI the command runs inside (parent
processes, then the variables hosts set such as `CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE`) →
the first CLI on `PATH`; `code-scan.js runners` shows what is installed.

```text
code-scan.js profile register sec-codex --prompt security --model codex:gpt-6.2-sol
code-scan.js start --profile sec-codex     # prints RUN <cmd> and NEXT {...}
code-scan.js run --detach                  # reviewers in the background (pid + log in `status`)
code-scan.js stop [--now]                  # --now kills the runner and releases claimed chunks
```

`auto-triage run`, `calibrate run`, `init run` and `run-prompt <file>` (one isolated agent, used by verify
outside Claude Code; `--full` gives it the host's unattended full-access mode) work the same way. `init`
can compare models across vendors: `init start --models sonnet,codex:gpt-6.2-sol,gemini:gemini-3.1-pro-preview`.
Extra arguments for one CLI: `CODESCAN_<RUNNER>_ARGS` (frozen into a review profile when it is registered, or
`profile register --runner-args "…"`; e.g. `CODESCAN_CODEX_ARGS="--sandbox workspace-write -c sandbox_workspace_write.network_access=true"`
so triage agents can run `gh`); another binary: `CODESCAN_<RUNNER>_BIN`.
Reasoning effort: `profile register --effort <level>` (frozen into the profile) and `auto-triage start|continue
--effort <level>`, `run-prompt --effort <level>`: claude `--effort low|medium|high|xhigh|max`, codex
`-c model_reasoning_effort=minimal|low|medium|high|xhigh|max|ultra` (narrowed to what the model lists in Codex's
`models_cache.json`, e.g. gpt-6.1-sol: low … ultra), opencode `--variant <any>`; Workflow agents get it as
their `effort`. Other runners have no effort setting.

## Model performance

https://dk-code-factory.github.io/code-scan/ compares reviewer models on real repositories (quality, false positives,
price, chunk size, reasoning effort) and recommends which to pick. Short version from those runs: Codex
`gpt-6.1-sol` at `xhigh` for full scans; effort raises recall, not precision; a second, different run finds more than a
higher effort level. The data is exported from local stores with `npm run site`
(`bin/site-export.js`: runs `scans`, `compare`, `init report` and `calibrate report` on copies of
`~/.cache/code-scan/*`, exports only aggregates, anonymizes repos not listed as public in `docs/site-config.json`);
pushing `docs/` to `main` publishes it.

## Skills

- `/code-scan:init` — benchmark reviewer models and reasoning efforts on two batches of the repo's code
  (its biggest files, and small files of one area) — quality, all-in $/100KB and $/1k lines, best chunk
  size per model and effort — and pick what scans use. Runs automatically before the first scan.
- `/code-scan:scan` — start, continue (same commit), restart (new HEAD; unchanged files skipped by
  content hash), repeat, stop. Runs one or several registered review profiles side by side.
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
- `/code-scan:profiles` — register review profiles (prompt + model + scope + chunk size, versioned) from
  prompts `default` (critical bugs, vulnerabilities, memory handling, leaks, panics, correctness),
  `security`, `memory`, `concurrency`, or your own.
- `/code-scan:compare` — compare scans (profiles/models on one commit, or one profile across commits);
  list, label, repeat and remove stored scans.

## Review profiles

A scan runs a registered review profile — an immutable spec of everything that shapes the review:

| field | |
|---|---|
| prompt | the review-focus text, frozen (from the prompt library: `default`, `security`, `memory`, `concurrency`, or `prompt add`) |
| reviewer instructions | the plugin's reviewer instructions at registration (runner reviewers and `--rules` get this copy) |
| runner, model, effort, runner args | e.g. `codex` / `codex:gpt-6.2-sol` / `--effort high` / `CODESCAN_CODEX_ARGS` at registration |
| chunk size | the repo's calibration for that model, or `--chunk-kb` |
| scope | `--only`, `--include`, `--exclude`, `--include-tests` |
| planner, dismissed context | `--no-plan`, `--no-dismissed` |

```text
code-scan.js profile register sec-opus  --prompt security --model opus
code-scan.js profile register sec-codex --prompt security --model codex:gpt-6.2-sol --only src/
code-scan.js profile list | show <ref> | diff sec-opus sec-codex | default <ref> | retire <ref>
```

Each profile is `name@version`, `#id` and a hash; refs accept any of them (a bare name is the latest
version). Registering an unchanged spec returns the existing version, a changed one the next version.
Scans refuse spec flags (`--model`, `--only`, `--chunk-kb`, …): those belong to a profile, so every scan
traces back to exactly how it ran. The hash keys the "already reviewed" ledger (a new model or prompt
re-reviews everything; the same profile skips unchanged files). `init pick` registers the `default`
profile. Run-time knobs (lanes, `--max-usd`, `--max-5h-pct`, commit) stay on the scan. Stores made by
1.x get `legacy-<prompt>@N` profiles for their past scans on first use.

## Parallel scans, repeating, comparing

`start --profile a,b,c` starts one scan per profile at the same commit; scans that use the planner share
one planner run (a Claude-model scan plans; the others adopt its plan), so they review the same code.
One Workflow (NEXT `follow`) serves all Claude-model scans; each other one runs from its own `RUN` line.
With several scans open, commands that act on one take `--scan <id|label|profile>`; `stop --close`
ends a scan for good.

Every scan stores its profile id/hash and a run record (plugin version and commit, node, runner binary,
version and exact argv, host). Each chunk records the hash of the exact prompt reviewers got and its
non-code context (subsystem hint, already-dismissed findings). `repeat <scan>` reruns it with the same
profile, commit, plan, chunks in the same order and the same dismissed context, and reports drift
(runner or plugin version, argv). Model sampling still varies between runs.

The same bug found by several scans is one finding (triage is shared); what each scan reported (severity,
type, line, title) is kept per scan (`show <id>`, table `seen`). A finding is marked gone only by a
rescan of the profile lineage that reported it.

```text
code-scan.js scans [--profile p] [--model m] [--status done]       # stored scans
code-scan.js compare sec-opus sec-codex                            # same commit: overlap, disagreements, quality vs $
code-scan.js compare 12 31                                         # same profile, two commits: new / gone / still there
code-scan.js query --scan sec-opus --not-seen-by sec-codex
code-scan.js repeat 12 | scans label 12 baseline | scans rm 12
```

`compare` on one commit uses only files every scan reviewed (same content) and reports per scan:
findings, unique, severity-weighted share of everything any of them found, confirmed and
false-positive counts from triage (precision), $ and $/100KB.

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

`init` searches model × effort × chunk size in stages instead of the full grid. The sample is two
batches matching the two chunk shapes a scan makes: **A**, the repo's biggest files (a file is never
split, so each is a chunk of its own at any size — only model and effort change how it is reviewed), and
**B**, small files of one area (packed several to a chunk — the shape the chunk size acts on). Each
candidate's score at a size is `wA·qA + wB·qB`, where `wA` is the share of the repo's code in files bigger
than that size; price is weighted the same way. Stages: every candidate is screened at 40KB and 90KB;
for runners with effort levels the default candidates are the lowest, middle and highest level, and one
level between the adjacent pair that differs most is added when the gap exceeds 0.15; candidates with no
non-dominated screen point near the best quality are pruned (at most 3 survive); survivors search for
their size — growing from 90KB when they hold up there, otherwise as above. An A round is reused for
every size at which batch A packs the same way. `--efforts` fixes the effort list, `--matrix` runs every
effort level and prunes nothing, `--sizes` replaces the search with fixed sizes (`--matrix --sizes …` is
the full grid).

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
