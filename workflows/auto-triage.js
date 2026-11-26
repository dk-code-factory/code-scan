export const meta = {
  name: 'code-scan-auto-triage',
  description: 'Triage code-scan findings in groups: one agent per group checks each finding, corrects severity, estimates fix size, links existing GitHub issues',
  whenToUse: 'Started by the code-scan:auto-triage skill with the NEXT args printed by `code-scan.js auto-triage start`',
  phases: [
    { title: 'Triage', detail: 'one agent per group of findings; each claims, checks, searches issues and submits' },
  ],
}

// shell word: bare when plainly safe, single-quoted otherwise (same rule as the CLI's own command lines)
const shw = (t) => (/^[\w@%+=:,./-]+$/.test(String(t)) ? String(t) : `'${String(t).replace(/'/g, `'\\''`)}'`)
const CLI = `${args.home ? `CODESCAN_HOME=${shw(args.home)} ` : ''}node ${shw(args.cli)} -C ${shw(args.root)}`

// Standing instructions live in agents/triager.md (minimal-tool agent); the prompt only carries the command.
const PROMPT = `Run: ${CLI} auto-triage claim ${args.runId}
Then follow your instructions. Final reply: {"group": <id or null>, "findings": <findings submitted>}.`

const SCHEMA = {
  type: 'object',
  properties: { group: { type: ['integer', 'null'] }, findings: { type: 'integer' } },
  required: ['group', 'findings'],
}

// Plugin agents load at session start: fall back to the default agent (claim then prints the
// triager instructions) when the plugin agent type is missing in this session.
let pluginAgents = true
async function run(prompt, opts) {
  if (pluginAgents) {
    try {
      return await agent(prompt, { ...opts, agentType: args.agentType || 'code-scan:triager' })
    } catch (e) {
      if (!/agent type .* not found/i.test(String(e && e.message || e))) throw e
      log('code-scan:triager is not loaded in this session (restart Claude Code to use it); using the default agent')
      pluginAgents = false
    }
  }
  return agent(prompt.replace(' auto-triage claim ', ' auto-triage claim --rules '), opts)
}

const groups = args.groups || 0
if (!groups) return { groups: 0, findings: 0, failed_agents: 0 }
const LANES = Math.max(1, Math.min(groups, args.lanes || 10, 16))
phase('Triage')
log(`triaging ${groups} group(s) in ${LANES} lane(s)`)
let started = 0
const results = []
await parallel(Array.from({ length: LANES }, () => async () => {
  let failures = 0
  while (started < groups + LANES * 2) {
    const n = ++started
    const r = await run(PROMPT, { label: `triage ${n}`, phase: 'Triage', schema: SCHEMA, ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}) })
    results.push(r)
    if (!r) { if (++failures >= 2) break; continue }
    failures = 0
    if (r.group === null) break
  }
}))
const ok = results.filter((r) => r && r.group !== null)
return {
  groups: ok.length,
  findings: ok.reduce((s, r) => s + (r.findings || 0), 0),
  failed_agents: results.filter((r) => !r).length,
}
