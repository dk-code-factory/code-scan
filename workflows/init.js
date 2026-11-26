export const meta = {
  name: 'code-scan-init',
  description: 'Repo initialization: benchmark reviewer models and reasoning efforts on two code batches (biggest files, small files) to compare quality, price and chunk size',
  whenToUse: 'Started by the code-scan:init skill with the NEXT args printed by `code-scan.js init start`',
  phases: [
    { title: 'Review', detail: 'every round of the step at once: one candidate (model + effort), one batch, one chunk size' },
    { title: 'Decide', detail: 'code-scan.js init next: screen → effort refine → prune → size search, and the next rounds' },
  ],
}

// args: { cli, root, home?, initId, rounds: [{ scanId, workers, model?, effort?, runner, label }] }
// Self-contained (no nested workflow). Each step reviews all of its rounds in parallel, then one cheap
// agent runs `init next`, which scores them and creates the next step's rounds.
// shell word: bare when plainly safe, single-quoted otherwise (same rule as the CLI's own command lines)
const shw = (t) => (/^[\w@%+=:,./-]+$/.test(String(t)) ? String(t) : `'${String(t).replace(/'/g, `'\\''`)}'`)
const CLI = `${args.home ? `CODESCAN_HOME=${shw(args.home)} ` : ''}node ${shw(args.cli)} -C ${shw(args.root)}`
// reviewer agents at once in one step, shared among its rounds by size
const LANES = 16
const WORKER_SCHEMA = {
  type: 'object',
  properties: { chunk: { type: ['integer', 'null'] }, files: { type: 'integer' }, findings: { type: 'integer' } },
  required: ['chunk', 'files', 'findings'],
}
const ROUND = {
  type: 'object',
  properties: { scanId: { type: 'integer' }, workers: { type: 'integer' }, model: { type: 'string' }, effort: { type: 'string' }, label: { type: 'string' } },
  required: ['scanId', 'workers'],
}
const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    rounds: { type: 'array', items: ROUND },
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

async function reviewRound(round, lanes) {
  let started = 0
  await parallel(Array.from({ length: lanes }, () => async () => {
    let failures = 0
    while (started < 300) {
      const n = ++started
      const r = await run(`Run: ${CLI} claim --inline ${round.scanId}
Then follow your instructions. Final reply: {"chunk": <id or null>, "files": <files submitted>, "findings": <findings submitted>}.`,
        { label: `${round.label || round.scanId}.${n}`, phase: 'Review', schema: WORKER_SCHEMA, agentType: 'code-scan:reviewer',
          ...(round.model ? { model: round.model } : {}), ...(round.effort ? { effort: round.effort } : {}) })
      if (!r) { if (++failures >= 2) break; continue }
      failures = 0
      if (r.chunk === null) break
    }
  }))
}

let rounds = args.rounds || []
let done = false
for (let step = 1; step <= 16 && !done; step++) {
  const work = rounds.filter((r) => r.workers > 0)
  const total = work.reduce((x, r) => x + r.workers, 0)
  if (work.length) {
    log(`step ${step}: ${work.length} round(s), ${total} chunk(s)`)
    await parallel(work.map((r) => () => reviewRound(r, Math.max(1, Math.min(r.workers, Math.round(LANES * r.workers / total))))))
  }
  const r = await agent(`Run exactly this command and report its result, nothing else:
  ${CLI} init next ${args.initId}
If its last line starts with "DONE", return {"done": true, "note": <that line>}.
If its last line starts with "NEXT ", parse the JSON after it and return {"done": false, "rounds": <its "rounds" array, every entry copied exactly>, "note": <the lines before RUN, joined with "; ">}.`,
    { label: `decide ${step}`, phase: 'Decide', model: 'haiku', effort: 'low', schema: DECIDE_SCHEMA })
  if (!r) { log('decision step failed'); break }
  if (r.note) log(r.note)
  done = r.done
  rounds = r.rounds || []
}
return { initId: args.initId, done }
