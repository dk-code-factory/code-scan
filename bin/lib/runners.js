'use strict';
/**
 * Headless agent runners: one adapter per agentic coding CLI. Each starts one agent on one prompt,
 * non-interactive, in the repo root, and parses its machine-readable output into the final text,
 * token usage and (when the CLI reports it) cost. No dependencies.
 *
 * Agents started for review/triage/planning are read-only: code-scan itself claims work and stores
 * results, so the agent only reads code (and, for triage, searches GitHub with `gh`). `full: true`
 * (verify) gives the agent the host's unattended full-access mode instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Read-only shell command prefixes reviewers use; `gh` search/view for issue lookup during triage.
// Allowlists match by prefix and any arguments may follow, so a tool is listed only if no option
// of it writes a file or runs a program: code under review may carry prompt injection. Left out:
// find -delete/-exec, awk system(), sed w/e (even under -n), rg --pre, sort -o, uniq IN OUT,
// git log/show --output=FILE, git grep -O<cmd>, git push/reset, gh api/pr merge.
// Only codex enforces read-only with an OS sandbox.
const RO_CMDS = ['git blame', 'git ls-files', 'git rev-parse', 'git cat-file',
  'grep', 'cat', 'head', 'tail', 'wc', 'ls', 'cut', 'nl',
  'gh search', 'gh issue list', 'gh issue view', 'gh pr list', 'gh pr view', 'gh label list'];
const ARG_PROMPT_MAX = 96 * 1024; // one argv string is capped at 128KB on Linux

function extraArgs(name) {
  const v = process.env[`CODESCAN_${name.toUpperCase()}_ARGS`];
  return v ? v.split(/\s+/).filter(Boolean) : [];
}

function jsonLines(s) {
  const res = [];
  for (const line of String(s).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { res.push(JSON.parse(t)); } catch (e) { /* not an event */ }
  }
  return res;
}
function firstJson(s) {
  const t = String(s).trim();
  try { return JSON.parse(t); } catch (e) { /* maybe banner text around it */ }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { /* fall through */ } }
  return null;
}
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

const RUNNERS = {
  claude: {
    bins: ['claude'], vendor: 'anthropic', stdin: true,
    argv: (o) => ['-p', '--output-format', 'json', ...(o.model ? ['--model', o.model] : []),
      ...(o.full ? ['--dangerously-skip-permissions']
        : ['--allowedTools', ['Read', 'Grep', 'Glob', ...RO_CMDS.map((c) => `Bash(${c}:*)`)].join(','),
          '--disallowedTools', 'Edit,Write,NotebookEdit']),
      ...extraArgs('claude')],
    parse(stdout) {
      const j = firstJson(stdout);
      if (!j) return { text: stdout };
      const u = j.usage || {};
      const models = Object.keys(j.modelUsage || {});
      return {
        text: typeof j.structured_output === 'object' && j.structured_output ? JSON.stringify(j.structured_output) : String(j.result ?? ''),
        error: j.is_error ? String(j.result || j.subtype || 'error') : null,
        usage: { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) },
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
        model: models[0] || null,
      };
    },
  },
  codex: {
    bins: ['codex'], vendor: 'openai', stdin: true,
    argv: (o) => ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', o.cwd,
      ...(o.full ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'read-only']),
      ...(o.model ? ['-m', o.model] : []), ...extraArgs('codex'), '-'],
    parse(stdout) {
      let text = '', err = null;
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const e of jsonLines(stdout)) {
        const it = e.item || {};
        if (/^item\./.test(e.type || '') && (it.type === 'agent_message' || it.item_type === 'agent_message') && it.text) text = it.text;
        if (e.type === 'turn.completed' && e.usage) {
          // input_tokens includes the cached part
          const cached = num(e.usage.cached_input_tokens);
          usage.input += Math.max(0, num(e.usage.input_tokens) - cached);
          usage.cacheRead += cached;
          usage.output += num(e.usage.output_tokens);
        }
        if (e.type === 'turn.failed' || e.type === 'error') err = (e.error && e.error.message) || e.message || 'error';
      }
      return { text, error: text ? null : err, usage, costUsd: null, model: null };
    },
  },
  gemini: {
    bins: ['gemini'], vendor: 'google', stdin: true,
    argv: (o) => ['-p', 'Follow the instructions given on standard input.', '-o', 'json',
      ...(o.full ? ['--approval-mode=yolo']
        : ['--approval-mode=default', '--allowed-tools', ['read_file', 'read_many_files', 'glob', 'search_file_content', 'list_directory',
          ...RO_CMDS.map((c) => `run_shell_command(${c})`)].join(',')]),
      ...(o.model ? ['-m', o.model] : []), ...extraArgs('gemini')],
    parse(stdout) {
      const j = firstJson(stdout);
      if (!j) return { text: stdout };
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let model = null;
      for (const [id, m] of Object.entries((j.stats && j.stats.models) || {})) {
        const t = m.tokens || {};
        const cached = num(t.cached);
        usage.input += Math.max(0, num(t.prompt) - cached);
        usage.cacheRead += cached;
        usage.output += num(t.candidates) + num(t.thoughts);
        model = model || id;
      }
      return { text: String(j.response ?? ''), error: j.error ? (j.error.message || String(j.error)) : null, usage, costUsd: null, model };
    },
  },
  agy: {
    bins: ['agy'], vendor: 'google', stdin: false,
    argv: (o) => ['-p', o.prompt, '--output-format', 'json', ...(o.full ? ['--dangerously-skip-permissions'] : []),
      ...(o.model ? ['--model', o.model] : []), ...extraArgs('agy')],
    parse(stdout) {
      const j = firstJson(stdout);
      if (!j) return { text: stdout };
      const u = j.usage || {};
      return {
        text: typeof j.structured_output === 'object' && j.structured_output ? JSON.stringify(j.structured_output) : String(j.response ?? ''),
        error: j.status && !/^(ok|success|completed?)$/i.test(j.status) && !j.response ? String(j.status) : null,
        usage: { input: Math.max(0, num(u.input_tokens) - num(u.cache_read_tokens)), output: num(u.output_tokens) + num(u.thinking_tokens), cacheRead: num(u.cache_read_tokens), cacheWrite: 0 },
        costUsd: null, model: null,
      };
    },
  },
  copilot: {
    bins: ['copilot'], vendor: null, stdin: false,
    argv: (o) => ['-p', o.prompt, '-s', '--no-ask-user', '--output-format=json',
      ...(o.full ? ['--allow-all-tools'] : [...RO_CMDS.flatMap((c) => ['--allow-tool', `shell(${c}:*)`]), '--deny-tool', 'write']),
      ...(o.model ? [`--model=${o.model}`] : []), ...extraArgs('copilot')],
    parse(stdout) {
      let text = '';
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let sawUsage = false;
      const evs = jsonLines(stdout);
      for (const e of evs) {
        const d = e.data || e;
        if (/assistant\.message/.test(e.type || '') && (d.content || d.text)) text = String(d.content || d.text);
        const u = d.usage || e.usage;
        if (u && typeof u === 'object') {
          sawUsage = true;
          usage.input += num(u.input_tokens ?? u.inputTokens);
          usage.output += num(u.output_tokens ?? u.outputTokens);
          usage.cacheRead += num(u.cache_read_tokens ?? u.cacheReadTokens);
        }
      }
      if (!evs.length) text = stdout;
      return { text, usage: sawUsage ? usage : null, costUsd: null, model: null };
    },
  },
  cursor: {
    bins: ['cursor-agent', 'agent'], vendor: null, stdin: false,
    argv: (o) => ['-p', o.prompt, '--output-format', 'json', '--workspace', o.cwd, '--trust', ...(o.full ? ['-f'] : []),
      ...(o.model ? ['--model', o.model] : []), ...extraArgs('cursor')],
    parse(stdout) {
      const j = firstJson(stdout);
      if (!j) return { text: stdout };
      const u = j.usage;
      return {
        text: String(j.result ?? ''), error: j.is_error ? String(j.result || j.subtype || 'error') : null,
        usage: u ? { input: num(u.inputTokens ?? u.input_tokens), output: num(u.outputTokens ?? u.output_tokens), cacheRead: num(u.cacheReadTokens ?? u.cache_read_tokens), cacheWrite: num(u.cacheWriteTokens ?? u.cache_write_tokens) } : null,
        costUsd: null, model: null,
      };
    },
  },
  opencode: {
    bins: ['opencode'], vendor: null, stdin: false,
    argv: (o) => ['run', '--format', 'json', '--dir', o.cwd, ...(o.model ? ['-m', o.model] : []), ...extraArgs('opencode'), o.prompt],
    env: (o) => (o.full ? {} : { OPENCODE_PERMISSION: JSON.stringify({ edit: 'deny', webfetch: 'deny', bash: Object.fromEntries([...RO_CMDS.map((c) => [`${c} *`, 'allow']), ['*', 'deny']]) }) }),
    parse(stdout) {
      let text = '', cost = 0, sawCost = false, err = null;
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const e of jsonLines(stdout)) {
        const p = e.part || {};
        if (e.type === 'text' && p.text) text = p.text;
        if (e.type === 'step_finish') {
          const t = p.tokens || {};
          usage.input += num(t.input);
          usage.output += num(t.output) + num(t.reasoning);
          usage.cacheRead += num(t.cache && t.cache.read);
          usage.cacheWrite += num(t.cache && t.cache.write);
          if (typeof p.cost === 'number') { cost += p.cost; sawCost = true; }
        }
        if (e.type === 'error') err = (e.error && ((e.error.data && e.error.data.message) || e.error.message || e.error.name)) || 'error';
      }
      return { text, error: text ? null : err, usage, costUsd: sawCost ? cost : null, model: null };
    },
  },
};
const ORDER = ['claude', 'codex', 'gemini', 'agy', 'copilot', 'cursor', 'opencode'];

/** `codex:gpt-6.2-sol` → {runner:'codex', model:'gpt-6.2-sol'}; a bare id is a claude model. */
function splitModel(id) {
  if (!id) return { runner: null, model: null };
  const s = String(id);
  const i = s.indexOf(':');
  if (i > 0 && RUNNERS[s.slice(0, i)]) return { runner: s.slice(0, i), model: s.slice(i + 1) || null };
  return { runner: 'claude', model: s };
}
/** Stored model id: claude models stay bare (existing configs), others carry their runner. */
function joinModel(runner, model) {
  if (!model) return null;
  return runner === 'claude' || !runner ? model : `${runner}:${model}`;
}

function onPath(bin) {
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ }
  }
  return null;
}
/** Absolute path of the runner's binary, or null. CODESCAN_<RUNNER>_BIN overrides. */
function binOf(name) {
  const r = RUNNERS[name];
  if (!r) return null;
  const o = process.env[`CODESCAN_${name.toUpperCase()}_BIN`];
  if (o) return onPath(o);
  for (const b of r.bins) { const p = onPath(b); if (p) return p; }
  return null;
}
function installed() { return ORDER.filter((n) => binOf(n)); }

const versionCache = new Map();
function version(name) {
  if (versionCache.has(name)) return versionCache.get(name);
  const bin = binOf(name);
  let v = null;
  if (bin) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
    v = r.status === 0 ? String(r.stdout || r.stderr).trim().split('\n')[0].slice(0, 80) || '?' : null;
  }
  versionCache.set(name, v);
  return v;
}

// Which agent CLI is running us: ancestors first (an exported variable can be stale), then variables
// the hosts set for their shell tools.
const ANCESTOR_PATS = [
  ['claude', /(^|\/)claude(\.exe)?$|@anthropic-ai\/claude-code/],
  ['codex', /(^|\/)codex(\.exe)?$|@openai\/codex/],
  ['gemini', /(^|\/)gemini$|@google\/gemini-cli/],
  ['agy', /(^|\/)agy$|antigravity-cli/],
  ['copilot', /(^|\/)copilot$|@github\/copilot/],
  ['cursor', /(^|\/)cursor-agent$|cursor-agent\/|\.cursor\/.*\/agent$/],
  ['opencode', /(^|\/)opencode$|opencode-ai/],
];
const ENV_HINTS = [
  ['claude', ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']],
  ['codex', ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID']],
  ['gemini', ['GEMINI_CLI']],
  ['agy', ['ANTIGRAVITY_CLI', 'ANTIGRAVITY_AGENT']],
  ['copilot', ['COPILOT_CLI', 'COPILOT_AGENT']],
  ['cursor', ['CURSOR_AGENT', 'CURSOR_CLI']],
  ['opencode', ['OPENCODE']],
];
function ancestors() {
  const res = [];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    let argv = null, ppid = null;
    if (process.platform === 'linux') {
      try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch (e) { break; }
      try { ppid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+\S+\s+/, '').split(' ')[0]); } catch (e) { ppid = null; }
    } else {
      const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' });
      const m = String(r.stdout || '').trim().match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      ppid = Number(m[1]);
      argv = m[2].split(/\s+/);
    }
    res.push(argv.slice(0, 2));
    if (!ppid || ppid === pid) break;
    pid = ppid;
  }
  return res;
}
function detectHost(env = process.env) {
  // CODESCAN_DETECT=env skips the process walk (tests run inside some agent CLI themselves)
  for (const argv of env.CODESCAN_DETECT === 'env' ? [] : ancestors()) {
    for (const [name, re] of ANCESTOR_PATS) {
      if (argv.some((a) => re.test(a))) return { runner: name, why: `running inside ${name} (${path.basename(argv[0])} process)` };
    }
  }
  for (const [name, vars] of ENV_HINTS) {
    const v = vars.find((k) => env[k]);
    if (v) return { runner: name, why: `running inside ${name} ($${v} is set)` };
  }
  return null;
}

/**
 * Pick the runner: explicit flag / model prefix → stored model → host we run inside → first
 * installed CLI. Returns {runner, model (stored form), why}.
 */
function resolve({ flagRunner, flagModel, storedModel, storedRunner }) {
  if (flagRunner && !RUNNERS[flagRunner]) throw new Error(`unknown runner '${flagRunner}' (one of ${ORDER.join(', ')})`);
  const prefixed = !!flagModel && splitModel(flagModel).runner !== 'claude' || /^claude:/.test(String(flagModel || ''));
  if (flagRunner || prefixed) {
    let runner = flagRunner, model = null;
    if (flagModel) {
      const fm = prefixed ? splitModel(flagModel) : { runner: flagRunner, model: String(flagModel) };
      if (flagRunner && fm.runner !== flagRunner) throw new Error(`--runner ${flagRunner} conflicts with --model ${flagModel}`);
      runner = fm.runner;
      model = fm.model;
    } else if (storedModel && splitModel(storedModel).runner === runner) {
      // `--runner codex` alone keeps the stored model only if it belongs to that runner
      model = splitModel(storedModel).model;
    }
    return { runner, model: joinModel(runner, model), why: flagRunner ? '--runner' : `--model ${flagModel}` };
  }
  if (flagModel) return { runner: 'claude', model: String(flagModel), why: `--model ${flagModel}` };
  if (storedRunner && RUNNERS[storedRunner]) return { runner: storedRunner, model: storedModel || null, why: 'chosen when the scan started' };
  if (storedModel) return { runner: splitModel(storedModel).runner, model: storedModel, why: `model ${storedModel}` };
  const pref = process.env.CODESCAN_RUNNER;
  if (pref) {
    if (!RUNNERS[pref]) throw new Error(`CODESCAN_RUNNER=${pref} is not a runner (one of ${ORDER.join(', ')})`);
    return { runner: pref, model: null, why: '$CODESCAN_RUNNER' };
  }
  const h = detectHost();
  if (h) return { runner: h.runner, model: null, why: h.why };
  const inst = installed();
  if (inst.length) return { runner: inst[0], model: null, why: `first agent CLI found on PATH (${inst.join(', ')})` };
  return { runner: null, model: null, why: `no agent CLI found on PATH (looked for ${ORDER.map((n) => RUNNERS[n].bins.join('/')).join(', ')})` };
}

/** Last top-level JSON object or array in an agent's reply. */
function extractJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch (e) { /* search */ }
  const fence = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  for (const f of fence) { try { return JSON.parse(f.trim()); } catch (e) { /* next */ } }
  for (let end = s.length - 1; end >= 0; end--) {
    const c = s[end];
    if (c !== '}' && c !== ']') continue;
    const open = c === '}' ? '{' : '[';
    let depth = 0, inStr = false;
    for (let i = end; i >= 0; i--) {
      const ch = s[i];
      if (ch === '"') {
        let bs = 0; // a quote is escaped only by an odd run of backslashes ("C:\\\\" ends a string)
        for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) bs++;
        if (bs % 2 === 0) inStr = !inStr;
      }
      if (inStr) continue;
      if (ch === c) depth++;
      else if (ch === open && --depth === 0) {
        try { return JSON.parse(s.slice(i, end + 1)); } catch (e) { break; }
      }
    }
  }
  return null;
}

const live = new Set();
/** Kill every agent still running (on SIGTERM/SIGINT of the runner). */
function killAll(sig = 'SIGTERM') {
  for (const c of live) { try { process.kill(-c.pid, sig); } catch (e) { try { c.kill(sig); } catch (e2) { /* gone */ } } }
}

/**
 * Run one agent. Resolves (never rejects) with {ok, text, usage, costUsd, model, exit, error, ms, pid}.
 */
function runAgent({ runner, model, prompt, cwd, full = false, timeoutMs = 45 * 60 * 1000, tmpDir, onSpawn }) {
  const r = RUNNERS[runner];
  const bin = binOf(runner);
  if (!r || !bin) return Promise.resolve({ ok: false, error: `${runner} CLI not found`, exit: null, ms: 0 });
  let p = prompt, promptFile = null;
  if (!r.stdin && Buffer.byteLength(p) > ARG_PROMPT_MAX) {
    // too long for one argv string: hand it over as a file the agent reads first
    const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'code-scan-'));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
    fs.writeFileSync(f, prompt);
    promptFile = f;
    p = `Read the file ${f} completely (it is long; read all of it) and follow the instructions in it exactly. Your final reply is what that file asks for.`;
  }
  const o = { prompt: p, model, cwd, full };
  const args = r.argv(o);
  const env = { ...process.env, ...(r.env ? r.env(o) : {}) };
  const t0 = Date.now();
  return new Promise((res) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, detached: true, stdio: [r.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) {
      res({ ok: false, error: e.message, exit: null, ms: 0 });
      return;
    }
    live.add(child);
    if (onSpawn) onSpawn(child.pid);
    const so = [], se = [];
    child.stdout.on('data', (b) => so.push(b));
    child.stderr.on('data', (b) => { se.push(b); if (se.length > 200) se.splice(0, se.length - 200); });
    if (r.stdin) { child.stdin.on('error', () => {}); child.stdin.end(prompt); }
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch (e) { try { child.kill(sig); } catch (e2) { /* gone */ } } };
    let killTimer = null;
    // SIGTERM, then SIGKILL if the group (or a child holding our pipes) ignores it
    const timer = setTimeout(() => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 10000); }, timeoutMs);
    let finished = false;
    const done = (code, errMsg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (promptFile) { try { fs.unlinkSync(promptFile); } catch (e) { /* already gone */ } }
      live.delete(child);
      const stdout = Buffer.concat(so).toString('utf8');
      const stderr = Buffer.concat(se).toString('utf8');
      let parsed = {};
      try { parsed = r.parse(stdout) || {}; } catch (e) { parsed = { text: stdout }; }
      const text = parsed.text || '';
      const error = errMsg || parsed.error || (code !== 0 ? `exit ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` : null);
      res({ ok: code === 0 && !!text && !parsed.error, text, usage: parsed.usage === undefined ? null : parsed.usage, costUsd: parsed.costUsd ?? null,
        model: parsed.model || model || null, exit: code, error, ms: Date.now() - t0, pid: child.pid, stderrTail: stderr.slice(-2000) });
    };
    child.on('error', (e) => done(null, e.message));
    child.on('close', (code, sig) => done(code === null ? -1 : code, sig ? `killed by ${sig}` : null));
  });
}

/** Model a runner uses when none is given, if its config says (for pricing); else null. */
function defaultModel(name) {
  if (name === 'codex') {
    const f = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    try {
      const top = fs.readFileSync(f, 'utf8').split(/^\s*\[/m)[0];
      const m = top.match(/^\s*model\s*=\s*"([^"]+)"/m);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  return null;
}

module.exports = { defaultModel, RUNNERS, ORDER, splitModel, joinModel, binOf, installed, version, detectHost, resolve, extractJson, runAgent, killAll };
