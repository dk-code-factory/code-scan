---
name: profiles
description: Manage code-scan review profiles — the registered, versioned spec a scan runs (review prompt, model and runner, runner CLI args, chunk size, scope, planner) — and the prompt library they are made from (builtins default, security, memory, concurrency, or your own). Register, list, show, diff, set the default, retire; add/edit prompts. Use for "create a review profile for X", "security review on codex", "same review with gemini", "what does the security profile check", "what changed between profile versions", "make the scan look for Y".
---

# code-scan: profiles

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI (Codex, Copilot, …), the plugin root is the directory two levels above this SKILL.md: use its absolute path wherever this file says `${CLAUDE_PLUGIN_ROOT}`.

**Codex:** `$CS` writes its store under `~/.cache/code-scan` and starts agent CLIs that need the network, so the Codex sandbox blocks it. Run every `$CS` command outside the sandbox: request escalation (`sandbox_permissions: "require_escalated"`, proposing the prefix rule `["node", "<plugin root>/bin/code-scan.js"]` so the user approves it once). If escalation is unavailable (approval policy `never`, e.g. `codex exec`), do not work around it: tell the user to rerun Codex with `--sandbox danger-full-access` (or approvals on).

A scan only runs a **registered review profile**: an immutable spec of everything that shapes the
review — the prompt text (frozen copy), the reviewer instructions of the plugin version that
registered it, runner and model, extra runner CLI arguments, chunk size, scope, planner on/off and
whether reviewers see already-dismissed findings. Each profile has a name, a version (`name@N`), an
id (`#12`) and a hash. Every scan records which one it ran, so results trace back to it and
`repeat` can rerun it exactly. Registering an unchanged spec returns the existing version; any
change makes the next version (old scans keep pointing at theirs).

Refs everywhere: `name` (latest version), `name@2`, `#12`, or a hash prefix.

## Register

1. Prompt (the review focus): a builtin (`$CS prompt list`: default, security, memory, concurrency), a
   saved one, or a new one — write a reviewer instruction list in the style of
   `${CLAUDE_PLUGIN_ROOT}/profiles/default.md` (what to report, each class concrete; what to skip;
   severity meaning) to a temp file and show it to the user. Save reusable ones with
   `$CS prompt add <name> --file <f>`.
2. `$CS profile register <name> --prompt <prompt> | --prompt-file <f> --model <model> [flags]`
   - `--model`: `opus`/`sonnet`/`haiku`/`fable`, `codex:<model>`, `gemini:<model>`, `agy:`, `copilot:`,
     `cursor:`, `opencode:<provider/model>`; `default` = the model picked at init for this host's runner.
     Unless the user names a model or runner, use the host's runner: Codex models inside Codex, Claude
     agents inside Claude Code. All profiles, scans and findings remain in the same shared repo store.
   - `--effort <level>` — reasoning effort, part of the profile ("high effort", "think harder" → `high`/`xhigh`):
     claude `low|medium|high|xhigh|max`, codex `minimal|low|medium|high|xhigh`, opencode any `--variant`;
     other runners have none. Omitted = the CLI's own default.
   - `--chunk-kb N` (default: this repo's calibration for that model, else 40), `--only <dir/|glob>`,
     `--include <glob>`, `--exclude <glob>`, `--include-tests`, `--no-plan`, `--no-dismissed`,
     `--runner-args "…"` (default: `CODESCAN_<RUNNER>_ARGS` at registration), `--note "…"`.
3. Relay the printed `name@N #id hash` line and the spec summary.

"Same review on another model" = register a second profile with the same `--prompt` and another
`--model`, then start both (`/code-scan:scan`) and compare (`/code-scan:compare`).

## Other

- `$CS profile list [--all-versions] [--retired]` · `$CS profile show <ref> [--full]` (spec, prompt, scans that used it)
- `$CS profile diff <ref> <ref>` — which spec fields differ, prompt lines added/removed
- `$CS profile default [<ref>]` — what `start` runs without `--profile` on that profile's runner
  (a bare name follows new versions); `--profile <ref>` explicitly selects any runner
- `$CS profile retire|unretire <ref>` — hide from `list`; scans and results stay
- Prompts: `$CS prompt list | show <name> | add <name> --file f | rm <name>` — editing a prompt does not
  change any registered profile; register again to use the new text.

The profile's hash keys the "already reviewed" ledger, so a new version re-reviews every file on
the next `restart`, while unchanged versions skip unchanged files.
