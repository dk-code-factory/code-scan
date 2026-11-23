export const meta = {
  name: 'code-scan',
  description: 'Repo-wide bug scan: optional planner agent, then reviewer agents that each claim one chunk from code-scan.js',
  whenToUse: 'Started by the code-scan:scan skill with the NEXT args printed by code-scan.js',
  phases: [
    { title: 'Plan', detail: 'one agent: classify code and group it into review units from the directory digest' },
    { title: 'Review', detail: 'one agent per chunk; each claims, reviews, verifies and submits per file' },
  ],
}

const CLI = `${args.home ? `CODESCAN_HOME=${args.home} ` : ''}node ${args.cli} -C ${args.root}`

const PLAN_PROMPT = `You plan a repository bug scan. Run:
  ${CLI} plan-context ${args.scanId}
and follow the INSTRUCTIONS it prints. Look only at the digest, top-level build/manifest files and
directory listings — never at source files. Write your plan JSON to a temp file and apply it with
  ${CLI} apply-plan ${args.scanId} --file <file>
If apply-plan rejects it, fix the plan and rerun until it succeeds. Return the chunk count it printed
(the number after "chunks=").`

// The reviewer's standing instructions live in agents/reviewer.md (a minimal-tool agent, so each
// turn re-reads a small preamble); the per-run prompt only carries the command.
const WORKER_PROMPT = `Run: ${CLI} claim --inline ${args.scanId}
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

let workers = args.workers || 0
if (args.plan) {
  phase('Plan')
  const r = await agent(PLAN_PROMPT, {
    label: 'planner',
    phase: 'Plan',
    schema: { type: 'object', properties: { chunks: { type: 'integer' }, notes: { type: 'string' } }, required: ['chunks'] },
  })
  if (r && typeof r.chunks === 'number') workers = r.chunks
  else log('planner failed; reviewing with the heuristic chunking')
}

const cap = Math.min(workers, 900)
if (workers > cap) log(`${workers - cap} chunks left for the next run (per-run cap 900) — run continue`)
phase('Review')
log(`reviewing ${cap} chunk(s)`)
const results = await parallel(Array.from({ length: cap }, (_, i) => () =>
  agent(WORKER_PROMPT, { label: `review ${i + 1}/${cap}`, phase: 'Review', schema: WORKER_SCHEMA, agentType: args.agentType || 'code-scan:reviewer' })))
const ok = results.filter((r) => r && r.chunk !== null)
return {
  chunks_reviewed: ok.length,
  files: ok.reduce((s, r) => s + (r.files || 0), 0),
  findings: ok.reduce((s, r) => s + (r.findings || 0), 0),
  failed_agents: results.filter((r) => !r).length,
}
