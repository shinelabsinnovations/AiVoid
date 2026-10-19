/* Browser test suite for the AiVoid engine.
   Builds real images on a canvas, injects metadata, strips it, and checks
   the result decodes and reads back clean. Open tests/index.html. */
(async function () {
  'use strict';
  const AIV = window.AIV;
  const log = document.getElementById('log');
  let pass = 0, fail = 0;
  const ok = (cond, msg) => {
    const li = document.createElement('li');
    li.textContent = (cond ? 'PASS  ' : 'FAIL  ') + msg;
    li.className = cond ? 'pass' : 'fail';
    log.appendChild(li);
    cond ? pass++ : fail++;
  };
  const enc = new TextEncoder();
  const cat = AIV.concat;
  const be16 = (n) => [n >> 8 & 255, n & 255];
  const be32 = (n) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
  const le32 = (n) => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];

  async function canvasBytes(type, w = 64, h = 48) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, '#0a84ff'); gr.addColorStop(1, '#ff9f0a');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, type, 0.9));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function decodes(bytes) {
    try { const bm = await createImageBitmap(new Blob([bytes])); const r = bm.width > 0; bm.close(); return r; }
    catch (e) { return false; }
  }

  // a tiny big-endian TIFF builder for fixtures
  function tiff(ifds) {
    // ifds: { ifd0: [[tag,type,valueBytes]], exif:[], gps:[], ifd1:[], thumb: Uint8Array }
    const out = [];
    let pos = 8;
    const blocks = [];
    const layout = (entries, ptrs) => {
      const all = entries.concat(ptrs.map((t) => [t, 4, [0, 0, 0, 0], true])).sort((a, b) => a[0] - b[0]);
      const start = pos;
      const size = 2 + all.length * 12 + 4;
      let dataPos = start + size;
      const recs = all.map(([tag, type, val, isPtr]) => {
        const v = Uint8Array.from(val);
        const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8];
        const count = v.length / sizes[type];
        let off = null;
        if (v.length > 4) { off = dataPos; dataPos += v.length + (v.length & 1); }
        return { tag, type, count, v, off, isPtr };
      });
      pos = dataPos;
      const blk = { start, recs, nextAt: start + 2 + all.length * 12 };
      blocks.push(blk);
      return blk;
    };
    const b0 = layout(ifds.ifd0, ['exif', 'gps'].filter((k) => ifds[k]).map((k) => (k === 'exif' ? 0x8769 : 0x8825)));
    const be = ifds.exif ? layout(ifds.exif, []) : null;
    const bg = ifds.gps ? layout(ifds.gps, []) : null;
    let b1 = null, thumbAt = 0;
    if (ifds.thumb) {
      b1 = layout([[0x0103, 3, [0, 6]], [0x0202, 4, be32(ifds.thumb.length)]], [0x0201]);
      thumbAt = pos; pos += ifds.thumb.length;
    }
    const buf = new Uint8Array(pos);
    buf.set([0x4D, 0x4D, 0, 42, 0, 0, 0, 8]);
    const put = (at, arr) => buf.set(arr, at);
    for (const blk of blocks) {
      put(blk.start, be16(blk.recs.length));
      blk.recs.forEach((r, i) => {
        const p = blk.start + 2 + i * 12;
        put(p, be16(r.tag)); put(p + 2, be16(r.type)); put(p + 4, be32(r.count));
        let val = r.v;
        if (r.isPtr) {
          const target = r.tag === 0x8769 ? be.start : r.tag === 0x8825 ? bg.start : thumbAt;
          val = Uint8Array.from(be32(target));
        }
        if (r.off !== null) { put(p + 8, be32(r.off)); put(r.off, val); } else put(p + 8, val);
      });
    }
    if (b1) { put(b0.nextAt, be32(b1.start)); put(thumbAt, ifds.thumb); }
    return buf;
  }
  const asc = (s) => Array.from(enc.encode(s + '\0'));
  const rat = (n, d) => be32(n).concat(be32(d));

  async function exifFixture() {
    const thumb = await canvasBytes('image/jpeg', 16, 12);
    const params = 'a cat astronaut, studio light\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 12345, Model: sdxl';
    const uc = Array.from(enc.encode('ASCII\0\0\0' + params));
    return tiff({
      ifd0: [
        [0x010F, 2, asc('Canon')], [0x0110, 2, asc('EOS R5')], [0x0112, 3, [0, 6, 0, 0]],
        [0x0131, 2, asc('Adobe Firefly Image 3')], [0x0132, 2, asc('2025:03:01 10:00:00')],
        [0x013B, 2, asc('Jane Doe')], [0x011A, 5, rat(72, 1)], [0x011B, 5, rat(72, 1)], [0x0128, 3, [0, 2, 0, 0]],
      ],
      exif: [
        [0x9000, 7, Array.from(enc.encode('0232'))], [0x9003, 2, asc('2025:03:01 09:59:58')],
        [0x8827, 3, [0, 100, 0, 0]], [0x829A, 5, rat(1, 125)], [0x829D, 5, rat(18, 10)],
        [0x9286, 7, uc], [0xA431, 2, asc('SN123456')],
      ],
      gps: [
        [0x0001, 2, Array.from(enc.encode('N\0'))], [0x0002, 5, rat(37, 1).concat(rat(46, 1), rat(30, 1))],
        [0x0003, 2, Array.from(enc.encode('W\0'))], [0x0004, 5, rat(122, 1).concat(rat(25, 1), rat(10, 1))],
      ],
      thumb,
    });
  }

  const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmp:CreatorTool="Midjourney" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

  function c2paBlob() {
    // JUMBF superbox with label c2pa and a CBOR claim_generator text.
    const cbor = cat([Uint8Array.from([0xA1, 0x6F]), enc.encode('claim_generator'), Uint8Array.from([0x78, 7]), enc.encode('ChatGPT'),
      enc.encode('..c2pa.actions..digitalSourceType..trainedAlgorithmicMedia..OpenAI')]);
    const desc = cat([Uint8Array.from([0x63, 0x32, 0x70, 0x61, 0, 0x11, 0, 0x10, 0, 0xAA, 0, 0x38, 0x9B, 0x71]), Uint8Array.from([3]), enc.encode('c2pa\0')]);
    const jumd = cat([Uint8Array.from(be32(8 + desc.length)), enc.encode('jumd'), desc]);
    const cb = cat([Uint8Array.from(be32(8 + cbor.length)), enc.encode('cbor'), cbor]);
    return cat([Uint8Array.from(be32(8 + jumd.length + cb.length)), enc.encode('jumb'), jumd, cb]);
  }

  function iccFixture() {
    const desc = cat([enc.encode('desc'), new Uint8Array(4), Uint8Array.from(be32(12)), enc.encode('Display P3\0\0')]);
    const head = new Uint8Array(128);
    const table = cat([Uint8Array.from(be32(1)), enc.encode('desc'), Uint8Array.from(be32(144)), Uint8Array.from(be32(desc.length))]);
    const out = cat([head, table, desc]);
    out.set(be32(out.length), 0);
    return out;
  }

  function jpegSeg(marker, payload) {
    const len = payload.length + 2;
    return cat([Uint8Array.from([0xFF, marker, len >> 8, len & 255]), payload]);
  }

  function photoshopIptc() {
    const cap = enc.encode('Made with Google AI');
    const rec = cat([Uint8Array.from([0x1C, 2, 120, 0, cap.length]), cap]);
    const res = cat([enc.encode('8BIM'), Uint8Array.from([0x04, 0x04, 0, 0]), Uint8Array.from(be32(rec.length)), rec, rec.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
    return cat([enc.encode('Photoshop 3.0\0'), res]);
  }

  function signalKinds(a) { return new Set(a.signals.map((s) => s.kind)); }

  // Fixture builders are reused to load sample files into the app during manual checks.
  window.Fx = { canvasBytes, exifFixture, XMP, c2paBlob, iccFixture, jpegSeg, photoshopIptc, pngChunk, deflate, riff, tiff };
  if (window.FX_ONLY) return;

  // JPEG
  async function testJpeg() {
    const base = await canvasBytes('image/jpeg');
    const tif = await exifFixture();
    const icc = iccFixture();
    const c2 = c2paBlob();
    const app11 = cat([Uint8Array.from([0x4A, 0x50, 0, 1, 0, 0, 0, 1]), c2]);
    const inject = cat([
      jpegSeg(0xE1, cat([enc.encode('Exif\0\0'), tif])),
      jpegSeg(0xE1, cat([enc.encode('http://ns.adobe.com/xap/1.0/\0'), enc.encode(XMP)])),
      jpegSeg(0xE2, cat([enc.encode('ICC_PROFILE\0'), Uint8Array.from([1, 1]), icc])),
      jpegSeg(0xEB, app11),
      jpegSeg(0xED, photoshopIptc()),
      jpegSeg(0xFE, enc.encode('Generated with Midjourney v7')),
    ]);
    // insert after SOI + JFIF APP0 (if any)
    let at = 2;
    if (base[2] === 0xFF && base[3] === 0xE0) at = 4 + ((base[4] << 8) | base[5]);
    const trailer = enc.encode('TRAILING-SECRET');
    const file = cat([base.subarray(0, at), inject, base.subarray(at), trailer]);
    ok(await decodes(file), 'JPEG fixture decodes');

    const a = await AIV.analyze(file);
    ok(a.supported && a.format === 'JPEG', 'JPEG identified');
    const k = signalKinds(a);
    for (const kind of ['c2pa', 'ai-tags', 'ai-params', 'xmp', 'iptc', 'location', 'camera', 'capture', 'dates', 'author', 'identifiers', 'thumbnail', 'icc', 'extra'])
      ok(k.has(kind), `JPEG detects ${kind}`);
    const c2s = a.signals.find((s) => s.kind === 'c2pa');
    ok(c2s && /ChatGPT/.test(c2s.detail), 'C2PA claim generator read: ' + (c2s && c2s.detail));
    const x = a.signals.find((s) => s.kind === 'xmp');
    ok(x && x.ai && /AI-generated/.test(x.detail + x.notes.join()), 'XMP flagged AI via DigitalSourceType');
    const icS = a.signals.find((s) => s.kind === 'icc');
    ok(icS && icS.detail === 'Display P3', 'ICC description read: ' + (icS && icS.detail));
    const loc = a.signals.find((s) => s.kind === 'location');
    ok(loc && /37\.775/.test(loc.detail) && /-122\.41/.test(loc.detail), 'GPS decoded: ' + (loc && loc.detail));
    const ip = a.signals.find((s) => s.kind === 'iptc');
    ok(ip && ip.ai, 'IPTC caption flagged AI');

    // remove everything
    const all = new Set(a.signals.map((s) => s.id));
    const out = AIV.strip(file, a, all);
    ok(await decodes(out), 'JPEG stripped (all) decodes');
    const v = await AIV.verify(out, a, all);
    ok(v.ok && v.after.signals.length === 0, 'JPEG stripped (all) reads back clean: ' + v.after.signals.map((s) => s.label).join(', '));
    const s = AIV.latin1(out);
    ok(!/Firefly|Midjourney|TRAILING|c2pa|Canon|Jane/.test(s), 'JPEG output contains no leftover strings');
    // orientation kept
    const p = AIV.formats[0].impl.parse(out);
    const ex = p.segs.find((g) => g.m === 0xE1);
    const r = ex && AIV.exif.parse(out, ex.data + 6, ex.end);
    ok(r && r.ifd0.length === 1 && r.ifd0[0].tag === 0x0112, 'Orientation preserved as the only Exif tag');
    ok(out.length < file.length, `JPEG size ${file.length} -> ${out.length}`);

    // keep location + dates
    const keep = new Set(a.signals.filter((g) => g.kind !== 'location' && g.kind !== 'dates').map((g) => g.id));
    const out2 = AIV.strip(file, a, keep);
    ok(await decodes(out2), 'JPEG partial strip decodes');
    const a2 = await AIV.analyze(out2);
    const k2 = signalKinds(a2);
    ok(k2.has('location') && k2.has('dates') && k2.size === 2, 'JPEG partial: only location and dates remain: ' + [...k2].join(','));
    const loc2 = a2.signals.find((g) => g.kind === 'location');
    ok(loc2 && loc2.detail === loc.detail, 'GPS values intact after rebuild');

    // keep thumbnail only
    const keepT = new Set(a.signals.filter((g) => g.kind !== 'thumbnail').map((g) => g.id));
    const out3 = AIV.strip(file, a, keepT);
    const a3 = await AIV.analyze(out3);
    ok(a3.signals.length === 1 && a3.signals[0].kind === 'thumbnail', 'JPEG thumbnail kept and relocated');
    const p3 = AIV.formats[0].impl.parse(out3);
    const ex3 = p3.segs.find((g) => g.m === 0xE1);
    const r3 = AIV.exif.parse(out3, ex3.data + 6, ex3.end);
    ok(r3.thumb && await decodes(r3.thumb), 'Relocated thumbnail still decodes');

    ok(AIV.outputName('photo.final.JPG') === 'photo.final_stripped.JPG', 'Rename keeps extension');
  }

  // JPEG with MPF secondary image
  async function testMpf() {
    const main = await canvasBytes('image/jpeg', 40, 30);
    const second = await canvasBytes('image/jpeg', 20, 15);
    // MPF payload with 2 entries; offset of image 2 is relative to the MPF TIFF header.
    const mpfBody = (offset) => {
      const entries = cat([
        Uint8Array.from(be32(0x00030000)), Uint8Array.from(be32(0)), Uint8Array.from(be32(0)), new Uint8Array(4),
        Uint8Array.from(be32(0x00010000)), Uint8Array.from(be32(second.length)), Uint8Array.from(be32(offset)), new Uint8Array(4),
      ]);
      const ifd = cat([Uint8Array.from(be16(1)), Uint8Array.from(be16(0xB002)), Uint8Array.from(be16(7)), Uint8Array.from(be32(32)),
        Uint8Array.from(be32(8 + 2 + 12 + 4)), Uint8Array.from(be32(0))]);
      return cat([enc.encode('MPF\0'), Uint8Array.from([0x4D, 0x4D, 0, 42, 0, 0, 0, 8]), ifd, entries]);
    };
    const junk = jpegSeg(0xEC, cat([enc.encode('Ducky\0'), new Uint8Array(200)])); // placed after MPF, will be removed
    let at = 2;
    if (main[2] === 0xFF && main[3] === 0xE0) at = 4 + ((main[4] << 8) | main[5]);
    const mpfLen = jpegSeg(0xE2, mpfBody(0)).length;
    const mpfTiffStart = at + 4 + 4;
    const eoiEnd = main.length + mpfLen + junk.length;
    const off = eoiEnd - mpfTiffStart;
    const file = cat([main.subarray(0, at), jpegSeg(0xE2, mpfBody(off)), junk, main.subarray(at), second]);
    const a = await AIV.analyze(file);
    const extra = a.signals.find((s) => s.kind === 'extra');
    ok(extra && /Extra embedded images/.test(extra.label), 'MPF secondary image detected');
    const rm = new Set(a.signals.filter((s) => s.kind === 'other').map((s) => s.id));
    const out = AIV.strip(file, a, rm);
    // read patched offset
    const p = AIV.formats[0].impl.parse(out);
    const seg = p.segs.find((g) => g.m === 0xE2);
    const t = seg.data + 4;
    const ifd = t + AIV.u32be(out, t + 4);
    const entAt = t + AIV.u32be(out, ifd + 2 + 8);
    const newOff = AIV.u32be(out, entAt + 16 + 8);
    ok(await decodes(out.subarray(t + newOff, t + newOff + second.length)), 'MPF offset patched: secondary image still found after removing a segment');
  }

  // PNG
  function pngChunk(type, data) {
    const body = cat([enc.encode(type), data]);
    return cat([Uint8Array.from(be32(data.length)), body, Uint8Array.from(be32(AIV.crc32(body)))]);
  }
  async function deflate(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function testPng() {
    const base = await canvasBytes('image/png');
    const ihdrEnd = 8 + 25;
    const params = 'masterpiece, castle\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7';
    const ztxt = cat([enc.encode('Comment\0'), Uint8Array.from([0]), await deflate(enc.encode('{"prompt":"a fox","steps":28,"uc":"bad"}'))]);
    const itxt = cat([enc.encode('XML:com.adobe.xmp\0'), Uint8Array.from([0, 0]), enc.encode('\0\0'), enc.encode(XMP)]);
    const iccp = cat([enc.encode('ICC Profile\0'), Uint8Array.from([0]), await deflate(iccFixture())]);
    const tif = await exifFixture();
    const inject = cat([
      pngChunk('iCCP', iccp),
      pngChunk('tEXt', cat([enc.encode('parameters\0'), enc.encode(params)])),
      pngChunk('zTXt', ztxt),
      pngChunk('iTXt', itxt),
      pngChunk('eXIf', tif),
      pngChunk('caBX', c2paBlob()),
      pngChunk('tIME', Uint8Array.from([0x07, 0xE9, 3, 1, 10, 0, 0])),
      pngChunk('tEXt', cat([enc.encode('Software\0'), enc.encode('NovelAI')])),
    ]);
    const file = cat([base.subarray(0, ihdrEnd), inject, base.subarray(ihdrEnd)]);
    ok(await decodes(file), 'PNG fixture decodes');
    const a = await AIV.analyze(file);
    const k = signalKinds(a);
    for (const kind of ['c2pa', 'ai-params', 'ai-tags', 'xmp', 'icc', 'location', 'dates', 'thumbnail']) ok(k.has(kind), `PNG detects ${kind}`);
    const z = a.signals.find((s) => /Comment/.test(s.label));
    ok(z && z.kind === 'ai-params', 'PNG zTXt NovelAI-style JSON inflated and flagged');
    const all = new Set(a.signals.map((s) => s.id));
    const out = AIV.strip(file, a, all);
    ok(await decodes(out), 'PNG stripped decodes');
    const v = await AIV.verify(out, a, all);
    ok(v.ok && v.after.signals.length === 0, 'PNG reads back clean (orientation-only eXIf ignored)');
    ok(!/parameters|Midjourney|NovelAI|c2pa/.test(AIV.latin1(out)), 'PNG output has no leftover strings');
    // keep ICC only
    const keep = new Set(a.signals.filter((s) => s.kind !== 'icc').map((s) => s.id));
    const out2 = AIV.strip(file, a, keep);
    const a2 = await AIV.analyze(out2);
    ok(a2.signals.length === 1 && a2.signals[0].kind === 'icc', 'PNG keeps ICC when unticked');
    ok(await decodes(out2), 'PNG partial decodes');
  }

  // WebP
  function riff(type, data) {
    const pad = data.length & 1 ? new Uint8Array(1) : new Uint8Array(0);
    return cat([enc.encode(type), Uint8Array.from(le32(data.length)), data, pad]);
  }
  async function testWebp() {
    const base = await canvasBytes('image/webp', 64, 48);
    if (AIV.ascii(base, 8, 4) !== 'WEBP') { ok(true, 'WebP encode not available in this browser, skipped'); return; }
    // keep only the image chunks; reuse the encoder's real ICC profile if it wrote one
    const imgParts = [];
    let realIcc = null;
    for (let i = 12; i + 8 <= base.length;) {
      const t = AIV.ascii(base, i, 4), l = AIV.u32le(base, i + 4), end = i + 8 + l + (l & 1);
      if (t === 'ICCP') realIcc = base.slice(i + 8, i + 8 + l);
      else if (t !== 'VP8X') imgParts.push(base.subarray(i, end));
      i = end;
    }
    const img = cat(imgParts);
    let w = 64, h = 48;
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x20 | 0x08 | 0x04;
    vp8x.set([(w - 1) & 255, (w - 1) >> 8 & 255, (w - 1) >> 16 & 255, (h - 1) & 255, (h - 1) >> 8 & 255, (h - 1) >> 16 & 255], 4);
    const tif = await exifFixture();
    const body = cat([riff('VP8X', vp8x), riff('ICCP', realIcc || iccFixture()), img,
      riff('EXIF', tif), riff('XMP ', enc.encode(XMP)), riff('C2PA', c2paBlob())]);
    const file = cat([enc.encode('RIFF'), Uint8Array.from(le32(body.length + 4)), enc.encode('WEBP'), body]);
    ok(await decodes(file), 'WebP fixture decodes');
    const a = await AIV.analyze(file);
    const k = signalKinds(a);
    for (const kind of ['c2pa', 'xmp', 'icc', 'location', 'ai-tags']) ok(k.has(kind), `WebP detects ${kind}`);
    const all = new Set(a.signals.map((s) => s.id));
    const out = AIV.strip(file, a, all);
    ok(await decodes(out), 'WebP stripped decodes');
    const v = await AIV.verify(out, a, all);
    ok(v.ok && v.after.signals.length === 0, 'WebP reads back clean');
    ok((out[20] & 0x2C) === 0x08, 'VP8X flags: ICC and XMP cleared, EXIF kept for orientation');
    ok(AIV.u32le(out, 4) === out.length - 8, 'RIFF size updated');
  }

  // GIF
  async function testGif() {
    const gif = Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
      0x21, 0xFF, 0x0B, ...enc.encode('NETSCAPE2.0'), 3, 1, 0, 0, 0,
      0x21, 0xFE, 22, ...enc.encode('Created with DALL-E 3!'), 0,
      0x21, 0xFF, 0x0B, ...enc.encode('XMP DataXMP'), ...enc.encode(XMP), 1, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0,
      0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
      0x3B,
    ]);
    ok(await decodes(gif), 'GIF fixture decodes');
    const a = await AIV.analyze(gif);
    const k = signalKinds(a);
    ok(k.has('ai-tags') && k.has('xmp'), 'GIF detects comment + XMP: ' + [...k].join(','));
    const all = new Set(a.signals.map((s) => s.id));
    const out = AIV.strip(gif, a, all);
    ok(await decodes(out), 'GIF stripped decodes');
    ok(/NETSCAPE2\.0/.test(AIV.latin1(out)) && !/DALL|xmpmeta/.test(AIV.latin1(out)), 'GIF keeps loop block, drops comment + XMP');
  }

  // HEIF (structure only)
  async function testHeif() {
    const box = (type, ...parts) => { const d = cat(parts); return cat([Uint8Array.from(be32(8 + d.length)), enc.encode(type), d]); };
    const full = (type, v, ...parts) => box(type, Uint8Array.from([v, 0, 0, 0]), ...parts);
    const tif = await exifFixture();
    const exifPayload = cat([Uint8Array.from(be32(6)), enc.encode('Exif\0\0'), tif]);
    const xmpPayload = enc.encode(XMP);
    const ftyp = box('ftyp', enc.encode('heic'), Uint8Array.from(be32(0)), enc.encode('mif1heic'));
    const infe = (id, type, extra) => full('infe', 2, Uint8Array.from(be16(id)), Uint8Array.from([0, 0]), enc.encode(type), Uint8Array.from([0]), extra || new Uint8Array(0));
    const iinf = full('iinf', 0, Uint8Array.from(be16(2)), infe(1, 'Exif'), infe(2, 'mime', enc.encode('application/rdf+xml\0')));
    const ilocFor = (o1, o2) => full('iloc', 0, Uint8Array.from([0x44, 0x00]), Uint8Array.from(be16(2)),
      Uint8Array.from(be16(1)), Uint8Array.from(be16(0)), Uint8Array.from(be16(1)), Uint8Array.from(be32(o1)), Uint8Array.from(be32(exifPayload.length)),
      Uint8Array.from(be16(2)), Uint8Array.from(be16(0)), Uint8Array.from(be16(1)), Uint8Array.from(be32(o2)), Uint8Array.from(be32(xmpPayload.length)));
    const hdlr = full('hdlr', 0, new Uint8Array(4), enc.encode('pict'), new Uint8Array(13));
    const metaLen = full('meta', 0, hdlr, iinf, ilocFor(0, 0)).length;
    const uuidC2pa = box('uuid', Uint8Array.from('d8fec3d61b0e483c92975828877ec481'.match(/../g).map((h) => parseInt(h, 16))), c2paBlob());
    const mdatStart = ftyp.length + metaLen + uuidC2pa.length + 8;
    const meta = full('meta', 0, hdlr, iinf, ilocFor(mdatStart, mdatStart + exifPayload.length));
    const file = cat([ftyp, meta, uuidC2pa, box('mdat', exifPayload, xmpPayload)]);
    const a = await AIV.analyze(file);
    ok(a.supported && a.format === 'HEIC', 'HEIC identified');
    const k = signalKinds(a);
    for (const kind of ['c2pa', 'xmp', 'location', 'ai-tags']) ok(k.has(kind), `HEIC detects ${kind}`);
    const all = new Set(a.signals.map((s) => s.id));
    const out = AIV.strip(file, a, all);
    ok(out.length === file.length, 'HEIC size unchanged (offsets stay valid)');
    const v = await AIV.verify(out, a, all);
    ok(v.ok && v.after.signals.length === 0, 'HEIC reads back clean: ' + v.after.signals.map((s) => s.label).join(', '));
    ok(!/Firefly|Midjourney|ChatGPT/.test(AIV.latin1(out)), 'HEIC output has no leftover strings');
  }

  for (const t of [testJpeg, testMpf, testPng, testWebp, testGif, testHeif]) {
    try { await t(); } catch (e) { ok(false, `${t.name} threw: ${e && e.stack || e}`); }
  }
  document.getElementById('summary').textContent = `${pass} passed, ${fail} failed`;
  document.title = fail ? `FAIL ${fail}` : `PASS ${pass}`;
  window.__results = { pass, fail };
})();
