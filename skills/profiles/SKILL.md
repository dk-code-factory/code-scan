---
name: profiles
description: Manage code-scan review profiles — the reviewer prompt that defines what kind of review the scan does (default critical bugs; builtins security, memory, concurrency). List, show, create from a description, edit, delete. Use for "create a review profile for X", "what does the security profile check", "make the scan look for Y".
---

# code-scan: profiles

```bash
CS="node ${CLAUDE_PLUGIN_ROOT}/bin/code-scan.js"
```

If the plugin root above was not filled in by your agent CLI, the CLI is `bin/code-scan.js` two directories above this SKILL.md file.

- List: `$CS profile list` · Show: `$CS profile show <name>`
- Create/edit from a description: write a reviewer instruction list in the style of
  `${CLAUDE_PLUGIN_ROOT}/profiles/default.md` (what to report, each class concrete; what to skip;
  severity meaning) to a temp file, show it to the user, then `$CS profile add <name> --file <f>`.
  For edits start from `$CS profile show <name>`.
- Delete: `$CS profile rm <name>`

Profiles are stored per repo. A profile's text hash keys the "already reviewed" ledger, so editing
a profile makes the next `restart` re-review everything under the new instructions.
Use with `/code-scan:scan --profile <name>`.
