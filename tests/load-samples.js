/* Dev helper: drops a batch of generated sample files into the running app.
   Usage from the console on the app page:
     const s = document.createElement('script'); s.src = '/tests/load-samples.js'; document.head.append(s); */
(async function () {
  window.FX_ONLY = true;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/tests/tests.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const Fx = window.Fx, enc = new TextEncoder(), cat = AIV.concat;

  async function jpeg(full) {
    const base = await Fx.canvasBytes('image/jpeg', 320, 240);
    const at = 4 + ((base[4] << 8) | base[5]);
    const segs = [Fx.jpegSeg(0xE1, cat([enc.encode('Exif\0\0'), await Fx.exifFixture()]))];
    if (full) segs.push(
      Fx.jpegSeg(0xE1, cat([enc.encode('http://ns.adobe.com/xap/1.0/\0'), enc.encode(Fx.XMP)])),
      Fx.jpegSeg(0xEB, cat([Uint8Array.from([0x4A, 0x50, 0, 1, 0, 0, 0, 1]), Fx.c2paBlob()])),
      Fx.jpegSeg(0xED, Fx.photoshopIptc()),
      Fx.jpegSeg(0xFE, enc.encode('Generated with Midjourney v7')));
    return cat([base.subarray(0, at), ...segs, base.subarray(at)]);
  }
  async function png() {
    const base = await Fx.canvasBytes('image/png', 320, 240);
    const params = 'portrait of an astronaut cat, 85mm\nNegative prompt: lowres, blurry\nSteps: 30, Sampler: DPM++ 2M Karras, CFG scale: 6.5, Seed: 2875531, Model: sd_xl_base_1.0';
    return cat([base.subarray(0, 33), Fx.pngChunk('tEXt', cat([enc.encode('parameters\0'), enc.encode(params)])), base.subarray(33)]);
  }
  const files = [
    new File([await jpeg(true)], 'midjourney-astronaut.jpg', { type: 'image/jpeg' }),
    new File([await png()], 'sdxl-render.png', { type: 'image/png' }),
    new File([await jpeg(false)], 'IMG_2041.jpg', { type: 'image/jpeg' }),
    new File([await Fx.canvasBytes('image/png', 200, 200)], 'already-clean.png', { type: 'image/png' }),
    new File([enc.encode('hello')], 'notes.tiff', { type: 'image/tiff' }),
  ];
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));

  // Capture downloads instead of saving them.
  window.__saved = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) { window.__saved.push({ name: this.download, href: this.href }); return; }
    return click.call(this);
  };
})();
