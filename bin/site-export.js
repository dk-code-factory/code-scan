#!/usr/bin/env node
'use strict';
/**
 * Export aggregate model-performance data from local code-scan stores for the GitHub Pages site.
 *
 *   node bin/site-export.js [--home ~/.cache/code-scan] [--config docs/site-config.json] [--out docs/data.json]
 *
 * Read-only for the stores: each codescan.db is copied to a temp dir and code-scan.js runs against the copy
 * (its schema migrations and spend caches touch only the copy). Only counts, sizes, models and dollars are
 * exported — never finding titles, paths or code. Repos not listed as public in the config are anonymized.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(__dirname, 'code-scan.js');

function args(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) f[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return f;
}
const F = args(process.argv.slice(2));
const HOME = path.resolve(F.home || process.env.CODESCAN_STORES || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'code-scan'));
const CONFIG = JSON.parse(fs.readFileSync(path.resolve(F.config || path.join(ROOT, 'docs/site-config.json')), 'utf8'));
const OUT = path.resolve(F.out || path.join(ROOT, 'docs/data.json'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'code-scan-site-'));
const PUBLIC = new Set(CONFIG.public || []);

const log = (s) => process.stderr.write(s + '\n');
const round = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(n)));

function git(cwd, a) {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
function repoKey(p) {
  const roots = (git(p, ['rev-list', '--max-parents=0', 'HEAD']) || '').split('\n').filter(Boolean).sort();
  return roots.length ? crypto.createHash('sha1').update(roots[0]).digest('hex').slice(0, 12) : null;
}

/** Copy a store so code-scan.js can run on it; XDG layout keeps the spend-cache keys (repo|''|scan) valid. */
function stage(key) {
  const xdg = path.join(TMP, key);
  const dir = path.join(xdg, 'code-scan', key);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['codescan.db', 'codescan.db-wal', 'codescan.db-shm']) {
    const src = path.join(HOME, key, n);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, n));
  }
  return { xdg, db: path.join(dir, 'codescan.db') };
}

function cli(st, cwd, key, a) {
  // a 12-hex store dir is keyed by the repo's root commit: run inside the repo so the store resolves itself;
  // any other store (made with CODESCAN_HOME) is pointed at directly
  const env = { ...process.env };
  delete env.CODESCAN_HOME;
  if (/^[0-9a-f]{12}$/.test(key) && cwd && repoKey(cwd) === key) env.XDG_CACHE_HOME = st.xdg;
  else { env.CODESCAN_HOME = path.dirname(st.db); cwd = ROOT; }
  const r = spawnSync(process.execPath, [CLI, '-C', cwd, ...a], { encoding: 'utf8', env, maxBuffer: 64 << 20, timeout: 300000 });
  if (r.status !== 0) { log(`  ${a.join(' ')}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`); return null; }
  return r.stdout;
}

function q(db, sql, ...p) { try { return db.prepare(sql).all(...p); } catch (e) { return []; } }

function tsv(text, header) {
  const lines = (text || '').split('\n');
  const h = lines.findIndex((l) => l.startsWith(header));
  if (h < 0) return [];
  const cols = lines[h].split('\t');
  const rows = [];
  for (const l of lines.slice(h + 1)) {
    const v = l.split('\t');
    if (v.length !== cols.length) break;
    rows.push(Object.fromEntries(cols.map((c, i) => [c, v[i]])));
  }
  return rows;
}
const num = (v) => (v === undefined || v === '-' || v === '' ? null : Number(v));

const privNames = new Map();
function displayName(repo, lang) {
  if (repo && PUBLIC.has(repo)) return { name: repo, public: true };
  const k = repo || `?${privNames.size}`;
  if (!privNames.has(k)) privNames.set(k, `private project ${String.fromCharCode(65 + privNames.size)}${lang ? ` (${lang})` : ''}`);
  return { name: privNames.get(k), public: false };
}

function exportStore(key) {
  const cfg = (CONFIG.stores || {})[key] || {};
  if (cfg.skip) return [];
  const st = stage(key);
  let db = new DatabaseSync(st.db, { readOnly: true });
  const conf = Object.fromEntries(q(db, 'SELECT key, value FROM config').map((r) => [r.key, r.value]));
  // local checkouts that ran against this store (from the spend cache keys), plus configured ones
  const cands = new Set();
  for (const r of q(db, "SELECT DISTINCT substr(scan_key,1,instr(scan_key,'|')-1) p FROM spend_files2 WHERE usd>0 AND scan_key LIKE '/%'")) cands.add(r.p);
  const paths = [...cands].filter((p) => fs.existsSync(p) && (!/^[0-9a-f]{12}$/.test(key) || repoKey(p) === key));
  db.close();
  if (!paths.length) paths.push(null);

  // scans with dollars: the spend cache is keyed by repo root, so ask from each checkout and keep the max
  const usd = new Map();
  let scanList = [];
  for (const p of paths) {
    const o = cli(st, p, key, ['scans', '--json', '--limit', '1000']);
    if (!o || !o.trim().startsWith('[')) continue;
    const rows = JSON.parse(o);
    scanList = rows;
    for (const r of rows) usd.set(r.id, Math.max(usd.get(r.id) || 0, r.usd || 0));
  }
  const cwd = paths[0];
  db = new DatabaseSync(st.db, { readOnly: true });
  const specOf = (s) => {
    const p = s.profile_id && q(db, 'SELECT spec_json FROM review_profiles WHERE id=?', s.profile_id)[0];
    const sp = p ? JSON.parse(p.spec_json) : {};
    const o = JSON.parse(s.options_json || '{}');
    return { model: sp.model || o.model || null, effort: sp.effort || o.effort || null, chunkKb: sp.chunkKb || sp.chunk_kb || o.chunkKb || null };
  };
  const repoOf = (id) => (cfg.scans && cfg.scans[id]) || cfg.repo || conf.code_repo || (conf.target || '').replace(/^gh:/, '') || null;
  const langOf = (id) => (q(db, "SELECT lang, SUM(bytes) b FROM files WHERE scan_id=? AND state='reviewed' AND lang IS NOT NULL GROUP BY lang ORDER BY b DESC LIMIT 1", id)[0] || {}).lang || null;

  const byRepo = new Map();
  const bucket = (repo, lang) => {
    if (!byRepo.has(repo)) byRepo.set(repo, { repo, lang, scans: [], compares: [], inits: [], curves: [], triage: [] });
    return byRepo.get(repo);
  };

  // full scans
  const excl = new Set((cfg.excludeScans || []).map(Number));
  for (const r of scanList.filter((x) => x.status === 'done' && !excl.has(x.id))) {
    const s = q(db, 'SELECT * FROM scans WHERE id=?', r.id)[0];
    const sp = specOf(s);
    const bytes = (q(db, "SELECT SUM(bytes) b FROM files WHERE scan_id=? AND state='reviewed'", r.id)[0] || {}).b || 0;
    if (bytes < (CONFIG.minScanKb || 100) * 1024) continue;
    const sev = Object.fromEntries(q(db, 'SELECT COALESCE(x.severity, f.severity) s, COUNT(*) n FROM seen x JOIN findings f ON f.id=x.finding_id WHERE x.scan_id=? GROUP BY 1', r.id).map((x) => [x.s, x.n]));
    const tri = Object.fromEntries(q(db, 'SELECT f.triage t, COUNT(*) n FROM seen x JOIN findings f ON f.id=x.finding_id WHERE x.scan_id=? GROUP BY 1', r.id).map((x) => [x.t, x.n]));
    const conf_ = (tri.confirmed || 0) + (tri.fixed || 0) + (tri.wontfix || 0), fp = tri.false_positive || 0;
    const runs = q(db, "SELECT runner, SUM(usd) u, COUNT(*) n FROM agent_runs WHERE scan_id=? GROUP BY runner", r.id);
    // noPrice: scans whose spend record is known to be incomplete (lost transcripts) show no price
    const u = (cfg.noPrice || []).map(Number).includes(r.id) ? 0 : usd.get(r.id) || 0;
    const ms = Date.parse(s.updated) - Date.parse(s.created);
    const repo = repoOf(r.id);
    const lang = cfg.lang || langOf(r.id);
    bucket(repo, lang).scans.push({
      id: r.id, store: key, profile: r.profile, model: sp.model, runner: (runs[0] && runs[0].runner) || (/^[a-z]+:/.test(sp.model || '') ? sp.model.split(':')[0] : 'claude'),
      effort: sp.effort, chunkKb: sp.chunkKb, commit: s.commit_sha.slice(0, 12), files: r.reviewed, kb: Math.round(bytes / 1024),
      findings: r.findings, severity: sev, triage: tri, triaged: conf_ + fp, precision: conf_ + fp ? round(conf_ / (conf_ + fp)) : null,
      usd: u ? round(u) : null, usdPer100Kb: u && bytes ? round(u / (bytes / 1024) * 100) : null, hours: ms > 0 ? round(ms / 3600000, 1) : null,
    });
  }

  const studies = (CONFIG.effortStudies || []).filter((x) => x.store === key);
  const studyIds = new Set(studies.flatMap((x) => x.scans));

  // head-to-head: every pair of scans of one repo with different profiles
  for (const b of byRepo.values()) {
    for (let i = 0; i < b.scans.length; i++) for (let j = i + 1; j < b.scans.length; j++) {
      const A = b.scans[i], B = b.scans[j];
      if (A.model === B.model && A.effort === B.effort) continue;
      if (studyIds.has(A.id) || studyIds.has(B.id)) continue; // study scans are compared together below
      const o = cli(st, cwd, key, ['compare', String(A.id), String(B.id), '--json', '--list', 'none']);
      if (!o) continue;
      const c = JSON.parse(o);
      if (!c.basis || c.basis.bytes < (CONFIG.minScanKb || 100) * 1024) continue;
      const clusters = c.clusters || [];
      const sevBy = (id) => { const o = {}; for (const k of clusters) { const v = k.seenBy[id]; if (v) o[v.severity] = (o[v.severity] || 0) + 1; } return o; };
      b.compares.push({
        store: key, basisKb: Math.round(c.basis.bytes / 1024), basisFiles: c.basis.files, both: clusters.filter((x) => Object.keys(x.seenBy).length > 1).length,
        scans: c.scans.map((x) => ({ id: x.id, model: x.model, findings: x.findings, severity: sevBy(x.id), unique: x.unique, share: round(x.share), confirmed: x.confirmed, falsePositive: x.falsePositive, precision: round(x.precision) })),
      });
    }
  }

  // init benchmarks (cross-model quality at each model's chunk size) and per-model calibration curves
  const inits = q(db, 'SELECT DISTINCT init_id i FROM calibrations WHERE init_id IS NOT NULL ORDER BY 1').map((r) => r.i);
  const calRepo = repoOf((q(db, "SELECT MIN(id) i FROM scans WHERE kind='scan'")[0] || {}).i);
  const calCommitRepo = (sha) => {
    const s = q(db, "SELECT id FROM scans WHERE kind='scan' AND commit_sha=? LIMIT 1", sha)[0];
    return s ? repoOf(s.id) : calRepo;
  };
  for (const id of inits) {
    const c0 = q(db, 'SELECT * FROM calibrations WHERE init_id=? ORDER BY id LIMIT 1', id)[0];
    const o = cli(st, cwd, key, ['init', 'report', String(id)]);
    const rows = tsv(o, 'model\t').map((r) => ({ model: r.model, effort: r.effort === '-' ? null : r.effort, chunkKb: num((r.chunk || '').replace('KB', '')),
      quality: num(r.quality), qA: num(r.qA), qB: num(r.qB), usdPer100Kb: num(r['$/100KB']), usdPer1kLoc: num(r['$/1kLOC']), findings: num(r.findings), calibrationUsd: num(r['calibration $']), status: r.status }))
      .filter((r) => r.status !== 'abandoned' && r.status !== 'running');
    const head = ((o || '').split('\n')[0] || '');
    const issues = num((head.match(/(\d+) distinct issues/) || [])[1]) ?? [...head.matchAll(/(\d+) issues/g)].reduce((s, m) => s + Number(m[1]), 0);
    if (!rows.some((r) => r.status === 'done') || issues < (CONFIG.minInitIssues || 5)) continue;
    for (const r of rows) if (!r.usdPer100Kb) { r.usdPer100Kb = null; r.usdPer1kLoc = null; r.calibrationUsd = r.calibrationUsd || null; }
    const repo = calCommitRepo(c0.commit_sha);
    bucket(repo, null).inits.push({ id, sampleKb: Math.round(c0.sample_bytes / 1024), issues, created: c0.created.slice(0, 10), rows });
  }
  for (const cal of q(db, "SELECT * FROM calibrations WHERE status IN ('done','failed') ORDER BY id")) {
    const rounds = tsv(cli(st, cwd, key, ['calibrate', 'report', String(cal.id)]), 'size\t')
      .filter((r) => /^[\d.]+$/.test(r.score)).map((r) => ({ kb: num(r.size.replace('KB', '')), score: num(r.score), findings: num(r.findings) }))
      .sort((x, y) => x.kb - y.kb);
    // one or two issues in the whole sample make a flat or 0/1 curve that says nothing about chunk size
    if (rounds.length < 2 || rounds.reduce((x, r) => x + (r.findings || 0), 0) < (CONFIG.minCurveFindings || 6) || new Set(rounds.map((r) => r.score)).size < 2) continue;
    bucket(calCommitRepo(cal.commit_sha), null).curves.push({ id: cal.id, model: cal.model, effort: cal.effort || null, init: cal.init_id, resultKb: cal.result_kb, status: cal.status, decision: cal.decision, rounds });
  }

  // effort studies: the same code reviewed by each model at several effort levels, all compared at once
  const effortStudies = [];
  for (const sd of studies) {
    const o = cli(st, cwd, key, ['compare', ...sd.scans.map(String), '--json', '--list', 'none']);
    if (!o) continue;
    const c = JSON.parse(o);
    const all = [...byRepo.values()].flatMap((b) => b.scans);
    const clusters = c.clusters || [];
    const sevW = { critical: 4, high: 3, medium: 2, low: 1 };
    const rows = c.scans.map((x) => {
      const sc = all.find((y) => y.id === x.id) || {};
      const tok = q(db, `SELECT COUNT(*) agents, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read) cr, SUM(cache_write) cw, SUM(1 - ok) failed,
        SUM((julianday(ended) - julianday(started)) * 86400) secs FROM agent_runs WHERE scan_id=? AND kind='review'`, x.id)[0] || {};
      const mine = clusters.filter((k) => k.seenBy[x.id]);
      const severity = {};
      for (const k of mine) { const v = k.seenBy[x.id].severity; severity[v] = (severity[v] || 0) + 1; }
      // confirmed findings at the severity triage settled on (reviewers grade severity differently)
      const confirmedSeverity = Object.fromEntries(q(db, `SELECT f.severity s, COUNT(DISTINCT f.id) n FROM seen x JOIN findings f ON f.id=x.finding_id
        WHERE x.scan_id=? AND (f.triage IN ('confirmed','fixed','wontfix') OR f.confirmation='confirmed') GROUP BY 1`, x.id).map((r) => [r.s, r.n]));
      // severity-weighted share of the confirmed issues any effort level found: recall against the pooled truth
      const realW = clusters.filter((k) => k.confirmed).reduce((s_, k) => s_ + (sevW[k.severity] || 1), 0);
      const gotW = mine.filter((k) => k.confirmed).reduce((s_, k) => s_ + (sevW[k.severity] || 1), 0);
      return {
        id: x.id, model: sc.model || x.model, effort: sc.effort, findings: x.findings, severity, confirmedSeverity, unique: x.unique, share: round(x.share),
        confirmed: x.confirmed, falsePositive: x.falsePositive, untriaged: x.findings - x.confirmed - x.falsePositive,
        precision: round(x.precision), confirmedRecall: realW ? round(gotW / realW) : null,
        highPlus: mine.filter((k) => k.severity === 'critical' || k.severity === 'high').length,
        usd: sc.usd, usdPer100Kb: sc.usdPer100Kb, usdPerConfirmed: sc.usd && x.confirmed ? round(sc.usd / x.confirmed) : null,
        agents: tok.agents || 0, failedAgents: tok.failed || 0, outputTokens: tok.o || null, inputTokens: (tok.i || 0) + (tok.cr || 0) + (tok.cw || 0) || null,
        agentMinutes: tok.secs ? round(tok.secs / 60, 1) : null,
      };
    });
    // two or more runs together: recall of their union against the same pooled confirmed issues, and summed price
    const realW = clusters.filter((k) => k.confirmed).reduce((s_, k) => s_ + (sevW[k.severity] || 1), 0);
    const combos = (sd.combos || []).map((ids) => {
      const gotW = clusters.filter((k) => k.confirmed && ids.some((i) => k.seenBy[i])).reduce((s_, k) => s_ + (sevW[k.severity] || 1), 0);
      const parts = ids.map((i) => rows.find((r) => r.id === i)).filter(Boolean);
      const usd_ = parts.reduce((s_, r) => s_ + (r.usd || 0), 0);
      return { runs: parts.map((r) => ({ model: r.model, effort: r.effort })), recall: realW ? round(gotW / realW) : null, usd: round(usd_) };
    });
    const repo = repoOf(sd.scans[0]);
    effortStudies.push({ combos, repo, title: sd.title || null, basisKb: Math.round(c.basis.bytes / 1024), basisFiles: c.basis.files, issues: clusters.length,
      confirmedIssues: clusters.filter((k) => k.confirmed).length, triagedBy: sd.triagedBy || null, rows });
  }
  for (const e of effortStudies) bucket(e.repo, null).efforts = (bucket(e.repo, null).efforts || []).concat(e);

  // auto-triage: verdict mix and price per finding, by triage model
  for (const t of q(db, 'SELECT * FROM triage_runs')) {
    const v = Object.fromEntries(q(db, 'SELECT verdict, COUNT(*) n FROM triage_results WHERE run_id=? GROUP BY verdict', t.id).map((x) => [x.verdict, x.n]));
    const n = Object.values(v).reduce((s, x) => s + x, 0);
    if (!n) continue;
    const u = (q(db, 'SELECT SUM(usd) u FROM agent_runs WHERE triage_run_id=?', t.id)[0] || {}).u;
    const sevChanged = (q(db, 'SELECT COUNT(*) n FROM triage_results WHERE run_id=? AND severity_old IS NOT NULL AND severity_new IS NOT NULL AND severity_old!=severity_new', t.id)[0] || {}).n || 0;
    const ids = q(db, 'SELECT finding_id FROM triage_results WHERE run_id=? LIMIT 1', t.id)[0];
    const fs_ = ids && q(db, 'SELECT first_scan FROM findings WHERE id=?', ids.finding_id)[0];
    const repo = repoOf(fs_ ? fs_.first_scan : null);
    bucket(repo, null).triage.push({ model: t.model, runner: t.runner || null, effort: t.effort || null, groupSize: t.group_size, findings: n, verdicts: v,
      severityChanged: sevChanged, usd: u ? round(u) : null, usdPerFinding: u ? round(u / n, 3) : null });
  }
  db.close();
  return [...byRepo.values()];
}

function main() {
  const keys = fs.readdirSync(HOME).filter((k) => fs.existsSync(path.join(HOME, k, 'codescan.db')));
  const merged = new Map();
  for (const key of keys) {
    log(`store ${key}`);
    for (const b of exportStore(key)) {
      if (!b.scans.length && !(b.efforts || []).length && !b.inits.length && !b.curves.length && !b.triage.length) continue;
      const k = b.repo || `?${key}`;
      if (!merged.has(k)) merged.set(k, { repo: b.repo, lang: b.lang, scans: [], compares: [], inits: [], curves: [], triage: [] });
      const m = merged.get(k);
      m.lang = m.lang || b.lang;
      for (const f of ['scans', 'compares', 'inits', 'curves', 'triage']) m[f].push(...b[f]);
      if (b.efforts) m.efforts = (m.efforts || []).concat(b.efforts);
    }
  }
  const repos = [...merged.values()].map((m) => {
    const d = displayName(m.repo, m.lang);
    return { name: d.name, public: d.public, url: d.public ? `https://github.com/${m.repo}` : null, lang: m.lang,
      scans: m.scans, compares: m.compares, inits: m.inits, curves: m.curves, triage: m.triage, efforts: m.efforts || [] };
  }).sort((a, b) => (b.public - a.public) || a.name.localeCompare(b.name));
  const data = { generated: new Date().toISOString().slice(0, 10), bench: CONFIG.bench || null, repos };
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
  fs.rmSync(TMP, { recursive: true, force: true });
  log(`wrote ${path.relative(process.cwd(), OUT)}: ${repos.length} repos, ${repos.reduce((s, r) => s + r.scans.length, 0)} scans, ${repos.reduce((s, r) => s + r.inits.length, 0)} inits, ${repos.reduce((s, r) => s + r.curves.length, 0)} curves`);
}

main();
