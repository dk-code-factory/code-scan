'use strict';
(async function () {
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
  const repoLink = (r) => (r.url ? `<a href="${r.url}">${esc(r.name)}</a>` : esc(r.name));

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

  $('generated').textContent = data.generated;

  // ---------- headline cards
  const allScans = data.repos.flatMap((r) => r.scans.map((s) => ({ ...s, repo: r })));
  const totalKb = allScans.reduce((s, x) => s + x.kb, 0);
  const totalFindings = allScans.reduce((s, x) => s + x.findings, 0);
  const triaged = allScans.reduce((s, x) => s + x.triaged, 0);
  $('headline').innerHTML = [
    ['repositories', data.repos.length, 'scanned with code-scan'],
    ['code reviewed', kb(totalKb), `${allScans.length} full scans`],
    ['findings', totalFindings.toLocaleString(), `${triaged.toLocaleString()} triaged`],
    ['models compared', new Set(allScans.map((s) => modelInfo(s.model).name).concat(data.repos.flatMap((r) => r.inits.flatMap((i) => i.rows.map((x) => modelInfo(x.model).name))))).size, 'Claude and Codex'],
  ].map(([k, v, p]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><p>${p}</p></div>`).join('');

  // ---------- scatter: quality vs price
  function scatter(host, pts, { xLabel, yLabel, yMax = 1 }) {
    const W = 640, H = 300, L = 44, R = 120, T = 12, B = 36;
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
    svgEl('text', { x: 10, y: T + 4, 'text-anchor': 'start' }, svg).textContent = '';
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
  if (b) {
    $('bench-desc').innerHTML = `${esc(b.repo)} @ ${esc(b.commit)}: ${b.sampleKb}KB / ${b.lines.toLocaleString()} lines of Go with ${b.knownBugs} verified bugs
      (filed upstream) and ${b.distinctIssues} distinct issues found across all models. Each model at the chunk size its own calibration chose (${esc(b.date)}).`;
    scatter($('bench-chart'), b.rows.map((r) => ({ x: r.usdPer100Kb, y: r.quality, model: r.model,
      tip: `<b>${esc(modelInfo(r.model).name)}</b><br>quality ${f2(r.quality)} · ${r.bugsFound}/${b.knownBugs} known bugs<br>${usd(r.usdPer100Kb)}/100KB at ${r.chunkKb}KB chunks` })),
    { xLabel: '$ per 100KB reviewed', yLabel: 'quality' });
    $('bench-table').innerHTML = `<tr><th>model</th><th>chunk</th><th>known bugs</th><th>quality</th><th>$/100KB</th><th>$/1k lines</th><th>calibration $</th><th class="l">note</th></tr>` +
      b.rows.map((r) => `<tr><td>${sw(r.model)}</td><td>${r.chunkKb}KB</td><td>${r.bugsFound}/${b.knownBugs}</td><td>${f2(r.quality)}</td><td>${usd(r.usdPer100Kb)}</td><td>${usd(r.usdPer1kLoc)}</td><td>${usd(r.calibrationUsd)}</td><td class="l muted">${esc(r.note || '')}</td></tr>`).join('');
  }

  // ---------- head-to-head
  const h2h = [];
  for (const r of data.repos) for (const c of r.compares) {
    const scanOf = (id) => r.scans.find((s) => s.id === id && s.store === c.store) || {};
    h2h.push(`<h3>${repoLink(r)} <span class="muted">— ${kb(c.basisKb)} in ${c.basisFiles} files compared, ${c.both} issues found by both</span></h3>
      <div class="table-wrap"><table><tr><th>model</th>${sevTh}<th>only this one</th><th>share</th><th>confirmed</th><th>false pos.</th><th>precision</th><th>whole scan $</th><th>$/100KB</th></tr>` +
      c.scans.map((x) => { const s = scanOf(x.id); return `<tr><td>${withEffort(x.model, s.effort)}</td>${sevTd(x.findings, x.severity)}<td>${x.unique}</td><td><b>${f2(x.share)}</b></td><td>${x.confirmed}</td><td>${x.falsePositive}</td><td>${f2(x.precision)}</td><td>${usd(s.usd)}</td><td>${usd(s.usdPer100Kb)}</td></tr>`; }).join('') +
      '</table></div>');
  }
  $('h2h-body').innerHTML = h2h.join('') || '<p class="muted">No head-to-head scans yet.</p>';

  // ---------- cost bars
  (function () {
    const rows = allScans.filter((s) => s.usdPer100Kb).sort((a, b) => a.usdPer100Kb - b.usdPer100Kb);
    const W = 640, rowH = 24, L = 210, R = 60, T = 4;
    const H = T + rows.length * rowH + 22;
    const max = nice(Math.max(...rows.map((r) => r.usdPer100Kb)));
    const X = (v) => L + (v / max) * (W - L - R);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'price per 100KB by scan' });
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      svgEl('line', { x1: X(v), x2: X(v), y1: T, y2: H - 20, class: 'grid' }, svg);
      svgEl('text', { x: X(v), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = '$' + v.toFixed(2);
    }
    rows.forEach((s, i) => {
      const y = T + i * rowH;
      svgEl('text', { x: L - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'lbl' }, svg).textContent = `${s.repo.name.replace(/^scylladb\//, '')} · ${modelInfo(s.model).name}${s.effort ? ' ' + s.effort : ''}`;
      const w = Math.max(2, X(s.usdPer100Kb) - L);
      svgEl('rect', { x: L, y: y + 4, width: w, height: rowH - 8, rx: 4, fill: modelInfo(s.model).color }, svg);
      svgEl('text', { x: L + w + 6, y: y + rowH / 2 + 4 }, svg).textContent = usd(s.usdPer100Kb);
      const hit = svgEl('rect', { x: 0, y, width: W, height: rowH, class: 'hit' }, svg);
      bindTip(hit, `<b>${esc(s.repo.name)}</b> · ${esc(modelInfo(s.model).name)}${s.effort ? ' ' + esc(s.effort) : ''}<br>${kb(s.kb)} reviewed, ${s.findings} findings<br>${usd(s.usd)} total · ${usd(s.usdPer100Kb)}/100KB`);
    });
    $('cost-chart').appendChild(svg);
  })();
  $('scan-table').innerHTML = `<tr><th>repository</th><th>model</th><th>code</th><th>files</th>${sevTh}<th>triaged</th><th>precision</th><th>$</th><th>$/100KB</th></tr>` +
    allScans.sort((a, b) => a.repo.name.localeCompare(b.repo.name) || b.kb - a.kb).map((s) =>
      `<tr><td>${repoLink(s.repo)}</td><td>${withEffort(s.model, s.effort)}</td><td>${kb(s.kb)}</td><td>${s.files}</td>${sevTd(s.findings, s.severity)}<td>${s.triaged}</td><td>${f2(s.precision)}</td><td>${usd(s.usd)}</td><td>${usd(s.usdPer100Kb)}</td></tr>`).join('');

  // ---------- calibration small multiples
  (function () {
    const curveRepos = data.repos.filter((r) => r.curves.length);
    const seen = new Set();
    for (const r of curveRepos) {
      const W = 300, H = 170, L = 30, R = 10, T = 10, B = 26;
      const sizes = [...new Set(r.curves.flatMap((c) => c.rounds.map((x) => x.kb)))].sort((a, b) => a - b);
      const X = (v) => L + (sizes.indexOf(v) / Math.max(1, sizes.length - 1)) * (W - L - R);
      const Y = (v) => T + (1 - v) * (H - T - B);
      const box = document.createElement('div'); box.className = 'chart';
      box.innerHTML = `<h4>${repoLink(r)}</h4>`;
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
      $('cal-charts').appendChild(box);
    }
    $('cal-legend').innerHTML = MODELS.filter(([k]) => [...seen].some((m) => m.includes(k))).map(([k]) => `<span>${sw(k)}</span>`).join('') +
      '<span class="muted">filled dot = size calibration chose</span>';
  })();

  // ---------- init tables
  $('init-body').innerHTML = data.repos.flatMap((r) => r.inits.map((i) =>
    `<h3>${repoLink(r)} <span class="muted">— ${kb(i.sampleKb)} sample, ${i.issues} distinct issues (${esc(i.created)})</span></h3>
     <div class="table-wrap"><table><tr><th>model</th><th>chunk</th><th>quality</th><th>findings</th><th>$/100KB</th><th>calibration $</th><th class="l">status</th></tr>` +
    i.rows.sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1)).map((x) => `<tr><td>${withEffort(x.model, x.effort)}</td><td>${x.chunkKb ? x.chunkKb + 'KB' : '–'}</td><td><b>${f2(x.quality)}</b></td><td>${x.findings ?? '–'}</td><td>${usd(x.usdPer100Kb)}</td><td>${usd(x.calibrationUsd)}</td><td class="l">${esc(x.status)}</td></tr>`).join('') +
    '</table></div>')).join('');

  // ---------- triage
  const tri = data.repos.flatMap((r) => r.triage.map((t) => ({ ...t, repo: r })));
  $('triage-table').innerHTML = `<tr><th>repository</th><th>triage model</th><th>findings</th><th>real</th><th>false pos.</th><th>won't fix</th><th>unsure</th><th>severity changed</th><th>$/finding</th></tr>` +
    tri.map((t) => `<tr><td>${repoLink(t.repo)}</td><td>${t.model ? withEffort(t.model, t.effort) : '<span class="muted">not recorded</span>'}</td><td>${t.findings}</td><td>${t.verdicts.real || 0}</td><td>${t.verdicts.false_positive || 0}</td><td>${t.verdicts.wontfix || 0}</td><td>${t.verdicts.unsure || 0}</td><td>${t.severityChanged}</td><td>${t.usdPerFinding === null ? '–' : '$' + t.usdPerFinding.toFixed(3)}</td></tr>`).join('');

  // ---------- languages
  const LANGS = { go: ['Go'], rust: ['Rust'], 'c++': ['C++'], 'ts+rust': ['TypeScript', 'Rust'], ts: ['TypeScript'], js: ['JavaScript'], java: ['Java'], 'c#': ['C#'] };
  const langsOf = (r) => LANGS[r.lang] || (r.lang ? [r.lang] : []);
  const langNames = [...new Set(data.repos.flatMap(langsOf))].sort();
  const reposOf = (L) => data.repos.filter((r) => L === 'any' || langsOf(r).includes(L));
  const family = (m) => modelInfo(m).name;
  const range = (xs, fmt) => { xs = xs.filter((v) => v !== null && v !== undefined); if (!xs.length) return '–'; const a = Math.min(...xs), b = Math.max(...xs); return a === b ? fmt(a) : `${fmt(a)}–${fmt(b)}`; };
  function evidence(L) {
    const items = [];
    let compared = false;
    for (const r of reposOf(L)) {
      for (const c of r.compares) {
        compared = true;
        const [a, b] = c.scans.slice().sort((x, y) => y.share - x.share);
        const sa = r.scans.find((s) => s.id === a.id && s.store === c.store) || {}, sb = r.scans.find((s) => s.id === b.id && s.store === c.store) || {};
        const at = (x) => (x.usdPer100Kb ? ` at ${usd(x.usdPer100Kb)}/100KB` : '');
        items.push(`${repoLink(r)} (same ${kb(c.basisKb)}): ${sw(a.model)} found share <b>${f2(a.share)}</b>${at(sa)} vs ${sw(b.model)} ${f2(b.share)}${at(sb)}`);
      }
      for (const i of r.inits) {
        compared = true;
        const rows = i.rows.filter((x) => x.status === 'done').sort((x, y) => y.quality - x.quality);
        items.push(`${repoLink(r)} calibration sample (${kb(i.sampleKb)}): ${rows.map((x) => `${sw(x.model)} ${f2(x.quality)}`).join(', ')}`);
      }
      for (const e of r.efforts || []) {
        compared = true;
        const best = (m) => e.rows.filter((x) => family(x.model) === m).sort((x, y) => y.confirmedRecall - x.confirmedRecall)[0];
        const cx = best('Codex gpt-6.1-sol'), op = best('Opus 5.5');
        items.push(`${repoLink(r)} effort study: best ${sw(cx.model)} <code>${esc(cx.effort)}</code> recall <b>${f2(cx.confirmedRecall)}</b> at ${usd(cx.usdPer100Kb)}/100KB; best ${sw(op.model)} <code>${esc(op.effort)}</code> ${f2(op.confirmedRecall)} at ${usd(op.usdPer100Kb)}/100KB`);
      }
      const fams = [...new Set(r.scans.map((s) => family(s.model)))];
      if (!r.compares.length && !(r.efforts || []).length && fams.length === 1) {
        const s = r.scans[0];
        items.push(`${repoLink(r)}: only ${sw(s.model)} ran — ${s.findings} findings, precision ${f2(s.precision)}${s.usdPer100Kb ? `, ${usd(s.usdPer100Kb)}/100KB` : ''}`);
      }
    }
    if (L !== 'any' && data.bench && L === 'Go') items.push(`gocql known-bug benchmark: Opus 5.5 found 7/7, Fable 6/7, Sonnet 4/7, Haiku 2/7`);
    return { items, compared };
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
    value: { title: 'Codex gpt-6.1-sol at <code>xhigh</code>', runs: [['codex-xhigh', CX, 'xhigh']], recall: '0.40', price: '$0.75', perBug: '$0.10',
      why: 'Highest recall per dollar in the effort study, and the largest share of issues on every repository where it ran next to a Claude model.' },
    most: { title: 'Codex <code>xhigh</code> + Opus <code>max</code>, side by side', runs: [['codex-xhigh', CX, 'xhigh'], ['opus-max', OP, 'max']], recall: '0.66', price: '$6.64', perBug: '$0.46',
      why: 'No single run found more than 41% of the confirmed issues; two different reviewers overlap little. Cheaper pair: Codex <code>high</code> + <code>xhigh</code>, recall 0.49 at $1.18/100KB.' },
    cheap: { title: 'Codex gpt-6.1-sol at <code>medium</code>', runs: [['codex-medium', CX, 'medium']], recall: '0.23', price: '$0.30', perBug: '$0.07',
      why: 'The cheapest level that still finds a useful share; <code>low</code> saves $0.06/100KB but drops recall to 0.17. Precision is the same at every level.' },
    claude: { title: 'Opus 5.5 at <code>medium</code>', runs: [['opus-medium', OP, 'medium']], recall: '0.15', price: '$1.01', perBug: '$0.28',
      why: 'Opus at low, medium and high found about the same; medium is the cheap middle. For depth use <code>max</code> (recall 0.35 at $5.89/100KB). Fable 5.2 scores higher on small samples but costs ~2× Opus.' },
  };
  const NOTES = {
    'Go|claude': 'On Go, Opus is the strongest Claude reviewer: 7/7 known gocql bugs and the top score (0.74) on the private Go sample. Sonnet came close there (0.68 at $0.31/100KB) but found only 4/7 known bugs.',
    'Go|value': 'On gocql Codex found share 0.76 vs Fable 0.43 on the same 1.4MB.',
    'C++|claude': 'On the seastar sample Fable scored highest (0.65 vs Opus 0.48) at about twice Opus\'s price; Sonnet scored 0.09 — avoid it on C++.',
    'C++|value': 'On seastar Codex found share 0.81 vs Opus 0.30, at a lower price per 100KB.',
    'Rust|value': 'On scylla-rust-driver Codex and Fable found similar shares (0.59 vs 0.55) but Fable cost about 7× as much.',
    'Rust|claude': 'Only Opus and Fable ran on Rust; Fable found more on scylla-rust-driver but at $1.93/100KB vs Opus $0.40.',
  };
  function renderPick() {
    const L = $('pick-lang').value, G = $('pick-goal').value, g = GOALS[G];
    const ev = evidence(L);
    const note = NOTES[`${L}|${G}`] || (L !== 'any' && !ev.compared ? `No two models were compared on ${esc(L)} yet, so this is the general recommendation. Run <code>/code-scan:init</code> to compare models on your own repository.` : '');
    const chunks = g.runs.map(([, m]) => {
      if (m.startsWith('codex:')) return `${sw(m)}: 40KB (every Codex scan here used 40KB; not calibrated yet)`;
      const c = chunkFor(L, m) || chunkFor('any', m);
      return `${sw(m)}: let <code>init</code> calibrate it${c ? ` (chosen before: ${esc(c)})` : ''}`;
    });
    const cmds = g.runs.map(([n, m, e]) => `code-scan.js profile register ${n} --prompt default --model ${m} --effort ${e}`).join('\n') +
      `\ncode-scan.js start --profile ${g.runs.map(([n]) => n).join(',')}`;
    $('pick-out').innerHTML = `<div class="setup">
      <h3>${g.title}${ev.compared ? '<span class="badge strong">compared on this language</span>' : L === 'any' ? '' : '<span class="badge">general recommendation</span>'}</h3>
      <p>${g.why}</p>${note ? `<p>${note}</p>` : ''}
      <div class="facts"><div><b>${g.recall}</b>recall in the effort study</div><div><b>${g.price}</b>per 100KB of code</div><div><b>${g.perBug}</b>per confirmed bug</div><div><b>0.94–0.99</b>precision after triage</div></div>
      <p class="muted" style="margin:4px 0">Chunk size</p><ul>${chunks.map((c) => `<li>${c}</li>`).join('')}</ul>
      <pre><code>${esc(cmds)}</code></pre>
      <p class="muted" style="margin:4px 0">Evidence for ${L === 'any' ? 'all languages' : esc(L)}</p>
      <ul>${ev.items.map((x) => `<li>${x}</li>`).join('') || '<li class="muted">No scans in this language yet.</li>'}</ul></div>`;
  }
  $('pick-lang').innerHTML = `<option value="any">Any language</option>` + langNames.map((l) => `<option>${esc(l)}</option>`).join('') + '<option value="other">Other</option>';
  for (const id of ['pick-lang', 'pick-goal']) $(id).addEventListener('change', renderPick);
  renderPick();

  // ---------- models by language
  $('lang-table').innerHTML = `<tr><th class="l">language</th><th class="l">repositories</th><th class="l">models run</th><th class="l">compared?</th><th>Codex $/100KB</th><th>Opus $/100KB</th><th>Opus precision</th><th class="l">Opus chunk</th></tr>` +
    langNames.map((L) => {
      const rs = reposOf(L), ev = evidence(L);
      const scans = rs.flatMap((r) => r.scans).filter(atRecommended);
      const fams = [...new Set(scans.map((s) => s.model).concat(rs.flatMap((r) => r.inits.flatMap((i) => i.rows.map((x) => x.model)))).map(family))].map((f) => SHORT[f] || f);
      const of = (f) => scans.filter((s) => family(s.model) === f);
      return `<tr><td class="l"><b>${esc(L)}</b></td><td class="l" style="white-space:normal">${rs.map(repoLink).join(', ')}</td><td class="l" style="white-space:normal">${fams.map(esc).join(', ')}</td>
        <td class="l">${ev.compared ? 'yes' : '<span class="muted">no</span>'}</td><td>${range(of('Codex gpt-6.1-sol').map((s) => s.usdPer100Kb), usd)}</td><td>${range(of('Opus 5.5').map((s) => s.usdPer100Kb), usd)}</td>
        <td>${range(of('Opus 5.5').map((s) => s.precision), f2)}</td><td class="l">${esc(chunkFor(L, OP, true) || '–')}</td></tr>`;
    }).join('');

  // ---------- effort
  (function () {
    const studies = data.repos.flatMap((r) => (r.efforts || []).map((e) => ({ ...e, repo: r })));
    const host = $('effort-body');
    if (!studies.length) { host.innerHTML = '<p class="muted">No effort study yet.</p>'; return; }
    const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    for (const st of studies) {
      const rows = st.rows.slice().sort((a, b) => modelInfo(a.model).name.localeCompare(modelInfo(b.model).name) || ORDER.indexOf(a.effort) - ORDER.indexOf(b.effort));
      const sec = document.createElement('div');
      sec.innerHTML = `<h3>${repoLink(st.repo)} <span class="muted">— ${kb(st.basisKb)} in ${st.basisFiles} files, every scan on the same commit, plan and 40KB chunks;
        ${st.issues} distinct issues, ${st.confirmedIssues} confirmed${st.triagedBy ? ' by ' + esc(st.triagedBy) : ''}</span></h3>`;
      // recall of confirmed issues vs whole-scan price, one line per model through its effort levels
      const fig = document.createElement('figure');
      const chart = document.createElement('div'); chart.className = 'chart';
      const W = 640, H = 300, L = 44, R = 30, T = 12, B = 36;
      const pts = rows.filter((r) => r.usd !== null && r.confirmedRecall !== null);
      const xMax = nice(Math.max(...pts.map((p) => p.usd)) * 1.1);
      const X = (v) => L + (v / xMax) * (W - L - R), Y = (v) => T + (1 - v) * (H - T - B);
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'recall of confirmed issues vs price by effort level' });
      for (let i = 0; i <= 4; i++) {
        svgEl('line', { x1: L, x2: W - R, y1: Y(i / 4), y2: Y(i / 4), class: 'grid' }, svg);
        svgEl('text', { x: L - 6, y: Y(i / 4) + 4, 'text-anchor': 'end' }, svg).textContent = (i / 4).toFixed(2);
        svgEl('text', { x: X((xMax * i) / 4), y: H - B + 16, 'text-anchor': 'middle' }, svg).textContent = '$' + ((xMax * i) / 4).toFixed(0);
      }
      svgEl('text', { x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle' }, svg).textContent = 'whole-scan price ($)';
      const models = [...new Set(pts.map((p) => p.model))];
      for (const m of models) {
        const ps = pts.filter((p) => p.model === m).sort((a, b) => ORDER.indexOf(a.effort) - ORDER.indexOf(b.effort));
        svgEl('polyline', { points: ps.map((p) => `${X(p.usd)},${Y(p.confirmedRecall)}`).join(' '), fill: 'none', stroke: modelInfo(m).color, 'stroke-width': 2 }, svg);
        for (const p of ps) {
          svgEl('circle', { cx: X(p.usd), cy: Y(p.confirmedRecall), r: 5, fill: modelInfo(m).color, stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
          svgEl('text', { x: X(p.usd) + 8, y: Y(p.confirmedRecall) - 6, class: 'lbl' }, svg).textContent = p.effort;
          bindTip(svgEl('circle', { cx: X(p.usd), cy: Y(p.confirmedRecall), r: 14, class: 'hit' }, svg),
            `<b>${esc(modelInfo(m).name)} ${esc(p.effort)}</b><br>recall ${f2(p.confirmedRecall)} · ${p.confirmed} confirmed, ${p.falsePositive} false pos.<br>${usd(p.usd)} · ${usd(p.usdPer100Kb)}/100KB`);
        }
      }
      chart.appendChild(svg);
      fig.appendChild(chart);
      const cap = document.createElement('figcaption');
      cap.innerHTML = `<div class="legend">${models.map((m) => `<span>${sw(m)}</span>`).join('')}</div>Recall = severity-weighted share of all confirmed issues found by any of these scans. Up and left is better.`;
      fig.appendChild(cap);
      sec.appendChild(fig);
      const lab = (r) => `<td>${sw(r.model)}</td><td class="l">${esc(r.effort || '–')}</td>`;
      const t1 = document.createElement('div'); t1.className = 'table-wrap';
      t1.innerHTML = `<table><tr><th>model</th><th class="l">effort</th><th>recall</th><th>precision</th><th>confirmed</th><th>false pos.</th><th>untriaged</th><th>only this one</th><th>$</th><th>$/100KB</th><th>$/confirmed</th><th>output tokens</th><th>agent min</th></tr>` +
        rows.map((r) => `<tr>${lab(r)}<td><b>${f2(r.confirmedRecall)}</b></td><td>${f2(r.precision)}</td><td>${r.confirmed}</td><td>${r.falsePositive}</td><td>${r.untriaged}</td><td>${r.unique}</td><td>${usd(r.usd)}</td><td>${usd(r.usdPer100Kb)}</td><td>${usd(r.usdPerConfirmed)}</td><td>${r.outputTokens ? (r.outputTokens / 1e6).toFixed(2) + 'M' : '–'}</td><td>${r.agentMinutes ?? '–'}</td></tr>`).join('') + '</table>';
      sec.appendChild(t1);
      const h = document.createElement('h4'); h.textContent = 'Findings by severity: as reported by the reviewer, and confirmed at the severity triage settled on'; h.className = 'muted'; h.style.margin = '16px 0 4px';
      sec.appendChild(h);
      const t2 = document.createElement('div'); t2.className = 'table-wrap';
      t2.innerHTML = `<table><tr><th rowspan="2">model</th><th rowspan="2" class="l">effort</th><th colspan="5">reported</th><th colspan="5">confirmed (triaged severity)</th></tr><tr>${sevTh}${sevTh}</tr>` +
        rows.map((r) => `<tr>${lab(r)}${sevTd(r.findings, r.severity)}${sevTd(r.confirmed, r.confirmedSeverity)}</tr>`).join('') + '</table>';
      sec.appendChild(t2);
      if (st.combos && st.combos.length) {
        const h2 = document.createElement('h4'); h2.className = 'muted'; h2.style.margin = '16px 0 4px';
        h2.textContent = 'Several runs together: recall of their union and their combined price';
        sec.appendChild(h2);
        const t3 = document.createElement('div'); t3.className = 'table-wrap';
        const best = rows.reduce((a, r) => (r.confirmedRecall > (a ? a.confirmedRecall : -1) ? r : a), null);
        t3.innerHTML = `<table><tr><th>runs</th><th>recall</th><th>$</th></tr>` +
          (best ? `<tr><td class="l">${withEffort(best.model, best.effort)} <span class="muted">(best single run)</span></td><td><b>${f2(best.confirmedRecall)}</b></td><td>${usd(best.usd)}</td></tr>` : '') +
          st.combos.map((c) => `<tr><td class="l">${c.runs.map((r) => withEffort(r.model, r.effort)).join(' + ')}</td><td><b>${f2(c.recall)}</b></td><td>${usd(c.usd)}</td></tr>`).join('') + '</table>';
        t3.querySelectorAll('td.l').forEach((td) => { td.style.whiteSpace = 'normal'; });
        sec.appendChild(t3);
      }
      host.appendChild(sec);
    }
  })();
})();
