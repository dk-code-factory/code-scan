export const meta = {
  name: 'code-scan',
  description: 'Repo-wide bug scan: optional planner agent, then reviewer agents that each claim one chunk from code-scan.js',
  whenToUse: 'Started by the code-scan:scan skill with the NEXT args printed by code-scan.js',
  phases: [
    { title: 'Plan', detail: 'one agent: classify code and group it into review units from the directory digest' },
    { title: 'Review', detail: 'one agent per chunk; each claims, reviews, verifies and submits per file' },
  ],
}

// shell word: bare when plainly safe, single-quoted otherwise (same rule as the CLI's own command lines)
const shw = (t) => (/^[\w@%+=:,./-]+$/.test(String(t)) ? String(t) : `'${String(t).replace(/'/g, `'\\''`)}'`)
const CLI = `${args.home ? `CODESCAN_HOME=${shw(args.home)} ` : ''}node ${shw(args.cli)} -C ${shw(args.root)}`

const PLAN_PROMPT = `You plan a repository bug scan. Run:
  ${CLI} plan-context ${args.scanId}
and follow the INSTRUCTIONS it prints. Look only at the digest, top-level build/manifest files and
directory listings — never at source files. Write your plan JSON to a temp file and apply it with
  ${CLI} apply-plan ${args.scanId} --file <file>
If apply-plan rejects it, fix the plan and rerun until it succeeds. Return the chunk count it printed
(the number after "chunks=").`

// The reviewer's standing instructions live in agents/reviewer.md (a minimal-tool agent, so each
// turn re-reads a small preamble); the per-run prompt only carries the command.
const workerPrompt = (scanId) => `Run: ${CLI} claim --inline ${scanId}
Then follow your instructions. Final reply: {"chunk": <id or null>, "files": <files submitted>, "findings": <findings submitted>}.`

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    chunk: { type: ['integer', 'null'] },
    files: { type: 'integer' },
    findings: { type: 'integer' },
  },
  required: ['chunk', 'files', 'findings'],
}

// Plugin agents load at session start: in a session older than the plugin install, its agent types
// are missing. Fall back to the default workflow agent (bigger preamble) instead of failing.
let pluginAgents = true
async function run(prompt, opts) {
  if (pluginAgents && opts.agentType) {
    try {
      return await agent(prompt, opts)
    } catch (e) {
      if (!/agent type .* not found/i.test(String(e && e.message || e))) throw e
      if (pluginAgents) log(`${opts.agentType} is not loaded in this session (restart Claude Code to use it); using the default agent`)
      pluginAgents = false
    }
  }
  const { agentType, ...rest } = opts
  // the default agent lacks the reviewer instructions: have claim print them
  return agent(prompt.replace(' claim --inline ', ' claim --inline --rules '), rest)
}

let workers = args.workers || 0
if (args.plan) {
  phase('Plan')
  const r = await run(PLAN_PROMPT, {
    label: 'planner',
    agentType: args.plannerType || 'code-scan:planner',
    ...(args.model ? { model: args.model } : {}),
    phase: 'Plan',
    schema: { type: 'object', properties: { chunks: { type: 'integer' }, notes: { type: 'string' } }, required: ['chunks'] },
  })
  if (r && typeof r.chunks === 'number') workers = r.chunks
  else log('planner failed; reviewing with the heuristic chunking')
}

// Reviewers run in lanes rather than one queued agent per chunk: each lane keeps starting
// reviewers until one gets NONE (no chunk left, scan stopped, or a spending limit crossed), so a
// crossed limit costs at most one short agent per lane instead of one per remaining chunk.
// `follow`: further scans of the same batch (other review profiles, possibly other models) that
// adopted this scan's plan; their lanes run alongside, each with its own model.
const scans = [{ scanId: args.scanId, workers, model: args.model, lanes: args.lanes }, ...(args.follow || [])]
  .filter((x) => x.workers > 0)
if (!scans.length) return { chunks_reviewed: 0, files: 0, findings: 0, failed_agents: 0 }
phase('Review')
let started = 0
const results = []
await parallel(scans.flatMap((sc) => {
  const lanes = Math.max(1, Math.min(sc.workers, sc.lanes || 10, 900))
  log(`scan ${sc.scanId}: ${sc.workers} chunk(s) in ${lanes} lane(s)${sc.model ? ` on ${sc.model}` : ''}`)
  return Array.from({ length: lanes }, () => async () => {
    let failures = 0
    while (started < 900) {
      const n = ++started
      const r = await run(workerPrompt(sc.scanId), { label: `scan ${sc.scanId} review ${n}`, phase: 'Review', schema: WORKER_SCHEMA, agentType: args.agentType || 'code-scan:reviewer', ...(sc.model ? { model: sc.model } : {}) })
      results.push(r)
      if (!r) { if (++failures >= 2) break; continue }
      failures = 0
      if (r.chunk === null) break
    }
  })
}))
if (started >= 900) log('per-run cap of 900 reviewers reached — run continue for the rest')
const ok = results.filter((r) => r && r.chunk !== null)
return {
  scans: scans.map((x) => x.scanId),
  chunks_reviewed: ok.length,
  files: ok.reduce((s, r) => s + (r.files || 0), 0),
  findings: ok.reduce((s, r) => s + (r.findings || 0), 0),
  failed_agents: results.filter((r) => !r).length,
}
