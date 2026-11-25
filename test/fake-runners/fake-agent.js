#!/usr/bin/env node
'use strict';
// Stand-in for an agent CLI in tests: `fake-agent.js <runner> <the CLI's argv...>`. Reads the prompt the
// way that CLI would get it, answers like a reviewer/triager/planner would, and prints the CLI's own
// JSON output shape with token usage. Env: FAKE_LOG (argv log), FAKE_BAD_ONCE (dir: first review reply
// is invalid once), FAKE_SLEEP_MS (delay before answering),
// FAKE_FAIL (exit 1 with this message, as a CLI does on a bad model or auth).
const fs = require('fs');
const path = require('path');

const [runner, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log(`fake-${runner} 1.0.0`); process.exit(0); }
if (process.env.FAKE_FAIL) { console.error(process.env.FAKE_FAIL); process.exit(1); }
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${runner} ${args.filter((a) => a.length < 200).join(' ')}\n`);

function promptText() {
  if (['claude', 'codex', 'gemini'].includes(runner)) return fs.readFileSync(0, 'utf8');
  if (runner === 'opencode') return args[args.length - 1];
  return args[args.indexOf('-p') + 1];
}
let prompt = promptText();
const indirect = prompt.match(/^Read the file (\S+) completely/);
if (indirect) prompt = fs.readFileSync(indirect[1], 'utf8');

function answer() {
  if (/^PING/.test(prompt)) return 'PONG';
  if (prompt.includes('DIRECTORY DIGEST')) return 'Here is the plan:\n```json\n{"units": [{"name": "net", "globs": ["src/net/"], "priority": 10, "hint": "buffers"}]}\n```';
  const objKeys = prompt.match(/^Reply with exactly one JSON object[^\n]*\n(\{.*\})$/m);
  if (objKeys) {
    const keys = Object.keys(JSON.parse(objKeys[1].replace(/\[ \]/g, '[]')));
    const fixing = prompt.includes('rejected by its validator');
    const bad = process.env.FAKE_BAD_ONCE && !fixing && keys.some((k) => k.endsWith('buf.c')) && !fs.existsSync(path.join(process.env.FAKE_BAD_ONCE, 'done'));
    if (bad) fs.writeFileSync(path.join(process.env.FAKE_BAD_ONCE, 'done'), '1');
    const o = {};
    for (const k of keys) {
      o[k] = k.endsWith('buf.c') ? [{ line: 1, severity: bad ? 'bad' : 'high', type: 'memory-safety', category: 'use-after-free',
        title: 'write after free in f', detail: 'b freed then written', evidence: 'buf.c:1', confidence: 0.9 }] : [];
    }
    return `Reviewed.\n${JSON.stringify(o)}`;
  }
  const arr = prompt.match(/^(\[\{"id":.*\}\])$/m);
  if (arr) {
    const ids = JSON.parse(arr[1]).map((x) => x.id);
    return JSON.stringify(ids.map((id) => ({ id, verdict: 'real', severity: 'medium', type: 'logic', fix_loc: 2, issue: null, note: `checked #${id}` })));
  }
  return 'I could not understand the task.';
}

const text = answer();
const U = { in: 1000, out: 200, cache: 500 };
function emit() {
  switch (runner) {
    case 'claude':
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.05,
        usage: { input_tokens: U.in, output_tokens: U.out, cache_read_input_tokens: U.cache, cache_creation_input_tokens: 0 }, modelUsage: { 'claude-sonnet-5-5': {} } }));
      break;
    case 'codex':
      for (const e of [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } },
        { type: 'turn.completed', usage: { input_tokens: U.in + U.cache, cached_input_tokens: U.cache, output_tokens: U.out } }]) console.log(JSON.stringify(e));
      break;
    case 'gemini':
      console.log(JSON.stringify({ response: text, stats: { models: { 'gemini-3.1-pro-preview': { tokens: { prompt: U.in + U.cache, candidates: U.out, cached: U.cache, thoughts: 0 } } } } }));
      break;
    case 'agy':
      console.log(JSON.stringify({ response: text, status: 'success', usage: { input_tokens: U.in + U.cache, output_tokens: U.out, cache_read_tokens: U.cache } }));
      break;
    case 'copilot':
      console.log(JSON.stringify({ type: 'session.start' }));
      console.log(JSON.stringify({ type: 'assistant.message', data: { content: text } }));
      break;
    case 'cursor':
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { inputTokens: U.in, outputTokens: U.out, cacheReadTokens: U.cache } }));
      break;
    case 'opencode':
      console.log(JSON.stringify({ type: 'step_start', part: {} }));
      console.log(JSON.stringify({ type: 'text', part: { text } }));
      console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: U.in, output: U.out, reasoning: 0, cache: { read: U.cache, write: 0 } }, cost: 0.02 } }));
      break;
    default:
      console.log(text);
  }
}
const ms = Number(process.env.FAKE_SLEEP_MS || 0);
if (ms) setTimeout(emit, ms); else emit();
