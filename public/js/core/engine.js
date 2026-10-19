/* Public engine API and a small store-only ZIP writer. */
(function (G) {
  'use strict';
  const AIV = G.AIV;

  function identify(b) {
    for (const f of AIV.formats) if (f.impl.sniff(b)) {
      const name = f.name === 'HEIF' ? AIV.bmffBrand(b) : f.name;
      return { ...f, name };
    }
    for (const [test, msg] of AIV.unsupported) if (test(b)) return { unsupported: msg };
    return { unsupported: 'This file is not an image format AiVoid can read' };
  }

  async function analyze(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const fmt = identify(b);
    if (fmt.unsupported) return { supported: false, reason: fmt.unsupported };
    const scan = await fmt.impl.scan(b);
    const order = AIV.KIND_ORDER;
    scan.signals.sort((x, y) => (y.ai - x.ai) || (order.indexOf(x.kind) - order.indexOf(y.kind)));
    return { supported: true, format: fmt.name, impl: fmt.impl, signals: scan.signals, scan };
  }

  /* Returns the cleaned bytes. `remove` is a Set of signal ids. */
  function strip(bytes, analysis, remove) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!analysis.signals.some((s) => remove.has(s.id))) return b;
    return analysis.impl.strip(b, analysis.scan, remove);
  }

  /* Re-reads the output and checks that every removed kind is gone, and that
     every kept signal is still present. */
  async function verify(output, before, remove) {
    const after = await analyze(output);
    if (!after.supported) return { ok: false, problems: ['The cleaned file could not be read back'] };
    const removedKinds = new Map();
    const keptKinds = new Set();
    for (const s of before.signals) {
      if (remove.has(s.id)) removedKinds.set(s.kind, s.label);
      else keptKinds.add(s.kind);
    }
    const problems = [];
    for (const s of after.signals) {
      if (removedKinds.has(s.kind) && !keptKinds.has(s.kind)) problems.push(`${s.label} is still present`);
    }
    return { ok: problems.length === 0, problems, after };
  }

  function outputName(name) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return name + '_stripped';
    return name.slice(0, dot) + '_stripped' + name.slice(dot);
  }

  // ZIP (stored, no compression: images are already compressed)

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  function zipWriter() {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosDateTime(new Date());
    const used = new Set();

    function unique(path) {
      if (!used.has(path.toLowerCase())) { used.add(path.toLowerCase()); return path; }
      const dot = path.lastIndexOf('.');
      for (let n = 2; ; n++) {
        const p = dot > path.lastIndexOf('/') ? `${path.slice(0, dot)} (${n})${path.slice(dot)}` : `${path} (${n})`;
        if (!used.has(p.toLowerCase())) { used.add(p.toLowerCase()); return p; }
      }
    }

    return {
      add(path, data) {
        const name = enc.encode(unique(path));
        const crc = AIV.crc32(data);
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
        h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
        h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
        h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
        parts.push(new Uint8Array(h.buffer), name, data);
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
        c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
        c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
        c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
        central.push(new Uint8Array(c.buffer), name);
        offset += 30 + name.length + data.length;
      },
      blob() {
        let size = 0;
        for (const c of central) size += c.length;
        const e = new DataView(new ArrayBuffer(22));
        const count = central.length / 2;
        e.setUint32(0, 0x06054b50, true); e.setUint16(8, count, true); e.setUint16(10, count, true);
        e.setUint32(12, size, true); e.setUint32(16, offset, true);
        return new Blob(parts.concat(central, [new Uint8Array(e.buffer)]), { type: 'application/zip' });
      },
    };
  }

  const MIME = { JPEG: 'image/jpeg', PNG: 'image/png', WebP: 'image/webp', GIF: 'image/gif', HEIC: 'image/heic', AVIF: 'image/avif', BMP: 'image/bmp' };

  Object.assign(AIV, { identify, analyze, strip, verify, outputName, zipWriter, MIME });
})(typeof window !== 'undefined' ? window : globalThis);
