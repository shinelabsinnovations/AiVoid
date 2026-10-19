/* Shared helpers, signal kinds and AI pattern matching. */
(function (G) {
  'use strict';
  const AIV = G.AIV || (G.AIV = {});

  const utf8Dec = new TextDecoder('utf-8', { fatal: false });
  const utf16le = new TextDecoder('utf-16le');
  const utf16be = new TextDecoder('utf-16be');

  function latin1(b, s = 0, e = b.length) {
    let out = '';
    const CH = 0x8000;
    for (let i = s; i < e; i += CH) {
      out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + CH)));
    }
    return out;
  }

  function ascii(b, s, n) {
    return latin1(b, s, Math.min(b.length, s + n));
  }

  function utf8(b) {
    return utf8Dec.decode(b);
  }

  function text(b) {
    const s = utf8Dec.decode(b);
    // Fall back to latin1 when the bytes clearly are not UTF-8.
    return s.includes('�') ? latin1(b) : s;
  }

  const u16be = (b, o) => (b[o] << 8) | b[o + 1];
  const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u16le = (b, o) => b[o] | (b[o + 1] << 8);
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + (b[o + 3] << 24 >>> 0);

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function clip(str, n = 180) {
    const s = String(str || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      return null;
    }
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, crc = 0) {
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return ~c >>> 0;
  }

  /* Signal kinds. Order decides how they are listed. */
  const KINDS = {
    c2pa:        { label: 'Content Credentials (C2PA)', ai: true },
    'ai-params': { label: 'AI prompt and generation settings', ai: true },
    'ai-tags':   { label: 'AI tool tags', ai: true },
    xmp:         { label: 'XMP metadata' },
    iptc:        { label: 'IPTC and Photoshop data' },
    location:    { label: 'Location (GPS)' },
    camera:      { label: 'Camera and lens' },
    capture:     { label: 'Capture settings' },
    dates:       { label: 'Dates and times' },
    software:    { label: 'Software' },
    author:      { label: 'Author and copyright' },
    description: { label: 'Descriptions and comments' },
    identifiers: { label: 'Unique IDs and serial numbers' },
    makernote:   { label: 'Maker notes' },
    thumbnail:   { label: 'Embedded thumbnail' },
    icc:         { label: 'Color profile (ICC)' },
    extra:       { label: 'Extra images and trailing data' },
    other:       { label: 'Other metadata' },
  };
  const KIND_ORDER = Object.keys(KINDS);

  /* Known AI tools and AI markers. Matched against every text value we find. */
  const AI_RULES = [
    ['IPTC: AI-generated', /\btrainedAlgorithmicMedia\b/],
    ['IPTC: edited with AI', /compositeWithTrainedAlgorithmicMedia/i],
    ['IPTC: computer-generated', /\b(algorithmicMedia|compositeSynthetic)\b/],
    ['IPTC AI fields', /\bAI(SystemUsed|SystemVersionUsed|PromptInformation|PromptWriterName)\b/],
    ['Midjourney', /midjourney/i],
    ['DALL·E', /\bdall[\s·\-_.]?e\b/i],
    ['OpenAI', /\bopen\s?ai\b/i],
    ['ChatGPT', /\bchatgpt\b|\bgpt-?(4o|image)/i],
    ['Stable Diffusion', /stable[\s_-]?diffusion|\bsdxl\b|\bsd[\s_-]?(1\.5|2\.1|3(\.5)?)\b|stability[\s.]?ai|dreamstudio/i],
    ['ComfyUI', /comfy\s?ui/i],
    ['AUTOMATIC1111', /automatic1111|\bA1111\b|sd-webui|stable-diffusion-webui|\bforge\b.*\bwebui\b/i],
    ['NovelAI', /novel\s?ai/i],
    ['InvokeAI', /invoke\s?ai/i],
    ['Fooocus', /fooocus/i],
    ['Adobe Firefly', /firefly/i],
    ['Generative Fill', /generative[\s_-]?(fill|expand|ai|remove)/i],
    ['Google Imagen', /\bimagen\b/i],
    ['Google Gemini', /\bgemini\b/i],
    ['Google AI', /made with google ai|google ai|synthid|nano[\s-]?banana/i],
    ['Microsoft Designer', /image creator|bing image|microsoft designer|\bcopilot\b/i],
    ['Meta AI', /meta ai|imagine with meta|imagined with ai/i],
    ['Grok', /\bgrok\b|\bx\.ai\b|\bxai\b/i],
    ['Leonardo.Ai', /leonardo[\s.]?ai/i],
    ['Ideogram', /ideogram/i],
    ['FLUX', /\bflux(\.1)?[\s_-]?(dev|schnell|pro|kontext|1\.1)\b|black forest labs/i],
    ['Runway', /runway\s?ml|runway gen/i],
    ['Canva AI', /canva (ai|magic)|magic media|dream lab/i],
    ['Krea', /krea[\s.]?ai/i],
    ['Playground', /playground\s?(ai|v\d)/i],
    ['Kandinsky', /kandinsky/i],
    ['Recraft', /recraft/i],
    ['Luma', /luma (ai|labs)|dream machine/i],
    ['Other AI model', /\b(hunyuan|seedream|kling|jimeng|qwen-image|tongyi|wanx|hidream|pixart|deepfloyd|wuerstchen)\b/i],
    ['AI generation settings', /negative prompt|cfg scale|\bsampler\b|denoising strength|\bsteps:\s*\d+|\bseed:\s*\d+|"class_type"|"ckpt_name"|lora:/i],
    ['AI-generated label', /\bai[\s_-]?generated\b|\bgenerated (by|with|using) (an? )?ai\b|\bai[\s_-]?edited\b|c2pa\.ai_/i],
  ];

  function detectAI(str) {
    if (!str) return [];
    const s = String(str);
    const hits = [];
    for (const [name, re] of AI_RULES) if (re.test(s)) hits.push(name);
    return hits;
  }

  const PARAMS_RE = /negative prompt|cfg scale|\bsampler\b|\bsteps:\s*\d+|"prompt"\s*:|"class_type"|"workflow"|"uc"\s*:|"steps"\s*:/i;
  function looksLikeParams(str) {
    return PARAMS_RE.test(String(str || ''));
  }

  Object.assign(AIV, {
    latin1, ascii, utf8, text, utf16le, utf16be,
    u16be, u32be, u16le, u32le, concat, clip, fmtBytes, inflate, crc32,
    KINDS, KIND_ORDER, detectAI, looksLikeParams,
  });
})(typeof window !== 'undefined' ? window : globalThis);
