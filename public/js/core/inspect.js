/* Readers for the metadata blocks themselves:
   XMP, C2PA manifests, ICC profiles and IPTC/Photoshop resources. */
(function (G) {
  'use strict';
  const AIV = G.AIV;
  const { detectAI, clip, latin1, u16be, u32be } = AIV;

  // XMP

  function xmpValues(s, prop) {
    const out = [];
    const re1 = new RegExp(`${prop}="([^"]*)"`, 'g');
    const re2 = new RegExp(`${prop}>\\s*(?:<rdf:(?:Alt|Seq|Bag)>\\s*<rdf:li[^>]*>)?([^<]+)<`, 'g');
    let m;
    while ((m = re1.exec(s))) out.push(m[1].trim());
    while ((m = re2.exec(s))) out.push(m[1].trim());
    return [...new Set(out.filter(Boolean))];
  }

  // True when a packet holds no properties at all (only wrappers and padding).
  function isEmptyXmp(s) {
    const body = s.replace(/<\?xpacket[^>]*\?>/g, '');
    if (/<(?!\/)(?!x:xmpmeta\b|rdf:RDF\b|rdf:Description\b)[A-Za-z][\w.-]*:[A-Za-z]/.test(body)) return false;
    if (/\s(?!xmlns\b)(?!rdf:about\b)(?!x:xmptk\b)[A-Za-z][\w.-]*:[A-Za-z][\w.-]*\s*=\s*"/.test(body)) return false;
    return true;
  }

  function inspectXmp(s) {
    const findings = [];
    let ai = false;
    const dst = xmpValues(s, '(?:Iptc4xmpExt:)?DigitalSourceType');
    for (const v of dst) {
      if (/compositeWithTrainedAlgorithmicMedia/i.test(v)) { findings.push('Marked as edited with AI (IPTC digital source type)'); ai = true; }
      else if (/trainedAlgorithmicMedia/i.test(v)) { findings.push('Marked as AI-generated (IPTC digital source type)'); ai = true; }
      else if (/algorithmicMedia|compositeSynthetic/i.test(v)) { findings.push('Marked as computer-generated (IPTC digital source type)'); ai = true; }
    }
    const sys = xmpValues(s, 'Iptc4xmpExt:AISystemUsed');
    if (sys.length) { findings.push('AI system: ' + sys.join(', ')); ai = true; }
    if (/AIPromptInformation/.test(s)) { findings.push('Contains the AI prompt'); ai = true; }
    const tool = xmpValues(s, 'xmp:CreatorTool');
    if (tool.length) {
      findings.push('Created with ' + tool.join(', '));
      if (detectAI(tool.join(' ')).length) ai = true;
    }
    const agents = xmpValues(s, 'stEvt:softwareAgent').filter((a) => !tool.includes(a));
    if (agents.length) {
      findings.push('Edit history: ' + agents.slice(0, 4).join(', ') + (agents.length > 4 ? ` and ${agents.length - 4} more` : ''));
    }
    const credit = xmpValues(s, '(?:photoshop:Credit|dc:source)');
    if (credit.length && detectAI(credit.join(' ')).length) findings.push('Credit: ' + credit.join(', '));
    if (/c2pa|contentauth/i.test(s)) { findings.push('Links to Content Credentials'); ai = true; }
    const hits = detectAI(s).filter((h) => !h.startsWith('IPTC'));
    if (hits.length) { ai = true; findings.push('Mentions ' + hits.join(', ')); }
    if (/exif:GPSLatitude|GPSLatitude=/.test(s)) findings.push('Contains location');
    if (/dc:creator|photoshop:AuthorsPosition|xmpRights/.test(s)) findings.push('Contains author or rights info');
    if (/xmpMM:(DocumentID|InstanceID|OriginalDocumentID)/.test(s)) findings.push('Contains document IDs that can link copies of this file');
    const notes = [];
    if (/hdrgm:|GContainer/.test(s)) notes.push('Also describes an HDR gain map. Removing it shows the photo in standard range.');
    return { ai, findings: [...new Set(findings)], notes };
  }

  function xmpSignal(id, s, size, label = 'XMP metadata') {
    if (isEmptyXmp(s)) return null;
    const x = inspectXmp(s);
    return {
      id, kind: 'xmp', label, ai: x.ai, size,
      detail: x.findings.length ? x.findings[0] : 'Editing and descriptive metadata',
      notes: x.findings.slice(1).concat(x.notes),
    };
  }

  // C2PA / JUMBF

  function cborText(b, i) {
    const h = b[i];
    if (h === undefined || h >> 5 !== 3) return null;
    let n = h & 31, p = i + 1;
    if (n === 24) { n = b[p]; p += 1; }
    else if (n === 25) { n = u16be(b, p); p += 2; }
    else if (n > 24) return null;
    if (p + n > b.length) return null;
    return AIV.utf8(b.subarray(p, p + n));
  }

  function cborAfterKey(b, s, key) {
    const out = [];
    let i = -1;
    while ((i = s.indexOf(key, i + 1)) !== -1 && out.length < 6) {
      const after = i + key.length;
      const direct = cborText(b, after);
      if (direct !== null) { out.push(direct); continue; }
      const near = s.indexOf('name', after);
      if (near !== -1 && near - after < 80) {
        const v = cborText(b, near + 4);
        if (v) out.push(v);
      }
    }
    return out;
  }

  function inspectC2pa(b) {
    const s = latin1(b);
    const gens = [...new Set(cborAfterKey(b, s, 'claim_generator_info').concat(cborAfterKey(b, s, 'claim_generator')))]
      .filter((g) => g && g.length < 120 && !/^c2pa-rs/i.test(g));
    const agents = [...new Set(cborAfterKey(b, s, 'softwareAgent'))].filter((g) => g && g.length < 120);
    const findings = [];
    if (/compositeWithTrainedAlgorithmicMedia/.test(s)) findings.push('Declares the image was edited with AI');
    else if (/trainedAlgorithmicMedia/.test(s)) findings.push('Declares the image was generated by AI');
    if (gens.length) findings.unshift('Made with ' + gens.slice(0, 3).join(', '));
    if (agents.length) findings.push('Tools: ' + agents.slice(0, 4).join(', '));
    const signer = s.match(/\b(OpenAI|Google LLC|Google|Adobe|Microsoft|Truepic|Samsung|Leica|Nikon|Sony|Canon|Qualcomm|Meta Platforms|TikTok|LinkedIn|Shutterstock|Getty)\b/);
    if (signer && !findings.some((f) => f.includes(signer[1]))) findings.push('Signed by ' + signer[1]);
    const hits = detectAI(gens.concat(agents).join(' '));
    if (hits.length && !findings.some((f) => /AI/.test(f))) findings.push('Matches: ' + hits.join(', '));
    return findings;
  }

  function c2paSignal(id, bytes, size) {
    const f = inspectC2pa(bytes);
    return {
      id, kind: 'c2pa', label: 'Content Credentials (C2PA)', ai: true, size,
      detail: f[0] || 'Signed provenance manifest describing how the image was made',
      notes: f.slice(1),
    };
  }

  // ICC

  function iccName(b) {
    try {
      if (b.length < 132) return '';
      const n = u32be(b, 128);
      for (let i = 0; i < n && i < 100; i++) {
        const p = 132 + i * 12;
        if (latin1(b, p, p + 4) !== 'desc') continue;
        const off = u32be(b, p + 4);
        const type = latin1(b, off, off + 4);
        if (type === 'desc') {
          const len = u32be(b, off + 8);
          return latin1(b, off + 12, off + 12 + len).replace(/\0+$/, '');
        }
        if (type === 'mluc') {
          const recLen = u32be(b, off + 20), recOff = u32be(b, off + 24);
          return AIV.utf16be.decode(b.subarray(off + recOff, off + recOff + recLen)).replace(/\0+$/, '');
        }
      }
    } catch (e) { /* malformed profile */ }
    return '';
  }

  function iccSignal(id, bytes, size, name) {
    const nm = name || iccName(bytes);
    return {
      id, kind: 'icc', label: 'Color profile (ICC)', ai: false, size,
      detail: nm ? clip(nm, 80) : 'Embedded color profile',
      notes: ['Removing it can make colors look a little different, especially on wide-gamut photos.'],
    };
  }

  // IPTC-IIM inside Photoshop resources

  const IPTC_NAMES = {
    5: 'Title', 25: 'Keywords', 55: 'Date created', 60: 'Time created', 65: 'Program', 70: 'Program version',
    80: 'By-line', 85: 'By-line title', 90: 'City', 95: 'State', 101: 'Country', 105: 'Headline',
    110: 'Credit', 115: 'Source', 116: 'Copyright', 120: 'Caption', 122: 'Caption writer',
  };

  function inspectPhotoshop(b) {
    const fields = [];
    const texts = [];
    const resources = [];
    let p = 0;
    while (p + 12 <= b.length && latin1(b, p, p + 4) === '8BIM') {
      const rid = u16be(b, p + 4);
      const nlen = b[p + 6];
      let q = p + 7 + nlen;
      if ((nlen + 1) & 1) q++;
      const size = u32be(b, q);
      const data = b.subarray(q + 4, q + 4 + size);
      resources.push(rid);
      if (rid === 0x0404) {
        let i = 0;
        while (i + 5 <= data.length && data[i] === 0x1C) {
          const rec = data[i + 1], ds = data[i + 2], len = u16be(data, i + 3);
          if (rec === 2 && IPTC_NAMES[ds]) {
            fields.push(IPTC_NAMES[ds]);
            texts.push(AIV.text(data.subarray(i + 5, i + 5 + len)));
          }
          i += 5 + len;
        }
      }
      p = q + 4 + size + (size & 1);
    }
    const uniq = [...new Set(fields)];
    const findings = [];
    if (uniq.length) findings.push('Fields: ' + uniq.join(', '));
    if (resources.some((r) => r === 0x0409 || r === 0x040C)) findings.push('Includes a thumbnail');
    if (resources.includes(0x0424)) findings.push('Includes an XMP copy');
    const hits = detectAI(texts.join(' '));
    if (hits.length) findings.push('Matches: ' + hits.join(', '));
    return { findings, ai: hits.length > 0 };
  }

  function photoshopSignal(id, bytes, size) {
    const r = inspectPhotoshop(bytes);
    return {
      id, kind: 'iptc', label: 'IPTC and Photoshop data', ai: r.ai, size,
      detail: r.findings[0] || 'Photoshop image resources',
      notes: r.findings.slice(1),
    };
  }

  // free text (comments, PNG text chunks)

  function textSignal(id, key, value, size, fallbackKind, source) {
    const hits = detectAI(key + ' ' + value);
    let kind = fallbackKind;
    const paramsKey = /^(parameters|prompt|workflow|sd-metadata|invokeai_metadata|invokeai_graph|dream|generation_data|negative_prompt|sd:.*|lora_hashes|aesthetic_score)$/i.test(key);
    if (paramsKey || AIV.looksLikeParams(value) || (hits.length && value.length > 240)) kind = 'ai-params';
    else if (hits.length) kind = 'ai-tags';
    const label = key ? `${AIV.KINDS[kind].label} (“${clip(key, 40)}”)` : AIV.KINDS[kind].label;
    const notes = [];
    if (hits.length) notes.push('Matches: ' + hits.join(', '));
    if (/^workflow$/i.test(key)) notes.push('ComfyUI node graph');
    return {
      id, kind, label, ai: !!AIV.KINDS[kind].ai, size, source,
      detail: clip(value, kind === 'ai-params' ? 260 : 180) || '(empty)',
      notes,
    };
  }

  Object.assign(AIV, { xmpSignal, isEmptyXmp, c2paSignal, iccSignal, iccName, photoshopSignal, textSignal });
})(typeof window !== 'undefined' ? window : globalThis);
