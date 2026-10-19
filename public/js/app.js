/* Cleaner page: file intake, the review list, batch toggles and downloads. */
(function () {
  'use strict';
  const AIV = window.AIV;
  const $ = (s, r = document) => r.querySelector(s);

  const IMAGE_EXT = /\.(jpe?g|jpe|jfif|pjpeg|png|apng|webp|gif|heic|heif|hif|avif|bmp)$/i;
  const SHOWABLE = new Set(['JPEG', 'PNG', 'WebP', 'GIF', 'AVIF', 'BMP']);
  const CONCURRENCY = 3;

  const state = { items: [], seq: 0, queue: [], running: 0, busy: false };

  const el = {
    body: document.body,
    drop: $('#drop'),
    horizon: $('#drop .horizon'),
    fileInput: $('#file-input'),
    folderInput: $('#folder-input'),
    pickFiles: $('#pick-files'),
    pickFolder: $('#pick-folder'),
    workspace: $('#workspace'),
    ovTitle: $('#ov-title'),
    ovSub: $('#ov-sub'),
    kindList: $('#kind-list'),
    kindsPanel: $('#kinds-panel'),
    fileList: $('#file-list'),
    clearAll: $('#clear-all'),
    bar: $('#actionbar'),
    abMain: $('#ab-main'),
    abSub: $('#ab-sub'),
    dlAll: $('#download-all'),
    veil: $('#veil'),
    live: $('#live'),
    tpl: $('#tpl-file'),
  };

  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const announce = (msg) => { el.live.textContent = ''; setTimeout(() => { el.live.textContent = msg; }, 30); };

  // input

  const ua = navigator.userAgent;
  const isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (isIOS || !('webkitdirectory' in el.folderInput)) el.pickFolder.hidden = true;

  el.pickFiles.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
  el.pickFolder.addEventListener('click', (e) => { e.stopPropagation(); el.folderInput.click(); });
  el.drop.addEventListener('click', (e) => { if (!e.target.closest('button')) el.fileInput.click(); });

  el.fileInput.addEventListener('change', () => {
    addFiles([...el.fileInput.files].map((f) => ({ file: f, path: f.name })), false);
    el.fileInput.value = '';
  });
  el.folderInput.addEventListener('change', () => {
    addFiles([...el.folderInput.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })), true);
    el.folderInput.value = '';
  });

  // Drag and drop anywhere on the page.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    setDragging(true, e);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragging(true, e);
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDragging(false);
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDragging(false);
    swallow();
    const { files, fromFolder } = await collectDropped(e.dataTransfer);
    addFiles(files, fromFolder);
  });

  function setDragging(on, e) {
    const hasItems = state.items.length > 0;
    el.drop.classList.toggle('is-over', on && !hasItems);
    el.veil.classList.toggle('show', on && hasItems);
  }

  function swallow() {
    for (const h of [el.horizon]) {
      h.classList.remove('swallow');
      void h.offsetWidth;
      h.classList.add('swallow');
    }
  }
  el.horizon.addEventListener('animationend', (e) => { if (e.target.classList.contains('core')) el.horizon.classList.remove('swallow'); });

  async function collectDropped(dt) {
    const entries = [...dt.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return { files: [...dt.files].map((f) => ({ file: f, path: f.name })), fromFolder: false };
    const out = [];
    let fromFolder = false;
    const walk = async (entry) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
        if (file) out.push({ file, path: entry.fullPath.replace(/^\//, '') || file.name });
      } else if (entry.isDirectory) {
        fromFolder = true;
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const child of batch) await walk(child);
        } while (batch.length);
      }
    };
    for (const entry of entries) await walk(entry);
    return { files: out, fromFolder };
  }

  // items

  function addFiles(list, fromFolder) {
    let skipped = 0;
    const added = [];
    for (const { file, path } of list) {
      const name = file.name;
      if (name.startsWith('.') || name === 'Thumbs.db' || name === 'desktop.ini') { skipped++; continue; }
      const looksImage = IMAGE_EXT.test(name) || (file.type && file.type.startsWith('image/'));
      if (fromFolder && !looksImage) { skipped++; continue; }
      const item = {
        id: ++state.seq, file, name, path, size: file.size,
        status: 'queued', signals: [], analysis: null, open: false, result: null, node: null, thumb: null,
      };
      state.items.push(item);
      added.push(item);
    }
    if (!added.length) {
      if (skipped) announce(`No images found. ${plural(skipped, 'file')} skipped.`);
      return;
    }
    el.body.classList.add('has-files');
    el.workspace.hidden = false;
    el.bar.hidden = false;
    added.forEach((it, i) => { renderRow(it, true); it.node.style.setProperty('--d', Math.min(i, 12)); state.queue.push(it); });
    pump();
    renderSummary();
    announce(`Added ${plural(added.length, 'image')}${skipped ? `, skipped ${plural(skipped, 'other file')}` : ''}. Reading metadata.`);
    if (skipped) state.skipped = (state.skipped || 0) + skipped;
  }

  function pump() {
    while (state.running < CONCURRENCY && state.queue.length) {
      const it = state.queue.shift();
      if (!state.items.includes(it)) continue;
      state.running++;
      analyzeItem(it).finally(() => { state.running--; pump(); if (!state.running && !state.queue.length) onAllRead(); });
    }
  }

  async function analyzeItem(it) {
    it.status = 'analyzing';
    renderRow(it);
    try {
      const buf = new Uint8Array(await it.file.arrayBuffer());
      const a = await AIV.analyze(buf);
      if (!a.supported) { it.status = 'unsupported'; it.error = a.reason; }
      else {
        it.status = 'ready';
        it.analysis = a;
        it.format = a.format;
        it.signals = a.signals.map((s) => ({ ...s, remove: kindDefault(s.kind) }));
      }
    } catch (err) {
      console.error(err);
      it.status = 'error';
      it.error = 'This file could not be read. It may be damaged.';
    }
    renderRow(it);
    renderSummary();
  }

  // New files follow whatever the batch toggles currently say.
  function kindDefault(kind) {
    const k = state.kindChoice && state.kindChoice[kind];
    return k === undefined ? true : k;
  }

  function onAllRead() {
    const ready = state.items.filter((i) => i.status === 'ready');
    const ai = ready.filter((i) => i.signals.some((s) => s.ai)).length;
    announce(`Finished reading ${plural(ready.length, 'image')}. ${ai ? `${plural(ai, 'image')} with AI signals.` : 'No AI signals found.'}`);
  }

  function removeItem(it) {
    state.items = state.items.filter((x) => x !== it);
    if (it.thumb) URL.revokeObjectURL(it.thumb);
    if (it.node) it.node.remove();
    if (!state.items.length) resetAll();
    else renderSummary();
  }

  function resetAll() {
    for (const it of state.items) if (it.thumb) URL.revokeObjectURL(it.thumb);
    state.items = [];
    state.queue = [];
    state.kindChoice = {};
    state.skipped = 0;
    el.fileList.textContent = '';
    el.kindList.textContent = '';
    el.workspace.hidden = true;
    el.bar.hidden = true;
    el.body.classList.remove('has-files');
    announce('Cleared.');
  }
  el.clearAll.addEventListener('click', resetAll);

  // rendering: rows

  function renderRow(it, isNew) {
    if (!it.node) {
      const node = el.tpl.content.firstElementChild.cloneNode(true);
      node.dataset.id = it.id;
      if (isNew) node.classList.add('enter');
      node.querySelector('.file-name').textContent = it.path.includes('/') ? it.path : it.name;
      node.querySelector('.file-name').title = it.path;
      const toggle = node.querySelector('.file-toggle');
      const body = node.querySelector('.file-body');
      body.id = `fb-${it.id}`;
      toggle.setAttribute('aria-controls', body.id);
      toggle.addEventListener('click', () => {
        it.open = !it.open;
        node.classList.toggle('open', it.open);
        toggle.setAttribute('aria-expanded', String(it.open));
        if (it.open) renderBody(it);
      });
      node.querySelector('.file-dl').addEventListener('click', () => downloadOne(it));
      it.node = node;
      el.fileList.appendChild(node);
    }
    const n = it.node;
    const meta = n.querySelector('.file-meta');
    const fb = n.querySelector('.thumb-fallback');
    const dl = n.querySelector('.file-dl');
    const toggle = n.querySelector('.file-toggle');
    const tag = n.querySelector('.tag-ai');

    fb.textContent = (it.format || it.name.split('.').pop() || '').toUpperCase().slice(0, 4);
    if (it.status === 'ready' && !it.thumb && SHOWABLE.has(it.format)) {
      it.thumb = URL.createObjectURL(it.file);
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => img.remove());
      img.src = it.thumb;
      n.querySelector('.thumb').prepend(img);
    }

    const size = AIV.fmtBytes(it.size);
    dl.setAttribute('aria-label', `Download cleaned ${it.name}`);
    if (it.status === 'queued' || it.status === 'analyzing') {
      meta.innerHTML = '';
      meta.append(span('busy', 'Reading metadata'), ` · ${size}`);
      dl.disabled = true; toggle.disabled = true; tag.hidden = true;
    } else if (it.status === 'unsupported' || it.status === 'error') {
      meta.innerHTML = '';
      meta.append(span('bad', it.status === 'error' ? 'Couldn’t read' : 'Not supported'), ` · ${it.error}`);
      dl.disabled = true; toggle.disabled = false; tag.hidden = true;
    } else {
      const total = it.signals.length;
      const sel = it.signals.filter((s) => s.remove).length;
      meta.innerHTML = '';
      let what;
      if (!total) what = 'No metadata found';
      else if (sel === total) what = `${plural(total, 'item')} to remove`;
      else what = `${sel} of ${total} items to remove`;
      meta.append(`${it.format} · ${size} · ${what}`);
      if (it.result) {
        meta.append(' · ');
        meta.append(it.result.ok ? span('ok', 'Cleaned') : span('bad', 'Check result'));
      }
      dl.disabled = false; toggle.disabled = false;
      tag.hidden = !it.signals.some((s) => s.ai);
      tag.title = 'Contains AI signals';
    }
    if (it.open) renderBody(it);
  }

  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function renderBody(it) {
    const inner = it.node.querySelector('.file-body-inner');
    inner.textContent = '';
    if (it.status === 'unsupported' || it.status === 'error') {
      const p = document.createElement('p');
      p.className = 'file-msg';
      p.textContent = it.status === 'unsupported'
        ? `${it.error}. It will be left out of the download.`
        : it.error;
      inner.append(p, foot(it));
      return;
    }
    if (it.status !== 'ready') return;
    if (!it.signals.length) {
      const p = document.createElement('p');
      p.className = 'file-empty';
      p.textContent = 'Nothing to remove. This file has no metadata blocks. It will still be saved with the _stripped name.';
      inner.append(p, foot(it));
      return;
    }
    const groups = [
      ['AI signals', it.signals.filter((s) => s.ai)],
      ['Other metadata', it.signals.filter((s) => !s.ai)],
    ];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      const g = document.createElement('div');
      g.className = 'sig-group';
      const h = document.createElement('h4');
      h.textContent = title;
      const ul = document.createElement('ul');
      ul.className = 'sig-list';
      for (const s of list) ul.appendChild(sigRow(it, s));
      g.append(h, ul);
      inner.appendChild(g);
    }
    if (it.result && !it.result.ok) {
      const p = document.createElement('p');
      p.className = 'file-msg';
      p.textContent = 'Read-back check: ' + it.result.problems.join('; ') + '.';
      inner.appendChild(p);
    }
    inner.appendChild(foot(it));
  }

  function foot(it) {
    const f = document.createElement('div');
    f.className = 'file-foot';
    if (it.status === 'ready' && it.signals.length) {
      const all = it.signals.every((s) => s.remove);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      b.textContent = all ? 'Keep everything' : 'Remove everything';
      b.addEventListener('click', () => {
        it.signals.forEach((s) => { s.remove = !all; });
        it.result = null;
        renderRow(it);
        renderSummary();
      });
      f.appendChild(b);
    }
    const r = document.createElement('button');
    r.type = 'button';
    r.className = 'link-btn';
    r.textContent = 'Remove from list';
    r.addEventListener('click', () => removeItem(it));
    f.appendChild(r);
    return f;
  }

  function sigRow(it, s) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'sig-row' + (s.remove ? '' : ' keep');
    const check = checkbox(s.remove);
    check.input.setAttribute('aria-describedby', `sd-${it.id}-${cssId(s.id)}`);
    check.input.addEventListener('change', () => {
      s.remove = check.input.checked;
      label.classList.toggle('keep', !s.remove);
      it.result = null;
      updateRowMeta(it);
      renderSummary();
    });
    const text = document.createElement('span');
    text.className = 'sig-text';
    const top = document.createElement('span');
    top.className = 'sig-top';
    const lab = span('sig-label', s.label);
    top.appendChild(lab);
    if (s.ai) top.appendChild(span('tag-ai', 'AI'));
    const where = [s.source, s.size ? AIV.fmtBytes(s.size) : ''].filter(Boolean).join(' · ');
    if (where) top.appendChild(span('sig-size', where));
    const det = span('sig-detail', s.detail || '');
    det.id = `sd-${it.id}-${cssId(s.id)}`;
    text.append(top, det);
    if (s.notes && s.notes.length) {
      const ul = document.createElement('ul');
      ul.className = 'sig-notes';
      for (const n of s.notes) { const x = document.createElement('li'); x.textContent = n; ul.appendChild(x); }
      text.appendChild(ul);
    }
    label.append(check.wrap, text);
    li.appendChild(label);
    return li;
  }

  const cssId = (s) => s.replace(/[^a-z0-9_-]/gi, '_');

  function checkbox(checked) {
    const wrap = document.createElement('span');
    wrap.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    const box = document.createElement('span');
    box.className = 'box';
    wrap.append(input, box);
    return { wrap, input };
  }

  // Lightweight update that leaves the open body (and focus) alone.
  function updateRowMeta(it) {
    const open = it.open;
    it.open = false;
    renderRow(it);
    it.open = open;
    const footBtn = it.node.querySelector('.file-foot .link-btn');
    if (footBtn && it.signals.length) footBtn.textContent = it.signals.every((s) => s.remove) ? 'Keep everything' : 'Remove everything';
  }

  // rendering: summary, kinds, bar

  // Tween a number in an element; jumps straight there for reduced motion.
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function countTo(node, target, fmt) {
    const from = Number(node.dataset.n || 0);
    node.dataset.n = target;
    if (from === target || reduceMotion.matches || document.hidden) { node.textContent = fmt(target); return; }
    const t0 = performance.now(), dur = 600;
    const tick = (t) => {
      if (Number(node.dataset.n) !== target) return;
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 4);
      node.textContent = fmt(Math.round(from + (target - from) * e));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Land on the final value even if animation frames are paused.
    setTimeout(() => { if (Number(node.dataset.n) === target) node.textContent = fmt(target); }, dur + 150);
  }

  function renderSummary() {
    const items = state.items;
    const ready = items.filter((i) => i.status === 'ready');
    const pending = items.filter((i) => i.status === 'queued' || i.status === 'analyzing').length;
    const bad = items.filter((i) => i.status === 'unsupported' || i.status === 'error').length;
    const aiFiles = ready.filter((i) => i.signals.some((s) => s.ai)).length;
    const found = ready.reduce((n, i) => n + i.signals.length, 0);
    const selected = ready.reduce((n, i) => n + i.signals.filter((s) => s.remove).length, 0);

    countTo(el.ovTitle, items.length, (n) => plural(n, 'image'));
    el.ovSub.textContent = '';
    if (pending) el.ovSub.append(`Reading ${pending.toLocaleString()} of ${items.length.toLocaleString()}…`);
    else {
      const parts = [];
      if (aiFiles) {
        const s = span('ai-count', `${aiFiles === ready.length && ready.length > 1 ? 'All' : aiFiles.toLocaleString()} with AI signals`);
        el.ovSub.append(s);
        parts.push('');
      } else if (ready.length) {
        el.ovSub.append('No AI signals found');
      }
      el.ovSub.append(` · ${plural(found, 'metadata item')} found`);
      if (bad) el.ovSub.append(` · ${bad.toLocaleString()} can’t be read`);
      if (state.skipped) el.ovSub.append(` · ${plural(state.skipped, 'non-image file')} skipped`);
    }

    renderKinds(ready);

    const usable = items.filter((i) => i.status === 'ready');
    el.abMain.textContent = selected
      ? `${plural(selected, 'item')} to remove`
      : (usable.length ? 'Nothing selected' : '');
    el.abSub.textContent = usable.length ? `from ${plural(usable.length, 'image')}` : (pending ? 'Reading…' : '');
    if (!state.busy) {
      el.dlAll.textContent = usable.length === 1 ? 'Download' : 'Download all';
      el.dlAll.disabled = !usable.length || pending > 0;
    }
  }

  function renderKinds(ready) {
    const kinds = new Map();
    for (const it of ready) {
      for (const s of it.signals) {
        if (!kinds.has(s.kind)) kinds.set(s.kind, { files: new Set(), on: 0, total: 0, ai: false });
        const k = kinds.get(s.kind);
        k.files.add(it.id);
        k.total++;
        if (s.remove) k.on++;
        if (s.ai) k.ai = true;
      }
    }
    el.kindsPanel.hidden = kinds.size === 0;
    const order = AIV.KIND_ORDER;
    const sorted = [...kinds.entries()].sort((a, b) => (b[1].ai - a[1].ai) || order.indexOf(a[0]) - order.indexOf(b[0]));

    // Reuse rows so focus is not lost while toggling.
    const existing = new Map([...el.kindList.children].map((li) => [li.dataset.kind, li]));
    const frag = [];
    for (const [kind, k] of sorted) {
      let li = existing.get(kind);
      if (!li) {
        li = document.createElement('li');
        li.dataset.kind = kind;
        const label = document.createElement('label');
        label.className = 'kind-row';
        const c = checkbox(true);
        c.input.addEventListener('change', () => setKind(kind, c.input.checked));
        const t = document.createElement('span');
        t.className = 'kind-text';
        t.append(span('kind-label', AIV.KINDS[kind].label), span('kind-sub', ''));
        label.append(c.wrap, t, span('tag-ai', 'AI'));
        li.appendChild(label);
      }
      existing.delete(kind);
      const input = li.querySelector('input');
      input.checked = k.on === k.total;
      input.indeterminate = k.on > 0 && k.on < k.total;
      li.querySelector('.kind-sub').textContent = ready.length === 1
        ? (k.total > 1 ? `${k.total} blocks` : 'Found in this image')
        : `In ${plural(k.files.size, 'image')}`;
      li.querySelector('.tag-ai').hidden = !k.ai;
      frag.push(li);
    }
    for (const li of existing.values()) li.remove();
    frag.forEach((li, i) => { if (el.kindList.children[i] !== li) el.kindList.insertBefore(li, el.kindList.children[i] || null); });
  }

  function setKind(kind, on) {
    state.kindChoice = state.kindChoice || {};
    state.kindChoice[kind] = on;
    for (const it of state.items) {
      let touched = false;
      for (const s of it.signals) if (s.kind === kind && s.remove !== on) { s.remove = on; touched = true; }
      if (touched) { it.result = null; renderRow(it); }
    }
    renderSummary();
    announce(`${AIV.KINDS[kind].label} will be ${on ? 'removed' : 'kept'} in every image.`);
  }

  // cleaning & downloads

  async function clean(it) {
    it.node.classList.add('cleaning');
    try { return await cleanInner(it); } finally { it.node.classList.remove('cleaning'); }
  }

  async function cleanInner(it) {
    const buf = new Uint8Array(await it.file.arrayBuffer());
    const remove = new Set(it.signals.filter((s) => s.remove).map((s) => s.id));
    // Signals carry ids from the analysis; re-analyse to get fresh parse state.
    const a = await AIV.analyze(buf);
    const out = AIV.strip(buf, a, remove);
    const check = await AIV.verify(out, a, remove);
    it.result = { ok: check.ok, problems: check.problems, size: out.length };
    renderRow(it);
    return out;
  }

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function downloadOne(it) {
    if (it.status !== 'ready') return;
    const btn = it.node.querySelector('.file-dl');
    btn.disabled = true;
    try {
      const out = await clean(it);
      save(new Blob([out], { type: AIV.MIME[it.format] || 'application/octet-stream' }), AIV.outputName(it.name));
      if (window.AIVTrack) AIVTrack.clean(1);
      flashDone(btn);
      announce(it.result.ok ? `Saved ${AIV.outputName(it.name)}.` : `Saved ${AIV.outputName(it.name)}, but the read-back check found something left. Open the image for details.`);
    } catch (err) {
      console.error(err);
      announce(`Couldn’t clean ${it.name}.`);
    } finally {
      btn.disabled = false;
    }
  }

  const CHECK = '<path d="M5 10.5l3.2 3.2L15 6.8"/>';
  function flashDone(btn) {
    const svg = btn.querySelector('svg');
    const prev = svg.innerHTML;
    svg.innerHTML = CHECK;
    btn.classList.add('done');
    setTimeout(() => { svg.innerHTML = prev; btn.classList.remove('done'); }, 1600);
  }

  function zipName(items) {
    const roots = new Set(items.map((i) => (i.path.includes('/') ? i.path.split('/')[0] : '')));
    if (roots.size === 1) {
      const r = [...roots][0];
      if (r) return `${r}_stripped.zip`;
    }
    return 'AiVoid_stripped.zip';
  }

  el.dlAll.addEventListener('click', async () => {
    const items = state.items.filter((i) => i.status === 'ready');
    if (!items.length || state.busy) return;
    if (items.length === 1) return downloadOne(items[0]);
    state.busy = true;
    el.dlAll.disabled = true;
    const label = document.createElement('span');
    el.dlAll.textContent = '';
    el.dlAll.append(span('spin', ''), label);
    try {
      const zip = AIV.zipWriter();
      let done = 0, flagged = 0, added = 0;
      for (const it of items) {
        label.textContent = `Cleaning ${++done} of ${items.length}`;
        try {
          const out = await clean(it);
          if (!it.result.ok) flagged++;
          const dir = it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/') + 1) : '';
          zip.add(dir + AIV.outputName(it.name), out);
          added++;
        } catch (err) {
          console.error(err);
          flagged++;
        }
      }
      label.textContent = 'Saving';
      save(zip.blob(), zipName(items));
      if (window.AIVTrack) AIVTrack.clean(added);
      announce(flagged ? `Saved. ${plural(flagged, 'image')} need a look: open them for details.` : `Saved ${plural(items.length, 'cleaned image')} in a ZIP file.`);
    } finally {
      state.busy = false;
      renderSummary();
    }
  });

  // visit count & scroll reveals

  if (window.AIVTrack) AIVTrack.visit();

  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      document.documentElement.classList.add('reveal-ready');
    }, { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach((n, i) => { n.style.setProperty('--i', i); io.observe(n); });
  } else reveals.forEach((n) => n.classList.add('in'));
})();
