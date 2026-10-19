/* Container formats. Each format has scan() which returns
   signals plus enough structure for strip(), and strip() which writes a new
   file with the chosen signals cut out. Pixel data is copied untouched. */
(function (G) {
  'use strict';
  const AIV = G.AIV;
  const { latin1, ascii, u16be, u32be, u16le, u32le, concat, fmtBytes, exif, crc32 } = AIV;

  // JPEG

  const JPEG = {
    sniff: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,

    parse(b) {
      const segs = [];
      let i = 2, eoi = -1;
      while (i < b.length - 1) {
        if (b[i] !== 0xFF) break; // corrupt; stop and treat the rest as-is
        while (b[i + 1] === 0xFF && i < b.length - 2) i++;
        const m = b[i + 1];
        if (m === 0xD9) { eoi = i; break; }
        if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { segs.push({ m, start: i, end: i + 2 }); i += 2; continue; }
        const len = u16be(b, i + 2);
        const seg = { m, start: i, end: Math.min(b.length, i + 2 + len), data: i + 4 };
        segs.push(seg);
        i = seg.end;
        if (m === 0xDA) {
          let j = i;
          while (j < b.length - 1) {
            if (b[j] === 0xFF) {
              const n = b[j + 1];
              if (n !== 0x00 && !(n >= 0xD0 && n <= 0xD7) && n !== 0xFF) break;
            }
            j++;
          }
          seg.end = j;
          i = j;
        }
      }
      const imageEnd = eoi >= 0 ? eoi + 2 : b.length;
      return { segs, eoi, imageEnd, stoppedAt: eoi >= 0 ? -1 : i };
    },

    async scan(b) {
      const p = JPEG.parse(b);
      const signals = [];
      const units = new Map(); // signal id -> segment indexes
      const add = (sig, idx) => {
        if (!sig) return;
        if (!units.has(sig.id)) { signals.push(sig); units.set(sig.id, []); }
        if (idx !== undefined) units.get(sig.id).push(idx);
      };
      p.exifSegs = [];
      let c2paParts = [], c2paIdx = [], c2paSize = 0;
      let iccParts = [], iccIdx = [], iccSize = 0;
      let xmpExtIdx = [], xmpExtSize = 0, xmpExtText = '';
      let mpfIdx = -1;

      p.segs.forEach((s, idx) => {
        const len = s.end - s.start;
        if (s.m < 0xE0 && s.m !== 0xFE) return;
        const id8 = ascii(b, s.data, 40);
        if (s.m === 0xE0) {
          if (id8.startsWith('JFIF\0')) return;
          if (id8.startsWith('JFXX\0')) add({ id: `j${idx}`, kind: 'thumbnail', label: 'Embedded thumbnail', detail: 'JFIF extension thumbnail', ai: false, size: len, notes: [] }, idx);
          else add(otherApp(idx, s, id8, len), idx);
        } else if (s.m === 0xE1) {
          if (id8.startsWith('Exif\0')) {
            const r = exif.parse(b, s.data + 6, s.end);
            if (!r) { add(otherApp(idx, s, 'Exif (unreadable)', len), idx); return; }
            p.exifSegs.push({ idx, r, prefix: `e${idx}` });
            for (const sig of exif.signals(r, `e${idx}`)) add(sig);
          } else if (id8.startsWith('http://ns.adobe.com/xap/1.0/\0')) {
            const s2 = AIV.text(b.subarray(s.data + 29, s.end));
            add(AIV.xmpSignal(`j${idx}`, s2, len), idx);
          } else if (id8.startsWith('http://ns.adobe.com/xmp/extension/\0')) {
            xmpExtIdx.push(idx); xmpExtSize += len;
            xmpExtText += AIV.text(b.subarray(s.data + 35 + 40, s.end));
          } else add(otherApp(idx, s, id8, len), idx);
        } else if (s.m === 0xE2) {
          if (id8.startsWith('ICC_PROFILE\0')) { iccParts.push(b.subarray(s.data + 14, s.end)); iccIdx.push(idx); iccSize += len; }
          else if (id8.startsWith('MPF\0')) mpfIdx = idx;
          else add(otherApp(idx, s, id8, len), idx);
        } else if (s.m === 0xEB) {
          c2paParts.push(b.subarray(s.data, s.end)); c2paIdx.push(idx); c2paSize += len;
        } else if (s.m === 0xED) {
          if (id8.startsWith('Photoshop 3.0\0')) add(AIV.photoshopSignal(`j${idx}`, b.subarray(s.data + 14, s.end), len), idx);
          else add(otherApp(idx, s, id8, len), idx);
        } else if (s.m === 0xEE) {
          return; // Adobe APP14: colour transform flag the decoder needs
        } else if (s.m === 0xFE) {
          const t = AIV.text(b.subarray(s.data, s.end));
          add(AIV.textSignal(`j${idx}`, '', t, len, 'description', 'JPEG comment'), idx);
        } else {
          add(otherApp(idx, s, id8, len), idx);
        }
      });

      if (c2paIdx.length) {
        const all = concat(c2paParts);
        const isC2pa = /c2pa/.test(latin1(all, 0, Math.min(all.length, 4096)));
        const sig = isC2pa ? AIV.c2paSignal('c2pa', all, c2paSize)
          : { id: 'c2pa', kind: 'other', label: 'JUMBF data (APP11)', detail: fmtBytes(c2paSize), ai: false, size: c2paSize, notes: [] };
        signals.push(sig); units.set('c2pa', c2paIdx);
      }
      if (xmpExtIdx.length) {
        const sig = AIV.xmpSignal('xmpext', xmpExtText, xmpExtSize, 'Extended XMP') ||
          { id: 'xmpext', kind: 'xmp', label: 'Extended XMP', detail: fmtBytes(xmpExtSize), ai: false, size: xmpExtSize, notes: [] };
        signals.push(sig); units.set('xmpext', xmpExtIdx);
      }
      if (iccIdx.length) {
        signals.push(AIV.iccSignal('icc', concat(iccParts), iccSize));
        units.set('icc', iccIdx);
      }
      const trailer = b.length - p.imageEnd;
      if (p.eoi >= 0 && (trailer > 0 || mpfIdx >= 0)) {
        const zeros = trailer > 0 && b.subarray(p.imageEnd).every((x) => x === 0);
        const what = mpfIdx >= 0 ? 'Extra images stored after the photo, such as an HDR gain map or depth map'
          : zeros ? 'Zero padding after the image' : 'Data stored after the end of the image';
        signals.push({
          id: 'extra', kind: 'extra', label: mpfIdx >= 0 ? 'Extra embedded images' : 'Trailing data', ai: false,
          size: trailer, detail: `${fmtBytes(trailer)} · ${what}`,
          notes: mpfIdx >= 0 ? ['Removing them keeps the main photo but drops HDR and depth effects.'] : [],
        });
        units.set('extra', mpfIdx >= 0 ? [mpfIdx] : []);
      }
      p.units = units;
      p.mpfIdx = mpfIdx;
      return { parsed: p, signals };
    },

    strip(b, scan, remove) {
      const p = scan.parsed;
      const drop = new Set();
      for (const [id, idxs] of p.units) if (remove.has(id)) idxs.forEach((x) => drop.add(x));
      const replace = new Map();
      for (const ex of p.exifSegs) {
        const kinds = [...exif.kindsIn(ex.r)].filter((k) => remove.has(`${ex.prefix}:${k}`));
        if (!kinds.length) continue;
        const tiff = exif.rebuild(ex.r, new Set(kinds));
        if (!tiff) { drop.add(ex.idx); continue; }
        const head = new Uint8Array(10);
        const len = tiff.length + 8;
        head.set([0xFF, 0xE1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
        replace.set(ex.idx, concat([head, tiff]));
      }
      const dropExtra = remove.has('extra');
      const parts = [b.subarray(0, 2)];
      let pos = 2, mpfNew = -1;
      p.segs.forEach((s, idx) => {
        if (drop.has(idx)) return;
        if (idx === p.mpfIdx) mpfNew = pos;
        const chunk = replace.get(idx) || b.subarray(s.start, s.end);
        parts.push(chunk); pos += chunk.length;
      });
      if (p.eoi >= 0) { parts.push(b.subarray(p.eoi, p.eoi + 2)); pos += 2; }
      else if (p.stoppedAt > 0) { parts.push(b.subarray(p.stoppedAt)); pos += b.length - p.stoppedAt; }
      const keepTrailer = !dropExtra && p.eoi >= 0 && p.imageEnd < b.length;
      if (keepTrailer) parts.push(b.subarray(p.imageEnd));
      const out = concat(parts);

      // Secondary images are addressed relative to the MPF header. If we
      // removed bytes between that header and the end of the main image,
      // shift the stored offsets by the same amount.
      if (keepTrailer && p.mpfIdx >= 0 && mpfNew >= 0) {
        const s = p.segs[p.mpfIdx];
        // segment start + marker/length (4) + "MPF\0" (4) = TIFF header
        const oldTiff = s.data + 4, newTiff = mpfNew + 8;
        const delta = (p.imageEnd - oldTiff) - (pos - newTiff);
        if (delta) patchMpf(out, newTiff, delta);
      }
      return out;
    },
  };

  function otherApp(idx, s, id8, len) {
    const name = (id8.match(/^[\x20-\x7E]{2,}/) || [''])[0].trim();
    const n = s.m === 0xFE ? 'Comment' : `APP${s.m - 0xE0}`;
    const label = name === 'Ducky' ? 'Photoshop “Save for Web” data' : `${n} data${name ? ` (${AIV.clip(name, 30)})` : ''}`;
    const hits = AIV.detectAI(id8);
    return { id: `j${idx}`, kind: hits.length ? 'ai-tags' : 'other', label, detail: fmtBytes(len), ai: hits.length > 0, size: len, notes: [] };
  }

  function patchMpf(out, t, delta) {
    const le = out[t] === 0x49;
    const r16 = (o) => le ? out[o] | (out[o + 1] << 8) : (out[o] << 8) | out[o + 1];
    const r32 = (o) => le ? (out[o] | (out[o + 1] << 8) | (out[o + 2] << 16)) + ((out[o + 3] << 24) >>> 0)
                          : ((out[o] << 24) >>> 0) + (out[o + 1] << 16) + (out[o + 2] << 8) + out[o + 3];
    const w32 = (o, v) => {
      if (le) { out[o] = v & 255; out[o + 1] = v >>> 8 & 255; out[o + 2] = v >>> 16 & 255; out[o + 3] = v >>> 24 & 255; }
      else { out[o] = v >>> 24 & 255; out[o + 1] = v >>> 16 & 255; out[o + 2] = v >>> 8 & 255; out[o + 3] = v & 255; }
    };
    try {
      const ifd = t + r32(t + 4);
      const n = r16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (r16(e) !== 0xB002) continue;
        const count = r32(e + 4);
        const at = t + r32(e + 8);
        for (let k = 0; k < count / 16; k++) {
          const o = at + k * 16 + 8;
          const v = r32(o);
          if (v > 0) w32(o, v - delta);
        }
      }
    } catch (e) { /* leave as-is */ }
  }

  // PNG

  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'hIST',
    'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi', 'mDCV', 'cLLI']);

  const PNG = {
    sniff: (b) => PNG_SIG.every((v, i) => b[i] === v),

    parse(b) {
      const chunks = [];
      let i = 8;
      while (i + 12 <= b.length) {
        const len = u32be(b, i);
        const type = ascii(b, i + 4, 4);
        const end = i + 12 + len;
        if (end > b.length) break;
        chunks.push({ type, start: i, end, data: i + 8, len });
        i = end;
        if (type === 'IEND') break;
      }
      return { chunks, end: i };
    },

    async scan(b) {
      const p = PNG.parse(b);
      const signals = [];
      p.exif = null;
      for (let idx = 0; idx < p.chunks.length; idx++) {
        const c = p.chunks[idx];
        const id = `p${idx}`;
        const data = b.subarray(c.data, c.data + c.len);
        const size = c.len + 12;
        if (PNG_KEEP.has(c.type) || c.type === 'iDOT') continue;
        if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
          const t = await pngText(c.type, data);
          if (t.key === 'XML:com.adobe.xmp') {
            const sig = AIV.xmpSignal(id, t.value, size);
            if (sig) signals.push(sig);
            continue;
          }
          let kind = 'other';
          if (/^(author|copyright|artist|disclaimer)$/i.test(t.key)) kind = 'author';
          else if (/^(title|description|comment|warning|caption)$/i.test(t.key)) kind = 'description';
          else if (/^(creation time|date|datetime)$/i.test(t.key)) kind = 'dates';
          else if (/^(software|source)$/i.test(t.key)) kind = 'software';
          else if (/^raw profile type (exif|app1)$/i.test(t.key)) kind = 'other';
          signals.push(AIV.textSignal(id, t.key, t.value, size, kind, 'PNG text'));
        } else if (c.type === 'eXIf') {
          const r = exif.parse(data);
          if (r) { p.exif = { idx, r, prefix: id }; signals.push(...exif.signals(r, id)); }
          else signals.push({ id, kind: 'other', label: 'Exif (unreadable)', detail: fmtBytes(size), ai: false, size, notes: [] });
        } else if (c.type === 'iCCP') {
          const z = data.indexOf(0);
          const name = latin1(data, 0, z > 0 ? z : 0);
          const prof = await AIV.inflate(data.subarray(z + 2));
          signals.push(AIV.iccSignal(id, prof || new Uint8Array(0), size, name || (prof && AIV.iccName(prof))));
        } else if (c.type === 'caBX') {
          signals.push(AIV.c2paSignal(id, data, size));
        } else if (c.type === 'tIME') {
          const y = u16be(data, 0);
          const pad = (n) => String(n).padStart(2, '0');
          signals.push({ id, kind: 'dates', label: 'Dates and times', ai: false, size,
            detail: `Modified ${y}-${pad(data[2])}-${pad(data[3])} ${pad(data[4])}:${pad(data[5])}`, notes: [] });
        } else if (c.type === 'dSIG') {
          signals.push({ id, kind: 'other', label: 'Digital signature (dSIG)', ai: false, size, detail: fmtBytes(size), notes: [] });
        } else {
          signals.push({ id, kind: 'other', label: `Private chunk “${c.type}”`, ai: false, size, detail: fmtBytes(size), notes: [] });
        }
      }
      if (p.end < b.length) {
        const n = b.length - p.end;
        signals.push({ id: 'extra', kind: 'extra', label: 'Trailing data', ai: false, size: n,
          detail: `${fmtBytes(n)} stored after the end of the image`, notes: [] });
      }
      return { parsed: p, signals };
    },

    strip(b, scan, remove) {
      const p = scan.parsed;
      const parts = [b.subarray(0, 8)];
      let exifChunk = null, dropExif = false;
      if (p.exif) {
        const kinds = [...exif.kindsIn(p.exif.r)].filter((k) => remove.has(`${p.exif.prefix}:${k}`));
        if (kinds.length) {
          const tiff = exif.rebuild(p.exif.r, new Set(kinds));
          if (!tiff) dropExif = true;
          else exifChunk = pngChunk('eXIf', tiff);
        }
      }
      const changed = scan.signals.some((s) => remove.has(s.id));
      p.chunks.forEach((c, idx) => {
        if (c.type === 'iDOT' && changed) return; // its offsets go stale once chunks move
        if (remove.has(`p${idx}`)) return;
        if (p.exif && idx === p.exif.idx) {
          if (dropExif) return;
          if (exifChunk) { parts.push(exifChunk); return; }
        }
        parts.push(b.subarray(c.start, c.end));
      });
      if (p.end < b.length && !remove.has('extra')) parts.push(b.subarray(p.end));
      return concat(parts);
    },
  };

  async function pngText(type, d) {
    const z = d.indexOf(0);
    const key = latin1(d, 0, z < 0 ? d.length : z);
    if (type === 'tEXt') return { key, value: latin1(d, z + 1) };
    if (type === 'zTXt') {
      const raw = await AIV.inflate(d.subarray(z + 2));
      return { key, value: raw ? latin1(raw) : '(compressed text)' };
    }
    const comp = d[z + 1];
    let q = z + 3;
    const lang = d.indexOf(0, q); q = lang + 1;
    const tk = d.indexOf(0, q); q = tk + 1;
    let body = d.subarray(q);
    if (comp === 1) body = (await AIV.inflate(body)) || new Uint8Array(0);
    return { key, value: AIV.utf8(body) };
  }

  function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const len = data.length;
    out.set([len >>> 24 & 255, len >>> 16 & 255, len >>> 8 & 255, len & 255]);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    const crc = crc32(out.subarray(4, 8 + len));
    out.set([crc >>> 24 & 255, crc >>> 16 & 255, crc >>> 8 & 255, crc & 255], 8 + len);
    return out;
  }

  // WebP

  const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);

  const WEBP = {
    sniff: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP',

    async scan(b) {
      const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
      const chunks = [];
      let i = 12;
      while (i + 8 <= riffEnd) {
        const type = ascii(b, i, 4);
        const len = u32le(b, i + 4);
        const end = Math.min(riffEnd, i + 8 + len + (len & 1));
        chunks.push({ type, start: i, end, data: i + 8, len });
        i = end;
      }
      const p = { chunks, riffEnd, exif: null };
      const signals = [];
      chunks.forEach((c, idx) => {
        if (WEBP_KEEP.has(c.type)) return;
        const id = `w${idx}`;
        const d = b.subarray(c.data, c.data + c.len);
        const size = c.end - c.start;
        if (c.type === 'EXIF') {
          const off = ascii(d, 0, 6) === 'Exif\0\0' ? 6 : 0;
          const r = exif.parse(d, off);
          if (r) { p.exif = { idx, r, prefix: id, off }; signals.push(...exif.signals(r, id)); }
          else signals.push({ id, kind: 'other', label: 'Exif (unreadable)', detail: fmtBytes(size), ai: false, size, notes: [] });
        } else if (c.type === 'XMP ') {
          const sig = AIV.xmpSignal(id, AIV.text(d), size);
          if (sig) signals.push(sig);
        } else if (c.type === 'ICCP') {
          signals.push(AIV.iccSignal(id, d, size));
        } else if (c.type === 'C2PA' || /c2pa/.test(latin1(d, 0, Math.min(d.length, 2048)))) {
          signals.push(AIV.c2paSignal(id, d, size));
        } else {
          signals.push({ id, kind: 'other', label: `Private chunk “${c.type.trim()}”`, ai: false, size, detail: fmtBytes(size), notes: [] });
        }
      });
      if (riffEnd < b.length) {
        const n = b.length - riffEnd;
        signals.push({ id: 'extra', kind: 'extra', label: 'Trailing data', ai: false, size: n,
          detail: `${fmtBytes(n)} stored after the image`, notes: [] });
      }
      return { parsed: p, signals };
    },

    strip(b, scan, remove) {
      const p = scan.parsed;
      const parts = [];
      let has = { ICCP: false, EXIF: false, XMP: false };
      p.chunks.forEach((c, idx) => {
        if (remove.has(`w${idx}`)) return;
        let chunk = b.subarray(c.start, c.end);
        if (p.exif && idx === p.exif.idx) {
          const kinds = [...exif.kindsIn(p.exif.r)].filter((k) => remove.has(`${p.exif.prefix}:${k}`));
          if (kinds.length) {
            const tiff = exif.rebuild(p.exif.r, new Set(kinds));
            if (!tiff) return;
            chunk = riffChunk('EXIF', tiff);
          }
        }
        if (c.type === 'ICCP') has.ICCP = true;
        if (c.type === 'EXIF') has.EXIF = true;
        if (c.type === 'XMP ') has.XMP = true;
        parts.push(chunk);
      });
      const body = concat(parts);
      // Update the VP8X feature flags to match what is left.
      const vp8x = p.chunks.findIndex((c) => c.type === 'VP8X');
      if (vp8x >= 0) {
        let off = 0;
        for (let k = 0; k < parts.length; k++) {
          if (ascii(parts[k], 0, 4) === 'VP8X') {
            let f = body[off + 8];
            f = has.ICCP ? f | 0x20 : f & ~0x20;
            f = has.EXIF ? f | 0x08 : f & ~0x08;
            f = has.XMP ? f | 0x04 : f & ~0x04;
            body[off + 8] = f;
            break;
          }
          off += parts[k].length;
        }
      }
      const head = new Uint8Array(12);
      const size = body.length + 4;
      head.set([0x52, 0x49, 0x46, 0x46, size & 255, size >>> 8 & 255, size >>> 16 & 255, size >>> 24 & 255, 0x57, 0x45, 0x42, 0x50]);
      const out = [head, body];
      if (p.riffEnd < b.length && !remove.has('extra')) out.push(b.subarray(p.riffEnd));
      return concat(out);
    },
  };

  function riffChunk(type, data) {
    const pad = data.length & 1;
    const out = new Uint8Array(8 + data.length + pad);
    for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
    const n = data.length;
    out.set([n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255], 4);
    out.set(data, 8);
    return out;
  }

  // GIF

  const GIF = {
    sniff: (b) => ascii(b, 0, 4) === 'GIF8',

    parse(b) {
      const blocks = [];
      let i = 13;
      const flags = b[10];
      if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1));
      const skipSub = (j) => {
        while (j < b.length && b[j] !== 0) j += b[j] + 1;
        return j + 1;
      };
      let end = b.length;
      while (i < b.length) {
        const t = b[i];
        if (t === 0x3B) { end = i + 1; break; }
        if (t === 0x21) {
          const label = b[i + 1];
          const start = i;
          let appId = '';
          if (label === 0xFF) appId = ascii(b, i + 3, 11);
          const j = skipSub(i + 2);
          blocks.push({ start, end: j, label, appId, body: i + 2 });
          i = j;
        } else if (t === 0x2C) {
          let j = i + 10;
          const f = b[i + 9];
          if (f & 0x80) j += 3 * (1 << ((f & 7) + 1));
          j = skipSub(j + 1);
          blocks.push({ start: i, end: j, label: 'image' });
          i = j;
        } else { end = i; break; }
      }
      return { blocks, end };
    },

    async scan(b) {
      const p = GIF.parse(b);
      const signals = [];
      p.blocks.forEach((k, idx) => {
        const id = `g${idx}`;
        const size = k.end - k.start;
        if (k.label === 0xFE) {
          const parts = [];
          let j = k.body;
          while (j < k.end && b[j]) { parts.push(b.subarray(j + 1, j + 1 + b[j])); j += b[j] + 1; }
          signals.push(AIV.textSignal(id, '', latin1(concat(parts)), size, 'description', 'GIF comment'));
        } else if (k.label === 0xFF) {
          if (k.appId === 'NETSCAPE2.0' || k.appId === 'ANIMEXTS1.0') return;
          const raw = b.subarray(k.start + 14, k.end);
          if (k.appId === 'XMP DataXMP') {
            const sig = AIV.xmpSignal(id, AIV.text(raw), size);
            if (sig) signals.push(sig);
          } else if (k.appId.startsWith('ICCRGBG1')) {
            signals.push(AIV.iccSignal(id, raw, size));
          } else if (/c2pa/i.test(k.appId)) {
            signals.push(AIV.c2paSignal(id, raw, size));
          } else {
            signals.push({ id, kind: 'other', label: `Application data (“${AIV.clip(k.appId, 20)}”)`, ai: false, size, detail: fmtBytes(size), notes: [] });
          }
        }
      });
      if (p.end < b.length) {
        const n = b.length - p.end;
        signals.push({ id: 'extra', kind: 'extra', label: 'Trailing data', ai: false, size: n,
          detail: `${fmtBytes(n)} stored after the image`, notes: [] });
      }
      return { parsed: p, signals };
    },

    strip(b, scan, remove) {
      const p = scan.parsed;
      const first = p.blocks.length ? p.blocks[0].start : p.end;
      const parts = [b.subarray(0, first)];
      p.blocks.forEach((k, idx) => { if (!remove.has(`g${idx}`)) parts.push(b.subarray(k.start, k.end)); });
      parts.push(b.subarray(p.blocks.length ? p.blocks[p.blocks.length - 1].end : first, p.end));
      if (p.end < b.length && !remove.has('extra')) parts.push(b.subarray(p.end));
      return concat(parts);
    },
  };

  /* HEIF / AVIF (ISO BMFF)
     Items are addressed by absolute offsets, so nothing is moved. Removed
     data is overwritten in place: Exif becomes an empty TIFF, XMP an empty
     packet, and C2PA boxes are retyped to 'free'. File size stays the same. */

  const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
  const BMFF_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis|miaf)$/;

  function boxes(b, start, end) {
    const out = [];
    let i = start;
    while (i + 8 <= end) {
      let size = u32be(b, i);
      const type = ascii(b, i + 4, 4);
      let head = 8;
      if (size === 1) { size = u32be(b, i + 8) * 4294967296 + u32be(b, i + 12); head = 16; }
      else if (size === 0) size = end - i;
      if (size < head || i + size > end) break;
      out.push({ type, start: i, end: i + size, data: i + head });
      i += size;
    }
    return out;
  }

  const BMFF = {
    sniff: (b) => ascii(b, 4, 4) === 'ftyp' && (BMFF_BRANDS.test(ascii(b, 8, 4)) ||
      Array.from({ length: Math.max(0, (u32be(b, 0) - 16) / 4) }, (_, k) => ascii(b, 16 + k * 4, 4)).some((x) => BMFF_BRANDS.test(x))),

    brand(b) { const m = ascii(b, 8, 4); return /^avi/.test(m) ? 'AVIF' : 'HEIC'; },

    async scan(b) {
      const top = boxes(b, 0, b.length);
      const p = { items: [], uuids: [] };
      const signals = [];
      const meta = top.find((x) => x.type === 'meta');
      if (meta) {
        const kids = boxes(b, meta.data + 4, meta.end);
        const iinf = kids.find((x) => x.type === 'iinf');
        const iloc = kids.find((x) => x.type === 'iloc');
        const idat = kids.find((x) => x.type === 'idat');
        const infos = new Map();
        if (iinf) {
          const v = b[iinf.data];
          const first = iinf.data + 4 + (v === 0 ? 2 : 4);
          for (const e of boxes(b, first, iinf.end)) {
            if (e.type !== 'infe') continue;
            const ev = b[e.data];
            if (ev < 2) continue;
            let q = e.data + 4;
            const id = ev === 2 ? u16be(b, q) : u32be(b, q); q += ev === 2 ? 2 : 4;
            q += 2;
            const itype = ascii(b, q, 4); q += 4;
            const nameEnd = b.indexOf(0, q); q = nameEnd + 1;
            let ctype = '';
            if (itype === 'mime') { const ce = b.indexOf(0, q); ctype = latin1(b, q, ce); }
            infos.set(id, { id, itype, ctype });
          }
        }
        const locs = new Map();
        if (iloc) {
          const v = b[iloc.data];
          let q = iloc.data + 4;
          const os = b[q] >> 4, ls = b[q] & 15, bs = b[q + 1] >> 4, is = v >= 1 ? b[q + 1] & 15 : 0;
          q += 2;
          const rd = (n) => { let x = 0; for (let k = 0; k < n; k++) x = x * 256 + b[q + k]; q += n; return x; };
          const count = v < 2 ? rd(2) : rd(4);
          for (let k = 0; k < count && q < iloc.end; k++) {
            const id = v < 2 ? rd(2) : rd(4);
            const method = v >= 1 ? rd(2) & 15 : 0;
            rd(2);
            const base = rd(bs);
            const ec = rd(2);
            const ext = [];
            for (let e = 0; e < ec; e++) { if (is) rd(is); ext.push({ off: rd(os), len: rd(ls) }); }
            locs.set(id, { method, base, ext });
          }
        }
        for (const [id, info] of infos) {
          const isExif = info.itype === 'Exif';
          const isXmp = info.itype === 'mime' && /rdf\+xml|xmp/i.test(info.ctype);
          const isC2pa = info.itype === 'mime' && /c2pa|jumbf/i.test(info.ctype);
          if (!isExif && !isXmp && !isC2pa) continue;
          const loc = locs.get(id);
          if (!loc || loc.ext.length !== 1) continue;
          let start = loc.base + loc.ext[0].off;
          if (loc.method === 1) { if (!idat) continue; start += idat.data; }
          else if (loc.method !== 0) continue;
          const len = loc.ext[0].len || (b.length - start);
          if (start + len > b.length) continue;
          const item = { id, start, len, type: isExif ? 'exif' : isXmp ? 'xmp' : 'c2pa' };
          const sid = `h${id}`;
          if (isExif) {
            const tOff = u32be(b, start);
            const ts = start + 4 + tOff;
            const r = exif.parse(b, ts, start + len);
            if (!r) continue;
            item.tiffStart = ts; item.r = r; item.prefix = sid;
            signals.push(...exif.signals(r, sid));
          } else if (isXmp) {
            const sig = AIV.xmpSignal(sid, AIV.text(b.subarray(start, start + len)), len);
            if (!sig) continue;
            signals.push(sig);
          } else {
            signals.push(AIV.c2paSignal(sid, b.subarray(start, start + len), len));
          }
          p.items.push(item);
        }
      }
      top.forEach((x, idx) => {
        if (x.type !== 'uuid') return;
        const u = Array.from(b.subarray(x.data, x.data + 16), (v) => v.toString(16).padStart(2, '0')).join('');
        const id = `u${idx}`;
        const size = x.end - x.start;
        p.uuids.push({ id, box: x });
        if (u === C2PA_UUID) signals.push(AIV.c2paSignal(id, b.subarray(x.data + 16, x.end), size));
        else signals.push({ id, kind: 'other', label: 'Private uuid box', ai: false, size, detail: fmtBytes(size), notes: [] });
      });
      return { parsed: p, signals };
    },

    strip(b, scan, remove) {
      const out = b.slice();
      const p = scan.parsed;
      for (const it of p.items) {
        if (it.type === 'exif') {
          const kinds = [...exif.kindsIn(it.r)].filter((k) => remove.has(`${it.prefix}:${k}`));
          if (!kinds.length) continue;
          const room = it.start + it.len - it.tiffStart;
          let tiff = exif.rebuild(it.r, new Set(kinds));
          if (!tiff || tiff.length > room) tiff = new Uint8Array([0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
          out.fill(0, it.tiffStart, it.start + it.len);
          out.set(tiff.subarray(0, room), it.tiffStart);
        } else if (remove.has(`h${it.id}`)) {
          if (it.type === 'xmp') {
            const empty = new TextEncoder().encode('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="w"?>');
            out.fill(0x20, it.start, it.start + it.len);
            if (empty.length <= it.len) out.set(empty, it.start);
          } else {
            out.fill(0, it.start, it.start + it.len);
          }
        }
      }
      for (const u of p.uuids) {
        if (!remove.has(u.id)) continue;
        const x = u.box;
        out.set([0x66, 0x72, 0x65, 0x65], x.start + 4); // 'free'
        out.fill(0, x.data, x.end);
      }
      return out;
    },
  };

  // BMP (no metadata)

  const BMP = {
    sniff: (b) => b[0] === 0x42 && b[1] === 0x4D,
    async scan() { return { parsed: {}, signals: [] }; },
    strip: (b) => b,
  };

  const UNSUPPORTED = [
    [(b) => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A) || (b[0] === 0x4D && b[1] === 0x4D && b[3] === 0x2A), 'TIFF and camera RAW files are not supported yet'],
    [(b) => (b[0] === 0xFF && b[1] === 0x0A) || ascii(b, 4, 4) === 'JXL ', 'JPEG XL is not supported yet'],
    [(b) => /^\s*(<\?xml|<svg)/i.test(ascii(b, 0, 64)), 'SVG files are not supported'],
  ];

  AIV.formats = [
    { name: 'JPEG', ext: 'jpg', impl: JPEG },
    { name: 'PNG', ext: 'png', impl: PNG },
    { name: 'WebP', ext: 'webp', impl: WEBP },
    { name: 'GIF', ext: 'gif', impl: GIF },
    { name: 'HEIF', ext: 'heic', impl: BMFF },
    { name: 'BMP', ext: 'bmp', impl: BMP },
  ];
  AIV.unsupported = UNSUPPORTED;
  AIV.bmffBrand = BMFF.brand;
})(typeof window !== 'undefined' ? window : globalThis);
