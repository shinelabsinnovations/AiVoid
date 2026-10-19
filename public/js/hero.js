/* Landing motion: the event-horizon canvas inside the drop
   zone and the headline reveal. Metadata fragments drift in, stretch and
   disappear past the horizon. Pauses off-screen; static for reduced motion. */
(function () {
  'use strict';
  const drop = document.getElementById('drop');
  const horizon = drop && drop.querySelector('.horizon');
  if (!drop || !horizon) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // headline: words rise in, "AI tags" decodes
  const h1 = document.querySelector('.hero h1');
  if (h1 && !h1.dataset.split) {
    h1.dataset.split = '1';
    h1.setAttribute('aria-label', h1.textContent.trim());
    const words = h1.textContent.trim().split(/\s+/);
    h1.textContent = '';
    words.forEach((w, i) => {
      const s = document.createElement('span');
      s.className = 'word' + (/^(AI|tags)$/.test(w) ? ' decode' : '');
      s.setAttribute('aria-hidden', 'true');
      s.style.setProperty('--i', i);
      s.textContent = w;
      h1.append(s, i < words.length - 1 ? ' ' : '');
    });
    if (!reduced.matches) {
      const glyphs = '01<>/#[]{}=+*';
      h1.querySelectorAll('.decode').forEach((el, k) => {
        const final = el.textContent;
        const start = performance.now() + 420 + k * 120;
        const dur = 620;
        let locked = false;
        const tick = (t) => {
          const p = (t - start) / dur;
          if (p < 0) return requestAnimationFrame(tick);
          // Hold the word's width so the scramble doesn't push its neighbours around.
          if (!locked) { el.style.width = el.getBoundingClientRect().width + 'px'; locked = true; }
          if (p >= 1) { el.textContent = final; el.style.width = ''; return; }
          const fixed = Math.floor(p * final.length);
          el.textContent = final.slice(0, fixed) + [...final.slice(fixed)].map(() => glyphs[(Math.random() * glyphs.length) | 0]).join('');
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }
  }

  // the horizon canvas
  const canvas = document.createElement('canvas');
  canvas.className = 'hero-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  drop.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  drop.classList.add('has-canvas');

  const TOKENS = [
    'GPS 37.77, -122.41', 'C2PA · ChatGPT', 'Software: Firefly', 'prompt: astronaut cat', 'Seed: 2875531',
    'DigitalSourceType', 'Make: Canon', 'XMP', 'EXIF', 'ICC: Display P3', 'CFG scale: 7', 'Midjourney v7',
    'Steps: 30', 'IPTC Credit', 'workflow.json', 'DateTimeOriginal', 'SynthID?', 'claim_generator', 'Lens: 50mm',
  ];

  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, S = 160, r0 = 30;
  let colors = {};
  let particles = [], stars = [], tokens = [];
  let running = false, visible = true, last = 0, spawnIn = 0.4;
  let tilt = 0.34, tiltTarget = 0.34, px = 0, py = 0, pxT = 0, pyT = 0;
  let speed = 1, speedT = 1, pull = 0, collapse = 0, tokenSeq = (Math.random() * TOKENS.length) | 0;

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    colors = { text: v('--text'), text2: v('--text-2'), accent: v('--link'), core: v('--core'), edge: v('--core-edge'),
      surface: v('--surface'), chip: v('--surface-2'), line: v('--line'), mono: v('--mono') };
    if (reduced.matches || !running) draw(0);
  }

  function layout() {
    const r = drop.getBoundingClientRect();
    const h = horizon.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    cx = h.left - r.left + h.width / 2;
    cy = h.top - r.top + h.height / 2;
    S = h.width;
    r0 = S * 0.19;
    seed();
  }

  const rand = (a, b) => a + Math.random() * (b - a);

  function newParticle(outer) {
    const rMax = S * 1.55;
    return {
      r: outer ? rand(rMax * 0.85, rMax) : rand(r0 * 1.35, rMax),
      t: rand(0, Math.PI * 2),
      size: rand(0.6, 1.7),
      accent: Math.random() < 0.16,
      a: rand(0.25, 0.85),
    };
  }

  function seed() {
    particles = Array.from({ length: Math.round(Math.min(170, 70 + S * 0.5)) }, () => newParticle(false));
    stars = Array.from({ length: Math.round(W * H / 9000) }, () => ({ x: Math.random(), y: Math.random(), z: rand(0.2, 1), tw: rand(0, 6.28) }));
  }

  function spawnToken() {
    const text = TOKENS[tokenSeq++ % TOKENS.length];
    ctx.font = `500 11px ${colors.mono || 'monospace'}`;
    const w = ctx.measureText(text).width + 16;
    // Fragments enter from the left or right edge, level with the disk and
    // never lower than just under the core, so they stay clear of the copy.
    for (let tries = 0; tries < 8; tries++) {
      const left = Math.random() < 0.5;
      const x = left ? 18 + w / 2 + rand(0, W * 0.08) : W - 18 - w / 2 - rand(0, W * 0.08);
      const y = cy + rand(-Math.max(0, Math.min(cy - 26, S * 0.9)), S * 0.22);
      const dx = x - cx, dy = (y - cy) / 0.62;
      const r = Math.hypot(dx, dy);
      if (r < S * 1.1) continue;
      if (tokens.some((o) => o.left === left && Math.abs(o.y0 - y) < 30 && o.r > r * 0.6)) continue;
      tokens.push({ text, t: Math.atan2(dy, dx), r, y0: y, left, w: w - 16, age: 0, v: rand(0.85, 1.15), spin: rand(-1, 1) });
      return;
    }
  }

  function project(r, t) {
    // Point on a disk tilted toward the viewer, rotated slightly.
    const x = r * Math.cos(t), y = r * Math.sin(t) * tilt;
    const rot = -0.2 + px * 0.08;
    return [cx + x * Math.cos(rot) - y * Math.sin(rot) + px * 6, cy + x * Math.sin(rot) + y * Math.cos(rot) + py * 4];
  }

  function step(dt) {
    speed += (speedT - speed) * Math.min(1, dt * 3);
    tilt += (tiltTarget - tilt) * Math.min(1, dt * 2.5);
    px += (pxT - px) * Math.min(1, dt * 2.5);
    py += (pyT - py) * Math.min(1, dt * 2.5);
    pull += ((drop.classList.contains('is-over') ? 1 : 0) - pull) * Math.min(1, dt * 4);
    if (collapse > 0) collapse = Math.max(0, collapse - dt * 1.1);

    const k = S * 0.9;
    for (const p of particles) {
      p.t += (k / Math.pow(Math.max(p.r, r0), 1.5)) * dt * speed * 1.6;
      p.r -= (S * 0.012 + S * 0.08 * pull) * dt * speed * (S / Math.max(p.r, r0 * 0.5)) * 0.5;
      if (p.r < r0 * 1.05) Object.assign(p, newParticle(true));
    }

    spawnIn -= dt * (1 + pull * 2.5) * Math.min(speed, 2);
    if (spawnIn <= 0 && tokens.length < 5) { spawnToken(); spawnIn = rand(1.1, 1.9); }
    for (const tk of tokens) {
      tk.age += dt;
      // Slow at the edge, accelerating as it nears the horizon.
      const gravity = 1 + Math.pow(S / Math.max(tk.r, r0), 1.5);
      tk.r -= (S * 0.3 + tk.r * 0.16) * gravity * dt * tk.v * speed * (1 + pull * 1.5 + collapse * 6);
      tk.t += tk.spin * 0.06 * gravity * dt * speed;
    }
    tokens = tokens.filter((tk) => tk.r > r0 * 0.9);
  }

  function chip(tk) {
    const fade = Math.min(1, (tk.r - r0) / (S * 0.9));
    if (fade <= 0) return;
    const x = cx + Math.cos(tk.t) * tk.r + px * 10;
    const y = cy + Math.sin(tk.t) * tk.r * 0.62 + py * 6;
    // Spaghettify: stretch along the fall line, squeeze across it.
    const near = 1 - fade;
    const sx = 1 + near * 1.4, sy = Math.max(0.05, 1 - near * 0.95);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(cy - y, cx - x));
    ctx.scale(sx * (0.55 + fade * 0.45), sy * (0.55 + fade * 0.45));
    ctx.rotate(-Math.atan2(cy - y, cx - x));
    ctx.font = `500 11px ${colors.mono || 'monospace'}`;
    if (!tk.w) tk.w = ctx.measureText(tk.text).width;
    const w = tk.w + 16, h = 22;
    ctx.globalAlpha = Math.min(1, fade * 1.6, tk.age / 0.6) * (1 - collapse * 0.5);
    ctx.fillStyle = colors.chip;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, 11); else ctx.rect(-w / 2, -h / 2, w, h);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = colors.text2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(tk.text, 0, 0.5);
    ctx.restore();
  }

  function dot(p, front) {
    const [x, y] = project(p.r * (1 - collapse * 0.7), p.t);
    const behind = Math.sin(p.t) < 0;
    if (behind === front) return;
    const edge = Math.min(1, (p.r - r0) / (r0 * 1.2));
    const far = 1 - Math.min(1, p.r / (S * 1.6));
    ctx.globalAlpha = p.a * edge * (0.35 + far * 0.65) * (behind ? 0.55 : 1);
    const col = p.accent ? colors.accent : colors.text;
    // A short trail along the orbit reads as motion rather than dust.
    const [tx, ty] = project(p.r * (1 - collapse * 0.7), p.t - Math.min(0.4, (S * 0.9 / Math.pow(Math.max(p.r, r0), 1.5)) * 0.2 * speed));
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    ctx.lineWidth = p.size * (0.9 + pull * 0.4);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function draw(time) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // faint star field with parallax
    ctx.fillStyle = colors.text;
    for (const s of stars) {
      ctx.globalAlpha = 0.08 + 0.12 * s.z * (0.6 + 0.4 * Math.sin(time * 0.0012 + s.tw));
      ctx.fillRect(s.x * W - px * 14 * s.z, s.y * H - py * 10 * s.z, 1, 1);
    }

    // lensing rings
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    for (const f of [1.55, 2.15]) {
      ctx.beginPath();
      ctx.ellipse(cx + px * 6, cy + py * 4, r0 * f * (1 - pull * 0.12), r0 * f * (1 - pull * 0.12), 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const p of particles) dot(p, false);

    // photon ring
    const rot = time * 0.0004 * speed;
    const ringR = r0 * 1.14;
    let ring = colors.accent;
    if (ctx.createConicGradient) {
      ring = ctx.createConicGradient(rot, cx + px * 6, cy + py * 4);
      ring.addColorStop(0, colors.accent);
      ring.addColorStop(0.35, 'transparent');
      ring.addColorStop(0.65, 'transparent');
      ring.addColorStop(1, colors.accent);
    }
    ctx.globalAlpha = 0.55 + pull * 0.45;
    ctx.strokeStyle = ring;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx + px * 6, cy + py * 4, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // core
    const cr = r0 * (1 + pull * 0.1 + collapse * 0.18);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.core;
    ctx.beginPath();
    ctx.arc(cx + px * 6, cy + py * 4, cr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    for (const p of particles) dot(p, true);
    for (const tk of tokens) chip(tk);
    ctx.globalAlpha = 1;
  }

  function frame(time) {
    if (!running) return;
    const dt = Math.min(0.05, (time - last) / 1000 || 0);
    last = time;
    step(dt);
    draw(time);
    requestAnimationFrame(frame);
  }

  function shouldRun() {
    return visible && !document.hidden && !reduced.matches && !document.body.classList.contains('has-files');
  }

  function update() {
    const on = shouldRun();
    if (on && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    else if (!on) running = false;
    if (!on && !document.body.classList.contains('has-files')) draw(performance.now());
  }

  // wiring
  new ResizeObserver(() => { layout(); if (!running) draw(performance.now()); }).observe(drop);
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; update(); }).observe(drop);
  document.addEventListener('visibilitychange', update);
  new MutationObserver(() => { readColors(); update(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
  reduced.addEventListener('change', update);

  drop.addEventListener('pointermove', (e) => {
    const r = drop.getBoundingClientRect();
    pxT = ((e.clientX - r.left) / r.width - 0.5) * 2;
    pyT = ((e.clientY - r.top) / r.height - 0.5) * 2;
    tiltTarget = 0.34 + pyT * 0.1;
  });
  drop.addEventListener('pointerenter', () => { speedT = 1.7; });
  drop.addEventListener('pointerleave', () => { speedT = 1; pxT = pyT = 0; tiltTarget = 0.34; });
  window.addEventListener('dragenter', () => { speedT = 3.2; });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) speedT = 1; });
  window.addEventListener('drop', () => { speedT = 1; collapse = 1; });

  readColors();
  layout();
  update();
})();
