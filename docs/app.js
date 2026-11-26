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
      <div class="table-wrap"><table><tr><th>model</th><th>findings</th><th>only this one</th><th>share</th><th>confirmed</th><th>false pos.</th><th>precision</th><th>whole scan $</th><th>$/100KB</th></tr>` +
      c.scans.map((x) => { const s = scanOf(x.id); return `<tr><td>${withEffort(x.model, s.effort)}</td><td>${x.findings}</td><td>${x.unique}</td><td><b>${f2(x.share)}</b></td><td>${x.confirmed}</td><td>${x.falsePositive}</td><td>${f2(x.precision)}</td><td>${usd(s.usd)}</td><td>${usd(s.usdPer100Kb)}</td></tr>`; }).join('') +
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
  $('scan-table').innerHTML = `<tr><th>repository</th><th>model</th><th>code</th><th>files</th><th>findings</th><th>triaged</th><th>precision</th><th>$</th><th>$/100KB</th></tr>` +
    allScans.sort((a, b) => a.repo.name.localeCompare(b.repo.name) || b.kb - a.kb).map((s) =>
      `<tr><td>${repoLink(s.repo)}</td><td>${withEffort(s.model, s.effort)}</td><td>${kb(s.kb)}</td><td>${s.files}</td><td>${s.findings}</td><td>${s.triaged}</td><td>${f2(s.precision)}</td><td>${usd(s.usd)}</td><td>${usd(s.usdPer100Kb)}</td></tr>`).join('');

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
    tri.map((t) => `<tr><td>${repoLink(t.repo)}</td><td>${t.model ? withEffort(t.model, t.effort) : '<span class="muted">manual</span>'}</td><td>${t.findings}</td><td>${t.verdicts.real || 0}</td><td>${t.verdicts.false_positive || 0}</td><td>${t.verdicts.wontfix || 0}</td><td>${t.verdicts.unsure || 0}</td><td>${t.severityChanged}</td><td>${t.usdPerFinding === null ? '–' : '$' + t.usdPerFinding.toFixed(3)}</td></tr>`).join('');

  // ---------- effort
  const E = data.efforts;
  if (!E) {
    const x = tri.filter((t) => t.effort);
    $('effort').innerHTML = `<p class="muted">A full effort-level comparison is in progress. So far: Codex triage at <code>xhigh</code> cost
      ${x.length ? '$' + x[0].usdPerFinding.toFixed(3) : '–'} per finding against ~$0.05 at the default, with the same verdict mix.</p>`;
  } else window.renderEffort && window.renderEffort(E, { $, esc, f2, usd, kb, sw, withEffort, modelInfo, svgEl, bindTip, nice, scatter });
})();
