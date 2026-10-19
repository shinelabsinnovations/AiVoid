/* Metrics page. Reads /api/stats.php and renders totals,
   a single-series column chart and the country table. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const RANGES = ['today', 'yesterday', 'week', 'month', 'year', 'lifetime'];
  const PREV_LABEL = {
    today: 'vs yesterday', yesterday: 'vs the day before', week: 'vs previous 7 days',
    month: 'vs previous 30 days', year: 'vs previous 365 days',
  };
  const TOP = 12;

  const state = {
    range: RANGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'week',
    metric: 'visitors',
    cache: new Map(),
    data: null,
    showAll: false,
  };

  const nf = new Intl.NumberFormat();
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const fmt = (n) => (n >= 1e6 ? compact.format(n) : nf.format(n));
  const regions = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(undefined, { type: 'region' }) : null;
  const countryName = (c) => {
    if (c === 'XX' || !c) return 'Unknown';
    if (c === 'T1') return 'Tor network';
    try { return (regions && regions.of(c)) || c; } catch (e) { return c; }
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const fullFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const asDate = (key) => new Date(key.length === 7 ? key + '-01T00:00:00Z' : key + 'T00:00:00Z');
  const keyLabel = (key) => (key.length === 7 ? monthFmt.format(asDate(key)) : dayFmt.format(asDate(key)));

  // controls

  function press(groupSel, attr, value) {
    document.querySelectorAll(`${groupSel} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));
  }

  $('#m-range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b || b.dataset.range === state.range) return;
    state.range = b.dataset.range;
    state.showAll = false;
    history.replaceState(null, '', '#' + state.range);
    load();
  });

  $('#m-metric').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (!b || b.dataset.metric === state.metric) return;
    state.metric = b.dataset.metric;
    press('#m-metric', 'metric', state.metric);
    if (state.data) renderChart(state.data);
  });

  $('#countries-more').addEventListener('click', () => {
    state.showAll = !state.showAll;
    if (state.data) renderCountries(state.data);
  });

  // data

  async function load() {
    press('#m-range', 'range', state.range);
    const body = $('#m-body');
    let data = state.cache.get(state.range);
    if (!data) {
      body.classList.add('loading');
      try {
        const res = await fetch(`api/stats.php?range=${state.range}`, { credentials: 'omit' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
        state.cache.set(state.range, data);
      } catch (err) {
        console.warn('Metrics unavailable. Locally, run: php tests/seed.php, then php -S localhost:5173 -t public tests/router.php', err);
        body.classList.remove('loading');
        return showError();
      }
      body.classList.remove('loading');
    }
    if (data.range !== state.range) return;
    state.data = data;
    $('#m-sample').hidden = !data.sample;
    render(data);
  }

  function showError() {
    $('#m-range-label').textContent = '';
    const body = $('#m-body');
    body.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'panel m-error';
    p.textContent = 'Metrics couldn’t be loaded right now. ';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn';
    b.textContent = 'Try again';
    b.addEventListener('click', () => location.reload());
    p.appendChild(b);
    body.appendChild(p);
  }

  // render

  function render(d) {
    $('#m-range-label').textContent = rangeLabel(d);
    for (const node of document.querySelectorAll('.stat-value')) {
      countTo(node, Number(d.totals[node.dataset.key] || 0));
    }
    for (const node of document.querySelectorAll('.stat-delta')) renderDelta(node, d, node.dataset.delta);
    renderChart(d);
    renderCountries(d);
  }

  function rangeLabel(d) {
    if (d.range === 'today' || d.range === 'yesterday') return `${longDay.format(asDate(d.to))} · UTC`;
    if (d.range === 'lifetime') return `Since ${fullFmt.format(asDate(d.from))} · UTC`;
    return `${dayFmt.format(asDate(d.from))} – ${fullFmt.format(asDate(d.to))} · UTC`;
  }

  function countTo(node, target) {
    const from = Number(node.dataset.n || 0);
    node.dataset.n = target;
    if (reduceMotion.matches || from === target || document.hidden) { node.textContent = fmt(target); return; }
    const t0 = performance.now(), dur = 700;
    const tick = (t) => {
      if (Number(node.dataset.n) !== target) return;
      const p = Math.min(1, (t - t0) / dur);
      node.textContent = fmt(Math.round(from + (target - from) * (1 - Math.pow(1 - p, 4))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Land on the final value even if animation frames are paused.
    setTimeout(() => { if (Number(node.dataset.n) === target) node.textContent = fmt(target); }, dur + 150);
  }

  const ARROW_UP = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2M2.5 5.5L6 2l3.5 3.5"/></svg>';
  const ARROW_DOWN = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M2.5 6.5L6 10l3.5-3.5"/></svg>';

  function renderDelta(node, d, key) {
    node.className = 'stat-delta';
    node.innerHTML = '';
    if (!d.previous) { node.textContent = d.range === 'lifetime' ? 'All time' : ''; return; }
    const cur = Number(d.totals[key] || 0), prev = Number(d.previous[key] || 0);
    if (!prev) { node.textContent = cur ? `New ${PREV_LABEL[d.range]}` : `No change ${PREV_LABEL[d.range]}`; return; }
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) { node.textContent = `No change ${PREV_LABEL[d.range]}`; return; }
    node.classList.add(pct > 0 ? 'up' : 'down');
    node.innerHTML = pct > 0 ? ARROW_UP : ARROW_DOWN;
    node.append(`${pct > 0 ? '+' : ''}${pct}% ${PREV_LABEL[d.range]}`);
  }

  function niceMax(v) {
    if (v <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function renderChart(d) {
    const metric = state.metric;
    const label = metric === 'files' ? 'Files cleaned' : 'Visitors';
    $('#chart-title').textContent = `${label} over time`;
    const span = d.range === 'today' || d.range === 'yesterday' ? 'Last 14 days, selected day highlighted'
      : d.bucket === 'month' ? 'By month' : 'By day';
    $('#chart-sub').textContent = span;

    const series = d.series || [];
    const max = niceMax(Math.max(0, ...series.map((s) => s[metric])));
    const grid = $('#chart-grid');
    grid.innerHTML = '';
    for (const f of [0, 0.5, 1]) {
      const line = document.createElement('div');
      line.style.top = `${(1 - f) * 100}%`;
      const t = document.createElement('span');
      t.textContent = compact.format(max * f);
      line.appendChild(t);
      grid.appendChild(line);
    }

    const chart = $('#chart');
    chart.classList.toggle('dim', !!d.highlight);
    const bars = $('#bars');
    bars.innerHTML = '';
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    series.forEach((s, i) => {
      const slot = document.createElement('div');
      slot.className = 'bar-slot' + (s.key === d.highlight ? ' hl' : '');
      slot.tabIndex = 0;
      const text = `${keyLabel(s.key)}: ${nf.format(s[metric])} ${metric === 'files' ? 'files cleaned' : 'visitors'}`;
      slot.setAttribute('aria-label', text);
      slot.setAttribute('role', 'img');
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = `${(s[metric] / max) * 100}%`;
      bar.style.setProperty('--i', Math.min(i, 60));
      slot.appendChild(bar);
      const show = () => {
        tip.hidden = false;
        tip.innerHTML = '';
        const b = document.createElement('b');
        b.textContent = nf.format(s[metric]);
        const sp = document.createElement('span');
        sp.textContent = ` ${metric === 'files' ? 'files' : 'visitors'} · ${keyLabel(s.key)}`;
        tip.append(b, sp);
        const cr = chart.getBoundingClientRect(), br = bar.getBoundingClientRect();
        const x = br.left - cr.left + br.width / 2;
        tip.style.left = `${Math.max(60, Math.min(cr.width - 60, x))}px`;
        tip.style.top = `${br.top - cr.top}px`;
      };
      slot.addEventListener('pointerenter', show);
      slot.addEventListener('focus', show);
      slot.addEventListener('pointerleave', () => { tip.hidden = true; });
      slot.addEventListener('blur', () => { tip.hidden = true; });
      bars.appendChild(slot);
    });
    bars.appendChild(tip);

    const xs = $('#chart-x');
    xs.innerHTML = '';
    if (series.length) {
      const picks = series.length > 2 ? [0, Math.floor((series.length - 1) / 2), series.length - 1] : series.map((_, i) => i);
      for (const i of picks) { const s = document.createElement('span'); s.textContent = keyLabel(series[i].key); xs.appendChild(s); }
    }

    // Table view of the same numbers.
    const t = $('#series-table');
    t.innerHTML = '';
    const head = t.createTHead().insertRow();
    for (const h of [d.bucket === 'month' ? 'Month' : 'Day', 'Visitors', 'Files cleaned']) {
      const th = document.createElement('th'); th.textContent = h; th.scope = 'col'; head.appendChild(th);
    }
    const tb = t.createTBody();
    for (const s of series.slice().reverse()) {
      const r = tb.insertRow();
      r.insertCell().textContent = keyLabel(s.key);
      r.insertCell().textContent = nf.format(s.visitors);
      r.insertCell().textContent = nf.format(s.files);
    }
  }

  function renderCountries(d) {
    const t = $('#countries');
    t.innerHTML = '';
    const list = (d.countries || []).filter((c) => c.visitors || c.files);
    const total = list.reduce((n, c) => n + Number(c.visitors || 0), 0);
    $('#countries-sub').textContent = list.length
      ? `${list.length} ${list.length === 1 ? 'country' : 'countries'} · share of visitors`
      : '';
    if (!list.length) {
      const r = t.insertRow().insertCell();
      r.className = 'm-empty';
      r.textContent = 'No visits in this period yet.';
      $('#countries-more').hidden = true;
      return;
    }
    const head = t.createTHead().insertRow();
    [['Country', ''], ['Visitors', ''], ['Files cleaned', ''], ['Share', 'm-share m-share-col']].forEach(([h, cls]) => {
      const th = document.createElement('th'); th.textContent = h; th.scope = 'col'; if (cls) th.className = cls; head.appendChild(th);
    });
    const tb = t.createTBody();
    const shown = state.showAll ? list : list.slice(0, TOP);
    shown.forEach((c, i) => {
      const r = tb.insertRow();
      const name = r.insertCell();
      const wrap = document.createElement('span');
      wrap.className = 'm-country';
      const code = document.createElement('span');
      code.className = 'm-code';
      code.textContent = c.country === 'XX' ? '—' : c.country;
      code.setAttribute('aria-hidden', 'true');
      const nm = document.createElement('span');
      nm.textContent = countryName(c.country);
      wrap.append(code, nm);
      name.appendChild(wrap);
      r.insertCell().textContent = nf.format(c.visitors || 0);
      r.insertCell().textContent = nf.format(c.files || 0);
      const share = r.insertCell();
      share.className = 'm-share-col';
      const pct = total ? (c.visitors / total) * 100 : 0;
      const cell = document.createElement('span');
      cell.className = 'm-share-cell';
      const track = document.createElement('span');
      track.className = 'm-share-track';
      const fill = document.createElement('span');
      fill.className = 'm-share-fill';
      fill.style.width = `${pct}%`;
      fill.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
      fill.style.display = 'block';
      track.appendChild(fill);
      const p = document.createElement('span');
      p.className = 'm-share-pct';
      p.textContent = pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
      cell.append(track, p);
      share.appendChild(cell);
    });
    const more = $('#countries-more');
    more.hidden = list.length <= TOP;
    more.textContent = state.showAll ? 'Show top 12' : `Show all ${list.length} countries`;
  }

  load();
})();
