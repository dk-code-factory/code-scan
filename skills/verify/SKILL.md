---
name: verify
description: Double-check a single code-scan finding (or each of several, separately) against the upstream repository's default branch in a fresh agent with no inherited context — reproduce it if possible, search for existing GitHub issues/PRs, file an issue only if it is real and new, and record the outcome (confirmed + issue link, linked to an existing report, false_positive or wontfix with the reason) so it is never investigated again. Use for "verify finding 12", "is #8 real? file it if so", "double check the high findings and open issues".
---

# code-scan: verify

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

For each finding id the user gives (one agent per finding, never batched into one agent):

1. `$CS show <id>`. If it is already `false_positive`/`wontfix` or already has an issue link, say so and skip
   it unless the user explicitly asks to re-check.
2. Upstream repo and base (once per run): in the scanned repo, `gh repo view --json nameWithOwner,parent` —
   the upstream is `parent` (owner/name) if the checkout is a fork, else `nameWithOwner`. Then take the branch from
   the upstream itself: `gh repo view <upstream> --json defaultBranchRef -q .defaultBranchRef.name` (a fork's
   default branch may differ). `git fetch https://github.com/<upstream>.git <that branch>` and
   `BASE=$(git rev-parse FETCH_HEAD)` (full sha).
   Findings are verified on the upstream default branch, not on the scanned checkout (which may be a branch).
3. Worktree per finding: `git worktree add --detach <scratchpad>/verify-<id> $BASE`.
4. Prompt: `$CS verify-prompt <id> --repo <upstream> --base $BASE --worktree <that dir> > <scratchpad>/verify-<id>.md`.
5. Launch `Agent` with `subagent_type: "general-purpose"`, `run_in_background: true`, and the prompt file's
   contents as `prompt` — nothing else: no summary of this conversation, so the agent starts with no inherited
   context. Several findings → one Agent call per finding, all in the same message.
6. When each agent finishes: relay its verdict and issue URL in one line; check `$CS show <id>` shows the triage
   state and link it was told to record (record it yourself from its report if it did not); then
   `git worktree remove --force <dir>` (and its `-target` build dir if one was created).
7. After several filings, list the new issues (`gh issue list --repo <upstream> --search "created:>=<today>"`)
   and make sure none duplicates another one or an older issue.

Filing issues is public: only do it because the user asked for verification and filing of these findings.

## Status tools (for the agent and for later updates)

- `$CS triage <id> --set confirmed|false_positive|wontfix|fixed|open --note "<why>"` — verdict; the note is
  shown to future reviewers of the file for dismissed findings, so always give the reason.
- `$CS link <id> gh:<owner/repo> <number> --kind filed|linked_existing --url <url>` / `$CS unlink <id> [tracker] [key]`
  — which issue covers the finding.
- `$CS issues-sync` — refresh the state of every linked GitHub issue or PR: closed as completed (or PR merged) →
  finding `fixed`, closed as not planned → `wontfix`, reopened → back to `confirmed`; duplicates and closes
  without a reason are recorded but leave the finding alone. `$CS show <id>` prints the state.
