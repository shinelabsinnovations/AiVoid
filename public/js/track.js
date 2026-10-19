/* Anonymous counts. Sends only {type, files}; never file names,
   contents or metadata. Skipped for Do Not Track / Global Privacy Control and
   when the page is opened from disk. */
(function () {
  'use strict';
  const off = location.protocol === 'file:' ||
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === '1' || window.doNotTrack === '1';

  function send(body) {
    if (off) return;
    try {
      fetch('api/hit.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: 'omit',
      }).catch(() => {});
    } catch (e) { /* counting is best-effort */ }
  }

  window.AIVTrack = {
    visit: () => send({ type: 'visit' }),
    clean: (files) => { if (files > 0) send({ type: 'clean', files }); },
  };
})();
