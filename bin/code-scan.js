#!/usr/bin/env node
'use strict';
/**
 * code-scan.js — state, planning and querying for the code-scan plugin.
 *
 * All coordination of a repo-wide bug scan lives here so the coordinating model
 * spends no tokens on it: inventory of git-tracked files, code/non-code
 * classification by path and git metadata, chunk packing, atomic chunk claims
 * for reviewer agents, per-file progress, the "already reviewed" ledger keyed by
 * blob sha, findings storage, querying, duplicate clustering, tracker matching
 * and issue filing bookkeeping.
 *
 * State: $CODESCAN_HOME or ~/.cache/code-scan/<repoKey>/codescan.db (SQLite).
 * Node >= 22.5 (node:sqlite), no dependencies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

const CLI = path.resolve(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const TRIAGE = ['open', 'confirmed', 'false_positive', 'fixed', 'wontfix'];
const FILE_STATES = ['pending', 'in_progress', 'partial', 'reviewed', 'excluded', 'unchanged'];
const MAX_CODE_BYTES = 512 * 1024;
const STDOUT_ROWS = 50;
const RATE_LIMIT_MAX_AGE_MIN = 15;
// Chunk size for a model that has not been calibrated on this repo. Picked by running the
// calibration below on real code (see README "Chunk size"); calibration starts from it.
const DEFAULT_CHUNK_KB = 40;
const MIN_CHUNK_KB = 8;
const CAL_SAMPLE_KB = 200;
const CAL_DELTA = 0.15;
const MAX_WORKERS_PER_RUN = 900;
const MAX_FILES_PER_CHUNK = 30;
const INLINE_MAX_CHARS = 24000;
const READ_PAGE_LINES = 1000;

// ------------------------------------------------------------ classification

const CODE_EXT = new Set([
  '.py', '.pyi', '.pyx', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
  '.java', '.kt', '.kts', '.scala', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hxx',
  '.hh', '.ipp', '.inl', '.cs', '.rb', '.php', '.swift', '.m', '.mm', '.sh', '.bash', '.zsh',
  '.pl', '.pm', '.lua', '.r', '.jl', '.ex', '.exs', '.erl', '.hrl', '.hs', '.ml', '.mli',
  '.dart', '.vue', '.svelte', '.sql', '.zig', '.nim', '.groovy', '.clj', '.cljs', '.fs',
  '.d', '.cu', '.cuh', '.asm', '.s', '.S',
]);
const BUILD_NAMES = new Set(['makefile', 'dockerfile', 'cmakelists.txt', 'rakefile',
  'justfile', 'meson.build', 'build.gradle', 'configure.py', 'setup.py', 'build.rs']);
const CONFIG_EXT = new Set(['.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.json',
  '.json5', '.tf', '.tfvars', '.hcl', '.properties', '.env', '.plist', '.xml', '.cmake',
  '.gradle', '.proto', '.thrift', '.idl', '.mk', '.in', '.bazel', '.bzl', '.lock']);
const DOC_EXT = new Set(['.md', '.markdown', '.rst', '.txt', '.adoc', '.org', '.tex',
  '.csv', '.tsv', '.po', '.html', '.htm', '.css', '.scss', '.svg', '.ipynb']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.ico',
  '.webp', '.pdf', '.zip', '.gz', '.bz2', '.xz', '.zst', '.tar', '.7z', '.jar', '.war',
  '.class', '.so', '.dylib', '.dll', '.exe', '.bin', '.o', '.a', '.wasm', '.pyc', '.pyo',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.wav',
  '.ogg', '.webm', '.sqlite', '.db', '.mo', '.pack', '.idx', '.keystore', '.p12',
  '.xlsx', '.docx', '.pptx', '.odt', '.ods', '.crt', '.pem', '.der', '.key']);
const GENERATED_PAT = new RegExp(
  '(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|poetry\\.lock|Cargo\\.lock|' +
  'go\\.sum|Gemfile\\.lock|composer\\.lock)$' +
  '|\\.(min\\.js|min\\.css|snap|pb\\.go|pb\\.cc|pb\\.h|pb2\\.py|pb2_grpc\\.py)$' +
  '|(_generated|\\.generated|_gen)\\.[a-z]+$' +
  '|(^|/)(vendor|vendored|node_modules|dist|\\.pnp|third_party|thirdparty|3rdparty)/', 'i');
const TEST_PAT = new RegExp(
  '(^|/)(tests?|spec|specs|__tests__|testdata|testing|fixtures|test-?utils?|bench(mark)?s?)/|' +
  '(^|/)(test_[^/]+|[^/]+_test|[^/]+_tests|[^/]+\\.test|[^/]+\\.spec|[^/]+Test|[^/]+Tests)\\.[a-z]+$', 'i');

const LANG = {
  '.py': 'python', '.pyi': 'python', '.pyx': 'cython', '.js': 'js', '.mjs': 'js', '.cjs': 'js',
  '.jsx': 'js', '.ts': 'ts', '.tsx': 'ts', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.c': 'c', '.h': 'c/c++',
  '.cc': 'c++', '.cpp': 'c++', '.cxx': 'c++', '.hpp': 'c++', '.hxx': 'c++', '.hh': 'c++',
  '.ipp': 'c++', '.inl': 'c++', '.cs': 'c#', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.m': 'objc', '.mm': 'objc', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.lua': 'lua', '.sql': 'sql', '.zig': 'zig', '.cu': 'cuda', '.cuh': 'cuda',
};

function extOf(p) {
  const name = p.split('/').pop();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/** Path/metadata-only verdict: {code, reason, lang}. Never reads content. */
function classifyPath(p, mode, size, opts) {
  if (mode === '120000') return { code: false, reason: 'symlink' };
  if (mode === '160000') return { code: false, reason: 'submodule' };
  const lower = p.toLowerCase();
  const name = lower.split('/').pop();
  const ext = extOf(p);
  if (BINARY_EXT.has(ext)) return { code: false, reason: 'binary' };
  if (GENERATED_PAT.test(p)) return { code: false, reason: 'generated/vendored' };
  if (BUILD_NAMES.has(name)) return { code: false, reason: 'build' };
  if (DOC_EXT.has(ext)) return { code: false, reason: 'docs' };
  if (CONFIG_EXT.has(ext)) return { code: false, reason: 'config' };
  if (CODE_EXT.has(ext) || (ext === '' && mode === '100755')) {
    if (!opts.includeTests && TEST_PAT.test(p)) return { code: false, reason: 'test' };
    if (size > MAX_CODE_BYTES) return { code: false, reason: 'too-large' };
    return { code: true, reason: '', lang: LANG[ext] || (ext ? ext.slice(1) : 'script') };
  }
  return { code: false, reason: ext ? 'unknown-ext' : 'no-ext' };
}

// ------------------------------------------------------------------- helpers

function die(msg, code = 1) {
  process.stderr.write(`code-scan: ${msg}\n`);
  process.exit(code);
}
function out(s) { process.stdout.write(s.endsWith('\n') ? s : s + '\n'); }
function now() { return new Date().toISOString(); }
function sha1(s, n = 16) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, n); }
function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB'; }

let REPO_ROOT = null;
function repoRoot() {
  if (REPO_ROOT) return REPO_ROOT;
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) die('not inside a git repository (use -C <repo>)');
  REPO_ROOT = r.stdout.trim();
  return REPO_ROOT;
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: repoRoot(), encoding: opts.buffer ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024, input: opts.input,
  });
  if (r.status !== 0) {
    if (opts.allowFail) return null;
    die(`git ${args.join(' ')} failed: ${(r.stderr || '').toString().trim()}`);
  }
  return r.stdout;
}

function catBlob(sha) {
  const b = git(['cat-file', 'blob', sha], { buffer: true, allowFail: true });
  return b ? b.toString('utf8') : '';
}

function stateDir() {
  if (process.env.CODESCAN_HOME) {
    fs.mkdirSync(process.env.CODESCAN_HOME, { recursive: true });
    return process.env.CODESCAN_HOME;
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const roots = (git(['rev-list', '--max-parents=0', 'HEAD'], { allowFail: true }) || '')
    .trim().split('\n').filter(Boolean).sort();
  const key = sha1(roots[0] || repoRoot(), 12);
  const d = path.join(base, 'code-scan', key);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function globRe(g) {
  let s = g.trim();
  if (s.startsWith('./')) s = s.slice(2);
  if (s.endsWith('/')) s += '**';
  const anchored = s.includes('/');
  let re = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') {
        i++;
        if (s[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const j = s.indexOf('}', i);
      if (j < 0) { re += '\\{'; continue; }
      re += '(?:' + s.slice(i + 1, j).split(',').map(escRe).join('|') + ')';
      i = j;
    } else re += escRe(c);
  }
  return new RegExp('^' + (anchored ? '' : '(?:.*/)?') + re + '$');
}
function escRe(s) { return s.replace(/[.+^$()|[\]\\{}*?]/g, '\\$&'); }

/** `dir/` → prefix, glob → glob, plain path → exact file or directory prefix. */
function pathMatcher(spec) {
  if (!spec) return null;
  const specs = [].concat(spec).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const ms = specs.map((s) => {
    if (/[*?{]/.test(s) || s.endsWith('/')) return globRe(s);
    const clean = s.replace(/^\.\//, '').replace(/\/$/, '');
    return { test: (p) => p === clean || p.startsWith(clean + '/') };
  });
  return (p) => ms.some((m) => m.test(p));
}

// ------------------------------------------------------------------ arg parse

const BOOL_FLAGS = new Set(['include-tests', 'force', 'no-plan', 'replan', 'now', 'all',
  'latest', 'stale', 'no-stale', 'reported', 'unreported', 'primary-only', 'new',
  'ambiguous', 'dry-run', 'json', 'help', 'include-reported', 'include-stale', 'gone', 'include-gone', 'reset-scope', 'inline']);
const MULTI_FLAGS = new Set(['include', 'exclude', 'only', 'force-path', 'path', 'severity',
  'category', 'triage', 'sort', 'label']);

function parseArgs(argv) {
  const pos = [];
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let val;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (BOOL_FLAGS.has(name)) { f[name] = val === undefined ? true : val !== 'false'; continue; }
      if (val === undefined) {
        if (i + 1 >= argv.length) die(`--${name} needs a value`);
        val = argv[++i];
      }
      if (MULTI_FLAGS.has(name)) (f[name] = f[name] || []).push(val);
      else f[name] = val;
    } else pos.push(a);
  }
  return { pos, f };
}

function listFlag(v) {
  if (!v) return null;
  return [].concat(v).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------------------ db

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  name TEXT PRIMARY KEY, hash TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, commit_sha TEXT NOT NULL, profile_name TEXT NOT NULL,
  profile_hash TEXT NOT NULL, options_json TEXT NOT NULL, plan_json TEXT, dirset_hash TEXT,
  status TEXT NOT NULL, workflow_task TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  scan_id INTEGER NOT NULL, path TEXT NOT NULL, blob_sha TEXT NOT NULL, mode TEXT NOT NULL,
  bytes INTEGER NOT NULL, lang TEXT, unit TEXT, state TEXT NOT NULL, reason TEXT,
  slices_json TEXT, slices_done TEXT NOT NULL DEFAULT '[]', findings_n INTEGER NOT NULL DEFAULT 0,
  reviewed_at TEXT, PRIMARY KEY (scan_id, path));
CREATE INDEX IF NOT EXISTS files_state ON files(scan_id, state);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id INTEGER NOT NULL, ord INTEGER NOT NULL,
  unit TEXT, items_json TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL,
  claimed_at TEXT, done_at TEXT);
CREATE INDEX IF NOT EXISTS chunks_state ON chunks(scan_id, state, ord);
CREATE TABLE IF NOT EXISTS reviewed (
  blob_sha TEXT NOT NULL, profile_hash TEXT NOT NULL, path TEXT NOT NULL, scan_id INTEGER NOT NULL,
  ts TEXT NOT NULL, PRIMARY KEY (blob_sha, profile_hash));
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE,
  first_scan INTEGER NOT NULL, last_scan INTEGER NOT NULL, commit_sha TEXT NOT NULL,
  path TEXT NOT NULL, line INTEGER, end_line INTEGER, severity TEXT NOT NULL, category TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, evidence TEXT, snippet TEXT, confidence REAL,
  blob_sha TEXT, unit TEXT, profile_name TEXT, triage TEXT NOT NULL DEFAULT 'open', note TEXT,
  dupe_lock INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS findings_sev ON findings(severity);
CREATE INDEX IF NOT EXISTS findings_path ON findings(path);
CREATE INDEX IF NOT EXISTS findings_triage ON findings(triage);
CREATE TABLE IF NOT EXISTS seen (finding_id INTEGER NOT NULL, scan_id INTEGER NOT NULL,
  PRIMARY KEY (finding_id, scan_id));
CREATE TABLE IF NOT EXISTS dupe_groups (group_id INTEGER NOT NULL, finding_id INTEGER NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 0, reason TEXT, manual INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS dupe_groups_g ON dupe_groups(group_id);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tracker_issues (
  tracker TEXT NOT NULL, key TEXT NOT NULL, url TEXT, title TEXT, state TEXT, body_excerpt TEXT,
  paths_json TEXT, markers_json TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (tracker, key));
CREATE TABLE IF NOT EXISTS match_candidates (
  finding_id INTEGER NOT NULL, tracker TEXT NOT NULL, key TEXT NOT NULL, score REAL NOT NULL,
  why TEXT, PRIMARY KEY (finding_id, tracker, key));
CREATE TABLE IF NOT EXISTS calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, profile_name TEXT NOT NULL, commit_sha TEXT NOT NULL,
  sample_json TEXT NOT NULL, sample_bytes INTEGER NOT NULL, medium_kb INTEGER NOT NULL, status TEXT NOT NULL,
  result_kb INTEGER, decision TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cal_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id INTEGER NOT NULL, path TEXT NOT NULL, line INTEGER,
  severity TEXT NOT NULL, category TEXT, title TEXT NOT NULL, snippet TEXT, end_line INTEGER);
CREATE TABLE IF NOT EXISTS filings (
  finding_id INTEGER NOT NULL, tracker TEXT NOT NULL, key TEXT NOT NULL, url TEXT,
  kind TEXT NOT NULL, draft_id TEXT, filed_at TEXT NOT NULL, PRIMARY KEY (finding_id, tracker, key));
CREATE INDEX IF NOT EXISTS filings_f ON filings(finding_id);
`;

let DB = null;
function db() {
  if (DB) return DB;
  const p = path.join(stateDir(), 'codescan.db');
  DB = new DatabaseSync(p, { timeout: 30000 });
  DB.exec('PRAGMA busy_timeout=30000;');
  if (DB.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') DB.exec('PRAGMA journal_mode=WAL;');
  if (!DB.prepare("SELECT 1 FROM sqlite_master WHERE name='cal_findings'").get()) DB.exec(SCHEMA);
  const scanCols = DB.prepare('PRAGMA table_info(scans)').all().map((c) => c.name);
  if (!scanCols.includes('kind')) DB.exec("ALTER TABLE scans ADD COLUMN kind TEXT NOT NULL DEFAULT 'scan'");
  if (!scanCols.includes('cal_id')) DB.exec('ALTER TABLE scans ADD COLUMN cal_id INTEGER');
  if (!DB.prepare('PRAGMA table_info(cal_findings)').all().some((c) => c.name === 'end_line')) DB.exec('ALTER TABLE cal_findings ADD COLUMN end_line INTEGER');
  if (!DB.prepare('PRAGMA table_info(findings)').all().some((c) => c.name === 'gone_scan')) {
    DB.exec('ALTER TABLE findings ADD COLUMN gone_scan INTEGER');
  }
  return DB;
}

function tx(fn) {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (ignored) { /* already rolled back */ }
    throw e;
  }
}

function cfgGet(key, dflt = null) {
  const r = db().prepare('SELECT value FROM config WHERE key=?').get(key);
  return r ? r.value : dflt;
}
function cfgSet(key, value) {
  db().prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

function getScan(id) {
  const s = db().prepare('SELECT * FROM scans WHERE id=?').get(Number(id));
  if (!s) die(`no scan ${id}`);
  return s;
}
function latestScan(required = true) {
  const s = db().prepare("SELECT * FROM scans WHERE kind='scan' ORDER BY id DESC LIMIT 1").get();
  if (!s && required) die('no scans yet — run `start`');
  return s;
}
function openScan() {
  return db().prepare("SELECT * FROM scans WHERE kind='scan' AND status IN ('active','stopped') ORDER BY id DESC LIMIT 1").get();
}
function scanArg(f) {
  if (f.scan) return getScan(f.scan);
  return openScan() || latestScan();
}
function setScanStatus(id, status) {
  db().prepare('UPDATE scans SET status=?, updated=? WHERE id=?').run(status, now(), id);
}

// ------------------------------------------------------------------ profiles

function builtinProfile(name) {
  const p = path.join(PLUGIN_ROOT, 'profiles', `${name}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function builtinProfileNames() {
  const d = path.join(PLUGIN_ROOT, 'profiles');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)) : [];
}
function upsertProfile(name, text) {
  const hash = sha1(text.trim(), 12);
  db().prepare(`INSERT INTO profiles(name,hash,text,created) VALUES(?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET hash=excluded.hash, text=excluded.text`).run(name, hash, text, now());
  return { name, hash, text };
}
function resolveProfile(name) {
  const row = db().prepare('SELECT * FROM profiles WHERE name=?').get(name);
  if (row) return row;
  const text = builtinProfile(name);
  if (text === null) die(`unknown profile '${name}' (see \`profile list\`)`);
  return upsertProfile(name, text);
}
function profileFromFlags(f, fallbackName = 'default') {
  if (f['prompt-file']) {
    const text = fs.readFileSync(f['prompt-file'], 'utf8');
    if (!text.trim()) die('prompt file is empty');
    const name = f.profile || `adhoc-${sha1(text.trim(), 8)}`;
    return upsertProfile(name, text);
  }
  return resolveProfile(f.profile || fallbackName);
}

// ----------------------------------------------------------------- inventory

function lsTree(commit) {
  const raw = git(['ls-tree', '-r', '-l', '-z', '--full-tree', commit]);
  const rows = [];
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, sha, size] = rec.slice(0, tab).split(/\s+/);
    rows.push({ mode, type, sha, size: size === '-' ? 0 : Number(size), path: rec.slice(tab + 1) });
  }
  return rows;
}

function linguistFlags(commit, paths) {
  const res = new Map();
  if (!paths.length) return res;
  let raw = git(['check-attr', '-z', '--stdin', `--source=${commit}`, 'linguist-generated', 'linguist-vendored'],
    { input: paths.join('\0') + '\0', allowFail: true });
  if (raw === null) {
    raw = git(['check-attr', '-z', '--stdin', 'linguist-generated', 'linguist-vendored'],
      { input: paths.join('\0') + '\0', allowFail: true }) || '';
  }
  const parts = raw.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [p, attr, val] = [parts[i], parts[i + 1], parts[i + 2]];
    if (val === 'set' || val === 'true') res.set(p, attr);
  }
  return res;
}

function shebang(sha) {
  const r = spawnSync('git', ['cat-file', 'blob', sha], { cwd: repoRoot(), maxBuffer: 1 << 30 });
  return r.status === 0 && r.stdout.length > 2 && r.stdout[0] === 0x23 && r.stdout[1] === 0x21;
}

function inventory(scan, opts, profileHash) {
  const tree = lsTree(scan.commit_sha);
  const inc = pathMatcher(opts.include);
  const exc = pathMatcher(opts.exclude);
  const only = pathMatcher(opts.only);
  const forced = pathMatcher(opts.forcePath);
  const verdicts = tree.map((t) => ({ t, v: classifyPath(t.path, t.mode, t.size, opts) }));
  const codePaths = verdicts.filter((x) => x.v.code).map((x) => x.t.path);
  const ling = linguistFlags(scan.commit_sha, codePaths);
  const reviewedQ = db().prepare('SELECT 1 FROM reviewed WHERE blob_sha=? AND profile_hash=?');
  const ins = db().prepare(`INSERT INTO files(scan_id,path,blob_sha,mode,bytes,lang,unit,state,reason)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const stats = { code: 0, codeBytes: 0, unchanged: 0, excluded: {}, unknownExt: {} };
  for (const { t, v } of verdicts) {
    let verdict = { ...v };
    if (verdict.code && ling.has(t.path)) verdict = { code: false, reason: ling.get(t.path) };
    if (verdict.code && t.mode === '100755' && extOf(t.path) === '' && !shebang(t.sha)) {
      verdict = { code: false, reason: 'no-ext' };
    }
    if (inc && inc(t.path) && !verdict.code && !['symlink', 'submodule', 'binary'].includes(verdict.reason)) {
      verdict = { code: true, reason: '', lang: LANG[extOf(t.path)] || extOf(t.path).slice(1) || 'other' };
    }
    if (exc && exc(t.path) && verdict.code) verdict = { code: false, reason: 'user-exclude' };
    if (only && !only(t.path) && verdict.code) verdict = { code: false, reason: 'out-of-scope' };
    let state = 'excluded';
    if (verdict.code) {
      const force = opts.force || (forced && forced(t.path));
      state = !force && reviewedQ.get(t.sha, profileHash) ? 'unchanged' : 'pending';
    }
    if (state === 'pending') { stats.code++; stats.codeBytes += t.size; }
    else if (state === 'unchanged') stats.unchanged++;
    else {
      stats.excluded[verdict.reason] = (stats.excluded[verdict.reason] || 0) + 1;
      if (verdict.reason === 'unknown-ext') {
        const e = extOf(t.path);
        stats.unknownExt[e] = (stats.unknownExt[e] || 0) + 1;
      }
    }
    ins.run(scan.id, t.path, t.sha, t.mode, t.size, verdict.lang || null, defaultUnit(t.path),
      state, verdict.code ? null : verdict.reason);
  }
  return stats;
}

function defaultUnit(p) {
  const parts = p.split('/');
  if (parts.length <= 1) return '(root)';
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

/** Directory digest for the planner: one line per directory, depth-collapsed. */
function writeTree(scan) {
  const files = db().prepare('SELECT path,bytes,state,reason,lang FROM files WHERE scan_id=?').all(scan.id);
  const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '.' : p.slice(0, i); };
  const depthOf = (d) => (d === '.' ? 0 : d.split('/').length);
  let maxDepth = 0;
  for (const f of files) maxDepth = Math.max(maxDepth, depthOf(dirOf(f.path)));
  const keyAt = (d, depth) => (d === '.' ? '.' : d.split('/').slice(0, depth).join('/'));
  let depth = maxDepth;
  while (depth > 1) {
    const s = new Set(files.map((f) => keyAt(dirOf(f.path), depth)));
    if (s.size <= 400) break;
    depth--;
  }
  const agg = new Map();
  for (const f of files) {
    const d = dirOf(f.path);
    const k = keyAt(d, depth) + (depthOf(d) > depth ? '/**' : '');
    let a = agg.get(k);
    if (!a) agg.set(k, a = { files: 0, code: 0, bytes: 0, langs: {}, excl: {} });
    a.files++;
    if (f.state === 'pending' || f.state === 'unchanged') {
      a.code++; a.bytes += f.bytes;
      a.langs[f.lang] = (a.langs[f.lang] || 0) + 1;
    } else a.excl[f.reason] = (a.excl[f.reason] || 0) + 1;
  }
  const fmt = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(',');
  const lines = [...agg.keys()].sort().map((k) => {
    const a = agg.get(k);
    let s = `${k === '.' ? './' : k + '/'}  files=${a.files} code=${a.code}`;
    if (a.code) s += ` code_kb=${Math.round(a.bytes / 1024)} langs=${fmt(a.langs)}`;
    if (Object.keys(a.excl).length) s += ` excluded=${fmt(a.excl)}`;
    return s;
  });
  const p = path.join(scanDir(scan.id), 'tree.txt');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function scanDir(id) {
  const d = path.join(stateDir(), 'scans', String(id));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function dirsetHash(scanId) {
  const dirs = new Set(db().prepare("SELECT path FROM files WHERE scan_id=? AND state IN ('pending','unchanged')")
    .all(scanId).map((r) => { const i = r.path.lastIndexOf('/'); return i < 0 ? '.' : r.path.slice(0, i); }));
  return sha1([...dirs].sort().join('\n'));
}

// ------------------------------------------------------------------- packing

function stemKey(p) {
  const name = p.split('/').pop().toLowerCase();
  const i = name.indexOf('.');
  let stem = i > 0 ? name.slice(0, i) : name;
  stem = stem.replace(/([_-](impl|inl|internal|linux|darwin|windows|win|unix|posix|bsd|amd64|arm64|x86|common|private|fwd|decl|defs?))+$/, '');
  return stem;
}

function pack(scan) {
  const opts = JSON.parse(scan.options_json);
  const budget = Math.max(MIN_CHUNK_KB, Number(opts.chunkKb || DEFAULT_CHUNK_KB)) * 1024;
  const plan = scan.plan_json ? JSON.parse(scan.plan_json) : null;
  const d = db();
  d.prepare("UPDATE chunks SET state='void' WHERE scan_id=? AND state IN ('pending','claimed')").run(scan.id);
  d.prepare("UPDATE files SET state='pending', slices_done='[]' WHERE scan_id=? AND state IN ('in_progress','partial')").run(scan.id);
  const files = d.prepare("SELECT * FROM files WHERE scan_id=? AND state IN ('pending','partial') ORDER BY path").all(scan.id);
  const unitMeta = new Map((plan && plan.units || []).map((u) => [u.name, u]));
  const groups = (plan && plan.groups || []).map((g) => pathMatcher(g));
  const setSlices = d.prepare('UPDATE files SET slices_json=? WHERE scan_id=? AND path=?');
  const atoms = new Map();
  const addAtom = (key, unit, dir, item) => {
    let a = atoms.get(key);
    if (!a) atoms.set(key, a = { unit, dir, items: [], bytes: 0 });
    a.items.push(item);
    a.bytes += item.bytes;
  };
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    // a file is never split: one file is always reviewed whole by one agent. A file larger than the
    // budget becomes a chunk of its own. (Older state may carry slice bookkeeping; drop it.)
    if (f.slices_json) setSlices.run(null, scan.id, f.path);
    if (f.bytes > budget) { addAtom(`whole|${f.path}`, f.unit, dir, { path: f.path, bytes: f.bytes }); continue; }
    const gi = groups.findIndex((m) => m(f.path));
    const key = gi >= 0 ? `g${gi}|${f.unit}` : `${dir}|${stemKey(f.path)}`;
    addAtom(key, f.unit, dir, { path: f.path, bytes: f.bytes });
  }
  // a same-stem / planner group larger than the budget is reviewed file by file instead
  for (const [k, a] of [...atoms.entries()]) {
    if (a.items.length > 1 && a.bytes > budget) {
      atoms.delete(k);
      for (const it of a.items) atoms.set(`${k}|${it.path}`, { unit: a.unit, dir: a.dir, items: [it], bytes: it.bytes });
    }
  }
  const prio = (u) => (unitMeta.get(u) && Number(unitMeta.get(u).priority)) || 0;
  const list = [...atoms.values()].sort((a, b) =>
    prio(b.unit) - prio(a.unit) || String(a.unit).localeCompare(String(b.unit)) || a.dir.localeCompare(b.dir));
  const parent = (dir) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.');
  const chunks = [];
  let cur = null;
  for (const a of list) {
    if (cur) {
      const sameUnit = cur.unit === a.unit;
      const fits = cur.bytes + a.bytes <= budget && cur.items.length + a.items.length <= MAX_FILES_PER_CHUNK;
      const sameDir = cur.dir === a.dir;
      const nearDir = parent(cur.dir) === parent(a.dir) || parent(a.dir) === cur.dir || parent(cur.dir) === a.dir;
      if (!sameUnit || !fits || (!sameDir && !(nearDir && cur.bytes < budget / 2))) { chunks.push(cur); cur = null; }
    }
    if (!cur) cur = { unit: a.unit, dir: a.dir, items: [], bytes: 0 };
    cur.items.push(...a.items);
    cur.bytes += a.bytes;
    cur.dir = a.dir;
  }
  if (cur) chunks.push(cur);
  chunks.sort((a, b) => prio(b.unit) - prio(a.unit) || b.bytes - a.bytes);
  const ins = d.prepare("INSERT INTO chunks(scan_id,ord,unit,items_json,bytes,state) VALUES(?,?,?,?,?,'pending')");
  chunks.forEach((c, i) => ins.run(scan.id, i, c.unit, JSON.stringify(c.items), c.bytes));
  return { chunks: chunks.length, files: files.length, bytes: chunks.reduce((s, c) => s + c.bytes, 0) };
}

function pendingChunks(scanId) {
  return db().prepare("SELECT COUNT(*) n FROM chunks WHERE scan_id=? AND state='pending'").get(scanId).n;
}

function cliPrefix() {
  const h = process.env.CODESCAN_HOME ? `CODESCAN_HOME=${path.resolve(process.env.CODESCAN_HOME)} ` : '';
  return `${h}node ${CLI} -C ${repoRoot()}`;
}

function nextLine(scan, plan) {
  const workers = Math.min(pendingChunks(scan.id), MAX_WORKERS_PER_RUN);
  const o = { cli: CLI, root: repoRoot(), scanId: scan.id, plan: !!plan, workers };
  if (process.env.CODESCAN_HOME) o.home = path.resolve(process.env.CODESCAN_HOME);
  return 'NEXT ' + JSON.stringify(o);
}

// ------------------------------------------------------------- scan commands

function buildOpts(f, base = {}) {
  const o = { ...base };
  if (f['include-tests'] !== undefined) o.includeTests = !!f['include-tests'];
  if (f.include) o.include = f.include;
  if (f.exclude) o.exclude = f.exclude;
  if (f.only) o.only = f.only;
  applyLimitFlags(o, f);
  if (f['chunk-kb']) { o.chunkKb = Number(f['chunk-kb']); o.chunkSource = 'flag'; }
  if (f.model) o.model = f.model;
  if (!f['chunk-kb'] && (o.chunkSource !== 'flag' || f.model)) {
    const cal = o.model ? cfgGet(`chunk_kb:${o.model}`) : null;
    o.chunkKb = cal ? Number(cal) : DEFAULT_CHUNK_KB;
    o.chunkSource = cal ? `calibrated for ${o.model}` : 'default';
  }
  if (f['no-plan'] !== undefined) o.noPlan = !!f['no-plan'];
  o.force = !!f.force;
  o.forcePath = f['force-path'] || null;
  return o;
}

function planSource(f) {
  if (f.replan) return null;
  return db().prepare("SELECT * FROM scans WHERE kind='scan' AND plan_json IS NOT NULL ORDER BY id DESC LIMIT 1").get() || null;
}

function createScan(f, base, profile) {
  const prev = planSource(f);
  const commit = git(['rev-parse', f.commit || 'HEAD']).trim();
  const opts = buildOpts(f, base);
  const d = db();
  const scan = tx(() => {
    const r = d.prepare(`INSERT INTO scans(commit_sha,profile_name,profile_hash,options_json,status,created,updated)
      VALUES(?,?,?,?,'active',?,?)`).run(commit, profile.name, profile.hash, JSON.stringify(opts), now(), now());
    const s = getScan(r.lastInsertRowid);
    const stats = inventory(s, opts, profile.hash);
    const dh = dirsetHash(s.id);
    d.prepare('UPDATE scans SET dirset_hash=? WHERE id=?').run(dh, s.id);
    s.dirset_hash = dh;
    s.stats = stats;
    return s;
  });
  writeTree(scan);
  let needPlan = !opts.noPlan;
  let reused = false;
  if (prev && prev.dirset_hash === scan.dirset_hash) {
    try {
      tx(() => applyPlan(scan, JSON.parse(prev.plan_json)));
      needPlan = false;
      reused = true;
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
    }
  }
  const s2 = getScan(scan.id);
  const pk = tx(() => pack(s2));
  if (pk.chunks === 0) setScanStatus(scan.id, 'done');
  const st = scan.stats;
  const excl = Object.entries(st.excluded).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' ');
  const unk = Object.entries(st.unknownExt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(' ');
  out(`scan ${scan.id} @ ${commit.slice(0, 12)} profile=${profile.name}`);
  const pre = needPlan && pk.files > 0 ? ' (before planner; it may include/exclude files and regroup)' : '';
  out(`to review: ${pk.files} files, ${kb(pk.bytes)} in ${pk.chunks} chunks${pre}; unchanged (skipped): ${st.unchanged}`);
  out(`excluded: ${excl || 'none'}`);
  out(`chunk size: ${opts.chunkKb}KB (${opts.chunkSource || 'default'})`);
  if (opts.model && !cfgGet(`chunk_kb:${opts.model}`) && opts.chunkSource !== 'flag') {
    out(`CALIBRATE model ${opts.model} has no chunk-size calibration for this repo — run \`calibrate start --model ${opts.model}\` first`);
  }
  if (unk) out(`unknown extensions (excluded; widen with --include): ${unk}`);
  if (reused) out(`planner: reused plan from scan ${prev.id} (directory layout unchanged; --replan to redo)`);
  out(nextLine(scan, needPlan && pk.files > 0));
}

function cmdStart(a) {
  const ex = openScan();
  if (ex && !a.f.new) {
    die(`scan ${ex.id} is ${ex.status} at ${ex.commit_sha.slice(0, 12)} — use \`continue\`, \`restart\`, or \`start --new\``);
  }
  if (ex) setScanStatus(ex.id, 'superseded');
  const profile = profileFromFlags(a.f);
  createScan(a.f, {}, profile);
}

function cmdRestart(a) {
  const prev = openScan() || latestScan(false);
  if (prev && ['active', 'stopped'].includes(prev.status)) setScanStatus(prev.id, 'superseded');
  const base = prev ? JSON.parse(prev.options_json) : {};
  delete base.force; delete base.forcePath;
  // a new scope replaces the old one as a whole; --reset-scope clears it
  if (a.f.only || a.f.include || a.f.exclude || a.f['reset-scope']) { delete base.only; delete base.include; delete base.exclude; }
  const profile = (a.f.profile || a.f['prompt-file']) ? profileFromFlags(a.f)
    : prev ? resolveProfile(prev.profile_name) : resolveProfile('default');
  createScan(a.f, base, profile);
}

function cmdContinue(a) {
  const scan = a.f.scan ? getScan(a.f.scan) : openScan();
  if (!scan) die('no active or stopped scan — use `start` or `restart`');
  if (!['active', 'stopped'].includes(scan.status)) die(`scan ${scan.id} is ${scan.status}`);
  const head = git(['rev-parse', 'HEAD']).trim();
  setScanStatus(scan.id, 'active');
  db().prepare('DELETE FROM config WHERE key=?').run(`stop_reason:${scan.id}`);
  if (a.f['max-usd'] !== undefined || a.f['max-5h-pct'] !== undefined) {
    const o = applyLimitFlags(JSON.parse(scan.options_json), a.f);
    db().prepare('UPDATE scans SET options_json=? WHERE id=?').run(JSON.stringify(o), scan.id);
    scan.options_json = JSON.stringify(o);
  }
  const why0 = limitReason(getScan(scan.id));
  if (why0) {
    // nothing to launch while a limit is crossed: the scan stays stopped, NEXT carries no workers
    setScanStatus(scan.id, 'stopped');
    cfgSet(`stop_reason:${scan.id}`, why0);
    out(`limit still crossed: ${why0} — not resuming`);
    out('NEXT ' + JSON.stringify({ cli: CLI, root: repoRoot(), scanId: scan.id, plan: false, workers: 0 }));
    return;
  }
  if (a.f.model || a.f['chunk-kb']) {
    // pick up a calibration finished after the scan was created (or an explicit size)
    const opts = buildOpts(a.f, JSON.parse(scan.options_json));
    opts.force = JSON.parse(scan.options_json).force;
    opts.forcePath = JSON.parse(scan.options_json).forcePath;
    db().prepare('UPDATE scans SET options_json=? WHERE id=?').run(JSON.stringify(opts), scan.id);
    out(`chunk size: ${opts.chunkKb}KB (${opts.chunkSource})`);
  }
  const pk = tx(() => pack(getScan(scan.id)));
  const unplanned = !scan.plan_json && !JSON.parse(scan.options_json).noPlan;
  out(`scan ${scan.id} @ ${scan.commit_sha.slice(0, 12)}: ${pk.files} files (${kb(pk.bytes)}) left in ${pk.chunks} chunks`);
  if (head !== scan.commit_sha) out(`note: HEAD is ${head.slice(0, 12)}; this scan reviews ${scan.commit_sha.slice(0, 12)} (use \`restart\` for HEAD)`);
  if (pk.chunks === 0) { setScanStatus(scan.id, 'done'); out('nothing left — scan marked done'); }
  out(nextLine(scan, unplanned && pk.files > 0));
}

function cmdStop(a) {
  const scan = a.f.scan ? getScan(a.f.scan) : openScan();
  if (!scan) die('no active scan');
  tx((d) => {
    setScanStatus(scan.id, 'stopped');
    if (a.f.now) {
      d.prepare("UPDATE chunks SET state='void' WHERE scan_id=? AND state='claimed'").run(scan.id);
      d.prepare("UPDATE files SET state=CASE WHEN slices_done='[]' THEN 'pending' ELSE 'partial' END WHERE scan_id=? AND state='in_progress'").run(scan.id);
    }
  });
  out(`scan ${scan.id} stopped; workers stop claiming new chunks${a.f.now ? ', claimed chunks released' : ' and in-flight chunks finish'}`);
  if (a.f.now && scan.workflow_task) out(`TASK ${scan.workflow_task}`);
}

function cmdSetRun(a) {
  const [id, task] = a.pos;
  if (!id || !task) die('usage: set-run <scanId> <taskId>');
  db().prepare('UPDATE scans SET workflow_task=?, updated=? WHERE id=?').run(task, now(), Number(id));
  out('ok');
}

// ------------------------------------------------------------------ planning

const PLAN_INSTRUCTIONS = `
You are planning a bug scan. Decide which tracked files are product code worth reviewing and how
to group them into review units. Use ONLY the directory digest above plus, if needed, top-level
manifests/build files (README*, CMakeLists.txt, configure.py, meson.build, go.mod, Cargo.toml,
package.json, pyproject.toml, setup.py, Makefile) and directory listings (\`git ls-files <dir>\`).
Do NOT open source files.

Write a JSON file with this shape and run \`node CLI apply-plan SCAN --file <that file>\`:
{
  "include": [{"glob": "scripts/**/*.lua", "reason": "product scripts"}],
  "exclude": [{"glob": "tools/gen/", "reason": "generated"}],
  "units": [{"name": "net", "globs": ["src/net/", "rpc/**"], "priority": 10,
             "hint": "parses untrusted frames; check bounds, length fields, lifetimes"}],
  "groups": [["src/foo/a.hh", "src/foo/a.cc", "src/foo/a_impl.hh"]]
}
- include/exclude: only corrections to the heuristic classification (excluded reasons are shown in
  the digest). Exclude generated, vendored, examples, benchmarks, dead/legacy code, test helpers.
- units: subsystems; every code file should land in one (first match wins; unmatched files keep a
  default unit by top-level dir). priority: higher = reviewed first (security-sensitive, untrusted
  input, memory management, concurrency first). hint: <= 2 lines of subsystem-specific focus.
- groups: optional sets of files that must be reviewed together (beyond same-dir same-stem
  pairing, which is automatic).
Globs: gitignore-like ('dir/' = everything under dir, '**' any depth, no '/' = any depth).
Every glob must match at least one tracked file; apply-plan rejects the plan otherwise — fix and rerun.
`;

function cmdPlanContext(a) {
  const scan = getScan(a.pos[0] || (openScan() || latestScan()).id);
  const tree = fs.readFileSync(path.join(scanDir(scan.id), 'tree.txt'), 'utf8');
  const prof = db().prepare('SELECT text FROM profiles WHERE name=?').get(scan.profile_name);
  out(`== SCAN ${scan.id} @ ${scan.commit_sha} (repo ${repoRoot()}) ==`);
  out('== REVIEW PROFILE (what reviewers will look for) ==');
  out((prof ? prof.text : '').trim().split('\n').slice(0, 25).join('\n'));
  out('== DIRECTORY DIGEST (code = files currently classified as code) ==');
  out(tree);
  out('== INSTRUCTIONS ==');
  out(PLAN_INSTRUCTIONS.replace('node CLI', cliPrefix()).replace('SCAN', String(scan.id)));
}

function applyPlan(scan, plan) {
  const d = db();
  const all = d.prepare('SELECT path,state,reason,blob_sha FROM files WHERE scan_id=?').all(scan.id);
  const bad = [];
  const check = (g) => { const m = pathMatcher(g); if (!all.some((r) => m(r.path))) bad.push(g); return m; };
  const incs = (plan.include || []).map((x) => ({ m: check(x.glob), reason: x.reason }));
  const excs = (plan.exclude || []).map((x) => ({ m: check(x.glob), reason: x.reason }));
  const units = (plan.units || []).map((u) => ({ name: String(u.name), ms: (u.globs || []).map(check) }));
  (plan.groups || []).forEach((g) => [].concat(g).forEach(check));
  if (bad.length) throw new PlanError(`globs match no tracked file: ${bad.slice(0, 20).join(', ')}`);
  const opts = JSON.parse(scan.options_json);
  const forced = pathMatcher(opts.forcePath);
  const reviewedQ = d.prepare('SELECT 1 FROM reviewed WHERE blob_sha=? AND profile_hash=?');
  const upd = d.prepare('UPDATE files SET state=?, reason=?, unit=?, lang=COALESCE(lang,?) WHERE scan_id=? AND path=?');
  let added = 0, removed = 0;
  for (const r of all) {
    let { state, reason } = r;
    if (state === 'excluded' && !['symlink', 'submodule', 'binary', 'user-exclude', 'out-of-scope'].includes(reason) &&
        incs.some((x) => x.m(r.path))) {
      const force = opts.force || (forced && forced(r.path));
      state = !force && reviewedQ.get(r.blob_sha, scan.profile_hash) ? 'unchanged' : 'pending';
      reason = null; added++;
    }
    const ex = excs.find((x) => x.m(r.path));
    if (ex && ['pending', 'unchanged', 'partial'].includes(state)) {
      state = 'excluded'; reason = `plan: ${ex.reason || 'excluded'}`.slice(0, 120); removed++;
    }
    const u = units.find((x) => x.ms.some((m) => m(r.path)));
    upd.run(state, reason, u ? u.name : defaultUnit(r.path), extOf(r.path).slice(1) || 'other', scan.id, r.path);
  }
  d.prepare('UPDATE scans SET plan_json=?, updated=? WHERE id=?').run(JSON.stringify(plan), now(), scan.id);
  return { added, removed };
}
class PlanError extends Error {}

function cmdApplyPlan(a) {
  const scan = getScan(a.pos[0] || (openScan() || latestScan()).id);
  const src = a.f.file ? fs.readFileSync(a.f.file, 'utf8') : fs.readFileSync(0, 'utf8');
  let plan;
  try { plan = JSON.parse(src); } catch (e) { die(`plan is not valid JSON: ${e.message}`); }
  for (const k of ['include', 'exclude', 'units', 'groups']) {
    if (plan[k] !== undefined && !Array.isArray(plan[k])) die(`plan.${k} must be an array`);
  }
  let res;
  try {
    res = tx(() => {
      const r = applyPlan(scan, plan);
      const pk = pack(getScan(scan.id));
      return { ...r, ...pk };
    });
  } catch (e) {
    if (e instanceof PlanError) die(e.message);
    throw e;
  }
  out(`plan applied: +${res.added} included, -${res.removed} excluded, ${(plan.units || []).length} units`);
  out(`chunks=${res.chunks} files=${res.files} bytes=${kb(res.bytes)}`);
}

// -------------------------------------------------------------- claim/submit

function worktreeMatches(p, blob) {
  const abs = path.join(repoRoot(), p);
  if (!fs.existsSync(abs)) return false;
  const r = spawnSync('git', ['hash-object', '--', p], { cwd: repoRoot(), encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === blob;
}

function cmdClaim(a) {
  const scanId = Number(a.pos[0] || (openScan() || {}).id);
  if (!scanId) { out('NONE'); return; }
  const pre = db().prepare('SELECT * FROM scans WHERE id=?').get(scanId);
  if (pre && pre.status === 'active') {
    const why = limitReason(pre);
    if (why) {
      setScanStatus(scanId, 'stopped');
      cfgSet(`stop_reason:${scanId}`, why);
      out(`NONE (${why})`);
      return;
    }
  }
  const got = tx((d) => {
    const scan = d.prepare('SELECT * FROM scans WHERE id=?').get(scanId);
    if (!scan || scan.status !== 'active') return null;
    const c = d.prepare("SELECT * FROM chunks WHERE scan_id=? AND state='pending' ORDER BY ord LIMIT 1").get(scanId);
    if (!c) return null;
    d.prepare("UPDATE chunks SET state='claimed', claimed_at=? WHERE id=?").run(now(), c.id);
    const items = JSON.parse(c.items_json);
    const st = d.prepare("UPDATE files SET state='in_progress' WHERE scan_id=? AND path=? AND state IN ('pending','partial')");
    for (const it of items) st.run(scanId, it.path);
    return { scan, c, items };
  });
  if (!got) { out('NONE'); return; }
  const { scan, c, items } = got;
  const prof = db().prepare('SELECT text FROM profiles WHERE name=?').get(scan.profile_name);
  const plan = scan.plan_json ? JSON.parse(scan.plan_json) : null;
  const unit = plan && (plan.units || []).find((u) => u.name === c.unit);
  const blobs = new Map(db().prepare(`SELECT path,blob_sha FROM files WHERE scan_id=? AND path IN (${items.map(() => '?').join(',')})`)
    .all(scanId, ...items.map((i) => i.path)).map((r) => [r.path, r.blob_sha]));
  out(`CHUNK ${c.id} (scan ${scanId}, unit ${c.unit}, ${kb(c.bytes)}) commit ${scan.commit_sha}`);
  out('== REVIEW PROFILE ==');
  out(prof ? prof.text.trim() : '(default)');
  if (unit && unit.hint) { out('== SUBSYSTEM FOCUS =='); out(unit.hint); }
  if (a.f.inline) {
    const submitHelp = () => {
      out('== SUBMIT (once, after reviewing everything) ==');
      out(`${cliPrefix()} submit ${scanId} ${c.id} <<'EOF'\n{${items.map((it) => JSON.stringify(it.path) + ': [ ]').join(', ')}}\nEOF`);
      out('Each key maps to that file\'s confirmed findings: [] if none, else objects {"line":N,"end_line":N,"severity":"critical|high|medium|low","category":"...","title":"...","detail":"...","evidence":"...","confidence":0.0-1.0}.');
    };
    const texts = items.map((it) => {
      const lines = catBlob(blobs.get(it.path)).split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return { it, lines };
    });
    const numbered = texts.map(({ it, lines }) => `=== ${it.path} (${lines.length} lines)\n` +
      lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')).join('\n');
    // Bash results over ~30KB are cut off and saved to a file the agent must page through, which
    // costs turns; inline only what fits, otherwise hand over paths for parallel Read calls.
    if (numbered.length <= INLINE_MAX_CHARS) {
      out('== CODE TO REVIEW (scanned commit; numbers are real file lines) ==');
      out(numbered);
    } else {
      out('== FILES TO REVIEW — issue ALL these Read calls in ONE turn (parallel); use the offset/limit shown ==');
      for (const { it, lines } of texts) {
        let p = path.join(repoRoot(), it.path);
        if (!worktreeMatches(it.path, blobs.get(it.path))) {
          p = path.join(stateDir(), 'chunks', String(c.id), it.path);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, catBlob(blobs.get(it.path)));
        }
        // one Read returns at most ~2000 lines / ~25k tokens: page long files
        if (lines.length <= READ_PAGE_LINES) out(`Read ${p}`);
        else for (let o = 1; o <= lines.length; o += READ_PAGE_LINES) out(`Read ${p} offset=${o} limit=${READ_PAGE_LINES}`);
      }
    }
    submitHelp();
    return;
  }
  out('== FILES TO REVIEW ==');
  for (const it of items) {
    const abs = path.join(repoRoot(), it.path);
    const rng = it.slice !== undefined ? ` lines ${it.start}-${it.end} (slice ${it.slice}; overlap with neighbours is intentional)` : '';
    const how = worktreeMatches(it.path, blobs.get(it.path)) ? abs : `git -C ${repoRoot()} show ${scan.commit_sha}:${it.path} | cat -n  (working tree differs from scanned commit)`;
    out(`- ${it.path}${rng}\n    read: ${how}`);
  }
  out('== SUBMIT (once per file/slice above, as soon as you finish it) ==');
  out(`${cliPrefix()} submit ${scanId} ${c.id} --file <path> [--slice <k>] <<'EOF'\n[ {"path":"...","line":N,"end_line":N,"severity":"critical|high|medium|low","category":"...","title":"...","detail":"...","evidence":"...","confidence":0.0-1.0} ]\nEOF`);
  out('Submit [] for a file with no confirmed issues.');
}

function normTitle(t) { return String(t).toLowerCase().replace(/[`'"]/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim(); }

const blobCache = new Map();
function lineText(blob, line) {
  if (!blob || !line) return '';
  if (!blobCache.has(blob)) blobCache.set(blob, catBlob(blob).split('\n'));
  const l = blobCache.get(blob)[line - 1];
  return l === undefined ? '' : l.trim().slice(0, 240);
}

/**
 * The same bug re-reported in a later scan rarely gets the same title or line. Match it to an
 * existing finding on the same file: same code line text or a nearby line, plus a related title.
 * Findings already seen in this scan are excluded so two distinct bugs in one review never merge.
 */
/** Same bug, judged from location and wording: overlapping lines with a related title, or the same
 * file with a strongly similar title (reviewers sometimes cite a different spot for one bug). */
function sameBug(a, b, pad = 3) {
  if (a.path !== b.path) return false;
  const jt = jaccard(tokens(a.title), tokens(b.title));
  if (jt >= 0.5) return true;
  return linesNear(a, b, pad) && jt >= (a.category === b.category ? 0.2 : 0.35);
}

/** Line ranges [line, end_line] overlap, allowing `pad` lines of drift between reviews. */
function linesNear(a, b, pad = 3) {
  if (!a.line || !b.line) return false;
  const a2 = Math.max(a.end_line || a.line, a.line), b2 = Math.max(b.end_line || b.line, b.line);
  return a.line - pad <= b2 && b.line - pad <= a2;
}

function similarFinding(d, f, snippet, scanId) {
  const cands = d.prepare(`SELECT id, triage, note, title, line, end_line, snippet, category FROM findings
    WHERE path=? AND id NOT IN (SELECT finding_id FROM seen WHERE scan_id=?)`).all(f.path, scanId);
  const tk = tokens(f.title);
  let best = null, bestScore = 0;
  for (const c of cands) {
    const sameLine = snippet && c.snippet && snippet === c.snippet;
    const near = linesNear(f, c);
    const jt = jaccard(tk, tokens(c.title));
    if (!sameLine && !near && jt < 0.5) continue;
    const score = jt + (sameLine ? 0.3 : 0) + (c.category === f.category ? 0.2 : 0);
    if ((jt >= 0.5 || ((sameLine || near) && jt >= 0.2) || (sameLine && c.category === f.category)) && score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function cmdSubmit(a) {
  const [sid, cid] = a.pos;
  const scanId = Number(sid), chunkId = Number(cid);
  const file = a.f.file;
  if (!scanId || !chunkId) die('usage: submit <scanId> <chunkId> [--file <path> [--slice k]] < findings.json');
  let arr = a.arr;
  if (!arr) {
    const raw = a.f.input ? fs.readFileSync(a.f.input, 'utf8') : fs.readFileSync(0, 'utf8');
    try { arr = JSON.parse(raw.trim() || (file ? '[]' : '{}')); } catch (e) { die(`findings are not valid JSON: ${e.message}`); }
  }
  if (!file) {
    // batch: {"path": [...], "path#slice": [...]} for the whole chunk in one call
    if (!arr || Array.isArray(arr) || typeof arr !== 'object') die('without --file, submit expects a JSON object {"<path>[#slice]": [findings], ...}');
    const ch = db().prepare('SELECT items_json FROM chunks WHERE id=? AND scan_id=?').get(chunkId, scanId);
    if (!ch) die(`chunk ${chunkId} is not part of scan ${scanId}`);
    const keys = new Set(JSON.parse(ch.items_json).map((it) => (it.slice !== undefined ? `${it.path}#${it.slice}` : it.path)));
    const bad = Object.keys(arr).filter((k) => !keys.has(k) && !keys.has(k.replace(/^\.\//, '')));
    if (bad.length) die(`not in chunk ${chunkId}: ${bad.join(', ')}; expected keys: ${[...keys].join(', ')}`);
    for (const [k, v] of Object.entries(arr)) {
      if (!Array.isArray(v)) die(`value for ${k} must be an array`);
    }
    const missing = [...keys].filter((k) => !(k in arr));
    for (const [k, v] of Object.entries(arr)) {
      const m = k.replace(/^\.\//, '').match(/^(.*?)(?:#(\d+))?$/);
      cmdSubmit({ pos: [String(scanId), String(chunkId)], f: { file: m[1], slice: m[2] }, arr: v });
    }
    if (missing.length) out(`note: not submitted yet: ${missing.join(', ')}`);
    return;
  }
  if (arr && !Array.isArray(arr) && Array.isArray(arr.findings)) arr = arr.findings;
  if (!Array.isArray(arr)) die('expected a JSON array of findings');
  const d = db();
  const scan = getScan(scanId);
  const chunk = d.prepare('SELECT * FROM chunks WHERE id=? AND scan_id=?').get(chunkId, scanId);
  if (!chunk) die(`chunk ${chunkId} is not part of scan ${scanId}`);
  const items = JSON.parse(chunk.items_json);
  const slice = a.f.slice !== undefined ? Number(a.f.slice) : undefined;
  const item = items.find((i) => i.path === file && (slice === undefined ? true : i.slice === slice));
  if (!item) die(`${file}${slice !== undefined ? ' slice ' + slice : ''} is not in chunk ${chunkId}; files: ${items.map((i) => i.path + (i.slice !== undefined ? '#' + i.slice : '')).join(', ')}`);
  if (item.slice !== undefined && slice === undefined) {
    const ks = items.filter((i) => i.path === file).map((i) => i.slice);
    if (ks.length > 1) die(`${file} has several slices in this chunk (${ks.join(',')}); pass --slice`);
  }
  const errs = [];
  const clean = arr.map((x, i) => {
    const p = String(x.path || file).replace(/^\.\//, '').replace(new RegExp('^' + escRe(repoRoot() + '/')), '');
    const sev = String(x.severity || '').toLowerCase();
    if (!SEVERITIES.includes(sev)) errs.push(`#${i}: severity must be one of ${SEVERITIES.join('|')}`);
    if (!x.title) errs.push(`#${i}: title required`);
    const line = x.line !== undefined && x.line !== null ? parseInt(x.line, 10) : null;
    if (x.line !== undefined && x.line !== null && !(line > 0)) errs.push(`#${i}: line must be a positive integer`);
    let conf = x.confidence !== undefined ? Number(x.confidence) : null;
    if (conf !== null && (isNaN(conf) || conf < 0)) conf = null;
    if (conf !== null && conf > 1) conf = conf / 100;
    return {
      path: p, line, end_line: x.end_line || x.endLine ? parseInt(x.end_line || x.endLine, 10) : null,
      severity: sev, category: String(x.category || 'correctness').toLowerCase().trim(),
      title: String(x.title || '').trim().slice(0, 300), detail: x.detail ? String(x.detail) : null,
      evidence: x.evidence ? (typeof x.evidence === 'string' ? x.evidence : JSON.stringify(x.evidence)) : null,
      confidence: conf,
    };
  });
  if (errs.length) die(`invalid findings:\n  ${errs.join('\n  ')}`);
  const res = tx(() => {
    const blobQ = d.prepare('SELECT blob_sha, unit FROM files WHERE scan_id=? AND path=?');
    let added = 0, updated = 0;
    for (const f of clean) {
      if (scan.kind === 'cal') {
        const b = blobQ.get(scanId, f.path) || { blob_sha: (git(['rev-parse', `${scan.commit_sha}:${f.path}`], { allowFail: true }) || '').trim() };
        if (!b.blob_sha) throw new Error(`finding path ${f.path} is not a tracked file at the scanned commit`);
        d.prepare('INSERT INTO cal_findings(scan_id,path,line,end_line,severity,category,title,snippet) VALUES(?,?,?,?,?,?,?,?)')
          .run(scanId, f.path, f.line, f.end_line, f.severity, f.category, f.title, lineText(b.blob_sha, f.line));
        added++;
        continue;
      }
      const fr = blobQ.get(scanId, f.path);
      if (!fr) throw new Error(`finding path ${f.path} is not a tracked file at the scanned commit`);
      const snippet = lineText(fr.blob_sha, f.line);
      const fp = sha1([f.path, f.category, normTitle(f.title), snippet || String(f.line)].join('\n'), 20);
      const ex = d.prepare('SELECT id, triage, note FROM findings WHERE fingerprint=?').get(fp) ||
        similarFinding(d, f, snippet, scanId);
      if (ex) {
        const reopen = ex.triage === 'fixed';
        d.prepare(`UPDATE findings SET last_scan=?, commit_sha=?, line=?, end_line=?, severity=?, detail=COALESCE(?,detail),
          evidence=COALESCE(?,evidence), confidence=COALESCE(?,confidence), blob_sha=?, updated=?, triage=?, note=?,
          snippet=?, gone_scan=NULL WHERE id=?`)
          .run(scanId, scan.commit_sha, f.line, f.end_line, f.severity, f.detail, f.evidence, f.confidence, fr.blob_sha, now(),
            reopen ? 'open' : ex.triage, reopen ? `${ex.note ? ex.note + '\n' : ''}reappeared in scan ${scanId}` : ex.note,
            snippet, ex.id);
        d.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(ex.id, scanId);
        updated++;
      } else {
        const r = d.prepare(`INSERT INTO findings(fingerprint,first_scan,last_scan,commit_sha,path,line,end_line,severity,category,
          title,detail,evidence,snippet,confidence,blob_sha,unit,profile_name,created,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(fp, scanId, scanId, scan.commit_sha, f.path, f.line, f.end_line,
          f.severity, f.category, f.title, f.detail, f.evidence, snippet, f.confidence, fr.blob_sha, fr.unit, scan.profile_name, now(), now());
        d.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(r.lastInsertRowid, scanId);
        added++;
      }
    }
    // progress is per file: a file is reviewed once all its slices are in
    const fr = d.prepare('SELECT * FROM files WHERE scan_id=? AND path=?').get(scanId, file);
    let state = 'reviewed';
    let done = JSON.parse(fr.slices_done);
    const slices = fr.slices_json ? JSON.parse(fr.slices_json) : null;
    if (slices && slices.length > 1) {
      const k = item.slice;
      if (!done.includes(k)) done.push(k);
      done.sort((x, y) => x - y);
      if (done.length < slices.length) state = 'partial';
    }
    if (fr.state === 'reviewed') state = 'reviewed';
    d.prepare('UPDATE files SET state=?, slices_done=?, findings_n=findings_n+?, reviewed_at=? WHERE scan_id=? AND path=?')
      .run(state, JSON.stringify(done), clean.length, now(), scanId, file);
    if (state === 'reviewed' && scan.kind !== 'cal') {
      // re-reviewed file: earlier findings on it that this review did not report again are likely gone
      d.prepare(`UPDATE findings SET gone_scan=? WHERE path=? AND gone_scan IS NULL AND blob_sha!=?
        AND id NOT IN (SELECT finding_id FROM seen WHERE scan_id=?)`).run(scanId, file, fr.blob_sha, scanId);
      d.prepare('INSERT OR REPLACE INTO reviewed VALUES(?,?,?,?,?)').run(fr.blob_sha, scan.profile_hash, file, scanId, now());
    }
    // chunk done when each of its items is covered
    const left = items.filter((it) => {
      const r = d.prepare('SELECT state, slices_done FROM files WHERE scan_id=? AND path=?').get(scanId, it.path);
      if (r.state === 'reviewed') return false;
      return it.slice === undefined || !JSON.parse(r.slices_done).includes(it.slice);
    });
    if (!left.length && chunk.state !== 'done') d.prepare("UPDATE chunks SET state='done', done_at=? WHERE id=?").run(now(), chunkId);
    const open = d.prepare("SELECT COUNT(*) n FROM files WHERE scan_id=? AND state IN ('pending','in_progress','partial')").get(scanId).n;
    const cur = d.prepare('SELECT status FROM scans WHERE id=?').get(scanId).status;
    if (!open && (cur === 'active' || cur === 'stopped')) setScanStatus(scanId, 'done');
    return { added, updated, state, left: left.length };
  });
  out(`ok: ${file} ${res.state}; findings +${res.added} new, ${res.updated} known; ${res.left} item(s) left in chunk`);
}

// --------------------------------------------------------------- calibration
//
// Finds the chunk size beyond which review quality drops, per repo and model. The same small code
// sample is reviewed at several chunk sizes; every round's findings are clustered across rounds
// (same file, same/nearby line, related title) and a round scores the severity-weighted share of
// all clusters it found. Start at the medium size, try half: if that is clearly better keep
// halving; otherwise grow by 1.5x until the score falls clearly below the best seen, and keep the
// last size before the drop.

function calSample(commit, opts, sampleKb) {
  const tree = lsTree(commit);
  const code = tree.filter((t) => classifyPath(t.path, t.mode, t.size, opts).code && t.size <= sampleKb * 1024 / 2);
  const ling = linguistFlags(commit, code.map((t) => t.path));
  const files = code.filter((t) => !ling.has(t.path));
  if (!files.length) die('no code files to calibrate on');
  const byUnit = new Map();
  for (const t of files) {
    const u = defaultUnit(t.path);
    if (!byUnit.has(u)) byUnit.set(u, { bytes: 0, files: [] });
    const e = byUnit.get(u); e.bytes += t.size; e.files.push(t);
  }
  // one coherent area first (largest unit), topped up from the next largest
  const units = [...byUnit.values()].sort((a, b) => b.bytes - a.bytes);
  const pick = [];
  let total = 0;
  for (const u of units) {
    for (const t of u.files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (total >= sampleKb * 1024) break;
      pick.push(t); total += t.size;
    }
    if (total >= sampleKb * 1024) break;
  }
  return { pick, total };
}

function calRound(cal, sizeKb) {
  const d = db();
  const opts = { chunkKb: sizeKb, noPlan: true, model: cal.model, chunkSource: 'calibration' };
  const prof = resolveProfile(cal.profile_name);
  return tx(() => {
    const r = d.prepare(`INSERT INTO scans(commit_sha,profile_name,profile_hash,options_json,status,kind,cal_id,created,updated)
      VALUES(?,?,?,?,'active','cal',?,?,?)`).run(cal.commit_sha, prof.name, prof.hash, JSON.stringify(opts), cal.id, now(), now());
    const sid = Number(r.lastInsertRowid);
    const ins = d.prepare(`INSERT INTO files(scan_id,path,blob_sha,mode,bytes,lang,unit,state) VALUES(?,?,?,?,?,?,?,'pending')`);
    for (const t of JSON.parse(cal.sample_json)) ins.run(sid, t.path, t.sha, t.mode, t.size, LANG[extOf(t.path)] || null, defaultUnit(t.path));
    const pk = pack(getScan(sid));
    return { scanId: sid, workers: pk.chunks };
  });
}

function calScores(cal) {
  const d = db();
  const rounds = d.prepare("SELECT id, options_json, status FROM scans WHERE kind='cal' AND cal_id=? ORDER BY id").all(cal.id)
    .map((r) => ({ id: r.id, size: JSON.parse(r.options_json).chunkKb, status: r.status }));
  const done = rounds.filter((r) => r.status === 'done');
  const sizeOf = new Map(done.map((r) => [r.id, r.size]));
  const fs_ = done.length ? d.prepare(`SELECT * FROM cal_findings WHERE scan_id IN (${done.map(() => '?').join(',')})`).all(...done.map((r) => r.id)) : [];
  const parent = fs_.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const tk = fs_.map((f) => tokens(f.title));
  for (let i = 0; i < fs_.length; i++) for (let j = i + 1; j < fs_.length; j++) {
    const a = fs_[i], b = fs_[j];
    if (a.path !== b.path) continue;
    const sameLine = a.snippet && a.snippet === b.snippet;
    if (sameBug(a, b) || (sameLine && a.category === b.category)) parent[find(j)] = find(i);
  }
  const clusters = new Map();
  fs_.forEach((f, i) => {
    const c = find(i);
    if (!clusters.has(c)) clusters.set(c, { w: 0, sizes: new Set() });
    const e = clusters.get(c);
    e.w = Math.max(e.w, SEV_RANK[f.severity] || 1);
    e.sizes.add(sizeOf.get(f.scan_id));
  });
  const totalW = [...clusters.values()].reduce((s, c) => s + c.w, 0);
  const score = new Map();
  for (const r of done) {
    if (score.has(r.size)) continue;
    const got = [...clusters.values()].filter((c) => c.sizes.has(r.size)).reduce((s, c) => s + c.w, 0);
    score.set(r.size, totalW ? got / totalW : 1);
  }
  return { rounds, score, clusters: clusters.size, findings: fs_.length };
}

/** Next size to try, or {done: size}. Pure function of the scores so far. */
function calDecide(score, medium, maxKb) {
  const has = (s) => score.has(s);
  const sc = (s) => score.get(s);
  if (!has(medium)) return { next: medium };
  const half = Math.max(MIN_CHUNK_KB, Math.round(medium / 2));
  if (half < medium) {
    if (!has(half)) return { next: half };
    if (sc(half) > sc(medium) + CAL_DELTA) {
      let cur = half;
      for (;;) {
        const n = Math.round(cur / 2);
        if (n < MIN_CHUNK_KB) return { done: cur, why: `smaller chunks kept improving down to ${cur}KB` };
        if (!has(n)) return { next: n };
        if (sc(n) > sc(cur) + CAL_DELTA) cur = n; else return { done: cur, why: `${n}KB was no better than ${cur}KB` };
      }
    }
  }
  let cur = medium;
  let best = Math.max(...[...score.entries()].filter(([k]) => k <= medium).map(([, v]) => v));
  for (;;) {
    const n = Math.round(cur * 1.5);
    if (n > maxKb) return { done: cur, why: `no degradation up to ${cur}KB (sample size limits further growth)` };
    if (!has(n)) return { next: n };
    if (sc(n) < best - CAL_DELTA) return { done: cur, why: `quality dropped at ${n}KB (${sc(n).toFixed(2)} vs best ${best.toFixed(2)})` };
    best = Math.max(best, sc(n));
    cur = n;
  }
}

function calNext(cal) {
  const { score } = calScores(cal);
  return calDecide(score, cal.medium_kb, Math.floor(cal.sample_bytes / 1024));
}

function calLine(cal, round) {
  const o = { cli: CLI, root: repoRoot(), calId: cal.id, scanId: round.scanId, workers: Math.min(round.workers, MAX_WORKERS_PER_RUN) };
  if (process.env.CODESCAN_HOME) o.home = path.resolve(process.env.CODESCAN_HOME);
  return 'NEXT ' + JSON.stringify(o);
}

function cmdCalibrate(a) {
  const sub = a.pos[0] || 'status';
  const d = db();
  if (sub === 'start') {
    const model = a.f.model;
    if (!model) die('calibrate start needs --model <model id> (calibration is per model)');
    const prof = profileFromFlags(a.f);
    const commit = git(['rev-parse', 'HEAD']).trim();
    const sampleKb = Number(a.f['sample-kb'] || CAL_SAMPLE_KB);
    const medium = Number(a.f.medium || DEFAULT_CHUNK_KB);
    const { pick, total } = calSample(commit, { includeTests: false }, sampleKb);
    if (total < 2 * medium * 1024) {
      // fewer than two medium chunks of code: every size reviews it in one or two chunks, nothing to compare
      cfgSet(`chunk_kb:${model}`, medium);
      out(`DONE chunk_kb=${medium} for model ${model}: repo has only ${kb(total)} of code — too small to calibrate, using the default`);
      return;
    }
    d.prepare("UPDATE calibrations SET status='abandoned' WHERE model=? AND status='running'").run(model);
    const r = d.prepare(`INSERT INTO calibrations(model,profile_name,commit_sha,sample_json,sample_bytes,medium_kb,status,created,updated)
      VALUES(?,?,?,?,?,?,'running',?,?)`).run(model, prof.name, commit,
      JSON.stringify(pick.map((t) => ({ path: t.path, sha: t.sha, mode: t.mode, size: t.size }))), total, medium, now(), now());
    const cal = d.prepare('SELECT * FROM calibrations WHERE id=?').get(r.lastInsertRowid);
    const dirs = [...new Set(pick.map((t) => t.path.split('/').slice(0, -1).join('/') || '.'))];
    out(`calibration ${cal.id} for model ${model}: sample ${pick.length} files, ${kb(total)} from ${dirs.slice(0, 4).join(', ')}${dirs.length > 4 ? ' …' : ''}`);
    out(`round 1: ${medium}KB chunks`);
    out(calLine(cal, calRound(cal, medium)));
    return;
  }
  if (sub === 'set') {
    const [, model, val] = a.pos;
    if (!model || !(Number(val) >= MIN_CHUNK_KB)) die(`usage: calibrate set <model> <kb>  (kb >= ${MIN_CHUNK_KB})`);
    cfgSet(`chunk_kb:${model}`, Number(val));
    out(`chunk_kb for ${model} = ${val}KB`);
    return;
  }
  const cal = a.pos[1] ? d.prepare('SELECT * FROM calibrations WHERE id=?').get(Number(a.pos[1]))
    : d.prepare('SELECT * FROM calibrations ORDER BY id DESC LIMIT 1').get();
  if (sub === 'status' || sub === 'show') {
    const all = d.prepare('SELECT * FROM calibrations ORDER BY id DESC LIMIT 10').all();
    if (!all.length) { out('no calibrations; chunk size default ' + DEFAULT_CHUNK_KB + 'KB'); return; }
    for (const c of all) out(`#${c.id} ${c.model} [${c.status}] sample ${kb(c.sample_bytes)}${c.result_kb ? ` → ${c.result_kb}KB` : ''}${c.decision ? ` (${c.decision})` : ''}`);
    if (cal) {
      const { score, rounds, clusters, findings } = calScores(cal);
      out(`#${cal.id} rounds: ${rounds.map((r) => `${r.size}KB${r.status === 'done' ? `=${(score.get(r.size) ?? 0).toFixed(2)}` : `(${r.status})`}`).join(', ')}; ${findings} findings in ${clusters} distinct issues`);
    }
    return;
  }
  if (!cal) die('no calibration — run `calibrate start --model <id>`');
  if (sub === 'next') {
    if (cal.status !== 'running') { out(`DONE chunk_kb=${cal.result_kb} (${cal.status})`); return; }
    const last = d.prepare("SELECT * FROM scans WHERE kind='cal' AND cal_id=? ORDER BY id DESC LIMIT 1").get(cal.id);
    if (last && last.status !== 'done') {
      // round did not finish (agents failed): retry the rest of it once, then give up on it
      if (last.workflow_task !== 'retried') {
        d.prepare("UPDATE scans SET workflow_task='retried', status='active' WHERE id=?").run(last.id);
        const pk = tx(() => pack(getScan(last.id)));
        if (pk.chunks) { out(`round ${JSON.parse(last.options_json).chunkKb}KB incomplete; retrying ${pk.chunks} chunk(s)`); out(calLine(cal, { scanId: last.id, workers: pk.chunks })); return; }
      }
      setScanStatus(last.id, 'failed');
    }
    const dec = calNext(cal);
    if (dec.next) {
      const sc = calScores(cal).score;
      out(`scores so far: ${[...sc.entries()].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k}KB=${v.toFixed(2)}`).join(' ')}; next ${dec.next}KB`);
      out(calLine(cal, calRound(cal, dec.next)));
      return;
    }
    d.prepare("UPDATE calibrations SET status='done', result_kb=?, decision=?, updated=? WHERE id=?").run(dec.done, dec.why, now(), cal.id);
    cfgSet(`chunk_kb:${cal.model}`, dec.done);
    out(`DONE chunk_kb=${dec.done} for model ${cal.model}: ${dec.why}`);
    return;
  }
  die('usage: calibrate start --model m [--sample-kb 200] [--medium 40] [--profile p] | next [id] | status | set <model> <kb>');
}

// -------------------------------------------------------------------- limits
//
// A scan can carry a dollar cap and a cap on the 5-hour subscription window. Both are enforced at
// `claim`: once crossed, no new chunk is handed out (in-flight chunks still finish), the scan stops
// with the reason recorded, and the workflow's reviewer lanes wind down on the first NONE. Dollars
// are list-price estimates from the scan's own agent transcripts (calibration rounds are separate
// scans and are not counted); the 5-hour percentage comes from the status line (see `statusline`).

// USD per million tokens [input, output, cache-read multiplier]; cache writes are 1.25x (5m) / 2x (1h)
// of input. Keyed by model id prefix, most specific first. Unknown models are priced at the most
// expensive row so a cap can only trigger early, never late.
const PRICES = [
  ['claude-fable-5-2', [8, 40, 0.025]],
  ['claude-fable', [10, 50, 0.1]],
  ['claude-opus-5-5', [4, 20, 0.05]],
  ['claude-opus', [5, 25, 0.1]],
  ['claude-sonnet-5-5', [2, 10, 0.05]],
  ['claude-sonnet', [3, 15, 0.1]],
  ['claude-haiku-5-5', [0.10, 0.50, 0.1]],
  ['claude-haiku', [1, 5, 0.1]],
];
const PRICE_MAX = [10, 50, 0.1];
const HAIKU_55_LONG = [0.50, 2.50, 0.1]; // Haiku 5.5 with a prompt over 100k tokens

function messageUsd(model, u, entry) {
  const m = String(model || '');
  const row = PRICES.find(([k]) => m.startsWith(k));
  let [inp, outp, readMul] = row ? row[1] : PRICE_MAX;
  const cw = u.cache_creation || {};
  const w1 = cw.ephemeral_1h_input_tokens || 0;
  const w5 = cw.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1);
  const read = u.cache_read_input_tokens || 0;
  const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + read;
  if (m.startsWith('claude-haiku-5-5') && prompt > 100000) [inp, outp, readMul] = HAIKU_55_LONG;
  let usd = ((u.input_tokens || 0) * inp + w5 * inp * 1.25 + w1 * inp * 2 + read * inp * readMul + (u.output_tokens || 0) * outp) / 1e6;
  // the API reports these in usage; older transcripts may carry them on the entry
  const speed = u.speed ?? (entry && entry.speed);
  const geo = u.inference_geo ?? (entry && entry.inference_geo);
  if (speed === 'fast') usd *= 2;
  if (geo === 'us') usd *= 1.1;
  return usd;
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Workflow agent transcripts in workflow dirs touched since `sinceMs`. */
function recentAgentTranscripts(sinceMs) {
  const res = [];
  const root = path.join(claudeConfigDir(), 'projects');
  const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return []; } };
  const fresh = (p) => { try { return fs.statSync(p).mtimeMs >= sinceMs; } catch (e) { return false; } };
  for (const proj of ls(root)) {
    if (!proj.isDirectory()) continue;
    for (const sess of ls(path.join(root, proj.name))) {
      if (!sess.isDirectory()) continue;
      const wfRoot = path.join(root, proj.name, sess.name, 'subagents', 'workflows');
      if (!fresh(wfRoot)) continue; // a new run adds a dir here, which bumps its mtime
      for (const wf of ls(wfRoot)) {
        const wfDir = path.join(wfRoot, wf.name);
        if (!wf.isDirectory() || !fresh(wfDir)) continue;
        for (const f of ls(wfDir)) {
          if (!f.name.startsWith('agent-') || !f.name.endsWith('.jsonl')) continue;
          const p = path.join(wfDir, f.name);
          let st;
          try { st = fs.statSync(p); } catch (e) { continue; }
          if (st.mtimeMs >= sinceMs) res.push({ p, size: st.size });
        }
      }
    }
  }
  return res;
}

/** Dollars spent so far by the agents of one scan, read incrementally from their transcripts. */
function scanSpendUsd(scan) {
  const d = db();
  d.exec(`CREATE TABLE IF NOT EXISTS spend_files2 (path TEXT PRIMARY KEY, size INTEGER NOT NULL, scan_key TEXT,
    usd REAL NOT NULL, last_id TEXT)`);
  const home = process.env.CODESCAN_HOME ? path.resolve(process.env.CODESCAN_HOME) : null;
  const key = `${repoRoot()}|${home || ''}|${scan.id}`;
  // an agent belongs to this scan when its task command runs the CLI against this repo + state + scan;
  // the prefix is matched on the command itself (code under review may mention CODESCAN_HOME too)
  // The owner (repo, state dir, scan) is parsed from the task command itself — never judged against
  // the scan that happens to ask first, since other scans (calibration rounds) share the cache.
  const owner = /(?:CODESCAN_HOME=(\S+) )?node \S+ -C (\S+) (?:claim(?: --inline)?|plan-context|apply-plan) (\d+)\b/;
  const since = Date.parse(scan.created) - 60000;
  const get = d.prepare('SELECT size, scan_key, usd, last_id FROM spend_files2 WHERE path=?');
  const put = d.prepare(`INSERT INTO spend_files2(path,size,scan_key,usd,last_id) VALUES(?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET size=excluded.size, scan_key=excluded.scan_key, usd=excluded.usd, last_id=excluded.last_id`);
  let total = 0;
  for (const { p, size } of recentAgentTranscripts(since)) {
    const c = get.get(p);
    if (c && c.size === size) { if (c.scan_key === key) total += c.usd; continue; }
    // ownership is decided once, from the task at the top of the file
    if (c && c.scan_key !== key) continue; // not ours; its owner reads it when asked
    let belongs = c ? true : null;
    let from = c && belongs ? c.size : 0;
    let usd = c && belongs ? c.usd : 0;
    let lastId = c && belongs ? c.last_id : null;
    let fd;
    try { fd = fs.openSync(p, 'r'); } catch (e) { continue; }
    try {
      if (belongs === null) {
        const head = Buffer.alloc(Math.min(size, 20000));
        fs.readSync(fd, head, 0, head.length, 0);
        const m = head.toString('utf8').match(owner);
        const ownerKey = m ? `${m[2]}|${m[1] ? path.resolve(m[1]) : ''}|${m[3]}` : null;
        belongs = ownerKey === key;
        // another scan's agent: remember its owner (usage is counted when that scan asks)
        if (!belongs) { put.run(p, ownerKey ? 0 : size, ownerKey, 0, null); continue; }
      }
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      let text = buf.toString('utf8');
      const cut = text.lastIndexOf('\n'); // a line still being written is read next time
      text = cut >= 0 ? text.slice(0, cut + 1) : '';
      const consumed = Buffer.byteLength(text, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue;
        let e;
        try { e = JSON.parse(line); } catch (err) { continue; }
        if (e.type !== 'assistant' || !e.message || !e.message.usage) continue;
        // parallel tool calls repeat one message on consecutive lines
        if (e.message.id && e.message.id === lastId) continue;
        lastId = e.message.id || lastId;
        usd += messageUsd(e.message.model, e.message.usage, e);
      }
      put.run(p, from + consumed, key, usd, lastId);
      total += usd;
    } finally {
      fs.closeSync(fd);
    }
  }
  return total;
}

/** One snapshot per Claude config dir (≈ per account), so sessions on other accounts do not mix in. */
function rateLimitsPath() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'code-scan', `rate-limits-${sha1(path.resolve(claudeConfigDir()), 10)}.json`);
}
function readRateLimits() {
  try { return JSON.parse(fs.readFileSync(rateLimitsPath(), 'utf8')); } catch (e) { return null; }
}

/** Limit value from a flag: a number > 0, or 0 / "off" to clear; anything else is an error. */
function parseLimit(v, flag) {
  if (v === undefined) return undefined;
  if (v === 'off' || v === '0' || v === 0) return null;
  const n = Number(String(v).replace(/^\$/, ''));
  if (!Number.isFinite(n) || n <= 0 || String(v).trim() === '') die(`--${flag} needs a number > 0 (or 0/off to clear), got '${v}'`);
  return n;
}
function applyLimitFlags(o, f) {
  const usd = parseLimit(f['max-usd'], 'max-usd');
  const pct = parseLimit(f['max-5h-pct'], 'max-5h-pct');
  if (pct !== undefined && pct !== null && pct > 100) die('--max-5h-pct is a percentage (0-100)');
  if (usd !== undefined) o.maxUsd = usd;
  if (pct !== undefined) o.max5hPct = pct;
  return o;
}

/** Why work must not be scheduled now, or null. */
function limitReason(scan) {
  const o = JSON.parse(scan.options_json);
  if (o.maxUsd) {
    const usd = scanSpendUsd(scan);
    if (usd >= o.maxUsd) return `spend $${usd.toFixed(2)} reached the $${o.maxUsd} limit`;
  }
  if (o.max5hPct) {
    const rl = readRateLimits();
    const fh = rl && rl.rate_limits && rl.rate_limits.five_hour;
    const ageMin = rl && Number.isFinite(rl.ts) ? (Date.now() - rl.ts) / 60000 : Infinity;
    if (!fh || typeof fh.used_percentage !== 'number' || ageMin > RATE_LIMIT_MAX_AGE_MIN) {
      return `5-hour usage is unknown (no status-line snapshot in the last ${RATE_LIMIT_MAX_AGE_MIN} min; see \`statusline\`)`;
    }
    const resetsMs = typeof fh.resets_at === 'number' ? fh.resets_at * 1000 : null;
    const resetPassed = resetsMs !== null && resetsMs <= Date.now();
    if (!resetPassed && fh.used_percentage >= o.max5hPct) {
      const when = resetsMs !== null ? ` (resets ${new Date(resetsMs).toISOString().slice(11, 16)} UTC)` : '';
      return `5-hour subscription usage ${fh.used_percentage}% reached the ${o.max5hPct}% limit${when}`;
    }
  }
  return null;
}

/**
 * Status line command. Saves the rate limits Claude Code passes to the status line (the only place
 * they are exposed) and prints a status line — or the output of the command given after `--`.
 */
function cmdStatusline(a) {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin */ }
  let j = {};
  try { j = JSON.parse(raw) || {}; } catch (e) { /* keep going: still print something */ }
  try {
    if (j.rate_limits && typeof j.rate_limits === 'object') {
      const p = rateLimitsPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      const cost = j.cost && typeof j.cost.total_cost_usd === 'number' ? j.cost.total_cost_usd : null;
      fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), rate_limits: j.rate_limits, session_cost_usd: cost }));
      fs.renameSync(tmp, p);
    }
  } catch (e) { /* never break the status line over a cache write */ }
  if (a.pos.length) {
    const r = spawnSync(a.pos[0], a.pos.slice(1), { input: raw, encoding: 'utf8', shell: a.pos.length === 1 });
    process.stdout.write(r.stdout || '');
    return;
  }
  const rl = j.rate_limits || {};
  const pct = (x) => (x && typeof x.used_percentage === 'number' ? `${Math.round(x.used_percentage)}%` : '–');
  const model = (j.model && (j.model.display_name || j.model.id)) || '';
  const cost = j.cost && typeof j.cost.total_cost_usd === 'number' ? ` · $${j.cost.total_cost_usd.toFixed(2)}` : '';
  out(`${model} · 5h ${pct(rl.five_hour)} · 7d ${pct(rl.seven_day)}${cost}`);
}

function cmdLimits(a) {
  const scan = scanArg(a.f);
  if (a.f['max-usd'] !== undefined || a.f['max-5h-pct'] !== undefined) {
    const o = applyLimitFlags(JSON.parse(scan.options_json), a.f);
    db().prepare('UPDATE scans SET options_json=? WHERE id=?').run(JSON.stringify(o), scan.id);
  }
  limitLines(getScan(scan.id)).forEach((l) => out(l));
}

function limitLines(scan) {
  const o = JSON.parse(scan.options_json);
  const lines = [];
  if (o.maxUsd) lines.push(`spend: $${scanSpendUsd(scan).toFixed(2)} of $${o.maxUsd} limit`);
  if (o.max5hPct) {
    const rl = readRateLimits();
    const fh = rl && rl.rate_limits && rl.rate_limits.five_hour;
    lines.push(fh && typeof fh.used_percentage === 'number'
      ? `5-hour window: ${fh.used_percentage}% used (limit ${o.max5hPct}%, snapshot ${Math.round((Date.now() - rl.ts) / 60000)} min old)`
      : `5-hour window: unknown — no status-line snapshot (limit ${o.max5hPct}%)`);
  }
  const why = cfgGet(`stop_reason:${scan.id}`);
  if (why) lines.push(`stopped by limit: ${why}`);
  return lines;
}

// -------------------------------------------------------------------- status

function scanSummary(s) {
  const d = db();
  const fc = Object.fromEntries(d.prepare('SELECT state, COUNT(*) n, SUM(bytes) b FROM files WHERE scan_id=? GROUP BY state')
    .all(s.id).map((r) => [r.state, r]));
  const n = (k) => (fc[k] ? fc[k].n : 0);
  const b = (k) => (fc[k] ? fc[k].b || 0 : 0);
  const total = n('pending') + n('in_progress') + n('partial') + n('reviewed');
  const cc = Object.fromEntries(d.prepare('SELECT state, COUNT(*) n FROM chunks WHERE scan_id=? GROUP BY state').all(s.id).map((r) => [r.state, r.n]));
  const sev = d.prepare(`SELECT f.severity, COUNT(*) n FROM findings f JOIN seen x ON x.finding_id=f.id WHERE x.scan_id=? GROUP BY f.severity`).all(s.id);
  const sevStr = SEVERITIES.map((k) => { const r = sev.find((x) => x.severity === k); return r ? `${k} ${r.n}` : null; }).filter(Boolean).join(', ') || 'none';
  const lines = [
    `scan ${s.id} @ ${s.commit_sha.slice(0, 12)} [${s.status}] profile=${s.profile_name} started ${s.created.slice(0, 16).replace('T', ' ')}`,
    `files: ${n('reviewed')}/${total} reviewed (${kb(b('reviewed'))}/${kb(b('reviewed') + b('pending') + b('in_progress') + b('partial'))}), ` +
      `${n('in_progress')} in progress, ${n('partial')} partial, ${n('pending')} pending; ${n('unchanged')} unchanged skipped, ${n('excluded')} non-code`,
    `chunks: ${cc.done || 0} done, ${cc.claimed || 0} claimed, ${cc.pending || 0} pending; planned: ${s.plan_json ? 'yes' : 'no'}`,
    `findings this scan: ${sevStr}`,
  ];
  return lines;
}

function cmdStatus(a) {
  const d = db();
  if (a.f.all) {
    for (const s of d.prepare("SELECT * FROM scans WHERE kind='scan' ORDER BY id DESC LIMIT 30").all()) {
      const r = d.prepare("SELECT SUM(state='reviewed') rv, SUM(state IN ('pending','in_progress','partial','reviewed')) t FROM files WHERE scan_id=?").get(s.id);
      out(`${s.id}\t${s.status}\t${s.commit_sha.slice(0, 12)}\t${s.profile_name}\t${r.rv || 0}/${r.t || 0} files\t${s.created.slice(0, 16)}`);
    }
    return;
  }
  const s = scanArg(a.f);
  scanSummary(s).forEach((l) => out(l));
  limitLines(s).forEach((l) => out(l));
  const g = d.prepare(`SELECT COUNT(*) n, SUM(NOT EXISTS (SELECT 1 FROM filings x WHERE x.finding_id=f.id AND x.kind!='skipped')) un
    FROM findings f WHERE triage IN ('open','confirmed') AND gone_scan IS NULL`).get();
  out(`all findings (open+confirmed): ${g.n}, unreported: ${g.un || 0}`);
}

function cmdFiles(a) {
  const s = scanArg(a.f);
  const states = listFlag(a.f.state);
  const pm = pathMatcher(a.f.path);
  let rows = db().prepare('SELECT path,state,reason,bytes,unit,findings_n,slices_json,slices_done FROM files WHERE scan_id=? ORDER BY path').all(s.id);
  if (states) rows = rows.filter((r) => states.includes(r.state));
  if (pm) rows = rows.filter((r) => pm(r.path));
  const counts = {};
  rows.forEach((r) => { counts[r.state] = (counts[r.state] || 0) + 1; });
  out(`scan ${s.id}: ${rows.length} files — ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const lines = rows.map((r) => {
    const sl = r.slices_json ? ` slices ${JSON.parse(r.slices_done).length}/${JSON.parse(r.slices_json).length}` : '';
    return `${r.state}\t${r.path}\t${kb(r.bytes)}\t${r.reason || r.unit || ''}${sl}${r.findings_n ? `\tfindings ${r.findings_n}` : ''}`;
  });
  emit(lines.join('\n'), a.f, lines.length);
}

/** Large output goes to a file; the terminal gets the path and a head. */
function emit(text, f, nrows, limitDefault = STDOUT_ROWS) {
  if (f.out) {
    fs.mkdirSync(path.dirname(path.resolve(f.out)), { recursive: true });
    fs.writeFileSync(f.out, text.endsWith('\n') ? text : text + '\n');
    out(`wrote ${nrows} rows to ${path.resolve(f.out)}`);
    return;
  }
  const lines = text.split('\n');
  const lim = f.limit ? Number(f.limit) : limitDefault;
  if (lines.length > lim && !f.limit) {
    const p = path.join(stateDir(), 'exports', `out-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text + '\n');
    out(lines.slice(0, lim).join('\n'));
    out(`... ${lines.length - lim} more lines; full output: ${p}`);
  } else out(text);
}

// --------------------------------------------------------------------- query

function headBlobs() {
  const m = new Map();
  for (const t of lsTree('HEAD')) m.set(t.path, t.sha);
  return m;
}

function loadFindings(f, { defaultTriage = ['open', 'confirmed'] } = {}) {
  const d = db();
  const where = [];
  const params = [];
  const sev = listFlag(f.severity);
  if (sev) {
    const expanded = sev.flatMap((s) => (s.endsWith('+') ? SEVERITIES.filter((x) => SEV_RANK[x] >= SEV_RANK[s.slice(0, -1)]) : [s]));
    where.push(`severity IN (${expanded.map(() => '?').join(',')})`); params.push(...expanded);
  }
  const cat = listFlag(f.category);
  if (cat) { where.push(`(${cat.map(() => 'category LIKE ?').join(' OR ')})`); params.push(...cat.map((c) => `%${c}%`)); }
  let tri = listFlag(f.triage);
  if (tri && tri.includes('all')) tri = null;
  else if (!tri && !f.ids) tri = defaultTriage;
  if (tri) { where.push(`triage IN (${tri.map(() => '?').join(',')})`); params.push(...tri); }
  if (f.ids) {
    const ids = listFlag(f.ids).map(Number);
    where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
  }
  if (f.scan) { where.push('id IN (SELECT finding_id FROM seen WHERE scan_id=?)'); params.push(Number(f.scan)); }
  else if (f.latest) { where.push('id IN (SELECT finding_id FROM seen WHERE scan_id=(SELECT MAX(id) FROM scans WHERE kind=\'scan\'))'); }
  if (f.gone) where.push('gone_scan IS NOT NULL');
  else if (!f['include-gone'] && !f.ids) where.push('gone_scan IS NULL');
  if (f['min-confidence']) { where.push('COALESCE(confidence,1) >= ?'); params.push(Number(f['min-confidence'])); }
  if (f.unit) { where.push('unit = ?'); params.push(f.unit); }
  if (f.text) {
    where.push('(title LIKE ? OR detail LIKE ? OR evidence LIKE ?)');
    params.push(`%${f.text}%`, `%${f.text}%`, `%${f.text}%`);
  }
  const rep = "EXISTS (SELECT 1 FROM filings x WHERE x.finding_id=findings.id AND x.kind!='skipped'";
  if (f.reported) where.push(rep + (f.tracker ? ' AND x.tracker LIKE ?)' : ')'));
  if (f.reported && f.tracker) params.push(`${f.tracker}%`);
  if (f.unreported) where.push('NOT ' + rep + ')');
  if (f['dupe-of']) {
    where.push('id IN (SELECT finding_id FROM dupe_groups WHERE group_id=(SELECT group_id FROM dupe_groups WHERE finding_id=?))');
    params.push(Number(f['dupe-of']));
  }
  if (f.group) { where.push('id IN (SELECT finding_id FROM dupe_groups WHERE group_id=?)'); params.push(Number(f.group)); }
  if (f['primary-only']) where.push('id NOT IN (SELECT finding_id FROM dupe_groups WHERE is_primary=0)');
  const sql = `SELECT findings.*,
    (SELECT group_concat(x.tracker || ':' || x.key, ' ') FROM filings x WHERE x.finding_id=findings.id AND x.kind!='skipped') AS reported_as,
    (SELECT group_id FROM dupe_groups g WHERE g.finding_id=findings.id) AS dupe_group
    FROM findings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  let rows = d.prepare(sql).all(...params);
  const pm = pathMatcher(f.path);
  if (pm) rows = rows.filter((r) => pm(r.path));
  if (f.stale || f['no-stale'] || f.format === 'json' || f.format === 'csv' || f.format === 'md') {
    let hb = null;
    try { hb = headBlobs(); } catch (e) { hb = null; }
    if (hb) rows.forEach((r) => { r.stale = hb.get(r.path) !== r.blob_sha ? 1 : 0; });
    if (f.stale) rows = rows.filter((r) => r.stale);
    if (f['no-stale']) rows = rows.filter((r) => !r.stale);
  }
  return sortRows(rows, f.sort);
}

const SORT_FIELDS = ['severity', 'path', 'line', 'confidence', 'created', 'updated', 'category', 'triage', 'id', 'title', 'unit'];
function sortRows(rows, sortSpec) {
  const specs = listFlag(sortSpec) || ['severity:desc', 'path', 'line'];
  const keys = specs.map((s) => {
    let [field, dir] = s.split(':');
    if (field.startsWith('-')) { field = field.slice(1); dir = 'desc'; }
    if (!SORT_FIELDS.includes(field)) die(`cannot sort by '${field}'; fields: ${SORT_FIELDS.join(', ')}`);
    return { field, mul: dir === 'desc' ? -1 : 1 };
  });
  const val = (r, k) => (k === 'severity' ? SEV_RANK[r.severity] : r[k]);
  return rows.sort((a, b) => {
    for (const k of keys) {
      const x = val(a, k.field), y = val(b, k.field);
      if (x === y) continue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * k.mul;
    }
    return a.id - b.id;
  });
}

function loc(r) { return `${r.path}${r.line ? ':' + r.line + (r.end_line && r.end_line !== r.line ? '-' + r.end_line : '') : ''}`; }

function formatRows(rows, fmt) {
  if (fmt === 'json') return JSON.stringify(rows.map(publicRow), null, 1);
  if (fmt === 'csv') {
    const cols = ['id', 'severity', 'category', 'path', 'line', 'end_line', 'title', 'triage', 'confidence', 'reported_as', 'dupe_group', 'stale', 'unit', 'first_scan', 'last_scan', 'detail', 'evidence'];
    const q = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
  }
  if (fmt === 'md') {
    return rows.map((r) => [
      `### #${r.id} [${r.severity}] ${r.title}`,
      `\`${loc(r)}\` — ${r.category}; triage: ${r.triage}${r.reported_as ? '; reported: ' + r.reported_as : ''}${r.stale ? '; STALE (file changed since)' : ''}${r.confidence !== null ? `; confidence ${r.confidence}` : ''}`,
      '', r.detail || '', r.evidence ? `\nEvidence: ${r.evidence}` : '', '',
    ].join('\n')).join('\n');
  }
  return rows.map((r) => `#${r.id}\t${r.severity}\t${loc(r)}\t${r.triage}${r.gone_scan ? ' gone' : ''}${r.reported_as ? ' R' : ''}${r.dupe_group ? ' g' + r.dupe_group : ''}\t${r.title}`).join('\n');
}
function publicRow(r) {
  const o = { ...r };
  delete o.dupe_lock;
  return o;
}

function cmdQuery(a) {
  const rows = loadFindings(a.f);
  const fmt = a.f.format || 'table';
  let shown = rows;
  if (a.f.limit) shown = rows.slice(0, Number(a.f.limit));
  if (!shown.length) { out('no findings match'); return; }
  const text = formatRows(shown, fmt);
  if (fmt === 'table' && !a.f.out) out(`${rows.length} finding(s)`);
  emit(text, a.f, shown.length, fmt === 'table' ? STDOUT_ROWS : 1e9);
}

function cmdShow(a) {
  const id = Number(a.pos[0]);
  const r = db().prepare('SELECT * FROM findings WHERE id=?').get(id);
  if (!r) die(`no finding ${id}`);
  out(`#${r.id} [${r.severity}] ${r.title}`);
  out(`${loc(r)}  category=${r.category} triage=${r.triage} confidence=${r.confidence ?? '-'} unit=${r.unit || '-'}` +
    (r.gone_scan ? `  GONE (not reported when the changed file was re-reviewed in scan ${r.gone_scan})` : ''));
  out(`commit ${r.commit_sha} (first scan ${r.first_scan}, last scan ${r.last_scan}) profile=${r.profile_name}`);
  if (r.snippet) out(`line: ${r.snippet}`);
  if (r.detail) out(`\n${r.detail}`);
  if (r.evidence) out(`\nEvidence: ${r.evidence}`);
  if (r.note) out(`\nNote: ${r.note}`);
  const fl = db().prepare('SELECT * FROM filings WHERE finding_id=?').all(id);
  for (const x of fl) out(`${x.kind}: ${x.tracker} ${x.key} ${x.url || ''} (${x.filed_at.slice(0, 10)})`);
  const g = db().prepare('SELECT group_id FROM dupe_groups WHERE finding_id=?').get(id);
  if (g) {
    const mem = db().prepare('SELECT f.id, f.path, f.line, g.is_primary FROM dupe_groups g JOIN findings f ON f.id=g.finding_id WHERE g.group_id=? AND f.id!=?').all(g.group_id, id);
    out(`dupe group ${g.group_id}: ${mem.map((m) => `#${m.id}${m.is_primary ? '*' : ''} ${m.path}:${m.line}`).join(', ')}`);
  }
  const mc = db().prepare('SELECT * FROM match_candidates m JOIN tracker_issues t USING(tracker,key) WHERE m.finding_id=? ORDER BY score DESC LIMIT 5').all(id);
  for (const m of mc) out(`possible tracker match (${m.score.toFixed(1)}): ${m.tracker} ${m.key} [${m.state}] ${m.title} — ${m.why}`);
}

function cmdSql(a) {
  const q = a.pos.join(' ').trim();
  if (!/^(select|with|pragma\s+table_info)\b/i.test(q)) die('only SELECT/WITH queries are allowed');
  db();
  const ro = new DatabaseSync(path.join(stateDir(), 'codescan.db'), { readOnly: true });
  const rows = ro.prepare(q).all();
  if (!rows.length) { out('(no rows)'); return; }
  const cols = Object.keys(rows[0]);
  const text = [cols.join('\t'), ...rows.map((r) => cols.map((c) => (r[c] === null ? '' : String(r[c]).replace(/\s+/g, ' '))).join('\t'))].join('\n');
  emit(a.f.format === 'json' ? JSON.stringify(rows, null, 1) : text, a.f, rows.length, a.f.format === 'json' ? 1e9 : STDOUT_ROWS + 1);
}

function selectIds(a) {
  const ids = a.pos.filter((x) => /^\d+(,\d+)*$/.test(x)).flatMap((x) => x.split(',').map(Number));
  if (ids.length) return ids;
  const hasFilter = ['severity', 'category', 'path', 'triage', 'scan', 'latest', 'text', 'unit', 'group', 'dupe-of', 'ids', 'reported', 'unreported']
    .some((k) => a.f[k] !== undefined);
  if (!hasFilter) die('give finding ids or filter flags');
  return loadFindings(a.f).map((r) => r.id);
}

function cmdTriage(a) {
  const state = a.f.set;
  if (!TRIAGE.includes(state)) die(`--set must be one of ${TRIAGE.join('|')}`);
  const ids = selectIds(a);
  if (!ids.length) die('no findings selected');
  const note = a.f.note;
  tx((d) => {
    const st = d.prepare(`UPDATE findings SET triage=?, note=CASE WHEN ? IS NULL THEN note ELSE
      COALESCE(note || char(10), '') || ? END, updated=? WHERE id=?`);
    for (const id of ids) st.run(state, note || null, note || null, now(), id);
  });
  out(`${ids.length} finding(s) → ${state}: ${ids.slice(0, 30).map((i) => '#' + i).join(' ')}${ids.length > 30 ? ' …' : ''}`);
}

function cmdProfile(a) {
  const [sub, name] = a.pos;
  const d = db();
  if (!sub || sub === 'list') {
    const rows = d.prepare('SELECT name, hash, created, length(text) len FROM profiles ORDER BY name').all();
    const names = new Set(rows.map((r) => r.name));
    rows.forEach((r) => out(`${r.name}\t${r.hash}\t${r.len} chars`));
    builtinProfileNames().filter((n) => !names.has(n)).forEach((n) => out(`${n}\t(builtin)`));
    return;
  }
  if (sub === 'show') { out(resolveProfile(name || 'default').text); return; }
  if (sub === 'add') {
    if (!name) die('usage: profile add <name> --file f');
    const text = a.f.file ? fs.readFileSync(a.f.file, 'utf8') : fs.readFileSync(0, 'utf8');
    if (!text.trim()) die('empty profile');
    const p = upsertProfile(name, text);
    out(`profile ${p.name} saved (${p.hash})`);
    return;
  }
  if (sub === 'rm') {
    d.prepare('DELETE FROM profiles WHERE name=?').run(name);
    out(`removed ${name}`);
    return;
  }
  die('usage: profile list|show <name>|add <name> --file f|rm <name>');
}

// -------------------------------------------------------------------- dupes

function tokens(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2 && !STOP.has(t)));
}
const STOP = new Set(['the', 'and', 'for', 'with', 'when', 'not', 'can', 'may', 'from', 'into', 'without', 'missing',
  'possible', 'potential', 'could', 'this', 'that', 'are', 'was', 'has', 'have', 'use', 'via', 'after', 'before']);
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}
function shape(s) { return String(s || '').replace(/"[^"]*"|'[^']*'/g, 's').replace(/[A-Za-z_]\w*/g, 'x').replace(/\d+/g, '0').replace(/\s+/g, ''); }

function cmdDupes(a) {
  const sub = a.pos[0];
  const d = db();
  if (sub === 'show') {
    const g = Number(a.pos[1]);
    const rows = d.prepare('SELECT f.*, g.is_primary, g.reason FROM dupe_groups g JOIN findings f ON f.id=g.finding_id WHERE g.group_id=? ORDER BY g.is_primary DESC, f.id').all(g);
    if (!rows.length) die(`no group ${g}`);
    rows.forEach((r) => out(`${r.is_primary ? '*' : ' '}#${r.id}\t${r.severity}\t${loc(r)}\t${r.title}\t(${r.reason || ''})`));
    return;
  }
  if (sub === 'list') {
    const rows = d.prepare(`SELECT g.group_id, COUNT(*) n, MAX(g.manual) manual,
      (SELECT f.title FROM dupe_groups p JOIN findings f ON f.id=p.finding_id WHERE p.group_id=g.group_id AND p.is_primary=1) title
      FROM dupe_groups g GROUP BY g.group_id HAVING n>1 ORDER BY n DESC`).all();
    emit(rows.map((r) => `g${r.group_id}\t${r.n} findings${r.manual ? ' (manual)' : ''}\t${r.title}`).join('\n') || 'no groups', a.f, rows.length);
    return;
  }
  if (sub === 'merge') {
    const ids = selectIds({ pos: a.pos.slice(1), f: a.f });
    if (ids.length < 2) die('merge needs at least two finding ids');
    tx(() => {
      const gid = (d.prepare('SELECT MAX(group_id) m FROM dupe_groups').get().m || 0) + 1;
      d.prepare(`DELETE FROM dupe_groups WHERE finding_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      ids.forEach((id) => d.prepare('INSERT INTO dupe_groups(group_id,finding_id,is_primary,reason,manual) VALUES(?,?,0,?,1)').run(gid, id, 'manual'));
      d.prepare(`UPDATE findings SET dupe_lock=1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      setPrimary(gid);
      out(`group ${gid}: ${ids.map((i) => '#' + i).join(' ')}`);
    });
    return;
  }
  if (sub === 'split') {
    const ids = selectIds({ pos: a.pos.slice(1), f: a.f });
    tx(() => {
      for (const id of ids) {
        const g = d.prepare('SELECT group_id FROM dupe_groups WHERE finding_id=?').get(id);
        d.prepare('DELETE FROM dupe_groups WHERE finding_id=?').run(id);
        d.prepare('UPDATE findings SET dupe_lock=1 WHERE id=?').run(id);
        if (g) { cleanupGroup(g.group_id); }
      }
    });
    out(`split ${ids.length} finding(s) out; they will not be auto-grouped again`);
    return;
  }
  // cluster
  const win = Number(a.f['line-window'] || 10);
  const sim = Number(a.f['title-sim'] || 0.6);
  const rows = loadFindings(a.f, { defaultTriage: ['open', 'confirmed'] }).filter((r) => !r.dupe_lock);
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const reason = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const unite = (x, y, why) => { const a1 = find(x), b1 = find(y); if (a1 !== b1) { parent.set(b1, a1); reason.set(y, why); reason.set(x, reason.get(x) || why); } };
  const tk = new Map(rows.map((r) => [r.id, tokens(r.title)]));
  // titles of one repeated pattern differ mainly in symbol names; compare them without those
  const gtk = new Map(rows.map((r) => [r.id, new Set([...tk.get(r.id)].filter((t) => !/[\d_]/.test(t)))]));
  const sh = new Map(rows.map((r) => [r.id, shape(r.snippet)]));
  const byPath = new Map();
  rows.forEach((r) => { if (!byPath.has(r.path)) byPath.set(r.path, []); byPath.get(r.path).push(r); });
  for (const list of byPath.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      if (sameBug(x, y, win)) unite(x.id, y.id, 'same file, same bug');
    }
  }
  const byCat = new Map();
  rows.forEach((r) => { if (!byCat.has(r.category)) byCat.set(r.category, []); byCat.get(r.category).push(r); });
  for (const list of byCat.values()) {
    if (list.length > 3000) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      const jt = jaccard(tk.get(x.id), tk.get(y.id));
      const jg = jaccard(gtk.get(x.id), gtk.get(y.id));
      const sameShape = sh.get(x.id) && sh.get(x.id).length >= 15 && sh.get(x.id) === sh.get(y.id);
      if (jt >= 0.85 || (sameShape && Math.max(jt, jg) >= Math.min(sim, 0.5))) unite(x.id, y.id, 'same pattern');
    }
  }
  const clusters = new Map();
  rows.forEach((r) => { const root = find(r.id); if (!clusters.has(root)) clusters.set(root, []); clusters.get(root).push(r.id); });
  let groups = 0, members = 0;
  tx(() => {
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      d.prepare(`DELETE FROM dupe_groups WHERE manual=0 AND finding_id IN (${part.map(() => '?').join(',')})`).run(...part);
    }
    let gid = d.prepare('SELECT MAX(group_id) m FROM dupe_groups').get().m || 0;
    for (const list of clusters.values()) {
      if (list.length < 2) continue;
      gid++; groups++; members += list.length;
      for (const id of list) d.prepare('INSERT INTO dupe_groups(group_id,finding_id,is_primary,reason) VALUES(?,?,0,?)').run(gid, id, reason.get(id) || '');
      setPrimary(gid);
    }
  });
  // new findings may join a manual group (its members are locked against re-clustering, not against company)
  let attached = 0;
  tx(() => {
    const locked = d.prepare(`SELECT f.*, g.group_id FROM findings f JOIN dupe_groups g ON g.finding_id=f.id WHERE g.manual=1`).all();
    const grouped = new Set(d.prepare('SELECT finding_id FROM dupe_groups').all().map((r) => r.finding_id));
    for (const r of rows) {
      if (grouped.has(r.id)) continue;
      const m = locked.find((l) => sameBug(l, r, win));
      if (!m) continue;
      d.prepare('INSERT INTO dupe_groups(group_id,finding_id,is_primary,reason,manual) VALUES(?,?,0,?,0)').run(m.group_id, r.id, 'joined manual group');
      setPrimary(m.group_id);
      attached++;
    }
  });
  out(`${groups} duplicate group(s) covering ${members} of ${rows.length} findings (manual groups kept${attached ? `, ${attached} finding(s) joined them` : ''}). \`dupes list\` / \`dupes show <g>\``);
}

function setPrimary(gid) {
  const d = db();
  const rows = d.prepare('SELECT f.id, f.severity, f.confidence FROM dupe_groups g JOIN findings f ON f.id=g.finding_id WHERE g.group_id=?').all(gid);
  rows.sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity] || (y.confidence || 0) - (x.confidence || 0) || x.id - y.id);
  d.prepare('UPDATE dupe_groups SET is_primary=0 WHERE group_id=?').run(gid);
  if (rows.length) d.prepare('UPDATE dupe_groups SET is_primary=1 WHERE finding_id=?').run(rows[0].id);
}
function cleanupGroup(gid) {
  const d = db();
  const n = d.prepare('SELECT COUNT(*) n FROM dupe_groups WHERE group_id=?').get(gid).n;
  if (n < 2) d.prepare('DELETE FROM dupe_groups WHERE group_id=?').run(gid);
  else setPrimary(gid);
}

// ------------------------------------------------------------------ trackers

const MARKER_RE = /(?:code-scan|bug-scan):fp=([0-9a-f]{20})/g;
function extractPaths(text) {
  const s = new Set();
  const re = /(?:blob\/[0-9a-f]{7,40}\/)?((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,5})(?:#L\d+|:\d+)?/g;
  let m;
  while ((m = re.exec(text || '')) && s.size < 50) {
    if (/^(https?|www)\b/.test(m[1]) || /\.(com|org|io|net|html?)$/.test(m[1])) continue;
    s.add(m[1]);
  }
  return [...s];
}

function storeIssues(tracker, issues) {
  const d = db();
  let n = 0;
  tx(() => {
    const st = d.prepare(`INSERT INTO tracker_issues(tracker,key,url,title,state,body_excerpt,paths_json,markers_json,fetched_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tracker,key) DO UPDATE SET url=excluded.url, title=excluded.title, state=excluded.state,
      body_excerpt=excluded.body_excerpt, paths_json=excluded.paths_json, markers_json=excluded.markers_json, fetched_at=excluded.fetched_at`);
    for (const i of issues) {
      const body = String(i.body || '');
      const markers = [...body.matchAll(MARKER_RE)].map((m) => m[1]);
      st.run(tracker, String(i.key), i.url || null, i.title || '', String(i.state || '').toLowerCase(), body.slice(0, 4000),
        JSON.stringify(extractPaths(`${i.title}\n${body}`)), JSON.stringify(markers), now());
      n++;
    }
  });
  // issues that carry our fingerprint marker are filings of those findings, even if made elsewhere
  const linked = autoLinkMarkers(tracker);
  return { n, linked };
}

function autoLinkMarkers(tracker) {
  const d = db();
  let linked = 0;
  tx(() => {
    for (const t of d.prepare('SELECT key,url,markers_json FROM tracker_issues WHERE tracker=?').all(tracker)) {
      for (const fp of JSON.parse(t.markers_json || '[]')) {
        const f = d.prepare('SELECT id FROM findings WHERE fingerprint=?').get(fp);
        if (!f) continue;
        const r = d.prepare(`INSERT OR IGNORE INTO filings(finding_id,tracker,key,url,kind,filed_at) VALUES(?,?,?,?,'filed',?)`)
          .run(f.id, tracker, t.key, t.url, now());
        linked += Number(r.changes);
      }
    }
  });
  return linked;
}

function defaultGhRepo() {
  const t = cfgGet('target');
  if (t && t.startsWith('gh:')) return t.slice(3);
  const r = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: repoRoot(), encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  die('cannot determine GitHub repo; pass --repo owner/name or set report-config target gh:owner/name');
}

function cmdTrackerSync(a) {
  const kind = a.pos[0];
  if (kind !== 'gh') die('usage: tracker-sync gh [--repo owner/name] [--state all|open|closed] [--search q] [--max 2000]');
  const repo = a.f.repo || defaultGhRepo();
  const args = ['issue', 'list', '--repo', repo, '--state', a.f.state || 'all', '--limit', String(a.f.max || 2000),
    '--json', 'number,title,state,body,url'];
  if (a.f.search) args.push('--search', a.f.search);
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) die(`gh issue list failed: ${r.stderr.trim()}`);
  const issues = JSON.parse(r.stdout).map((i) => ({ key: i.number, title: i.title, state: i.state, body: i.body, url: i.url }));
  const res = storeIssues(`gh:${repo}`, issues);
  out(`synced ${res.n} issues from gh:${repo}; ${res.linked} finding(s) linked via code-scan markers`);
}

function cmdTrackerImport(a) {
  const kind = a.pos[0];
  if (kind !== 'jira') die('usage: tracker-import jira [--project KEY] < issues.json');
  const raw = a.f.file ? fs.readFileSync(a.f.file, 'utf8') : fs.readFileSync(0, 'utf8');
  let arr = JSON.parse(raw);
  if (!Array.isArray(arr)) arr = arr.issues || arr.values || [];
  const byProj = new Map();
  for (const x of arr) {
    const key = x.key;
    if (!key) continue;
    const fields = x.fields || {};
    const desc = x.description ?? fields.description ?? '';
    const it = {
      key, title: x.summary || fields.summary || x.title || '',
      state: x.status?.name || x.status || fields.status?.name || '',
      body: typeof desc === 'string' ? desc : JSON.stringify(desc),
      url: x.url || x.self || null,
    };
    const proj = a.f.project || String(key).split('-')[0];
    if (!byProj.has(proj)) byProj.set(proj, []);
    byProj.get(proj).push(it);
  }
  let total = 0, linked = 0;
  for (const [proj, list] of byProj) { const r = storeIssues(`jira:${proj}`, list); total += r.n; linked += r.linked; }
  out(`imported ${total} Jira issue(s) (${[...byProj.keys()].join(', ') || 'none'}); ${linked} finding(s) linked via markers`);
}

function cmdMatch(a) {
  const d = db();
  const sub = a.pos[0];
  if (sub === 'show') {
    const id = Number(a.pos[1]);
    const rows = d.prepare('SELECT * FROM match_candidates m JOIN tracker_issues t USING(tracker,key) WHERE m.finding_id=? ORDER BY score DESC').all(id);
    if (!rows.length) out('no candidates');
    rows.forEach((r) => out(`${r.score.toFixed(1)}\t${r.tracker} ${r.key} [${r.state}]\t${r.title}\t(${r.why})\t${r.url || ''}`));
    return;
  }
  if (sub === 'export') {
    // compact JSON for LLM adjudication: only what is needed to judge sameness
    const min = Number(a.f['min-score'] || 3);
    const rows = loadFindings({ ...a.f, unreported: true });
    const res = [];
    for (const r of rows) {
      const cands = d.prepare('SELECT m.*, t.title, t.state, t.body_excerpt, t.url FROM match_candidates m JOIN tracker_issues t USING(tracker,key) WHERE m.finding_id=? AND m.score>=? ORDER BY score DESC LIMIT 3').all(r.id, min);
      if (!cands.length) continue;
      res.push({
        finding: { id: r.id, path: r.path, line: r.line, category: r.category, title: r.title, detail: String(r.detail || '').slice(0, 600), snippet: r.snippet },
        candidates: cands.map((c) => ({ tracker: c.tracker, key: c.key, state: c.state, title: c.title, excerpt: String(c.body_excerpt || '').slice(0, 800), score: c.score })),
      });
    }
    const p = a.f.out || path.join(stateDir(), 'exports', `match-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(res, null, 1));
    out(`${res.length} finding(s) with candidates → ${p}`);
    return;
  }
  const issues = d.prepare('SELECT * FROM tracker_issues' + (a.f.tracker ? ' WHERE tracker LIKE ?' : '')).all(...(a.f.tracker ? [`${a.f.tracker}%`] : []));
  if (!issues.length) die('no tracker issues cached — run `tracker-sync gh` or `tracker-import jira` first');
  const prepared = issues.map((t) => {
    const paths = JSON.parse(t.paths_json || '[]');
    return { t, paths: new Set(paths), bases: new Set(paths.map((p) => p.split('/').pop())), tk: tokens(t.title), text: `${t.title}\n${t.body_excerpt}`.toLowerCase() };
  });
  const rows = loadFindings({ ...a.f, tracker: undefined, reported: undefined, unreported: a.f['include-reported'] ? undefined : true });
  const top = Number(a.f.top || 3);
  let strong = 0, weak = 0;
  tx(() => {
    const del = d.prepare('DELETE FROM match_candidates WHERE finding_id=?');
    const ins = d.prepare('INSERT INTO match_candidates VALUES(?,?,?,?,?)');
    for (const r of rows) {
      del.run(r.id);
      const base = r.path.split('/').pop();
      const ftk = tokens(r.title);
      const syms = [...new Set(`${r.snippet || ''} ${r.evidence || ''}`.match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) || [])]
        .filter((s) => /[A-Z_]/.test(s.slice(1)) || s.includes('_')).slice(0, 12);
      const scored = [];
      for (const p of prepared) {
        let score = 0; const why = [];
        if (p.paths.has(r.path)) { score += 3; why.push('path'); } else if (p.bases.has(base) || p.text.includes(base.toLowerCase())) { score += 1.5; why.push('file name'); }
        const jt = jaccard(ftk, p.tk);
        if (jt > 0) { score += 5 * jt; if (jt >= 0.2) why.push(`title ${Math.round(jt * 100)}%`); }
        const hits = syms.filter((s) => p.text.includes(s.toLowerCase())).length;
        if (hits) { score += Math.min(3, hits); why.push(`${hits} symbol(s)`); }
        if (score >= 2.5) scored.push({ p, score, why: why.join(', ') });
      }
      scored.sort((x, y) => y.score - x.score).slice(0, top).forEach((s) => ins.run(r.id, s.p.t.tracker, s.p.t.key, s.score, s.why));
      if (scored.length) { if (scored[0].score >= 6) strong++; else weak++; }
    }
  });
  out(`matched ${rows.length} unreported finding(s) against ${issues.length} issue(s): ${strong} strong, ${weak} weak candidate sets. \`match export\` for adjudication, \`match show <id>\``);
}

function cmdLink(a) {
  const [target, tracker, key] = a.pos;
  if (!target || !tracker || !key) die('usage: link <findingId|g<group>> <tracker e.g. gh:owner/repo|jira:PROJ> <key> [--url u] [--kind filed|linked_existing|skipped]');
  const d = db();
  const ids = target.startsWith('g')
    ? d.prepare('SELECT finding_id id FROM dupe_groups WHERE group_id=?').all(Number(target.slice(1))).map((r) => r.id)
    : target.split(',').map(Number);
  if (!ids.length) die('nothing to link');
  const t = d.prepare('SELECT url FROM tracker_issues WHERE tracker=? AND key=?').get(tracker, key);
  const kind = a.f.kind || 'linked_existing';
  tx(() => {
    for (const id of ids) {
      d.prepare(`INSERT INTO filings(finding_id,tracker,key,url,kind,filed_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(finding_id,tracker,key) DO UPDATE SET kind=excluded.kind, url=COALESCE(excluded.url,url)`)
        .run(id, tracker, String(key), a.f.url || (t && t.url) || null, kind, now());
    }
  });
  out(`${ids.length} finding(s) → ${kind} ${tracker} ${key}`);
}

function cmdUnlink(a) {
  const [id, tracker, key] = a.pos;
  const r = db().prepare('DELETE FROM filings WHERE finding_id=? AND (? IS NULL OR tracker=?) AND (? IS NULL OR key=?)')
    .run(Number(id), tracker || null, tracker || null, key || null, key || null);
  out(`removed ${r.changes} filing record(s)`);
}

// ----------------------------------------------------------------- reporting

const CONFIG_KEYS = {
  target: 'gh:owner/repo or jira:PROJ',
  code_repo: 'owner/repo used for permalinks (default: origin remote)',
  issue_type: 'Jira issue type (default Bug)',
  labels: 'comma-separated labels',
  assignee: 'assignee login / account id',
  components: 'Jira components, comma-separated',
  priority_map: 'JSON severity→priority, e.g. {"critical":"P0","high":"P1"}',
  group_by: 'finding | dupe-group | file | category (default dupe-group)',
  min_severity: 'critical|high|medium|low (default high)',
  require_triage: 'comma list of triage states eligible (default confirmed; "any" = open,confirmed)',
  title_template: 'default "{{severity_upper}}: {{title}} ({{basename}})"',
  body_template: 'path to body template (default templates/issue-<gh|jira>.md)',
  max_per_run: 'cap on drafts per render (default 20)',
  marker: 'yes|no — embed code-scan fingerprint marker in body (default yes)',
};

function cmdReportConfig(a) {
  const [sub, key, ...rest] = a.pos;
  if (!sub || sub === 'show') {
    for (const k of Object.keys(CONFIG_KEYS)) {
      const v = cfgGet(k);
      out(`${k}\t${v === null ? '-' : v}\t# ${CONFIG_KEYS[k]}`);
    }
    return;
  }
  if (sub === 'set') {
    if (!CONFIG_KEYS[key]) die(`unknown key ${key}; keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    const val = rest.join(' ');
    if (key === 'target' && !/^(gh:[\w.-]+\/[\w.-]+|jira:[A-Z][A-Z0-9_]+)$/.test(val)) die('target must be gh:owner/repo or jira:PROJ');
    if (key === 'group_by' && !['finding', 'dupe-group', 'file', 'category'].includes(val)) die('group_by: finding|dupe-group|file|category');
    if (key === 'min_severity' && !SEVERITIES.includes(val)) die(`min_severity: ${SEVERITIES.join('|')}`);
    if (key === 'priority_map') { try { JSON.parse(val); } catch (e) { die('priority_map must be JSON'); } }
    if (key === 'body_template' && !fs.existsSync(val)) die(`no such file ${val}`);
    cfgSet(key, val);
    out(`${key} = ${val}`);
    return;
  }
  if (sub === 'unset') { db().prepare('DELETE FROM config WHERE key=?').run(key); out(`unset ${key}`); return; }
  die('usage: report-config show|set <key> <value>|unset <key>');
}

function codeRepo() {
  const c = cfgGet('code_repo');
  if (c) return c;
  const u = (git(['remote', 'get-url', 'origin'], { allowFail: true }) || '').trim();
  const m = u.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

function render(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

function cmdRender(a) {
  const d = db();
  const target = a.f.target || cfgGet('target');
  if (!target) die('no report target — `report-config set target gh:owner/repo|jira:PROJ` (or pass --target)');
  const isJira = target.startsWith('jira:');
  const minSev = a.f['min-severity'] || cfgGet('min_severity', 'high');
  let tri = listFlag(a.f.triage) || listFlag(cfgGet('require_triage', 'confirmed'));
  if (tri.includes('any')) tri = ['open', 'confirmed'];
  const groupBy = a.f['group-by'] || cfgGet('group_by', 'dupe-group');
  const max = Number(a.f.max || cfgGet('max_per_run', '20'));
  const f = { ...a.f, unreported: true, triage: tri, severity: a.f.severity || [`${minSev}+`] };
  delete f.out;
  let rows = loadFindings(f);
  const hb = headBlobs();
  const stale = rows.filter((r) => hb.get(r.path) !== r.blob_sha);
  if (!a.f['include-stale']) rows = rows.filter((r) => hb.get(r.path) === r.blob_sha);
  // a finding already reported through a dupe sibling is covered by that issue
  const groupsOf = new Map(d.prepare('SELECT finding_id, group_id FROM dupe_groups').all().map((r) => [r.finding_id, r.group_id]));
  const reportedGroups = new Set(d.prepare(`SELECT DISTINCT g.group_id FROM dupe_groups g JOIN filings x ON x.finding_id=g.finding_id
    WHERE x.kind!='skipped'`).all().map((r) => r.group_id));
  const covered = rows.filter((r) => groupsOf.has(r.id) && reportedGroups.has(groupsOf.get(r.id)));
  rows = rows.filter((r) => !covered.includes(r));
  const bucket = new Map();
  for (const r of rows) {
    let k;
    if (groupBy === 'finding') k = `f${r.id}`;
    else if (groupBy === 'file') k = `p${r.path}`;
    else if (groupBy === 'category') k = `c${r.category}`;
    else k = groupsOf.has(r.id) ? `g${groupsOf.get(r.id)}` : `f${r.id}`;
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k).push(r);
  }
  const repo = codeRepo();
  const remoteHas = new Map();
  const onRemote = (sha) => {
    if (!remoteHas.has(sha)) {
      const r = git(['branch', '-r', '--contains', sha], { allowFail: true });
      remoteHas.set(sha, !!(r && r.trim()));
    }
    return remoteHas.get(sha);
  };
  const link = (r) => (repo ? `https://github.com/${repo}/blob/${r.commit_sha}/${r.path}#L${r.line || 1}${r.end_line && r.end_line > r.line ? '-L' + r.end_line : ''}` : null);
  const tplPath = cfgGet('body_template') || path.join(PLUGIN_ROOT, 'templates', isJira ? 'issue-jira.md' : 'issue-github.md');
  const tpl = fs.readFileSync(tplPath, 'utf8');
  const titleTpl = cfgGet('title_template', '{{severity_upper}}: {{title}} ({{basename}})');
  const pmap = JSON.parse(cfgGet('priority_map', '{}'));
  const labels = listFlag(a.f.label) || listFlag(cfgGet('labels', '')) || [];
  const marker = cfgGet('marker', 'yes') !== 'no';
  const dir = a.f.out || path.join(stateDir(), 'renders', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const drafts = [];
  const warn = new Set();
  const list = [...bucket.values()].map((g) => sortRows(g, 'severity:desc,path,line'))
    .sort((x, y) => SEV_RANK[y[0].severity] - SEV_RANK[x[0].severity] || y.length - x.length);
  for (const g of list.slice(0, max)) {
    const lead = g[0];
    const ids = g.map((r) => r.id).sort((x, y) => x - y);
    const draftId = 'd-' + sha1(ids.join(','), 10);
    const blocks = g.map((r) => {
      const l = link(r);
      if (!l) warn.add('no GitHub code repo — set report-config code_repo owner/repo for permalinks');
      else if (!onRemote(r.commit_sha)) warn.add(`commit ${r.commit_sha.slice(0, 12)} is not on any remote branch — push it or the permalinks will 404`);
      const where = isJira ? `\`${loc(r)}\` — ${r.title}${l ? `\n${l}` : ''}` : (l ? `${l}` : `\`${loc(r)}\``);
      // paragraphs, blank-line separated: a permalink only expands into a snippet on a line of its own
      return [
        g.length > 1 ? `#### ${r.title} (\`${loc(r)}\`)` : null,
        where, r.detail || null, r.evidence ? `**Evidence:** ${r.evidence}` : null,
        marker ? (isJira ? `_code-scan:fp=${r.fingerprint}_` : `<!-- code-scan:fp=${r.fingerprint} -->`) : null,
      ].filter((x) => x !== null).join('\n\n');
    }).join('\n\n');
    const sevs = [...new Set(g.map((r) => r.severity))];
    const vars = {
      title: groupBy === 'file' ? `${g.length} issue(s) in ${lead.path}` : groupBy === 'category' ? `${g.length} ${lead.category} issue(s)` : lead.title,
      severity: lead.severity, severity_upper: lead.severity.toUpperCase(), category: lead.category,
      path: lead.path, basename: lead.path.split('/').pop(), line: lead.line, count: g.length,
      commit: lead.commit_sha, short_commit: lead.commit_sha.slice(0, 12), findings: blocks,
      locations: g.map((r) => `- \`${loc(r)}\``).join('\n'), severities: sevs.join(', '),
    };
    const title = render(titleTpl, vars).slice(0, 250);
    const body = render(tpl, vars);
    const bodyFile = path.join(dir, `${draftId}.md`);
    fs.writeFileSync(bodyFile, body);
    drafts.push({
      draft: draftId, title, body_file: bodyFile, finding_ids: ids, severity: lead.severity,
      priority: pmap[lead.severity] || null, labels, assignee: cfgGet('assignee'),
      issue_type: isJira ? cfgGet('issue_type', 'Bug') : undefined,
      components: isJira ? listFlag(cfgGet('components', '')) : undefined,
    });
  }
  const manifest = { target, created: now(), drafts };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  cfgSet('_last_render', dir);
  out(`${drafts.length} draft(s) for ${target} from ${rows.length} eligible finding(s) (min ${minSev}, triage ${tri.join('/')}, group_by ${groupBy})${list.length > max ? `; ${list.length - max} more groups over max_per_run` : ''}`);
  if (covered.length) out(`skipped ${covered.length} finding(s) whose duplicate group already has an issue (${covered.map((r) => '#' + r.id).join(' ')}); \`link\` them to it`);
  if (stale.length && !a.f['include-stale']) out(`skipped ${stale.length} stale finding(s) (file changed since scan; rescan or --include-stale)`);
  for (const w of warn) out(`warning: ${w}`);
  out(`manifest: ${path.join(dir, 'manifest.json')}`);
}

function lastManifest(f) {
  const dir = f.render || cfgGet('_last_render');
  if (!dir) die('no rendered drafts — run `render` first');
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) die(`missing ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function cmdRecordFiling(a) {
  const [draftId, tracker, key, url] = a.pos;
  if (!draftId || !tracker || !key) die('usage: record-filing <draftId> <tracker> <key> [url]');
  const m = lastManifest(a.f);
  const dr = m.drafts.find((x) => x.draft === draftId);
  if (!dr) die(`draft ${draftId} not in ${m.target} manifest`);
  tx((d) => {
    for (const id of dr.finding_ids) {
      d.prepare(`INSERT INTO filings(finding_id,tracker,key,url,kind,draft_id,filed_at) VALUES(?,?,?,?, 'filed', ?, ?)
        ON CONFLICT(finding_id,tracker,key) DO UPDATE SET kind='filed', url=COALESCE(excluded.url,url), draft_id=excluded.draft_id`)
        .run(id, tracker, String(key), url || null, draftId, now());
    }
  });
  out(`recorded ${dr.finding_ids.length} finding(s) as filed in ${tracker} ${key}`);
}

/** GitHub filing is mechanical; doing it here keeps issue bodies out of the model's context. */
function cmdFileGh(a) {
  const m = lastManifest(a.f);
  if (!m.target.startsWith('gh:')) die(`last render targets ${m.target}; file-gh only handles gh: targets`);
  const repo = m.target.slice(3);
  const only = listFlag(a.f.drafts);
  const drafts = m.drafts.filter((x) => !only || only.includes(x.draft));
  const filed = new Set(db().prepare("SELECT DISTINCT draft_id FROM filings WHERE kind='filed' AND draft_id IS NOT NULL").all().map((r) => r.draft_id));
  let n = 0;
  for (const dr of drafts) {
    if (filed.has(dr.draft)) { out(`skip ${dr.draft}: already filed`); continue; }
    if (a.f['dry-run']) { out(`would file ${dr.draft}: ${dr.title}`); continue; }
    const args = ['issue', 'create', '--repo', repo, '--title', dr.title, '--body-file', dr.body_file];
    for (const l of dr.labels || []) args.push('--label', l);
    if (dr.assignee) args.push('--assignee', dr.assignee);
    const r = spawnSync('gh', args, { encoding: 'utf8' });
    if (r.status !== 0) { out(`FAILED ${dr.draft}: ${r.stderr.trim()}`); continue; }
    const url = r.stdout.trim().split('\n').pop();
    const key = (url.match(/\/issues\/(\d+)/) || [])[1] || url;
    cmdRecordFiling({ pos: [dr.draft, m.target, key, url], f: a.f });
    n++;
  }
  out(`filed ${n} issue(s) to ${m.target}`);
}

function cmdDrafts(a) {
  const m = lastManifest(a.f);
  out(`target ${m.target}, ${m.drafts.length} draft(s), rendered ${m.created}`);
  m.drafts.forEach((dr) => out(`${dr.draft}\t${dr.severity}\t${dr.finding_ids.length} finding(s)\t${dr.title}\t${dr.body_file}`));
}

// ---------------------------------------------------------------------- main

const HELP = `code-scan.js [-C repo] <command> [...]
scan:      start [--model m] [--profile p|--prompt-file f] [--only g] [--include g] [--exclude g] [--include-tests] [--chunk-kb N]
                 [--force] [--force-path g] [--no-plan] [--new]
           continue [--scan id] [--model m] | restart [--replan] [--reset-scope] [...start flags] | stop [--now] | set-run <scan> <task>
planner:   plan-context <scan> | apply-plan <scan> --file plan.json
workers:   claim <scan> | submit <scan> <chunk> --file <path> [--slice k] < findings.json
limits:    start/restart/continue/limits [--max-usd N] [--max-5h-pct P]  | statusline [-- <wrapped status line cmd>]
progress:  status [--scan id|--all] | files [--state s] [--path p] [--out f]
findings:  query [--severity critical,high|high+] [--category c] [--path p] [--triage t|all] [--reported|--unreported]
                 [--tracker t] [--scan id|--latest] [--stale|--no-stale] [--gone|--include-gone] [--min-confidence x] [--text s] [--unit u]
                 [--group g] [--dupe-of id] [--primary-only] [--ids 1,2] [--sort severity:desc,path,line]
                 [--limit n] [--format table|md|json|csv] [--out file]
           show <id> | sql "<SELECT ...>" | triage <ids|filters> --set <state> [--note s]
profiles:  profile list | show <name> | add <name> --file f | rm <name>
dupes:     dupes [filters] [--line-window 10] [--title-sim 0.6] | dupes list | dupes show <g> | dupes merge|split <ids>
trackers:  tracker-sync gh [--repo o/r] [--state all] [--search q] | tracker-import jira < issues.json
           match [filters] [--tracker t] [--include-reported] [--top 3] | match show <id> | match export [--min-score 3] [--out f]
           link <id|ids|gN> <tracker> <key> [--url u] [--kind k] | unlink <id> [tracker] [key]
calibrate: calibrate start --model m [--sample-kb 200] [--medium 40] | calibrate next [id] | calibrate status | calibrate set <m> <kb>
report:    report-config show|set <k> <v>|unset <k> | render [filters] [--target t] [--group-by g] [--max n]
           drafts | file-gh [--drafts d1,d2] [--dry-run] | record-filing <draft> <tracker> <key> [url]`;

const COMMANDS = {
  start: cmdStart, continue: cmdContinue, restart: cmdRestart, stop: cmdStop, 'set-run': cmdSetRun,
  'plan-context': cmdPlanContext, 'apply-plan': cmdApplyPlan, claim: cmdClaim, submit: cmdSubmit,
  status: cmdStatus, files: cmdFiles, query: cmdQuery, show: cmdShow, sql: cmdSql, triage: cmdTriage,
  profile: cmdProfile, dupes: cmdDupes, 'tracker-sync': cmdTrackerSync, 'tracker-import': cmdTrackerImport,
  match: cmdMatch, link: cmdLink, unlink: cmdUnlink, 'report-config': cmdReportConfig, render: cmdRender,
  drafts: cmdDrafts, calibrate: cmdCalibrate, statusline: cmdStatusline, limits: cmdLimits, 'statusline-path': () => out(rateLimitsPath()), 'file-gh': cmdFileGh, 'record-filing': cmdRecordFiling,
};

function main() {
  let argv = process.argv.slice(2);
  while (argv[0] === '-C') {
    if (!argv[1]) die('-C needs a path');
    process.chdir(argv[1]);
    argv = argv.slice(2);
  }
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help') { out(HELP); return; }
  const fn = COMMANDS[cmd];
  if (!fn) die(`unknown command '${cmd}'\n${HELP}`);
  fn(parseArgs(argv.slice(1)));
}

try {
  main();
} catch (e) {
  die(e && e.message ? e.message : String(e));
}
