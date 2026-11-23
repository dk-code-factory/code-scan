export const meta = {
  name: 'code-scan-calibrate',
  description: 'Find the chunk size where review quality starts to drop: review the same code sample at several chunk sizes',
  whenToUse: 'Started by the code-scan:scan skill (calibration step) with the NEXT args printed by `code-scan.js calibrate start`',
  phases: [
    { title: 'Round', detail: 'review the sample at one chunk size (reuses workflows/scan.js)' },
    { title: 'Decide', detail: 'code-scan.js scores rounds and picks the next size or finishes' },
  ],
}

// args: NEXT object from `calibrate start` plus {scanScript: absolute path of workflows/scan.js}
const CLI = `${args.home ? `CODESCAN_HOME=${args.home} ` : ''}node ${args.cli} -C ${args.root}`
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

let round = { scanId: args.scanId, workers: args.workers }
let result = null
for (let i = 0; i < 8 && round; i++) {
  phase('Round')
  log(`round ${i + 1}: scan ${round.scanId}, ${round.workers} chunk(s)`)
  await workflow({ scriptPath: args.scanScript }, { cli: args.cli, root: args.root, home: args.home, scanId: round.scanId, plan: false, workers: round.workers })
  phase('Decide')
  const r = await agent(`Run exactly this command and report its result, nothing else:
  ${CLI} calibrate next ${args.calId}
If its last line starts with "DONE chunk_kb=<N>", return {"done": true, "chunk_kb": N, "note": <that line>}.
If its last line starts with "NEXT ", parse the JSON after it and return {"done": false, "next": {"scanId": <scanId>, "workers": <workers>}, "note": <the line before it>}.`,
    { label: `decide ${i + 1}`, phase: 'Decide', model: 'haiku', effort: 'low', schema: DECIDE_SCHEMA })
  if (!r) { log('decision step failed'); break }
  log(r.note || '')
  if (r.done) { result = r.chunk_kb; break }
  round = r.next
}
return { chunk_kb: result }
