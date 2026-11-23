export const meta = {
  name: 'code-scan-init',
  description: 'Repo initialization: calibrate several reviewer models on one code sample to compare quality, price and chunk size',
  whenToUse: 'Started by the code-scan:init skill with the NEXT args printed by `code-scan.js init start`',
  phases: [
    { title: 'Review', detail: 'per model: review the sample at one chunk size per round' },
    { title: 'Decide', detail: 'per model: code-scan.js scores the rounds and picks the next size' },
  ],
}

// args: { cli, root, home?, initId, runs: [{ calId, model, scanId, workers }] }
// Self-contained (no nested workflow): each model runs its own rounds, all models in parallel.
const CLI = `${args.home ? `CODESCAN_HOME=${args.home} ` : ''}node ${args.cli} -C ${args.root}`
const WORKER_SCHEMA = {
  type: 'object',
  properties: { chunk: { type: ['integer', 'null'] }, files: { type: 'integer' }, findings: { type: 'integer' } },
  required: ['chunk', 'files', 'findings'],
}
const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    chunk_kb: { type: ['integer', 'null'] },
    next: { type: ['object', 'null'], properties: { scanId: { type: 'integer' }, workers: { type: 'integer' } } },
    note: { type: 'string' },
  },
  required: ['done'],
}

let pluginAgents = true
async function run(prompt, opts) {
  if (pluginAgents && opts.agentType) {
    try {
      return await agent(prompt, opts)
    } catch (e) {
      if (!/agent type .* not found/i.test(String((e && e.message) || e))) throw e
      if (pluginAgents) log(`${opts.agentType} is not loaded in this session (restart Claude Code to use it); using the default agent`)
      pluginAgents = false
    }
  }
  const { agentType, ...rest } = opts
  // the default agent lacks the reviewer instructions: have claim print them
  return agent(prompt.replace(' claim --inline ', ' claim --inline --rules '), rest)
}

async function reviewRound(m, round) {
  const lanes = Math.max(1, Math.min(round.workers, 6))
  let started = 0
  await parallel(Array.from({ length: lanes }, () => async () => {
    let failures = 0
    while (started < 300) {
      const n = ++started
      const r = await run(`Run: ${CLI} claim --inline ${round.scanId}
Then follow your instructions. Final reply: {"chunk": <id or null>, "files": <files submitted>, "findings": <findings submitted>}.`,
        { label: `${m.label || m.model} ${round.scanId}.${n}`, phase: 'Review', schema: WORKER_SCHEMA, agentType: 'code-scan:reviewer', ...(m.model ? { model: m.model } : {}) })
      if (!r) { if (++failures >= 2) break; continue }
      failures = 0
      if (r.chunk === null) break
    }
  }))
}

const results = await parallel(args.runs.map((m) => async () => {
  let round = { scanId: m.scanId, workers: m.workers }
  for (let i = 0; i < 8 && round; i++) {
    if (round.workers > 0) await reviewRound(m, round)
    const r = await agent(`Run exactly this command and report its result, nothing else:
  ${CLI} calibrate next ${m.calId}
If its last line starts with "DONE chunk_kb=<N>", return {"done": true, "chunk_kb": N, "note": <that line>}.
If its last line starts with "NEXT ", parse the JSON after it and return {"done": false, "next": {"scanId": <scanId>, "workers": <workers>}, "note": <the line before it>}.`,
      { label: `${m.label || m.model} decide ${i + 1}`, phase: 'Decide', model: 'haiku', effort: 'low', schema: DECIDE_SCHEMA })
    if (!r) { log(`${m.label || m.model}: decision step failed`); return { model: m.label || m.model, chunk_kb: null } }
    log(`${m.label || m.model}: ${r.note || ''}`)
    if (r.done) return { model: m.label || m.model, chunk_kb: r.chunk_kb }
    round = r.next
  }
  return { model: m.label || m.model, chunk_kb: null }
}))
return { initId: args.initId, models: results.filter(Boolean) }
