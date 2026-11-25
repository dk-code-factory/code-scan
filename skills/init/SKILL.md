---
name: init
description: Initialize code-scan for a repository — benchmark reviewer models (Opus, Sonnet, Haiku, Fable) on a sample of the repo's code, find each model's best chunk size, compare quality against all-in price ($ per 100KB / per 1k lines, including every agent's preamble and coordination tokens), and let the user pick the model scans will use. Use for "init code-scan", "set up the bug scanner for this repo", "which model should scan this repo", "re-benchmark models"; /code-scan:scan runs it first on a repo that has no model chosen.
---

# code-scan: init

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI, the CLI is `bin/code-scan.js` two directories above this SKILL.md file.

Do not read source files or the database; the CLI does the work.

1. `$CS init status`. If a model is already chosen and the user did not ask to re-run, report it and stop.
2. `$CS init start [--models opus,sonnet,haiku,fable] [--only <dir/>]` — default: the four Claude models.
   Other vendors' models run through their own CLI and are compared the same way: `codex:<model>`
   (e.g. `codex:gpt-6.2-sol`), `gemini:<model>` (e.g. `gemini:gemini-3.1-pro-preview`), `agy:`, `copilot:`,
   `cursor:`, `opencode:<provider/model>`. If you are not Claude Code, suggest adding your own CLI's main
   model(s) to the list; `$CS runners` shows which CLIs are installed (a model whose CLI is missing fails).
   If the user wants it cheaper, drop `fable` (most expensive) or pass fewer models. Last lines: `RUN ...`
   and `NEXT {...}`.
   Before launching, tell the user in one line: models, sample size, and that each model reviews the
   sample at 2–4 chunk sizes (this costs real usage; on a subscription it draws on the 5-hour window).
3. If you have the `Workflow` tool and every entry of NEXT `runs` has `"runner":"claude"`:
   `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/init.js", args: <the NEXT object> })` and wait
   for the completion notification. Otherwise run the printed `RUN` command (`init run <id> --detach`)
   and tell the user it runs in the background; `$CS init status` shows when every model is done. Do not poll.
4. `$CS init report` and show its table to the user as is (it is short): per model the chosen chunk
   size, quality (share of all distinct issues found by any model), all-in $/100KB and $/1kLOC, and
   the recommendation (cheapest model within 10% of the best quality).
5. Ask the user which model to use (recommended first, each option showing quality and $/100KB; use your
   question/choice tool if you have one). Then `$CS init pick <model>` and report the model and its chunk size in one line.

Scans then default to that model and chunk size; `--model` on a scan still overrides.
