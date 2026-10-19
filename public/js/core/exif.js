/* Exif (TIFF) reader, categoriser and rebuilder.
   Exif is split into categories so people can keep, say, the date while
   dropping the location. Removing a category rebuilds the TIFF structure
   from the tags that remain. */
(function (G) {
  'use strict';
  const AIV = G.AIV;
  const { KINDS, detectAI, looksLikeParams, clip } = AIV;

  const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

  const PTR_EXIF = 0x8769, PTR_GPS = 0x8825, PTR_INTEROP = 0xA005;
  const THUMB_OFF = 0x0201, THUMB_LEN = 0x0202;
  const ORIENTATION = 0x0112;

  // Tags that describe how to display the picture, not who/what/where.
  const STRUCTURAL_0 = new Set([0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0112, 0x0115, 0x011A, 0x011B,
    0x011C, 0x0128, 0x013E, 0x013F, 0x0211, 0x0212, 0x0213, 0x0214]);
  const STRUCTURAL_EXIF = new Set([0x9000, 0x9101, 0xA000, 0xA001, 0xA002, 0xA003, 0xA500]);

  const CAT = {
    0x010F: 'camera', 0x0110: 'camera', 0xA432: 'camera', 0xA433: 'camera', 0xA434: 'camera',
    0x0132: 'dates', 0x9003: 'dates', 0x9004: 'dates', 0x9010: 'dates', 0x9011: 'dates', 0x9012: 'dates',
    0x9290: 'dates', 0x9291: 'dates', 0x9292: 'dates',
    0x0131: 'software', 0x000B: 'software', 0x013C: 'software',
    0x013B: 'author', 0x8298: 'author', 0x9C9D: 'author', 0xA430: 'author',
    0x010E: 'description', 0x9286: 'description', 0x9C9B: 'description', 0x9C9C: 'description',
    0x9C9E: 'description', 0x9C9F: 'description', 0x010D: 'description', 0x011D: 'description',
    0xA420: 'identifiers', 0xA431: 'identifiers', 0xA435: 'identifiers', 0xC62F: 'identifiers',
    0x927C: 'makernote',
    0x02BC: 'xmp', 0x83BB: 'iptc', 0x8649: 'iptc', 0x8773: 'icc',
  };

  const NAMES = {
    0x010F: 'Make', 0x0110: 'Model', 0xA434: 'Lens', 0xA433: 'Lens make', 0x0131: 'Software',
    0x000B: 'Processing software', 0x013C: 'Host computer', 0x013B: 'Artist', 0x8298: 'Copyright',
    0x9C9D: 'Author', 0xA430: 'Owner', 0x010E: 'Description', 0x9286: 'User comment',
    0x9C9B: 'Title', 0x9C9C: 'Comment', 0x9C9E: 'Keywords', 0x9C9F: 'Subject', 0x010D: 'Document name',
    0xA420: 'Image ID', 0xA431: 'Body serial', 0xA435: 'Lens serial', 0xC62F: 'Camera serial',
    0x0132: 'Modified', 0x9003: 'Taken', 0x9004: 'Digitized',
  };

  // reading

  function parse(bytes, start = 0, end = bytes.length) {
    const b = bytes.subarray(start, end);
    if (b.length < 8) return null;
    const le = b[0] === 0x49 && b[1] === 0x49;
    const be = b[0] === 0x4D && b[1] === 0x4D;
    if (!le && !be) return null;
    const u16 = (o) => le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
    const u32 = (o) => le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0)
                          : ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    if (u16(2) !== 42) return null;

    const seen = new Set();
    function readIfd(off) {
      if (!off || off + 2 > b.length || seen.has(off)) return null;
      seen.add(off);
      const n = u16(off);
      if (n > 1000 || off + 2 + n * 12 > b.length) return null;
      const entries = [];
      for (let i = 0; i < n; i++) {
        const p = off + 2 + i * 12;
        const tag = u16(p), type = u16(p + 2), count = u32(p + 4);
        const size = (TYPE_SIZE[type] || 0) * count;
        if (!TYPE_SIZE[type] || size > b.length) continue;
        let raw;
        if (size <= 4) raw = b.slice(p + 8, p + 8 + size);
        else {
          const vo = u32(p + 8);
          if (vo + size > b.length) continue;
          raw = b.slice(vo, vo + size);
        }
        entries.push({ tag, type, count, raw, valueOffset: size <= 4 ? null : u32(p + 8) });
      }
      const next = off + 2 + n * 12 + 4 <= b.length ? u32(off + 2 + n * 12) : 0;
      return { entries, next };
    }

    const r = { le, u16, u32, ifd0: [], exif: [], gps: [], interop: [], ifd1: [], thumb: null };
    const i0 = readIfd(u32(4));
    if (!i0) return r;
    const ptr = (list, tag) => {
      const e = list.find((x) => x.tag === tag);
      return e && e.raw.length >= 4 ? (le ? e.raw[0] | (e.raw[1] << 8) | (e.raw[2] << 16) | (e.raw[3] << 24) >>> 0
                                          : ((e.raw[0] << 24) >>> 0) + (e.raw[1] << 16) + (e.raw[2] << 8) + e.raw[3]) : 0;
    };
    r.ifd0 = i0.entries.filter((e) => e.tag !== PTR_EXIF && e.tag !== PTR_GPS);
    const ex = readIfd(ptr(i0.entries, PTR_EXIF));
    if (ex) {
      r.exif = ex.entries.filter((e) => e.tag !== PTR_INTEROP);
      const io = readIfd(ptr(ex.entries, PTR_INTEROP));
      if (io) r.interop = io.entries;
    }
    const gps = readIfd(ptr(i0.entries, PTR_GPS));
    if (gps) r.gps = gps.entries;
    const i1 = readIfd(i0.next);
    if (i1) {
      r.ifd1 = i1.entries;
      const to = ptr(i1.entries, THUMB_OFF), tl = ptr(i1.entries, THUMB_LEN);
      if (to && tl && to + tl <= b.length) r.thumb = b.slice(to, to + tl);
    }

    for (const e of r.ifd0) e.kind = STRUCTURAL_0.has(e.tag) ? 'structural' : (CAT[e.tag] || 'other');
    for (const e of r.exif) e.kind = STRUCTURAL_EXIF.has(e.tag) ? 'structural' : (CAT[e.tag] || 'capture');
    for (const e of r.gps) e.kind = 'location';
    for (const e of r.interop) e.kind = 'structural';
    for (const e of r.ifd1) e.kind = 'thumbnail';

    // Pull AI-related values out into their own kinds.
    for (const e of r.ifd0.concat(r.exif)) {
      if (e.kind === 'structural' || e.kind === 'xmp' || e.kind === 'iptc' || e.kind === 'icc' || e.kind === 'makernote') continue;
      const s = valueText(r, e);
      if (!s) continue;
      const hits = detectAI(s);
      if (hits.length) {
        e.kind = looksLikeParams(s) || s.length > 240 ? 'ai-params' : 'ai-tags';
        e.aiHits = hits;
      }
    }
    return r;
  }

  function num(r, e, i = 0) {
    const b = e.raw, le = r.le;
    switch (e.type) {
      case 1: case 7: return b[i];
      case 3: return le ? b[i * 2] | (b[i * 2 + 1] << 8) : (b[i * 2] << 8) | b[i * 2 + 1];
      case 4: case 9: {
        const o = i * 4;
        return le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0)
                  : ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
      }
      case 5: case 10: {
        const sub = { type: 4, raw: b };
        const n = num(r, sub, i * 2), d = num(r, sub, i * 2 + 1);
        return d ? n / d : 0;
      }
      default: return undefined;
    }
  }

  function valueText(r, e) {
    if (e.type === 2) return AIV.latin1(e.raw).replace(/\0+$/, '').trim();
    if (e.tag >= 0x9C9B && e.tag <= 0x9C9F) return AIV.utf16le.decode(e.raw).replace(/\0+$/, '').trim();
    if (e.tag === 0x9286 && e.raw.length > 8) {
      const head = AIV.latin1(e.raw, 0, 8);
      const body = e.raw.subarray(8);
      if (head.startsWith('UNICODE')) {
        const a = AIV.utf16be.decode(body), c = AIV.utf16le.decode(body);
        const score = (s) => (s.match(/[\x20-\x7E]/g) || []).length;
        return (score(a) >= score(c) ? a : c).replace(/\0+$/, '').trim();
      }
      return AIV.text(body).replace(/\0+$/, '').trim();
    }
    if (e.type === 7 && (e.tag === 0x010E || e.tag === 0xA420)) return AIV.latin1(e.raw).replace(/\0+$/, '').trim();
    return '';
  }

  function gpsText(r) {
    const g = (tag) => r.gps.find((e) => e.tag === tag);
    const lat = g(2), latRef = g(1), lon = g(4), lonRef = g(3);
    if (!lat || !lon || lat.count < 3 || lon.count < 3) return r.gps.length ? `${r.gps.length} location fields` : '';
    const dms = (e) => num(r, e, 0) + num(r, e, 1) / 60 + num(r, e, 2) / 3600;
    let a = dms(lat), o = dms(lon);
    if (latRef && AIV.latin1(latRef.raw).startsWith('S')) a = -a;
    if (lonRef && AIV.latin1(lonRef.raw).startsWith('W')) o = -o;
    if (!isFinite(a) || !isFinite(o)) return 'Coordinates present';
    return `${a.toFixed(5)}, ${o.toFixed(5)}`;
  }

  function captureText(r, list) {
    const f = (tag) => list.find((e) => e.tag === tag);
    const parts = [];
    const iso = f(0x8827); if (iso) parts.push('ISO ' + num(r, iso));
    const exp = f(0x829A);
    if (exp) { const v = num(r, exp); parts.push(v && v < 1 ? `1/${Math.round(1 / v)} s` : `${v} s`); }
    const fn = f(0x829D); if (fn) parts.push('f/' + +num(r, fn).toFixed(1));
    const fl = f(0x920A); if (fl) parts.push(Math.round(num(r, fl)) + ' mm');
    return parts.length ? parts.join(' · ') : `${list.length} field${list.length === 1 ? '' : 's'}`;
  }

  /* Turn a parsed TIFF into user-facing signals, one per category. */
  function signals(r, prefix) {
    if (!r) return [];
    const all = r.ifd0.concat(r.exif, r.gps, r.ifd1);
    const groups = new Map();
    for (const e of all) {
      if (e.kind === 'structural') continue;
      if (!groups.has(e.kind)) groups.set(e.kind, []);
      groups.get(e.kind).push(e);
    }
    const out = [];
    for (const [kind, list] of groups) {
      let detail = '';
      const named = list.filter((e) => NAMES[e.tag]).map((e) => {
        const v = valueText(r, e);
        return v ? `${NAMES[e.tag]}: ${v}` : '';
      }).filter(Boolean);
      const notes = [];
      if (kind === 'location') detail = gpsText(r);
      else if (kind === 'capture') detail = captureText(r, list);
      else if (kind === 'thumbnail') detail = r.thumb ? `${AIV.fmtBytes(r.thumb.length)} preview image` : 'Preview image';
      else if (kind === 'makernote') detail = `${AIV.fmtBytes(list[0].raw.length)} of camera-maker data`;
      else if (kind === 'xmp') detail = 'XMP packet stored inside Exif';
      else if (kind === 'iptc') detail = 'IPTC block stored inside Exif';
      else if (kind === 'icc') detail = 'Color profile stored inside Exif';
      else if (kind === 'dates') {
        const order = [0x9003, 0x9004, 0x0132];
        const e = order.map((t) => list.find((x) => x.tag === t)).find(Boolean);
        detail = e ? `${NAMES[e.tag]} ${valueText(r, e)}` : `${list.length} date fields`;
      } else detail = named.join(' · ') || `${list.length} field${list.length === 1 ? '' : 's'}`;
      if (kind === 'ai-tags' || kind === 'ai-params') {
        const hits = [...new Set(list.flatMap((e) => e.aiHits || []))];
        notes.push('Matches: ' + hits.join(', '));
      }
      out.push({
        id: `${prefix}:${kind}`,
        kind,
        label: KINDS[kind].label,
        source: 'Exif',
        detail: clip(detail, kind === 'ai-params' ? 260 : 180),
        notes,
        ai: !!KINDS[kind].ai,
        size: list.reduce((s, e) => s + e.raw.length + 12, 0),
      });
    }
    return out;
  }


  // writing

  function writer(le) {
    let buf = new Uint8Array(1024), len = 0;
    const ensure = (n) => {
      if (len + n <= buf.length) return;
      let cap = buf.length * 2;
      while (cap < len + n) cap *= 2;
      const nb = new Uint8Array(cap); nb.set(buf.subarray(0, len)); buf = nb;
    };
    const w = {
      get pos() { return len; },
      bytes(a) { ensure(a.length); buf.set(a, len); len += a.length; },
      u16(v) { ensure(2); if (le) { buf[len] = v & 255; buf[len + 1] = v >> 8 & 255; } else { buf[len] = v >> 8 & 255; buf[len + 1] = v & 255; } len += 2; },
      u32(v) { ensure(4); w.put32(len, v); len += 4; },
      put32(at, v) {
        if (le) { buf[at] = v & 255; buf[at + 1] = v >>> 8 & 255; buf[at + 2] = v >>> 16 & 255; buf[at + 3] = v >>> 24 & 255; }
        else { buf[at] = v >>> 24 & 255; buf[at + 1] = v >>> 16 & 255; buf[at + 2] = v >>> 8 & 255; buf[at + 3] = v & 255; }
      },
      align() { if (len & 1) w.bytes([0]); },
      done() { return buf.slice(0, len); },
    };
    return w;
  }

  // Writes one IFD. `ptrs` are pointer tags whose value gets patched later.
  // Returns positions of the pointer value fields and of the next-IFD field.
  function writeIfd(w, entries, ptrs) {
    const all = entries.map((e) => ({ ...e })).concat(ptrs.map((p) => ({ tag: p, type: 4, count: 1, raw: new Uint8Array(4), isPtr: true })));
    all.sort((a, b) => a.tag - b.tag);
    w.align();
    const start = w.pos;
    w.u16(all.length);
    const deferred = [];
    const fields = {};
    for (const e of all) {
      w.u16(e.tag); w.u16(e.type); w.u32(e.count);
      if (e.raw.length <= 4) {
        fields[e.tag] = w.pos;
        const pad = new Uint8Array(4); pad.set(e.raw);
        w.bytes(pad);
      } else {
        deferred.push({ at: w.pos, raw: e.raw });
        fields[e.tag] = w.pos;
        w.u32(0);
      }
    }
    const nextAt = w.pos;
    w.u32(0);
    for (const d of deferred) {
      w.align();
      w.put32(d.at, w.pos);
      w.bytes(d.raw);
    }
    return { start, fields, nextAt };
  }

  /* Rebuild with the given kinds removed.
     Returns null when nothing worth keeping is left. */
  function rebuild(r, removeKinds) {
    const keep = (e) => e.kind === 'structural' || !removeKinds.has(e.kind);
    const meaningful = (list) => list.some((e) => e.kind !== 'structural' && !removeKinds.has(e.kind));

    const keepExif = meaningful(r.exif);
    const keepGps = r.gps.length && !removeKinds.has('location');
    const keepThumb = r.ifd1.length && r.thumb && !removeKinds.has('thumbnail');
    const keep0 = meaningful(r.ifd0);

    if (!keep0 && !keepExif && !keepGps && !keepThumb) {
      const o = r.ifd0.find((e) => e.tag === ORIENTATION);
      const ov = o ? num(r, o) : 1;
      if (!o || ov === 1) return null;
      const w = writer(r.le);
      w.bytes(r.le ? [0x49, 0x49] : [0x4D, 0x4D]); w.u16(42); w.u32(8);
      writeIfd(w, [o], []);
      return w.done();
    }

    const w = writer(r.le);
    w.bytes(r.le ? [0x49, 0x49] : [0x4D, 0x4D]); w.u16(42); w.u32(8);
    const ifd0 = r.ifd0.filter(keep);
    const ptrs0 = [];
    if (keepExif) ptrs0.push(PTR_EXIF);
    if (keepGps) ptrs0.push(PTR_GPS);
    const h0 = writeIfd(w, ifd0, ptrs0);

    if (keepExif) {
      const ex = r.exif.filter(keep);
      const hasInterop = r.interop.length > 0;
      w.align();
      w.put32(h0.fields[PTR_EXIF], w.pos);
      const he = writeIfd(w, ex, hasInterop ? [PTR_INTEROP] : []);
      if (hasInterop) {
        w.align();
        w.put32(he.fields[PTR_INTEROP], w.pos);
        writeIfd(w, r.interop, []);
      }
    }
    if (keepGps) {
      w.align();
      w.put32(h0.fields[PTR_GPS], w.pos);
      writeIfd(w, r.gps, []);
    }
    if (keepThumb) {
      w.align();
      w.put32(h0.nextAt, w.pos);
      const ents = r.ifd1.filter((e) => e.tag !== THUMB_OFF);
      const h1 = writeIfd(w, ents, [THUMB_OFF]);
      w.align();
      w.put32(h1.fields[THUMB_OFF], w.pos);
      w.bytes(r.thumb);
    }
    return w.done();
  }

  function kindsIn(r) {
    const s = new Set();
    for (const e of r.ifd0.concat(r.exif, r.gps, r.ifd1)) if (e.kind !== 'structural') s.add(e.kind);
    return s;
  }

  AIV.exif = { parse, signals, rebuild, kindsIn };
})(typeof window !== 'undefined' ? window : globalThis);
