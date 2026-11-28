'use strict';
(async function () {
  // phones: the nav scrolls sideways; bring the current page's tab into view
  const cur = document.querySelector('nav.site a[aria-current="page"]');
  const showCur = () => { if (cur && cur.parentElement.scrollWidth > cur.parentElement.clientWidth) { const box = cur.parentElement, a = cur.getBoundingClientRect(), b = box.getBoundingClientRect(); box.scrollLeft += a.left - b.left - (b.width - a.width) / 2; } };
  showCur(); addEventListener('load', showCur); addEventListener('resize', showCur);
  const data = await (await fetch('data.json', { cache: 'no-cache' })).json();
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f2 = (v) => (v === null || v === undefined ? '–' : v.toFixed(2));
  const usd = (v) => (v === null || v === undefined ? '–' : '$' + v.toFixed(2));
  const kb = (v) => (v >= 1024 ? (v / 1024).toFixed(1) + 'MB' : v + 'KB');

  // fixed model → categorical slot; color follows the model everywhere
  const MODELS = [
    ['claude-opus-5-5', 'Opus 5.5', '--s1'],
    ['gpt-6.1-sol', 'Codex gpt-6.1-sol', '--s2'],
    ['claude-fable-5-2', 'Fable 5.2', '--s3'],
    ['claude-sonnet-5-5', 'Sonnet 5.5', '--s4'],
    ['claude-haiku-5-5', 'Haiku 5.5', '--s5'],
  ];
  const modelInfo = (m) => {
    const bare = String(m || '').replace(/^[a-z]+:/, '').replace(/^.*\//, '');
    const hit = MODELS.find(([k]) => bare.startsWith(k));
    return hit ? { name: hit[1], color: `var(${hit[2]})` } : { name: bare || '?', color: 'var(--s6)' };
  };
  const sw = (m) => `<span class="swatch" style="background:${modelInfo(m).color}"></span>${esc(modelInfo(m).name)}`;
  const withEffort = (m, e) => sw(m) + (e ? ` <span class="muted">${esc(e)}</span>` : '');
  // findings split by severity: total, then critical / high / medium / low
  const SEVS = ['critical', 'high', 'medium', 'low'];
  const sevTh = '<th>total</th><th>critical</th><th>high</th><th>medium</th><th>low</th>';
  const sevTd = (total, sev) => `<td><b>${total ?? '–'}</b></td>` + SEVS.map((k) => `<td>${(sev && sev[k]) || 0}</td>`).join('');
  // plain description of each repository for readers who don't know it
  const WHAT = { 'scylladb/cpp-rs-driver': 'C/C++ driver API in Rust', 'scylladb/csharp-driver': 'C# database driver', 'scylladb/gocql': 'Go database driver',
    'scylladb/java-driver': 'Java database driver', 'scylladb/nodejs-rs-driver': 'Node.js driver, TypeScript + Rust', 'scylladb/scylla-rust-driver': 'Rust database driver',
    'scylladb/scylladb': 'C++ database', 'scylladb/seastar': 'C++ async framework', 'private project A (go)': 'private Go code' };
  const repoLink = (r) => (r.url ? `<a href="${r.url}">${esc(r.name)}</a>` : esc(r.name));
  // model page headings: plain description first, repo slug as a small secondary link
  const repoTitle = (r) => (WHAT[r.name] ? esc(WHAT[r.name].replace(/^./, (c) => c.toUpperCase())) : esc(r.name));
  const repoSrc = (r) => { if (/^private/.test(r.name) || !WHAT[r.name]) return ''; const t = esc(r.name.replace(/^scylladb\//, '')); return ` <span class="muted">(${r.url ? `<a href="${r.url}">${t}</a>` : t})</span>`; };

  // ---------- tooltip
  const tip = $('tip');
  function bindTip(el, html) {
    el.addEventListener('mousemove', (e) => {
      tip.innerHTML = html; tip.style.display = 'block';
      const x = Math.min(e.pageX + 12, document.documentElement.scrollWidth - tip.offsetWidth - 8);
      tip.style.left = x + 'px'; tip.style.top = (e.pageY + 12) + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
  const svgEl = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const nice = (max) => { const p = Math.pow(10, Math.floor(Math.log10(max))); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= max); };

  for (const el of document.querySelectorAll('.generated')) el.textContent = data.generated;

  // ---------- headline cards
  const allScans = data.repos.flatMap((r) => r.scans.map((s) => ({ ...s, repo: r })));
  const totalFindings = allScans.reduce((s, x) => s + x.findings, 0);
  const triaged = allScans.reduce((s, x) => s + x.triaged, 0);
  const confirmedAll = allScans.reduce((s, x) => s + x.confirmed, 0), fpAll = allScans.reduce((s, x) => s + x.falsePositive, 0);
  if ($('headline')) $('headline').innerHTML = [
    ['repositories', data.repos.length, 'open-source and private'],
    ['full scans', allScans.length, `${kb(Math.min(...allScans.map((x) => x.kb)))}–${kb(Math.max(...allScans.map((x) => x.kb)))} of code each; the same code is often rescanned with another model or effort level to compare them`],
    ['triaged findings that were real', Math.round((100 * confirmedAll) / (confirmedAll + fpAll)) + '%', `${confirmedAll.toLocaleString()} of ${(confirmedAll + fpAll).toLocaleString()} triaged findings (out of ${totalFindings.toLocaleString()}). Mostly checked by Codex auto-triage, not by hand, so Codex findings may be judged leniently`],
    ...(() => {
      const full = new Set(allScans.map((s) => modelInfo(s.model).name));
      const calOnly = [...new Set(data.repos.flatMap((r) => r.inits.flatMap((i) => i.rows.map((x) => modelInfo(x.model).name))))].filter((m) => !full.has(m));
      return [['models compared', full.size + calOnly.length, `${[...full].join(', ')} in full scans${calOnly.length ? `; ${calOnly.join(' and ')} only on small calibration samples` : ''}`]];
    })(),
  ].map(([k, v, p]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><p>${p}</p></div>`).join('');

  // ---------- scatter: quality vs price
  function scatter(host, pts, { xLabel, yLabel, yMax = 1 }) {
    const W = 640, H = 300, L = 58, R = 120, T = 12, B = 36;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${yLabel} vs ${xLabel}` });
    const xMax = nice(Math.max(...pts.map((p) => p.x)) * 1.1);
    const X = (v) => L + (v / xMax) * (W - L - R), Y = (v) => T + (1 - v / yMax) * (H - T - B);
    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4;
      svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
      svgEl('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = v.toFixed(2);
      const xv = (xMax * i) / 4;
      svgEl('text', { x: X(xv), y: H - B + 16, 'text-anchor': 'middle' }, svg).textContent = '$' + xv.toFixed(2);
    }
    svgEl('line', { x1: L, x2: W - R, y1: Y(0), y2: Y(0), class: 'axis' }, svg);
    svgEl('text', { x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle' }, svg).textContent = xLabel;
    svgEl('text', { x: 14, y: (T + H - B) / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${(T + H - B) / 2})` }, svg).textContent = yLabel;
    for (const p of pts) {
      svgEl('circle', { cx: X(p.x), cy: Y(p.y), r: 6, fill: modelInfo(p.model).color, stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
      svgEl('text', { x: X(p.x) + 10, y: Y(p.y) + 4, class: 'lbl' }, svg).textContent = p.label || modelInfo(p.model).name;
      const hit = svgEl('circle', { cx: X(p.x), cy: Y(p.y), r: 14, class: 'hit' }, svg);
      bindTip(hit, p.tip);
    }
    host.appendChild(svg);
  }

  // ---------- benchmark
  const b = data.bench;
  if (b && $('bench-chart')) {
    const br = data.repos.find((r) => r.name === b.repo) || { name: b.repo };
    $('bench-desc').innerHTML = `${repoTitle(br)}${repoSrc(br)}: ${b.sampleKb}KB / ${b.lines.toLocaleString()} lines of Go with ${b.knownBugs} verified bugs
      (filed upstream) and ${b.distinctIssues} distinct issues found across all models. Each model at the chunk size its own calibration chose (${esc(b.date)}).`;
    scatter($('bench-chart'), b.rows.map((r) => ({ x: r.usdPer100Kb, y: r.quality, model: r.model,
      tip: `<b>${esc(modelInfo(r.model).name)}</b><br>quality ${f2(r.quality)} · ${r.bugsFound}/${b.knownBugs} known bugs<br>${usd(r.usdPer100Kb)}/100KB at ${r.chunkKb}KB chunks` })),
    { xLabel: '$ per 100KB reviewed', yLabel: 'quality' });
    $('bench-table').innerHTML = `<tr><th>model</th><th>chunk</th><th>known bugs</th><th>quality</th><th>$/100KB</th><th>$/1k lines</th><th>calibration $</th><th class="l">note</th></tr>` +
      b.rows.map((r) => `<tr><td>${sw(r.model)}</td><td>${r.chunkKb}KB</td><td>${r.bugsFound}/${b.knownBugs}</td><td>${f2(r.quality)}</td><td>${usd(r.usdPer100Kb)}</td><td>${usd(r.usdPer1kLoc)}</td><td>${usd(r.calibrationUsd)}</td><td class="l muted" style="white-space:normal">${esc(/rounds failed/.test(r.note || '') ? 'incomplete: reviewers stopped early' : r.note || '')}</td></tr>`).join('');
  }

  // ---------- head-to-head (provider page): severity each reviewer gave on the compared files
  const h2h = [];
  for (const r of data.repos) for (const c of r.compares) {
    h2h.push(`<h3>${repoLink(r)} <span class="muted">— ${kb(c.basisKb)} compared</span></h3>
      <div class="table-wrap"><table class="lab"><tr><th>model</th>${sevTh}<th>only this one</th></tr>` +
      c.scans.map((x) => `<tr><td class="l">${sw(x.model)}</td><td data-l="total"><b>${x.findings ?? '–'}</b></td>` + SEVS.map((k) => `<td data-l="${k}">${(x.severity && x.severity[k]) || 0}</td>`).join('') + `<td data-l="only this one">${x.unique}</td></tr>`).join('') +
      '</table></div>');
  }
  if ($('h2h-body')) $('h2h-body').innerHTML = h2h.join('') || '<p class="muted">No head-to-head scans yet.</p>';

  // ---------- calibration small multiples
  if ($('cal-charts')) (function () {
    const curveRepos = data.repos.filter((r) => r.curves.length);
    const seen = new Set();
    for (const r of curveRepos) {
      const W = 300, H = 170, L = 30, R = 10, T = 10, B = 26;
      const sizes = [...new Set(r.curves.flatMap((c) => c.rounds.map((x) => x.kb)))].sort((a, b) => a - b);
      const X = (v) => L + (sizes.indexOf(v) / Math.max(1, sizes.length - 1)) * (W - L - R);
      const Y = (v) => T + (1 - v) * (H - T - B);
      const box = document.createElement('div'); box.className = 'chart';
      const initIds = new Set(r.curves.map((c) => c.init).filter((x) => x != null));
      const sampleKb = initIds.size === 1 ? ((r.inits || []).find((i) => initIds.has(i.id)) || {}).sampleKb : null;
      box.innerHTML = `<h4>${repoTitle(r)}${repoSrc(r)}${sampleKb ? ` <span class="muted">· ${sampleKb}KB sample</span>` : ''}</h4>`;
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `calibration curves for ${r.name}` });
      for (const v of [0, 0.5, 1]) {
        svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
        svgEl('text', { x: L - 4, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = v.toFixed(1);
      }
      for (const s of sizes) svgEl('text', { x: X(s), y: H - 8, 'text-anchor': 'middle' }, svg).textContent = s + 'KB';
      for (const c of r.curves) {
        const col = modelInfo(c.model).color;
        seen.add(c.model);
        svgEl('polyline', { points: c.rounds.map((x) => `${X(x.kb)},${Y(x.score)}`).join(' '), fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
        for (const x of c.rounds) {
          const chosen = x.kb === c.resultKb;
          svgEl('circle', { cx: X(x.kb), cy: Y(x.score), r: chosen ? 5 : 3.5, fill: chosen ? col : 'var(--surface-1)', stroke: col, 'stroke-width': 2 }, svg);
          bindTip(svgEl('circle', { cx: X(x.kb), cy: Y(x.score), r: 10, class: 'hit' }, svg),
            `<b>${esc(modelInfo(c.model).name)}${c.effort ? ' ' + esc(c.effort) : ''}</b> at ${x.kb}KB<br>score ${f2(x.score)}${chosen ? ' · chosen' : ''}${c.decision ? `<br><span class="muted">${esc(c.decision)}</span>` : ''}`);
        }
      }
      box.appendChild(svg);
      const vals = document.createElement('details'); vals.className = 'muted';
      vals.innerHTML = `<summary>values</summary>` + r.curves.map((c) => `<div>${sw(c.model)} ${c.rounds.map((x) => (x.kb === c.resultKb ? `<b>${x.kb}KB ${f2(x.score)}</b>` : `${x.kb}KB ${f2(x.score)}`)).join(' · ')}</div>`).join('');
      box.appendChild(vals);
      $('cal-charts').appendChild(box);
    }
    $('cal-legend').innerHTML = MODELS.filter(([k]) => [...seen].some((m) => m.includes(k))).map(([k]) => `<span>${sw(k)}</span>`).join('') +
      '<span class="muted">filled dot = size calibration chose</span>';
  })();

  // ---------- init tables
  if ($('init-body')) $('init-body').innerHTML = data.repos.flatMap((r) => r.inits.map((i) => {
    // drop the price columns when the run recorded no prices at all
    const priced = i.rows.some((x) => x.usdPer100Kb != null || x.calibrationUsd != null);
    return `<h3>${repoTitle(r)}${repoSrc(r)} <span class="muted">— ${kb(i.sampleKb)} sample, ${i.issues} distinct issues (${esc(i.created)})${priced ? '' : ', prices not recorded'}</span></h3>
     <div class="table-wrap"><table><tr><th>model</th><th>chunk</th><th>quality</th><th>findings</th>${priced ? '<th>$/100KB</th><th>calibration $</th>' : ''}</tr>` +
    i.rows.sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1)).map((x) => `<tr><td>${withEffort(x.model, x.effort)}${x.status === 'done' ? '' : ` <span class="muted">(${esc(x.status)}, no result)</span>`}</td><td>${x.chunkKb ? x.chunkKb + 'KB' : '–'}</td><td><b>${x.status === 'done' ? f2(x.quality) : '–'}</b></td><td>${x.status === 'done' ? (x.findings ?? '–') : '–'}</td>${priced ? `<td>${usd(x.usdPer100Kb)}</td><td>${usd(x.calibrationUsd)}</td>` : ''}</tr>`).join('') +
    '</table></div>';
  })).join('');

  // ---------- triage: aggregated by triage setup (model, effective effort, findings per agent)
  if ($('triage-table')) {
    const groups = new Map();
    for (const t of data.repos.flatMap((r) => r.triage)) {
      const eff = t.effort || (t.runner === 'codex' ? 'high' : null);
      const key = t.model ? `${t.model}|${eff}|${t.groupSize}` : 'none';
      const g = groups.get(key) || groups.set(key, { model: t.model, eff, dflt: !t.effort && !!eff, groupSize: t.groupSize, repos: new Set(), findings: 0, v: {}, sev: 0, usd: 0, priced: 0 }).get(key);
      if (g.dflt && t.effort) g.dflt = false;
      g.findings += t.findings; g.sev += t.severityChanged;
      for (const [k, n] of Object.entries(t.verdicts)) g.v[k] = (g.v[k] || 0) + n;
      if (t.usd !== null) { g.usd += t.usd; g.priced += t.findings; }
    }
    const rows = [...groups.values()].sort((a, b) => (a.model ? 0 : 1) - (b.model ? 0 : 1) || b.findings - a.findings);
    const share = (n, of, pct = true) => (pct ? `${n} <span class="muted">${Math.round((100 * n) / of)}%</span>` : `${n}`);
    $('triage-table').innerHTML = `<tr><th class="l">triage model, effort</th><th>per agent</th><th>findings</th><th>real</th><th>false pos.</th><th>unsure</th><th>sev. changed</th><th>$/finding</th></tr>` +
      rows.map((g) => `<tr${g.model ? '' : ' class="muted"'}><td class="l">${g.model ? `${esc(modelInfo(g.model).name)} <span class="muted">${esc(g.eff + (g.dflt ? ' (default)' : ''))}</span>` : '<span class="muted">model not recorded</span>'}</td><td data-l="per agent">${g.groupSize}</td><td data-l="findings">${g.findings}</td><td data-l="real">${share((g.v.real || 0) + (g.v.wontfix || 0), g.findings, !!g.model)}</td><td data-l="false pos.">${g.v.false_positive || 0}</td><td data-l="unsure">${g.v.unsure || 0}</td><td data-l="sev. changed">${share(g.sev, g.findings, !!g.model)}</td><td data-l="$/finding">${g.priced ? '$' + (g.usd / g.priced).toFixed(3) : '–'}</td></tr>`).join('');
    const all = rows.reduce((a, g) => ({ n: a.n + g.findings, real: a.real + (g.v.real || 0) + (g.v.wontfix || 0), fp: a.fp + (g.v.false_positive || 0), usd: a.usd + g.usd, priced: a.priced + g.priced }), { n: 0, real: 0, fp: 0, usd: 0, priced: 0 });
    if ($('triage-summary')) $('triage-summary').innerHTML = `Agents triaged ${all.n.toLocaleString()} distinct findings (each once, however many scans reported it) and rejected only ${all.fp} as false positives (${Math.round((100 * all.real) / all.n)}% judged real). <b>Triage rarely rejects anything, so this ${Math.round((100 * all.real) / all.n)}% and the precision on other pages are upper bounds, not measured false-positive rates.</b> Severity changed on ${Math.round((100 * rows.reduce((n, g) => n + g.sev, 0)) / all.n)}%. Triage cost about $${(all.usd / all.priced).toFixed(3)} per finding where cost was recorded. Verdicts are an agent's judgement after reading the code, not reproduced bugs.`;
  }

  // ---------- languages
  const LANGS = { go: ['Go'], rust: ['Rust'], 'c++': ['C++'], 'ts+rust': ['TypeScript', 'Rust'], ts: ['TypeScript'], js: ['JavaScript'], java: ['Java'], 'c#': ['C#'] };
  const langsOf = (r) => LANGS[r.lang] || (r.lang ? [r.lang] : []);
  const langNames = [...new Set(data.repos.flatMap(langsOf))].sort();
  if ($('method-scope')) {
    const scans = data.repos.flatMap((r) => r.scans);
    const sizes = scans.map((x) => x.kb);
    const nF = scans.reduce((n, x) => n + x.findings, 0), nT = scans.reduce((n, x) => n + x.triaged, 0);
    $('method-scope').textContent = `${data.repos.length} repositories (${langNames.join(', ')}), ${scans.length} full scans of ${kb(Math.min(...sizes))}–${kb(Math.max(...sizes))} of code each, ${nF.toLocaleString()} findings, counted once per scan (a bug two scans both reported counts twice).`;
    const setT = (id, t) => { if ($(id)) $(id).textContent = t; };
    setT('method-verdicts', `${nT.toLocaleString()} of the ${nF.toLocaleString()} findings (${Math.round((100 * nT) / nF)}%) have a real or false-positive verdict, mostly from agent triage (below), some by hand. The rest are untriaged, unsure or duplicates (marked during triage as a repeat of another finding), and are left out of precision, confirmed counts and recall.`);
    const perM = new Map();
    for (const x of scans) { const m = modelInfo(x.model).name; perM.set(m, (perM.get(m) || 0) + 1); }
    const sampled = [...new Set([...data.repos.flatMap((r) => r.inits.flatMap((i) => i.rows)), ...((data.bench && data.bench.rows) || [])].filter((x) => x.status !== 'failed').map((x) => modelInfo(x.model).name))].filter((m) => !perM.has(m));
    setT('method-permodel', `${[...perM].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${n} ${m}`).join(', ')}${sampled.length ? `; ${sampled.join(' and ')} ran only on samples (Pick a model)` : ''}. ${scans.filter((x) => x.effort).length} of the ${scans.length} set an explicit effort level; the rest ran at the default.`);
    const noP = scans.filter((x) => x.usd === null).length;
    if ($('method-noprice') && noP) $('method-noprice').textContent = `${noP} of ${scans.length} scans show no price because their transcripts are lost or incomplete.`;
  }
  const reposOf = (L) => data.repos.filter((r) => L === 'any' || langsOf(r).includes(L));
  const family = (m) => modelInfo(m).name;
  const range = (xs, fmt) => { xs = xs.filter((v) => v !== null && v !== undefined); if (!xs.length) return '–'; const a = Math.min(...xs), b = Math.max(...xs); return a === b ? fmt(a) : `${fmt(a)}–${fmt(b)}`; };
  const langOf = (r) => langsOf(r).join(' + ') || '?';
  // where = language and size first; the repository name is secondary
  const where = (r, what) => `<b>${esc(langOf(r))}</b>, ${what} <span class="muted">(${r.url || !/^private/.test(r.name) ? repoLink(r) : 'private repository'})</span>`;
  // no recorded effort: Codex ran at its CLI default (high); Claude ran without an effort setting
  const effTag = (s) => (s && s.effort ? ` <code>${esc(s.effort)}</code>` : family(s && s.model) === 'Codex gpt-6.1-sol' ? ' <span class="muted">CLI default (<code>high</code>)</span>' : ' <span class="muted">default effort (level not recorded)</span>');
  function evidence(L) {
    const items = [], cals = [], single = [];
    let compared = false, cal = 0;
    for (const r of reposOf(L)) {
      for (const c of r.compares) {
        compared = true;
        const [a, b] = c.scans.slice().sort((x, y) => y.share - x.share);
        const sa = r.scans.find((s) => s.id === a.id && s.store === c.store) || {}, sb = r.scans.find((s) => s.id === b.id && s.store === c.store) || {};
        const part = sa.kb && sb.kb && (sa.kb !== c.basisKb || sb.kb !== c.basisKb);
        const at = (x) => (x.usdPer100Kb ? `, ${usd(x.usdPer100Kb)}/100KB${part ? ` <span class="muted">(whole ${kb(x.kb)} scan)</span>` : ''}` : ', <span class="muted">price not recorded</span>');
        const conf = (x) => ` <span class="muted">(${x.confirmed} confirmed)</span>`;
        const span = part ? `compared on the ${kb(c.basisKb)} both full scans covered` : `two full scans of the same ${kb(c.basisKb)}`;
        items.push(`${where(r, span)}: share of issues found — ${sw(a.model)}${effTag(sa)} <b>${f2(a.share)}</b>${conf(a)}${at(sa)} vs ${sw(b.model)}${effTag(sb)} ${f2(b.share)}${conf(b)}${at(sb)}`);
      }
      for (const i of r.inits) {
        compared = true; cal++;
        const rows = i.rows.filter((x) => x.status === 'done').sort((x, y) => y.quality - x.quality);
        const priced = rows.some((x) => x.usdPer100Kb != null);
        cals.push(`${where(r, `${kb(i.sampleKb)} calibration sample`)}: calibration score — ${rows.map((x) => `${sw(x.model)} ${f2(x.quality)}${x.usdPer100Kb != null ? ` <span class="muted">at ${usd(x.usdPer100Kb)}/100KB</span>` : ''}`).join(', ')} <span class="muted">(${rows.every((x) => !x.effort) ? 'default effort, level not recorded' : 'effort as listed'}${priced ? '; one run per model on a small sample, so prices are rough' : '; prices not recorded'})</span>`);
      }
      for (const e of r.efforts || []) {
        compared = true;
        const best = (m) => e.rows.filter((x) => family(x.model) === m).sort((x, y) => y.confirmedRecall - x.confirmedRecall)[0];
        const cx = best('Codex gpt-6.1-sol'), op = best('Opus 5.5');
        const opHigh = op.effort !== 'high' && e.rows.find((x) => family(x.model) === 'Opus 5.5' && x.effort === 'high');
        items.push(`${where(r, `effort study, ${e.rows.length} full scans of the same ${kb(e.basisKb)}`)}: recall — best ${sw(cx.model)} <code>${esc(cx.effort)}</code> <b>${f2(cx.confirmedRecall)}</b> at ${usd(cx.usdPer100Kb)}/100KB; best ${sw(op.model)} <code>${esc(op.effort)}</code> ${f2(op.confirmedRecall)} at ${usd(op.usdPer100Kb)}/100KB${opHigh ? ` (Opus <code>high</code>: ${f2(opHigh.confirmedRecall)} at ${usd(opHigh.usdPer100Kb)}/100KB)` : ''}`);
      }
      // scans with no head-to-head partner; precision only when at least a fifth of the findings were triaged
      const paired = (s) => r.compares.some((c) => c.store === s.store && c.scans.some((x) => x.id === s.id)) || (r.efforts || []).some((e) => e.rows.some((x) => x.id === s.id));
      for (const s of r.scans.filter((x) => !paired(x))) {
        const pr = s.findings && s.triaged / s.findings >= 0.2 ? `precision ${f2(s.precision)} on ${s.triaged} triaged of ${s.findings} findings`
          : `only ${s.triaged} of ${s.findings} findings triaged, too few for a precision figure`;
        const self = family(s.model) === 'Codex gpt-6.1-sol' && s.triaged / s.findings >= 0.2 ? ' <span class="muted">(triaged mostly by Codex auto-triage, so precision may be overstated)</span>' : '';
        const early = (r.efforts || []).some((e) => e.basisKb === s.kb && e.rows.every((x) => x.id > s.id)) ? ' <span class="muted">(earlier scan, not part of the effort study)</span>' : '';
        single.push(`${where(r, kb(s.kb))}: ${sw(s.model)}${effTag(s)}${early} — ${pr}${self}${s.usdPer100Kb ? `, ${usd(s.usdPer100Kb)}/100KB` : ', <span class="muted">price not recorded</span>'}`);
      }
    }
    if (L !== 'any' && data.bench && L === 'Go') cals.push(`<b>Go</b>, ${kb(data.bench.sampleKb)} known-bug benchmark <span class="muted">(gocql)</span>: known bugs found — ${data.bench.rows.map((x) => `${sw(x.model)} ${x.bugsFound}/${data.bench.knownBugs}${x.usdPer100Kb != null ? ` <span class="muted">at ${usd(x.usdPer100Kb)}/100KB</span>` : ''}`).join(', ')} <span class="muted">(default effort, level not recorded)</span>`);
    return { items, cals, single, compared, cal };
  }
  function chunkFor(L, model, short) {
    const cs = reposOf(L).flatMap((r) => r.curves.filter((c) => family(c.model) === family(model) && c.resultKb).map((c) => (short ? `${c.resultKb}KB` : `${c.resultKb}KB on ${r.name.replace(/^scylladb\//, '')}`)));
    return cs.length ? [...new Set(cs)].join(short ? ' / ' : ', ') : null;
  }
  const SHORT = { 'Codex gpt-6.1-sol': 'Codex', 'Opus 5.5': 'Opus', 'Fable 5.2': 'Fable', 'Sonnet 5.5': 'Sonnet', 'Haiku 5.5': 'Haiku' };
  // price ranges use the levels the guide recommends, not every level of the effort study
  const atRecommended = (s) => !s.effort || (family(s.model) === 'Codex gpt-6.1-sol' ? s.effort === 'xhigh' : s.effort === 'medium');

  // ---------- goal picker
  const CX = 'codex:gpt-6.1-sol', OP = 'claude-opus-5-5';
  const GOALS = {
    value: { title: 'Codex gpt-6.1-sol at <code>xhigh</code>', runs: [['codex-xhigh', CX, 'xhigh']],
      why: 'In the effort study it reached recall 0.40 at $0.75/100KB, against 0.31 at $0.43 for the CLI default <code>high</code>; <code>max</code> added only 0.01 (0.41) for $0.86, so <code>xhigh</code> is the better buy.</p><p>Against Claude: Codex had the higher severity-weighted share in all 4 head-to-head comparisons (Go, Rust, C++ full scans and this effort study), but Rust was close (0.59 vs 0.55 for Fable). In the Go, Rust and C++ scans Claude ran at its default effort, whose level was not recorded. By raw count Claude confirmed more twice, mostly lower-severity bugs: Fable on Rust (62 vs 47) and Opus <code>max</code> here (85 vs 78 for Codex <code>max</code>).' },
    most: { title: 'Codex <code>xhigh</code> + Opus <code>max</code>, side by side', runs: [['codex-xhigh', CX, 'xhigh'], ['opus-max', OP, 'max']], recall: '0.66', price: '$6.64', perBug: '$0.46', time: '45.0',
      why: 'No single run found more than 41% of the confirmed issues; two different reviewers overlap little. Cheaper pair: Codex <code>high</code> + <code>xhigh</code>, recall 0.49 at $1.18/100KB.' },
    cheap: { title: 'Codex gpt-6.1-sol at <code>medium</code>', runs: [['codex-medium', CX, 'medium']],
      why: 'The cheapest level that still finds a useful share; <code>low</code> saves $0.06/100KB but drops recall to 0.17. Precision is the same at every level.' },
  };
  // the same goals when only Claude models may be used
  const CLAUDE = {
    value: { title: 'Opus 5.5 at <code>medium</code>', runs: [['opus-medium', OP, 'medium']],
      why: 'Opus at low, medium and high found about the same (recall 0.12–0.17); medium costs $0.28 per confirmed bug, about the same as <code>low</code> ($0.27), and finds a little more. Fable 5.2 scored higher on 2 of 3 small samples (not on the private Go one) at ~2× Opus\'s price; run <code>/code-scan:init</code> to compare them on your code.' },
    most: { title: 'Opus 5.5 at <code>max</code>', runs: [['opus-max', OP, 'max']],
      why: 'The most any single Claude run found (recall 0.35), at about 5× the price of <code>high</code> ($5.89 vs $1.20/100KB).' },
    cheap: { title: 'Opus 5.5 at <code>low</code>', runs: [['opus-low', OP, 'low']],
      why: 'The cheapest Claude level measured ($0.78/100KB); <code>medium</code> finds a little more (recall 0.15 vs 0.12) for $1.01.' },
  };
  GOALS.quick = { title: 'Opus 5.5 at <code>low</code>', runs: [['opus-low', OP, 'low']],
    why: 'Opus reviewers finish 6–14× faster than Codex per 100KB: the 995KB effort-study scan took 4 minutes of wall clock at <code>low</code> against 53 for Codex <code>xhigh</code>. You trade recall for it (0.12 vs 0.40). Fastest Codex level: <code>low</code>, 10.2 agent-min/100KB, recall 0.17.' };
  const NOTES = {
    'Go|claude': 'On Go, Opus found 7/7 known gocql bugs and scored highest (0.74) on the private Go sample, but Fable scored higher on the gocql sample (0.49 vs 0.29): the Claude ranking depends on the codebase. Sonnet came close on the private sample (0.68 at $0.31/100KB) but found only 4/7 known bugs.',
    'Go|value': 'On gocql Codex found share 0.76 vs Fable 0.43 on the same 1.4MB.',
    'C++|claude': 'On the seastar sample Fable scored highest (0.65 vs Opus 0.48) at about twice Opus\'s price; Sonnet scored 0.09 — avoid it on C++.',
    'C++|value': 'On seastar Codex had share 0.81 vs Opus 0.29.',
    'Rust|value': 'On scylla-rust-driver Codex and Fable had similar shares (0.59 vs 0.55); Fable confirmed more bugs (62 vs 47, about half of them low severity) but cost about 7× as much.',
    'Rust|claude': 'Opus and Fable were never compared on the same Rust code: each scanned a different part of scylla-rust-driver, Fable at $1.93/100KB and Opus at $0.40.',
  };
  function renderPick() {
    const L = $('pick-lang').value, G = $('pick-goal').value, claudeOnly = $('pick-claude').checked;
    const g = (claudeOnly && CLAUDE[G]) || GOALS[G];
    const ev = evidence(L);
    // card figures come from the effort study rows of the recommended runs
    const study = data.repos.flatMap((r) => (r.efforts || []).map((e) => ({ r, e })))[0];
    const rowOf = ([, m, eff]) => study && study.e.rows.find((x) => family(x.model) === family(m) && x.effort === eff);
    const rs = g.runs.map(rowOf).filter(Boolean);
    const one = g.runs.length === 1 ? rs[0] : null;
    const f = one ? { recall: f2(one.confirmedRecall), price: usd(one.usdPer100Kb), perBug: usd(one.usdPerConfirmed), time: (one.agentMinutes / study.e.basisKb * 100).toFixed(1), precision: f2(one.precision) }
      : { recall: g.recall, price: g.price, perBug: g.perBug, time: g.time, precision: range(rs.map((x) => x.precision), f2) };
    const wall = one ? ((study.r.scans.find((s) => s.id === one.id) || {}).wallMinutes ?? null) : null;
    const triager = study ? esc(String(study.e.triagedBy).replace(/\s*\((\d+) findings confirmed earlier by hand\)/, ', plus $1 confirmed by hand')) : '';
    const src = study ? `<p class="note"><b>Caveats:</b> Codex judged its own findings here, so Codex precision may be overstated. Wall clock is from this one run, whose <code>--concurrency</code> was not recorded; yours at the default of 10 may differ. Source: one effort study, ${study.e.rows.length} full scans of the same ${kb(study.e.basisKb)} of ${esc(langOf(study.r))}${g.runs.length > 1 ? ', both runs added together' : ''}.</p>
      <details class="defs note"><summary>What each figure means</summary><dl>
        <dt>Recall</dt><dd>severity-weighted share of the ${study.e.confirmedIssues} confirmed issues all runs found together</dd>
        <dt>Per 100KB</dt><dd>API list price of every token every agent used (code, preamble, coordination; cached input at the cache-read rate), same basis for Codex and Claude</dd>
        <dt>Per confirmed bug</dt><dd>price ÷ confirmed findings (checked by ${triager})</dd>
        <dt>Wall clock</dt><dd>start to finish of this run; reviewers busy = agent-minutes ÷ wall clock</dd>
        <dt>Agent-minutes</dt><dd>agent time summed across parallel reviewers</dd>
        <dt>Precision</dt><dd>confirmed ÷ (confirmed + false positives)</dd>
      </dl></details>` : '';
    const studyLangs = study ? langsOf(study.r) : [];
    const offLang = study && L !== 'any' && !studyLangs.includes(L)
      ? `<p class="warn">These figures were measured on ${esc(langOf(study.r))} code; there is no effort study on ${L === 'other' ? 'other languages' : esc(L)}.</p>` : '';
    const note = NOTES[`${L}|${claudeOnly ? 'claude' : G}`] || (L !== 'any' && !ev.compared ? `No two models were compared on ${esc(L)} yet, so this is the general recommendation. Run <code>/code-scan:init</code> to compare models on your own repository.` : '');
    const chunks = g.runs.map(([, m]) => {
      if (m.startsWith('codex:')) return `${sw(m)}: 40KB, set by <code>--chunk-kb 40</code> below. Every Codex scan here used it; other sizes are untested`;
      const c = chunkFor(L, m) || chunkFor('any', m);
      return `${sw(m)}: <code>/code-scan:scan</code> calibrates it on the first scan of a repository; the bare CLI uses 40KB${c ? ` (calibrated before: ${esc(c)})` : ''}`;
    });
    const cmds = g.runs.map(([n, m, e]) => `code-scan.js profile register ${n} --prompt default --model ${m} --effort ${e}${m.startsWith('codex:') ? ' --chunk-kb 40' : ''}`).join('\n') +
      `\ncode-scan.js start --profile ${g.runs.map(([n]) => n).join(',')}\n# start only plans the scan; run the RUN line it prints to launch the reviewers`;
    $('pick-out').innerHTML = `<div class="setup">
      <h3>${g.title}${L === 'any' ? '' : ev.compared ? '<span class="badge strong">models compared on this language</span>' : '<span class="badge">general recommendation</span>'}</h3>
      ${offLang}<p>${g.why}</p>${note ? `<p>${note}</p>` : ''}
      <div class="facts"><div><b>${f.recall}</b>recall</div><div><b>${f.price}</b>per 100KB of code</div><div><b>${f.perBug}</b>per confirmed bug</div>${wall !== null ? `<div><b>${wall} min</b>wall clock for the whole ${kb(study.e.basisKb)} scan (≈${Math.round(one.agentMinutes / wall)} reviewers busy on average)</div>` : ''}<div><b>${f.time}</b>agent-minutes per 100KB (summed over reviewers)</div><div><b>${f.precision}</b>precision</div></div>
      ${src}
      <p class="muted" style="margin:4px 0">Chunk size</p><ul>${chunks.map((c) => `<li>${c}</li>`).join('')}</ul>
      <p class="muted" style="margin:4px 0">Commands: run in the repository you scan; <code>code-scan.js</code> is <code>node &lt;code-scan dir&gt;/bin/code-scan.js</code> (the plugin's or your clone's). Or ask <code>/code-scan:scan</code> in Claude Code to run this setup for you.</p>
      <pre><code>${esc(cmds)}</code></pre>
      <h4>Codex vs Claude, full scans compared on the code both covered — ${L === 'any' ? 'all languages' : esc(L)}</h4>
      <p class="note"><b>Compare models within a row, not across rows:</b> each row uses its own severity-weighted measure.</p>
      <details class="defs note"><summary>What each measure means</summary><dl>
        <dt>Share of issues found</dt><dd>share of all distinct issues either scan found; issues both found count for both, so two shares can sum above 1</dd>
        <dt>Calibration score</dt><dd>the same, on a small sample every Claude model reviewed</dd>
        <dt>Recall</dt><dd>share of the effort study's confirmed issues</dd>
        <dt>$/100KB</dt><dd>API list price of all agent tokens, same basis for every model</dd>
      </dl></details>
      <ul>${ev.items.map((x) => `<li>${x}</li>`).join('') || '<li class="muted">No Codex-vs-Claude full scans on this language yet.</li>'}</ul>
      ${ev.cals.length ? `<h4>Claude models against each other, small samples</h4><ul>${ev.cals.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}${ev.cal ? '<p class="note">The Claude order changes from one codebase to another, so run <code>/code-scan:init</code> on your own repository to pick a Claude model.</p>' : ''}
      ${ev.single.length ? `<details><summary class="muted">Scans without a head-to-head comparison (${ev.single.length})</summary><ul>${ev.single.map((x) => `<li>${x}</li>`).join('')}</ul></details>` : ''}</div>`;
  }
  if ($('pick-lang')) {
    $('pick-lang').innerHTML = `<option value="any">Any language</option>` + langNames.map((l) => `<option>${esc(l)}</option>`).join('') + '<option value="other">Other</option>';
    for (const id of ['pick-lang', 'pick-goal', 'pick-claude']) $(id).addEventListener('change', renderPick);
    renderPick();
  }

  // ---------- configuration explorer
  if ($('ex-table')) (function () {
    const per100 = (v, s) => (v === null || v === undefined || !s.kb ? null : (v / s.kb) * 100);
    const sev = (o, k) => (o && o[k]) || 0;
    const fpRate = (s) => (s.confirmed + s.falsePositive ? s.falsePositive / (s.confirmed + s.falsePositive) : null);
    const n1 = (v) => (v === null || v === undefined ? '–' : v.toFixed(1));
    const pct = (v) => (v === null || v === undefined ? '–' : (v * 100).toFixed(1) + '%');
    const int = (v) => (v === null || v === undefined ? '–' : String(v));
    const mins = (v) => (v === null || v === undefined ? '–' : v >= 90 ? (v / 60).toFixed(1) + ' h' : Math.round(v) + ' min');
    // a scan with many untriaged findings under-counts confirmed: flag it and sort it last on confirmed-based columns
    const SHAKY = 0.1;
    const shaky = (s) => s.findings > 0 && s.untriaged / s.findings > SHAKY;
    const CONF_COLS = ['conf', 'cHigh', 'confPer100', 'usdConf', 'fpRate'];
    // unique between scans at different commits partly reflects code changes, not the models
    const uniqApprox = (s) => s.unique != null && s.repo.scans.some((o) => o.unique != null && o.commit !== s.commit);
    // the number of scans compared against goes in the repository row when it is the same for all of them
    const uniqN = (r) => { const n = new Set(r.scans.map((s) => s.uniqueAgainst).filter((v) => v != null)); return n.size === 1 ? [...n][0] : null; };
    const uniqFmt = (v, s) => (v === null || v === undefined ? '–' : `${uniqApprox(s) ? '≈' : ''}${v}${uniqN(s.repo) == null ? ` <span class="muted">of ${s.uniqueAgainst} other scans</span>` : ''}`);
    // why a scan has no unique count although its repository has others
    const uniqMissing = (s) => (s.unique == null && s.repo.scans.some((o) => o.unique != null) ? (s.repo.scans.some((o) => o.unique != null && o.commit !== s.commit) ? 'Not compared: this scan ran at a different commit from the others' : 'Not compared with the other scans') : null);
    const isCodex = (m) => family(m) === 'Codex gpt-6.1-sol';
    const effLabel = (s) => s.effort || (isCodex(s.model) ? 'default (high)' : 'default');
    const langOfRepo = (r) => langsOf(r).join(' + ') || '?';
    // placeholder names like 'private project A (go)' already carry the language, which the explorer shows separately
    const exName = (r) => r.name.replace(/ \([a-z+#]+\)$/, '');
    const exLink = (r) => (r.url ? repoLink(r) : esc(exName(r)));
    // id, header, group, value, format(v, s), views, plottable, definition
    const COLS = [
      ['kb', 'code', '', (s) => s.kb, kb, ['findings', 'cost', 'all'], 0, 'Code reviewed by this scan'],
      ['chunk', 'chunk', '', (s) => s.chunkKb ?? null, (v) => (v == null ? '–' : v + 'KB'), ['cost', 'all'], 0, 'Code given to each reviewer agent at once; smaller chunks mean more agents and more repeated preamble tokens'],
      ['findings', 'findings', 'findings reported', (s) => s.findings, int, ['overview', 'findings', 'all'], 1, 'Findings the scan reported'],
      ['crit', 'critical', 'findings reported', (s) => sev(s.severity, 'critical'), int, ['findings', 'all'], 1, 'Reported findings the reviewer itself graded critical; triage may re-grade them (see the conf. columns)'],
      ['high', 'high', 'findings reported', (s) => sev(s.severity, 'high'), int, ['findings', 'all'], 1, 'Reported findings the reviewer itself graded high; triage may re-grade them (see the conf. columns)'],
      ['med', 'medium', 'findings reported', (s) => sev(s.severity, 'medium'), int, ['findings', 'all'], 1, 'Reported findings the reviewer itself graded medium; triage may re-grade them (see the conf. columns)'],
      ['low', 'low', 'findings reported', (s) => sev(s.severity, 'low'), int, ['findings', 'all'], 1, 'Reported findings the reviewer itself graded low; triage may re-grade them (see the conf. columns)'],
      ['conf', 'confirmed', 'after triage', (s) => s.confirmed, int, ['overview', 'findings', 'all'], 1, 'Findings triage confirmed as real; untriaged findings count as not confirmed'],
      ['cHigh', 'conf. crit+high', 'after triage', (s) => sev(s.confirmedSeverity, 'critical') + sev(s.confirmedSeverity, 'high'), int, ['findings', 'all'], 1, 'Confirmed critical and high findings, at the severity triage assigned'],
      ['cLow', 'conf. low', 'after triage', (s) => sev(s.confirmedSeverity, 'low'), int, ['findings', 'all'], 1, 'Confirmed low findings, at the severity triage assigned'],
      ['confPer100', 'confirmed /100KB', 'after triage', (s) => per100(s.confirmed, s), n1, ['overview', 'all'], 1, 'Confirmed findings per 100KB of code'],
      ['fp', 'false pos.', 'after triage', (s) => s.falsePositive, int, ['findings', 'all'], 1],
      ['fpRate', 'false-pos. rate', 'after triage', fpRate, pct, ['overview', 'findings', 'all'], 1, 'False positives / triaged findings'],
      ['untri', 'untriaged', 'after triage', (s) => s.untriaged, int, ['overview', 'findings', 'all'], 1, 'Findings nobody has triaged yet'],
      ['uniq', 'unique', 'vs other scans', (s) => s.unique ?? null, uniqFmt, ['overview', 'findings', 'all'], 1, 'Reported findings (confirmed or not) that no other scan of the same repository found, on files both reviewed; the repository row says how many other scans it was compared against; ≈ = the scans ran at different commits, so some differences come from changed code'],
      ['uniqConf', 'unique confirmed', 'vs other scans', (s) => s.uniqueConfirmed ?? null, int, ['findings', 'all'], 1, 'Unique findings that triage confirmed'],
      ['usd', '$ total', 'price', (s) => s.usd, usd, ['cost', 'all'], 1, 'List price of every token of every reviewer agent'],
      ['usd100', '$/100KB', 'price', (s) => s.usdPer100Kb, usd, ['overview', 'cost', 'all'], 1, 'Total price per 100KB of code'],
      ['usdConf', '$/confirmed', 'price', (s) => s.usdPerConfirmed, usd, ['overview', 'cost', 'all'], 1, 'Total price / confirmed findings'],
      ['agent', 'reviewer time', 'time', (s) => s.agentMinutes, mins, ['cost', 'all'], 1, 'Summed time of all reviewer agents'],
      ['agent100', 'reviewer min /100KB', 'time', (s) => s.agentMinPer100Kb, n1, ['overview', 'cost', 'all'], 1, 'Summed reviewer-agent minutes per 100KB of code'],
      ['wall', 'wall clock', 'time', (s) => s.wallMinutes, mins, ['cost', 'all'], 1, 'Elapsed time with at least one reviewer working'],
      ['wall100', 'wall min /100KB', 'time', (s) => per100(s.wallMinutes, s), n1, ['cost', 'all'], 1, 'Elapsed minutes per 100KB; depends on how many reviewers ran in parallel'],
    ];
    const rows = allScans.map((s) => ({ s, lang: langsOf(s.repo) }));
    const fill = (id, opts) => { $(id).innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''); };
    const repoOrder = data.repos.slice().sort((a, b) => b.scans.length - a.scans.length || a.name.localeCompare(b.name));
    fill('ex-repo', [['any', 'Any repository'], ...repoOrder.map((r) => [r.name, `${exName(r)} (${langOfRepo(r)}, ${r.scans.length} scan${r.scans.length > 1 ? 's' : ''})`])]);
    // a mixed-language repository matches each of its languages; say so in the option
    fill('ex-lang', [['any', 'Any language'], ...langNames.map((l) => { const mixed = data.repos.filter((r) => langsOf(r).length > 1 && langsOf(r).includes(l)).map(langOfRepo); return [l, mixed.length ? `${l} (incl. ${[...new Set(mixed)].join(', ')})` : l]; })]);
    const fams = [...new Set(allScans.map((s) => family(s.model)))].sort();
    fill('ex-model', [['any', 'Any model'], ...fams.map((f) => [f, f])]);
    const ORD = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const effs = [...new Set(allScans.map((s) => s.effort || ''))].sort((a, b) => ORD.indexOf(a) - ORD.indexOf(b));
    fill('ex-effort', [['any', 'Any effort'], ...effs.map((e) => [e || 'default', e || 'not set (tool default)'])]);
    const plot = COLS.filter((c) => c[6]);
    fill('ex-x', plot.map((c) => [c[0], c[1]]));
    fill('ex-y', plot.map((c) => [c[0], c[1]]));
    $('ex-x').value = 'usd100'; $('ex-y').value = 'confPer100';
    fill('ex-chart-repo', [...repoOrder.map((r) => [r.name, `${exName(r)} (${r.scans.length} scan${r.scans.length > 1 ? 's' : ''})`]), ['any', 'All repositories (not comparable)']]);
    $('ex-chart-repo').value = repoOrder[0].name;
    let sortK = 'natural', asc = true;
    // natural order: model, then effort low→ultra (unset effort last)
    const natural = (a, b) => family(a.s.model).localeCompare(family(b.s.model)) || ((ORD.indexOf(a.s.effort) + 1 || 99) - (ORD.indexOf(b.s.effort) + 1 || 99));
    const filtered = () => rows.filter(({ s, lang }) => {
      const P = $('ex-repo').value, L = $('ex-lang').value, M = $('ex-model').value, E = $('ex-effort').value;
      return (P === 'any' || s.repo.name === P) && (L === 'any' || lang.includes(L)) && (M === 'any' || family(s.model) === M) && (E === 'any' || (s.effort || 'default') === E);
    });
    function render() {
      const view = $('ex-view').value;
      const cols = COLS.filter((c) => c[5].includes(view));
      const col = COLS.find((c) => c[0] === sortK);
      const flagSort = col && CONF_COLS.includes(col[0]);
      const list = filtered().slice().sort((a, b) => {
        if (!col) return asc ? natural(a, b) : natural(b, a);
        if (flagSort && shaky(a.s) !== shaky(b.s)) return shaky(a.s) ? 1 : -1;
        const x = col[3](a.s), y = col[3](b.s);
        if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1;
        return asc ? x - y : y - x;
      });
      // rows grouped by repository: numbers only compare within one
      const byRepo = new Map();
      for (const it of list) { if (!byRepo.has(it.s.repo)) byRepo.set(it.s.repo, []); byRepo.get(it.s.repo).push(it); }
      const repos = [...byRepo.keys()].sort((a, b) => byRepo.get(b).length - byRepo.get(a).length || a.name.localeCompare(b.name));
      const groups = [];
      // g0: first column of each group, drawn with a left border so the group spans are visible
      const g0 = new Set();
      for (const c of cols) { const g = groups[groups.length - 1]; if (g && g.name === c[2]) g.n++; else { groups.push({ name: c[2], n: 1 }); g0.add(c[0]); } }
      const head1 = `<tr><th class="sticky"></th>${groups.map((g) => `<th class="grp" colspan="${g.n}">${esc(g.name)}</th>`).join('')}</tr>`;
      const head2 = `<tr><th class="l sticky${sortK === 'natural' ? ' sorted asc' : ''}" data-k="natural" title="Sort by model, then effort low → ultra, unset (tool default) last">model · effort</th>${cols.map((c) => `<th data-k="${c[0]}"${c[7] ? ` title="${esc(c[7])}"` : ''} class="${g0.has(c[0]) ? 'g0 ' : ''}${c[0] === sortK ? 'sorted' + (asc ? ' asc' : '') : ''}">${esc(c[1])}</th>`).join('')}</tr>`;
      const cell = (c, s) => {
        const v = c[4](c[3](s), s), flag = CONF_COLS.includes(c[0]) && shaky(s) && c[3](s) !== null && c[3](s) !== undefined;
        const body = c[0] === 'findings' || c[0] === 'conf' ? `<b>${v}</b>` : v;
        const miss = c[0].startsWith('uniq') && uniqMissing(s);
        const g = g0.has(c[0]) ? ' class="g0"' : '';
        if (miss) return `<td${g} title="${esc(miss)}">–${/commit/.test(miss) ? ' <span class="muted">other commit</span>' : ''}</td>`;
        return flag ? `<td class="shaky${g ? ' g0' : ''}" title="${Math.round((100 * s.untriaged) / s.findings)}% of findings untriaged">${body}*</td>` : `<td${g}>${body}</td>`;
      };
      const repoRow = (r, items) => {
        const sizes = [...new Set(items.map(({ s }) => s.kb))], commits = new Set(items.map(({ s }) => s.commit));
        const size = sizes.length === 1 ? kb(sizes[0]) : `${kb(Math.min(...sizes))}–${kb(Math.max(...sizes))}`;
        return `<tr class="repo"><td class="l" colspan="${cols.length + 1}"><span class="in"><b>${esc(langOfRepo(r))}</b> · ${exLink(r)} · ${size}${commits.size > 1 ? ' <span class="muted">(scans at different commits)</span>' : ''}${cols.some((c) => c[0].startsWith('uniq')) && uniqN(r) != null ? ` <span class="muted">· unique = found by none of the ${uniqN(r)} other scan${uniqN(r) > 1 ? 's' : ''} compared</span>` : ''}</span></td></tr>`;
      };
      $('ex-table').innerHTML = head1 + head2 + repos.map((r) => repoRow(r, byRepo.get(r)) + byRepo.get(r).map(({ s }) =>
        `<tr><td class="l sticky"><span class="m-long"><span class="swatch" style="background:${modelInfo(s.model).color}"></span>${esc(modelInfo(s.model).name)}</span><span class="m-short" title="${esc(modelInfo(s.model).name)}"><span class="swatch" style="background:${modelInfo(s.model).color}"></span>${esc(SHORT[family(s.model)] || modelInfo(s.model).name)}</span> <span class="muted">${esc(effLabel(s))}</span></td>` + cols.map((c) => cell(c, s)).join('') + '</tr>').join('')).join('') ||
        `<tr><td class="l" colspan="${cols.length + 1}">No scans match these filters.</td></tr>`;
      $('ex-table').querySelectorAll('th[data-k]').forEach((th) => th.addEventListener('click', () => {
        if (sortK === th.dataset.k) asc = !asc; else { sortK = th.dataset.k; asc = ['natural', 'usd', 'usd100', 'usdConf', 'agent', 'agent100', 'wall', 'wall100', 'fpRate', 'untri'].includes(sortK); }
        document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('on'));
        render();
      }));
      const wrap = $('ex-table').parentElement;
      for (const el of document.querySelectorAll('.scroll-cue')) el.style.display = wrap.scrollWidth > wrap.clientWidth + 1 ? '' : 'none';
      $('ex-note').innerHTML = `<p>${list.length} of ${rows.length} scans. </p>
        <details class="defs"><summary>Column definitions</summary><dl>${cols.filter((c) => c[7]).map((c) => `<dt>${esc(c[1])}</dt><dd>${esc(c[7])}</dd>`).join('')}</dl></details><ul>
        <li><b>*</b> More than ${SHAKY * 100}% of that scan's findings were never triaged, so its confirmed count is a lower bound, $/confirmed an upper bound, and its false-positive rate rests on the few findings that were triaged. These rows sort last on those columns.</li>
        <li><b>–</b> in price columns: no price was recorded for that scan. In <b>unique</b>: not computed, because the repository has only one scan or this scan was not compared with the others (<i>other commit</i>: it ran at a different commit).</li>
        <li><b>default</b> effort: Codex used its CLI default, <code>high</code>. Claude used Claude Code's default, which was not recorded, so it is not known which explicit level it matches.</li>
        <li><b>reviewer min</b> is agent time summed over reviewers running in parallel, not elapsed time; for elapsed time choose <i>Price and time</i> under Columns and read <b>wall clock</b>.</li>
        <li><b>unique</b> grows with the number of other scans compared (given in the repository row); <b>≈</b> marks scans at different commits. Times are single runs and vary several-fold between repositories; price per 100KB also depends on chunk size (<b>chunk</b> column under <i>Price and time</i>). Compare all of these only within a repository.</li>
        <li>Sonnet 5.5 and Haiku 5.5 never ran a full scan; they were tested only on calibration samples (see <a href="model.html">Pick a model</a>).</li></ul>`;
      // scatter
      const X = COLS.find((c) => c[0] === $('ex-x').value), Y = COLS.find((c) => c[0] === $('ex-y').value);
      const CR = $('ex-chart-repo').value;
      const pts = list.filter(({ s }) => CR === 'any' || s.repo.name === CR).map(({ s }) => ({ s, x: X[3](s), y: Y[3](s) })).filter((p) => p.x !== null && p.x !== undefined && p.y !== null && p.y !== undefined);
      const host = $('ex-chart'); host.innerHTML = '';
      if (!pts.length) { host.innerHTML = '<p class="muted">Nothing to plot for these filters.</p>'; $('ex-cap').innerHTML = ''; return; }
      const W = 640, H = 320, Lm = 64, R = 60, T = 12, B = 40;
      const xs = pts.map((p) => p.x), xMin = Math.min(...xs);
      // a wide spread squeezes most dots into a corner: switch the horizontal axis to log
      const logX = xMin > 0 && Math.max(...xs) / xMin >= 8;
      const xMax = nice(Math.max(...xs) * 1.05 || 1), yMax = nice(Math.max(...pts.map((p) => p.y)) * 1.05 || 1);
      const xLo = logX ? Math.pow(10, Math.floor(Math.log10(xMin))) : 0;
      const px = logX ? (v) => Lm + ((Math.log10(v) - Math.log10(xLo)) / (Math.log10(xMax) - Math.log10(xLo))) * (W - Lm - R) : (v) => Lm + (v / xMax) * (W - Lm - R);
      const py = (v) => T + (1 - v / yMax) * (H - T - B);
      const xTicks = logX ? [] : [0, 1, 2, 3, 4].map((i) => (xMax * i) / 4);
      if (logX) for (let d = xLo; d <= xMax * 1.0001; d *= 10) for (const m of [1, 2, 5]) if (d * m <= xMax * 1.0001) xTicks.push(d * m);
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${Y[1]} against ${X[1]}` });
      for (let i = 0; i <= 4; i++) {
        svgEl('line', { x1: Lm, x2: W - R, y1: py((yMax * i) / 4), y2: py((yMax * i) / 4), class: 'grid' }, svg);
        svgEl('text', { x: Lm - 6, y: py((yMax * i) / 4) + 4, 'text-anchor': 'end' }, svg).textContent = Y[4]((yMax * i) / 4, {});
      }
      for (const v of xTicks) svgEl('text', { x: px(v), y: H - B + 16, 'text-anchor': 'middle' }, svg).textContent = String(X[4](v, {})).replace(/<[^>]*>/g, '');
      svgEl('text', { x: (Lm + W - R) / 2, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = X[1] + (logX ? ' (log scale)' : '');
      svgEl('text', { x: 12, y: (T + H - B) / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${(T + H - B) / 2})` }, svg).textContent = Y[1];
      const placed = [];
      for (const p of pts) {
        // hollow dot: the scan was partly triaged (* in the table), so a confirmed-based value is only a bound
        const hollow = shaky(p.s) && [X[0], Y[0]].some((k) => CONF_COLS.includes(k));
        svgEl('circle', hollow ? { cx: px(p.x), cy: py(p.y), r: 5, fill: 'var(--surface-1)', stroke: modelInfo(p.s.model).color, 'stroke-width': 2 }
          : { cx: px(p.x), cy: py(p.y), r: 6, fill: modelInfo(p.s.model).color, stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
      }
      // labels: try right, left, then above/below with a leader line, so close dots each keep their name
      const clash = (p, lx, ly, lw) => lx < Lm - 4 || lx + lw > W - 2 || ly < 10 || ly > H - B ||
        placed.some((b) => lx < b.x + b.w && lx + lw > b.x && Math.abs(ly - b.y) < 12) ||
        pts.some((q) => px(q.x) + 6 > lx && px(q.x) - 6 < lx + lw && Math.abs(py(q.y) + 4 - ly) < 10) ||
        // ambiguous: another dot sits as close to the label as its own dot
        pts.some((q) => q !== p && (() => { const nx = lx + lw / 2, ny = ly - 4, d = (a) => Math.max(Math.abs(px(a.x) - nx) - lw / 2, 0) + Math.abs(py(a.y) - ny); return d(q) <= d(p) + 4; })());
      for (const p of pts) {
        const lbl = effLabel(p.s).replace(' (high)', ''), lw = lbl.length * 6, cx = px(p.x), cy = py(p.y);
        const spots = [[cx + 8, cy + 4], [cx - 8 - lw, cy + 4]];
        for (const d of [16, 26, 36]) spots.push([cx + 6, cy - d + 4], [cx + 6, cy + d + 4], [cx - 6 - lw, cy - d + 4], [cx - 6 - lw, cy + d + 4]);
        const i = spots.findIndex(([lx, ly]) => !clash(p, lx, ly, lw));
        if (i < 0) continue; // the tooltip still names the dot
        const [lx, ly] = spots[i];
        if (i > 1) svgEl('line', { x1: cx, y1: cy, x2: lx < cx ? lx + lw : lx, y2: ly - 4, class: 'leader' }, svg);
        svgEl('text', { x: lx, y: ly, class: 'lbl' }, svg).textContent = lbl;
        placed.push({ x: lx, y: ly, w: lw });
      }
      for (const p of pts) bindTip(svgEl('circle', { cx: px(p.x), cy: py(p.y), r: 10, class: 'hit' }, svg),
        `<b>${esc(family(p.s.model))} ${esc(effLabel(p.s))}</b> · ${esc(exName(p.s.repo))} (${esc(langOfRepo(p.s.repo))})<br>${esc(X[1])}: ${String(X[4](p.x, p.s)).replace(/<[^>]*>/g, '')}<br>${esc(Y[1])}: ${String(Y[4](p.y, p.s)).replace(/<[^>]*>/g, '')}`);
      host.appendChild(svg);
      const nRepos = new Set(pts.map((p) => p.s.repo)).size;
      const nMissing = list.filter(({ s }) => CR === 'any' || s.repo.name === CR).length - pts.length;
      const nHollow = pts.filter((p) => shaky(p.s) && [X[0], Y[0]].some((k) => CONF_COLS.includes(k))).length;
      $('ex-cap').innerHTML = `<div class="legend">${[...new Set(pts.map((p) => p.s.model))].map((m) => modelInfo(m).name).filter((v, i, a) => a.indexOf(v) === i).map((n) => `<span>${sw(MODELS.find((x) => x[1] === n)?.[0] || n)}</span>`).join('')}</div>${esc(Y[1])} against ${esc(X[1])}, one dot per scan, labelled with its effort; hover or tap a dot for its repository.` +
        (nHollow ? ' Hollow dots: scans marked * in the table, whose confirmed count is a lower bound.' : '') +
        (nMissing ? ` ${nMissing} scan${nMissing > 1 ? 's' : ''} with no value for these measures (– in the table) ${nMissing > 1 ? 'are' : 'is'} not plotted.` : '') +
        (nRepos > 1 ? ` These dots come from ${nRepos} repositories, so they do not compare models; pick one repository to compare like with like.` : '');
    }
    for (const id of ['ex-repo', 'ex-lang', 'ex-model', 'ex-effort', 'ex-view', 'ex-x', 'ex-y', 'ex-chart-repo']) $(id).addEventListener('change', render);
    // the chart follows a repository picked for the table
    $('ex-repo').addEventListener('change', () => { $('ex-chart-repo').value = $('ex-repo').value; render(); });
    // preference presets: sort key, direction, plot axes
    const PRESETS = { cheap: ['usd100', true, 'usd100', 'confPer100'], most: ['confPer100', false, 'usd100', 'confPer100'],
      value: ['usdConf', true, 'usdConf', 'confPer100'], natural: ['natural', true, 'usd100', 'confPer100'], quick: ['agent100', true, 'agent100', 'confPer100'] };
    document.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
      [sortK, asc, $('ex-x').value, $('ex-y').value] = PRESETS[btn.dataset.preset];
      document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b === btn));
      render();
    }));
    window.addEventListener('resize', () => { const w = $('ex-table').parentElement; for (const el of document.querySelectorAll('.scroll-cue')) el.style.display = w.scrollWidth > w.clientWidth + 1 ? '' : 'none'; });
    render();
  })();

  // ---------- models by language
  // price range with the effort behind each end, so the spread is not read as a language effect
  // no scan: "not run"; scans without a recorded price: "not recorded"; different efforts are listed, not ranged
  const priceRange = (all, dflt) => {
    const ss = all.filter((s) => s.usdPer100Kb != null).sort((a, b) => a.usdPer100Kb - b.usdPer100Kb);
    if (!ss.length) return `<span class="muted">${all.length ? 'not recorded' : 'not run'}</span>`;
    const one = (s) => `${usd(s.usdPer100Kb)} <span class="muted">${esc(s.effort || dflt)}</span>`;
    const a = ss[0], z = ss[ss.length - 1];
    if (a.usdPer100Kb === z.usdPer100Kb) return one(a);
    return (a.effort || dflt) === (z.effort || dflt) ? `${usd(a.usdPer100Kb)}–${one(z)}` : `${one(a)};<br>${one(z)}`;
  };
  if ($('lang-table')) $('lang-table').innerHTML = `<tr><th class="l">language <span class="muted">· codebases</span></th><th class="l">models run</th><th class="l">compared?</th><th>Codex $/100KB</th><th>Opus $/100KB</th><th>Opus precision</th><th class="l">Opus chunk</th></tr>` +
    langNames.map((L) => {
      const rs = reposOf(L), ev = evidence(L);
      const scans = rs.flatMap((r) => r.scans).filter(atRecommended);
      const fams = [...new Set(scans.map((s) => s.model).concat(rs.flatMap((r) => r.inits.flatMap((i) => i.rows.map((x) => x.model)))).map(family))].map((f) => SHORT[f] || f);
      const of = (f) => scans.filter((s) => family(s.model) === f);
      return `<tr><td class="l lang"><b>${esc(L)}</b><div class="muted">${rs.map((r) => { const t = esc(WHAT[r.name] || r.name.replace(/^scylladb\//, '')); return r.url ? `<a href="${r.url}">${t}</a>` : t; }).join('; ')}</div></td><td class="l" data-l="models run" style="white-space:normal">${fams.map(esc).join(', ')}</td>
        <td class="l" data-l="compared">${ev.compared ? 'yes' : '<span class="muted">no</span>'}</td><td data-l="Codex $/100KB">${priceRange(of('Codex gpt-6.1-sol'), 'high')}</td><td data-l="Opus $/100KB">${priceRange(of('Opus 5.5'), 'effort not recorded')}</td>
        <td data-l="Opus precision">${of('Opus 5.5').length ? range(of('Opus 5.5').map((s) => s.precision), f2) : '<span class="muted">not run</span>'}</td><td class="l" data-l="Opus chunk">${esc(chunkFor(L, OP, true)) || '<span class="muted">not calibrated</span>'}</td></tr>`;
    }).join('');

  // ---------- effort
  (function () {
    const studies = data.repos.flatMap((r) => (r.efforts || []).map((e) => ({ ...e, repo: r })));
    const host = $('effort-body');
    if (!host) return;
    if (!studies.length) { host.innerHTML = '<p class="muted">No effort study yet.</p>'; return; }
    const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    for (const st of studies) {
      const rows = st.rows.slice().sort((a, b) => modelInfo(a.model).name.localeCompare(modelInfo(b.model).name) || ORDER.indexOf(a.effort) - ORDER.indexOf(b.effort));
      const sec = document.createElement('div');
      // wall clock lives on the scan record, not the study row
      const wallOf = (r) => (st.repo.scans.find((s) => s.id === r.id) || {}).wallMinutes ?? null;
      const judge = st.triagedBy ? `the judge (${esc(st.triagedBy.replace(/\s*\(.*\)\s*$/, '').replace(/ auto-triage at (\w+) effort$/, ', $1 effort'))})` : 'the judge';
      sec.innerHTML = `<p>The codebase: ${kb(st.basisKb)} in ${st.basisFiles} files.
        Together the ${rows.length} runs reported ${st.issues} distinct issues; ${judge} confirmed ${st.confirmedIssues} and rejected ${st.issues - st.confirmedIssues}. Those ${st.confirmedIssues} are the ground truth for recall.</p>`;
      // recall of confirmed issues vs whole-scan price, one line per model through its effort levels
      const fig = document.createElement('figure');
      const chart = document.createElement('div'); chart.className = 'chart';
      // a smaller canvas on phones, so axis and effort labels are not scaled down to unreadable
      const narrow = (host.clientWidth || 640) < 520;
      const W = narrow ? 400 : 640, H = narrow ? 300 : 320, L = 46, R = narrow ? 16 : 30, T = 12, B = 40;
      const pts = rows.filter((r) => r.usdPer100Kb !== null && r.confirmedRecall !== null);
      // log price axis: the cheap levels sit within a few cents of each other, the dearest is 25x the cheapest
      // left edge: the largest 1/2/5 step at or below the cheapest run, so the plot has no empty strip
      const minP = Math.min(...pts.map((p) => p.usdPer100Kb)), dec = Math.pow(10, Math.floor(Math.log10(minP)));
      const lo = [5, 2, 1].map((m) => m * dec).find((v) => v <= minP), hi = nice(Math.max(...pts.map((p) => p.usdPer100Kb)) * 1.2);
      const yMax = Math.min(1, Math.ceil(Math.max(...pts.map((p) => p.confirmedRecall)) * 10 + 1) / 10);
      const X = (v) => L + (Math.log10(v / lo) / Math.log10(hi / lo)) * (W - L - R), Y = (v) => T + (1 - v / yMax) * (H - T - B);
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'recall against price per 100KB by effort level' });
      for (let v = 0; v <= yMax + 1e-9; v += 0.1) {
        svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
        svgEl('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = v.toFixed(1);
      }
      for (let d = dec; d <= hi * 1.001; d *= 10) for (const m of [1, 2, 5]) {
        const v = d * m; if (v < lo * 0.999) continue; if (v > hi * 1.001) break;
        svgEl('line', { x1: X(v), x2: X(v), y1: T, y2: H - B, class: 'grid' }, svg);
        svgEl('text', { x: X(v), y: H - B + 16, 'text-anchor': 'middle' }, svg).textContent = '$' + (v < 1 ? v.toFixed(2) : v.toFixed(0));
      }
      svgEl('text', { x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle' }, svg).textContent = 'price per 100KB of code (log scale)';
      svgEl('text', { x: 12, y: (T + H - B) / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${(T + H - B) / 2})` }, svg).textContent = 'recall';
      const models = [...new Set(pts.map((p) => p.model))];
      // effort labels: try a few spots around each dot and keep the first that clears other labels, dots and lines
      const placed = [], dots = pts.map((p) => [X(p.usdPer100Kb), Y(p.confirmedRecall)]), segs = [];
      for (const m of models) {
        const ps = pts.filter((p) => p.model === m).sort((a, b) => ORDER.indexOf(a.effort) - ORDER.indexOf(b.effort));
        for (let i = 1; i < ps.length; i++) segs.push([X(ps[i - 1].usdPer100Kb), Y(ps[i - 1].confirmedRecall), X(ps[i].usdPer100Kb), Y(ps[i].confirmedRecall)]);
      }
      const hits = (b) => placed.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h) ||
        dots.some(([x, y]) => x + 5 > b.x && x - 5 < b.x + b.w && y + 5 > b.y && y - 5 < b.y + b.h) ||
        segs.some(([x1, y1, x2, y2]) => { for (let t = 0; t <= 1; t += 0.05) { const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t; if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return true; } return false; }) ||
        b.x < L || b.x + b.w > W || b.y < 0 || b.y + b.h > H - B;
      for (const m of models) {
        const ps = pts.filter((p) => p.model === m).sort((a, b) => ORDER.indexOf(a.effort) - ORDER.indexOf(b.effort));
        svgEl('polyline', { points: ps.map((p) => `${X(p.usdPer100Kb)},${Y(p.confirmedRecall)}`).join(' '), fill: 'none', stroke: modelInfo(m).color, 'stroke-width': 2 }, svg);
        for (const p of ps) {
          const cx = X(p.usdPer100Kb), cy = Y(p.confirmedRecall);
          svgEl('circle', { cx, cy, r: 5, fill: modelInfo(m).color, stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
          const w = p.effort.length * 6.5 + 2, h = 13;
          const spots = [[8, -h - 2], [8, 2], [-w - 8, -h - 2], [-w - 8, 2], [-w / 2, -h - 8], [-w / 2, 8], [8, -h - 14], [8, 14], [-w - 8, -h - 14], [-w - 8, 14]];
          const box = spots.map(([dx, dy]) => ({ x: cx + dx, y: cy + dy, w, h })).find((b) => !hits(b)) || { x: cx + 8, y: cy - h - 2, w, h };
          placed.push(box);
          svgEl('text', { x: box.x + 1, y: box.y + h - 3, class: 'lbl' }, svg).textContent = p.effort;
          bindTip(svgEl('circle', { cx, cy, r: 14, class: 'hit' }, svg),
            `<b>${esc(modelInfo(m).name)} ${esc(p.effort)}</b><br>recall ${f2(p.confirmedRecall)} · ${p.confirmed} confirmed, ${p.falsePositive} false pos.<br>${usd(p.usdPer100Kb)}/100KB · ${usd(p.usd)} whole scan`);
        }
      }
      chart.appendChild(svg);
      fig.appendChild(chart);
      const cap = document.createElement('figcaption');
      cap.innerHTML = `<div class="legend">${models.map((m) => `<span>${sw(m)}</span>`).join('')}</div>One dot per run, labelled with its effort level. Recall as defined above. Up and left is better.`;
      fig.appendChild(cap);
      sec.appendChild(fig);
      // model name as a header row over its group, so the tables need no mostly-empty model column
      const lab = (r) => `<td class="l">${esc(r.effort || '–')}</td>`;
      const grp = (r, i, n) => (i && rows[i - 1].model === r.model ? '' : `<tr><td class="l" colspan="${n}" style="background:var(--code-bg)">${sw(r.model)}</td></tr>`);
      const anyUntriaged = rows.some((r) => r.untriaged);
      const t1 = document.createElement('div'); t1.className = 'table-wrap';
      const th = (t, tip) => `<th title="${esc(tip)}">${t}</th>`;
      const n1cols = 6 + (anyUntriaged ? 1 : 0);
      t1.innerHTML = `<table><tr><th class="l">effort</th>${th('recall', 'severity-weighted share of the pooled confirmed issues')}${th('precision', 'confirmed / (confirmed + false positives)')}` +
        `${th('confirmed', 'findings the judge confirmed')}${th('false pos.', 'findings the judge rejected')}${anyUntriaged ? th('untriaged', 'not judged yet') : ''}${th('only this run', 'confirmed or not, issues no other run in the study found')}` +
        `</tr>` + rows.map((r, i) => `${grp(r, i, n1cols)}<tr>${lab(r)}<td><b>${f2(r.confirmedRecall)}</b></td><td>${f2(r.precision)}</td><td>${r.confirmed}</td><td>${r.falsePositive}</td>${anyUntriaged ? `<td>${r.untriaged}</td>` : ''}<td>${r.unique}</td></tr>`).join('') + '</table>';
      const hq = document.createElement('h4'); hq.className = 'muted'; hq.style.margin = '16px 0 4px'; hq.textContent = 'Quality';
      sec.appendChild(hq);
      const cue = document.createElement('p'); cue.className = 'note chart-cue'; cue.textContent = 'Tables below have more columns: scroll them sideways.';
      sec.appendChild(cue);
      sec.appendChild(t1);
      // cost and time in a second table so neither needs sideways scrolling on desktop
      const hc = document.createElement('h4'); hc.className = 'muted'; hc.style.margin = '16px 0 4px'; hc.textContent = 'Cost and time';
      sec.appendChild(hc);
      const t1b = document.createElement('div'); t1b.className = 'table-wrap';
      // review agents = one per chunk plus one retry per failed agent; the chunk count is what is left once failures are taken out
      const perChunk = [...new Set(rows.map((r) => r.agents - (r.failedAgents || 0)))];
      const nChunks = perChunk.length === 1 ? perChunk[0] : null;
      t1b.innerHTML = `<table><tr><th class="l">effort</th>${th('$/100KB', 'price per 100KB of code reviewed')}${th('$/confirmed', 'price per confirmed issue')}${th('whole scan', `price of the whole ${kb(st.basisKb)} scan`)}` +
        `${th('wall min', 'elapsed minutes, reviewers running in parallel')}${th('agent min', 'reviewer minutes summed over all parallel agents')}${th('agents (failed)', 'review agents started: one per chunk, plus a retry for each failed agent')}</tr>` +
        rows.map((r, i) => `${grp(r, i, 7)}<tr>${lab(r)}<td>${usd(r.usdPer100Kb)}</td><td>${usd(r.usdPerConfirmed)}</td><td>${usd(r.usd)}</td><td>${wallOf(r) ?? '–'}</td><td>${r.agentMinutes ?? '–'}</td><td>${r.agents}${r.failedAgents ? ` <span class="muted">(${r.failedAgents})</span>` : ''}</td></tr>`).join('') + '</table>';
      sec.appendChild(t1b);
      const n1 = document.createElement('div');
      const failedRuns = rows.filter((r) => r.failedAgents >= 5).map((r) => `${esc(SHORT[family(r.model)] || family(r.model))} ${esc(r.effort)}`);
      n1.innerHTML = `<p class="note"><b>only this run</b>: issues no other run found, confirmed or not. <b>whole scan</b>: price of this ${kb(st.basisKb)} study scan; for your repo, scale <b>$/100KB</b> by its size. <b>$/confirmed</b>: price per confirmed issue. <b>wall min</b>: elapsed time with reviewers in parallel; <b>agent min</b>: the same work summed over agents.
        <b>agents</b>: one per chunk${nChunks ? ` (${nChunks} chunks; chunks hold whole files, so more than ${kb(st.basisKb)} ÷ 40KB)` : ''}, plus a retry for each failed agent.</p>
        <p class="note"><b>Failures and retries</b>: every run still reviewed all ${st.basisFiles} files, but prices include everything the review agents spent, failed agents and retries too (the judge's triage is not included)${failedRuns.length ? `, so runs with many failures (${failedRuns.join(', ')}) cost somewhat more than a clean run would` : ''}.
        Failures also slow a run, so Codex times do not follow effort; treat time as rough. To estimate your own wall clock, divide <b>agent min</b> by how many reviewers you run at once (the study did not record that number).</p>`;
      sec.appendChild(n1);
      const h = document.createElement('h4'); h.textContent = 'Findings by severity (confirmed counts use the severity the judge assigned)'; h.className = 'muted'; h.style.margin = '16px 0 4px';
      sec.appendChild(h);
      const t2 = document.createElement('div'); t2.className = 'table-wrap';
      // grouped header with short severity names, so all 11 columns fit on desktop
      const sevHead = ['total', 'crit.', 'high', 'med.', 'low'].map((k, j) => `<th${j ? '' : ' style="border-left:1px solid var(--border)"'}>${k}</th>`).join('');
      t2.innerHTML = `<table class="sev-tbl"><tr><th class="l" rowspan="2">effort</th><th class="grp" colspan="5">reported by the reviewer</th><th class="grp" colspan="5">confirmed by the judge</th></tr><tr>${sevHead}${sevHead}</tr>` +
        rows.map((r, i) => `${grp(r, i, 11)}<tr>${lab(r)}${sevTd(r.findings, r.severity)}${sevTd(r.confirmed, r.confirmedSeverity)}</tr>`).join('') + '</table>';
      sec.appendChild(t2);
      const n2 = document.createElement('p'); n2.className = 'note';
      // reviewer-assigned criticals vs confirmed criticals, summed over all runs
      const critRep = rows.reduce((a, r) => a + ((r.severity || {}).critical || 0), 0), critConf = rows.reduce((a, r) => a + ((r.confirmedSeverity || {}).critical || 0), 0);
      n2.textContent = 'Codex reports mostly high, Opus mostly medium and low; after triage both land mostly on medium.' +
        (critRep ? ` Reviewer criticals rarely hold up: the runs reported ${critRep} in total, the judge rated ${critConf} confirmed issue${critConf === 1 ? '' : 's'} critical.` : '');
      sec.appendChild(n2);
      if (st.combos && st.combos.length) {
        const h2 = document.createElement('h4'); h2.className = 'muted'; h2.style.margin = '16px 0 4px';
        h2.textContent = 'Several runs together: recall of their union and their combined price (selected combinations, not every pair)';
        sec.appendChild(h2);
        const t3 = document.createElement('div'); t3.className = 'table-wrap';
        const best = rows.reduce((a, r) => (r.confirmedRecall > (a ? a.confirmedRecall : -1) ? r : a), null);
        // per 100KB, same basis as usdPer100Kb (basisKb is the reviewed size of every run)
        const per100 = (u) => usd(u / st.basisKb * 100);
        // "Codex high + xhigh", "Codex: all six levels": the model name once per group of runs
        const comboLabel = (runs) => {
          const groups = [];
          for (const r of runs) { const g = groups.find((x) => x.model === r.model); if (g) g.efforts.push(r.effort); else groups.push({ model: r.model, efforts: [r.effort] }); }
          return groups.map((g) => {
            const all = rows.filter((r) => r.model === g.model).length;
            return sw(g.model) + ' ' + (g.efforts.length === all && all > 2 ? `<span class="muted">all ${all} levels</span>` : g.efforts.map((e) => `<span class="muted">${esc(e)}</span>`).join(' + '));
          }).join(' + ');
        };
        t3.innerHTML = `<table><tr><th>runs</th><th>recall</th><th>$/100KB</th><th>whole scan</th></tr>` +
          (best ? (() => {
            // baseline: the cheapest run of the best model whose recall ties the best (within 0.05), as the page advises
            const ties = rows.filter((r) => r.model === best.model && Math.round((best.confirmedRecall - r.confirmedRecall) * 100) < 5);
            const base = ties.reduce((a, r) => (r.usdPer100Kb < a.usdPer100Kb ? r : a), best);
            const others = ties.filter((r) => r !== base).map((r) => `${esc(r.effort)} ${f2(r.confirmedRecall)}`);
            return `<tr><td class="l">${withEffort(base.model, base.effort)} <span class="muted">(single run${others.length ? `; within noise of ${others.join(', ')}` : ''})</span></td><td><b>${f2(base.confirmedRecall)}</b></td><td>${usd(base.usdPer100Kb)}</td><td>${usd(base.usd)}</td></tr>`;
          })() : '') +
          st.combos.map((c) => {
            // a combination another one beats on both recall and price: say so, so the reader need not compare
            const dom = st.combos.filter((o) => o !== c && o.recall >= c.recall && o.usd < c.usd).sort((x, y) => x.usd - y.usd)[0];
            const note = dom ? ` <span class="muted">(costs more than ${comboLabel(dom.runs).replace(/<[^>]+>/g, '')}, no more recall)</span>` : '';
            return `<tr><td class="l">${comboLabel(c.runs)}${note}</td><td><b>${f2(c.recall)}</b></td><td>${per100(c.usd)}</td><td>${usd(c.usd)}</td></tr>`;
          }).join('') + '</table>';
        t3.querySelectorAll('td.l').forEach((td) => { td.style.whiteSpace = 'normal'; });
        sec.appendChild(t3);
      }
      host.appendChild(sec);
    }
  })();

  // ---------- provider: OpenAI (Codex) vs Anthropic (Claude)
  if ($('prov-sum')) (function () {
    const isOpenAI = (m) => family(m) === 'Codex gpt-6.1-sol';
    const provOf = (m) => (isOpenAI(m) ? 'OpenAI' : 'Anthropic');
    const ssw = (m) => `<span class="swatch" style="background:${modelInfo(m).color}"></span>${esc(SHORT[family(m)] || family(m))}`;
    const sumOf = (xs, k) => xs.reduce((a, s) => a + (s[k] || 0), 0);
    // at a glance: one row per model
    const fams = MODELS.map(([k, n]) => n).filter((n) => allScans.some((s) => family(s.model) === n)).sort((x, y) => (y === 'Codex gpt-6.1-sol') - (x === 'Codex gpt-6.1-sol'));
    $('prov-sum').innerHTML = `<tr><th class="l">provider</th><th class="l">model</th><th>full scans</th><th>code reviewed</th><th>$/100KB at default effort</th><th>precision</th><th>findings triaged</th></tr>` +
      fams.map((n) => {
        const ss = allScans.filter((s) => family(s.model) === n);
        return `<tr><td class="l"><b>${provOf(ss[0].model)}</b></td><td class="l">${sw(ss[0].model)}</td><td data-l="full scans">${ss.length}</td><td data-l="code">${kb(sumOf(ss, 'kb'))}</td>
          <td data-l="$/100KB">${range(ss.filter((s) => !s.effort).map((s) => s.usdPer100Kb), usd)}</td><td data-l="precision">${range(ss.map((s) => s.precision), f2)}</td>
          <td data-l="triaged">${sumOf(ss, 'triaged').toLocaleString()} of ${sumOf(ss, 'findings').toLocaleString()}</td></tr>`;
      }).join('');
    const tri = data.repos.flatMap((r) => r.triage);
    const cxTri = tri.filter((t) => t.model && isOpenAI(t.model));
    const cxN = sumOf(cxTri, 'findings'), allN = sumOf(tri, 'findings'), cxFp = cxTri.reduce((a, t) => a + (t.verdicts.false_positive || 0), 0);
    if (cxN) $('prov-prec-note').innerHTML = `<b>Precision does not tell these configurations apart:</b> Codex auto-triage, which gave almost every verdict, rejected only ${cxFp} of the ${cxN.toLocaleString()} findings it judged, so precision is high for almost every scan. A Codex judge may also favour Codex findings, so read Codex precision as an upper bound. Counting details: Codex gave ${cxN.toLocaleString()} of ${allN.toLocaleString()} auto-triage verdicts, on findings from both providers; the judge of the other ${(allN - cxN).toLocaleString()} was not recorded. The table's triaged counts are higher because they count a finding once per scan that reported it and include findings triaged by hand. See <a href="method.html#triage">Method &amp; data</a>.`;

    // effort study: every level of both models on the same code
    const st = data.repos.flatMap((r) => (r.efforts || []).map((e) => ({ ...e, repo: r })))[0];
    if (st && $('prov-effort')) {
      const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
      const rows = st.rows.slice().sort((a, b) => (isOpenAI(b.model) - isOpenAI(a.model)) || ORDER.indexOf(a.effort) - ORDER.indexOf(b.effort));
      const wall = (x) => (st.repo.scans.find((s) => s.id === x.id && s.model === x.model && s.effort === x.effort) || {}).wallMinutes;
      const mins = (v) => (v === null || v === undefined ? '–' : Math.round(v));
      $('prov-effort-desc').innerHTML = `${kb(st.basisKb)} of ${esc(langsOf(st.repo).join(' + '))} in ${st.basisFiles} files (${repoLink(st.repo)}), every run on the same commit and the same ${esc([...new Set(st.repo.scans.filter((s) => st.rows.some((x) => x.id === s.id && x.model === s.model && x.effort === s.effort)).map((s) => s.chunkKb))].join('/'))}KB chunks (KB of code per reviewer agent).
        Together the runs found ${st.issues} distinct issues; triage (${esc(String(st.triagedBy).replace(/\s*\((\d+) findings confirmed earlier by hand\)/, ', plus $1 confirmed by hand'))}) confirmed ${st.confirmedIssues}, so rejected almost none (see the <a href="#prov-prec-note">precision caveat</a>). Recall = share of those ${st.confirmedIssues} a run found, weighting critical 4, high 3, medium 2, low 1 by the highest label any reviewer gave the issue, so Codex's harsher labelling raises its recall too. $/confirmed bug = the run's total price ÷ the number of its findings triage confirmed, unweighted.`;
      const combo = (st.combos || []).find((c) => c.runs.length === 2 && c.runs.some((r) => isOpenAI(r.model) && r.effort === 'xhigh') && c.runs.some((r) => !isOpenAI(r.model) && r.effort === 'max'));
      const comboWall = combo && Math.max(...combo.runs.map((r) => wall(rows.find((x) => x.model === r.model && x.effort === r.effort) || {}) || 0));
      $('prov-effort').innerHTML = `<tr><th class="l">model</th><th class="l">effort</th><th>recall</th><th>$/100KB</th><th>$/confirmed bug</th><th>wall clock</th></tr>` +
        rows.map((x) => `<tr><td class="l">${ssw(x.model)}</td><td class="l"><code>${esc(x.effort)}</code></td><td data-l="recall"><b>${f2(x.confirmedRecall)}</b></td><td data-l="$/100KB">${usd(x.usdPer100Kb)}</td><td data-l="$/bug">${usd(x.usdPerConfirmed)}</td><td data-l="wall">${mins(wall(x))} min</td></tr>`).join('') +
        (combo ? `<tr><td class="l" colspan="2">${combo.runs.map((r) => `${ssw(r.model)} <code>${esc(r.effort)}</code>`).join(' + ')} <span class="muted">merged</span></td><td data-l="recall"><b>${f2(combo.recall)}</b></td><td data-l="$/100KB">${usd(combo.usd / st.basisKb * 100)}</td><td data-l="$/bug">–†</td><td data-l="wall">${comboWall ? `${mins(comboWall)} min*` : '–'}</td></tr>` : '');
    }

    // full scans of the same files by both providers
    const rows = [];
    for (const r of data.repos) {
      for (const c of r.compares) {
        const o = c.scans.find((x) => isOpenAI(x.model)), a = c.scans.find((x) => !isOpenAI(x.model));
        if (!o || !a) continue;
        const so = r.scans.find((s) => s.id === o.id && s.store === c.store) || {}, sa = r.scans.find((s) => s.id === a.id && s.store === c.store) || {};
        const eff = (s, d) => ` <span class="muted">${esc(s.effort || d)}</span>`;
        rows.push(`<tr><td class="l">${repoLink(r)}<br><span class="muted">${esc(langsOf(r).join(' + '))}, ${kb(c.basisKb)} compared</span></td>
          <td class="l">${ssw(o.model)}${eff(so, 'default (high)')}</td><td data-l="share"><b>${f2(o.share)}</b></td><td data-l="$/100KB">${usd(so.usdPer100Kb)}</td>
          <td class="l">${ssw(a.model)}${eff(sa, 'default')}</td><td data-l="share"><b>${f2(a.share)}</b></td><td data-l="$/100KB">${usd(sa.usdPer100Kb)}</td></tr>`);
      }
    }
    $('prov-table').innerHTML = `<tr><th class="l" rowspan="2">repository</th><th class="grp" colspan="3">OpenAI</th><th class="grp" colspan="3">Anthropic</th></tr>
      <tr><th class="l">model</th><th>share</th><th>$/100KB</th><th class="l">model</th><th>share</th><th>$/100KB</th></tr>` + rows.join('');
  })();
})();
