---
name: init
description: Initialize code-scan for a repository — benchmark reviewer models (Opus, Sonnet, Haiku, Fable) and reasoning efforts on two batches of the repo's code (its biggest files, and small files), find each candidate's best chunk size, compare quality against all-in price ($ per 100KB / per 1k lines, including every agent's preamble and coordination tokens), and let the user pick the model and effort scans will use. Use for "init code-scan", "set up the bug scanner for this repo", "which model should scan this repo", "re-benchmark models"; /code-scan:scan runs it first on a repo that has no model chosen.
---

# code-scan: init

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI (Codex, Copilot, …), the plugin root is the directory two levels above this SKILL.md: use its absolute path wherever this file says `${CLAUDE_PLUGIN_ROOT}`.

**Codex:** `$CS` writes its store under `~/.cache/code-scan` and starts agent CLIs that need the network, so the Codex sandbox blocks it. Run every `$CS` command outside the sandbox: request escalation (`sandbox_permissions: "require_escalated"`, proposing the prefix rule `["node", "<plugin root>/bin/code-scan.js"]` so the user approves it once). If escalation is unavailable (approval policy `never`, e.g. `codex exec`), do not work around it: tell the user to rerun Codex with `--sandbox danger-full-access` (or approvals on).

Do not read source files or the database; the CLI does the work.

State is shared between hosts: scans, findings, triage, calibration and progress use the same repo
store. Default model and profile choices are saved per runner in that store. Use Codex models when
invoked from Codex and Claude agents when invoked from Claude Code, unless the user explicitly names
other models or a runner. Do not select a foreign model merely because an old benchmark used it.

1. `$CS init status`. If a model is already chosen for this host and the user did not ask to re-run, report it and stop.
2. `$CS init start [--models opus,sonnet,haiku,fable] [--efforts e1,e2] [--matrix] [--sizes 20,40,90] [--only <dir/>]`
   — default: the configured Codex model inside Codex; the four Claude models inside Claude Code.
   Omit `--models` unless the user specifies models; the CLI detects the host. If a non-Claude host
   has no configured benchmark model, use the CLI's diagnostic to request a model for that runner.
   Other vendors' models run through their own CLI and are compared the same way: `codex:<model>`
   (e.g. `codex:gpt-6.2-sol`), `gemini:<model>` (e.g. `gemini:gemini-3.1-pro-preview`), `agy:`, `copilot:`,
   `cursor:`, `opencode:<provider/model>`. `$CS runners` shows which CLIs are installed (a model whose CLI is missing fails).
   Reasoning effort: by default each model whose CLI has effort levels (claude, codex) is tried at its
   lowest, middle and highest level, plus one level in between where quality differs; models without
   effort control get one candidate. Pass `--efforts` only when the user names levels ("only high and max").
   The search is staged (screen at 40/90KB → effort refine → prune → chunk-size search for at most 3
   survivors). If the user asks for the full / whole matrix, pass `--matrix` (every effort level, nothing
   pruned) and, if they want every size too, `--sizes <list>` (every candidate runs exactly those sizes);
   warn that this multiplies the cost.
   If the user wants it cheaper, drop `fable` (most expensive) or pass fewer models or `--efforts`.
   Last lines: `RUN ...` and `NEXT {...}`.
   Before launching, tell the user in one line what the output's first lines say: candidates (model ×
   effort), the two sample batches (A biggest files, B small files) and the first step's rounds and
   reviewer agents (this costs real usage; on a subscription it draws on the 5-hour window).
3. If you have the `Workflow` tool and every entry of NEXT `rounds` has `"runner":"claude"`:
   `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/init.js", args: <the NEXT object> })` and wait
   for the completion notification. Otherwise run the printed `RUN` command (`init run <id> --detach`)
   and tell the user it runs in the background; `$CS init status` shows when every candidate is done. Do not poll.
4. `$CS init report` and show its table to the user as is (it is short): per candidate (model, effort)
   the chosen chunk size, qA / qB (share of all distinct issues found by any candidate in the biggest-files
   / small-files batch), the combined quality (weighted by how much of this repo's code is in big files),
   all-in $/100KB and $/1kLOC, and status (done, pruned, failed); then the recommendation (cheapest
   candidate within 10% of the best quality).
5. Ask the user which model and effort to use (recommended first, each option showing quality and
   $/100KB; use your question/choice tool if you have one). Then `$CS init pick <model> [--effort <level>]`
   (without `--effort` it takes the recommended effort for that model, or the only one) and report the
   model, effort, chunk size and the registered profile in one line.

`init pick` registers that model, effort and chunk size with the default prompt as (a new version of) the
`default` (Claude) or `default-<runner>` (other runners) review profile and makes it the default for
`start` on that runner. Other candidates stay usable: register a
profile for them (`/code-scan:profiles`, with `--effort`) and run several side by side.
