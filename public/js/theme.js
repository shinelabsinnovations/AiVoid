/* Applies the saved appearance before first paint, then wires the
   system / light / dark switcher once the page has loaded. */
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  try {
    var t = localStorage.getItem('aivoid-theme');
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system */ }

  function setTheme(choice) {
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    try {
      if (choice === 'system') localStorage.removeItem('aivoid-theme');
      else localStorage.setItem('aivoid-theme', choice);
    } catch (e) { /* ignore */ }
    sync();
  }

  function sync() {
    var cur = root.getAttribute('data-theme') || 'system';
    document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.themeChoice === cur));
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var group = document.querySelector('.theme');
    if (!group) return;
    sync();
    group.querySelectorAll('[data-theme-choice]').forEach(function (b) {
      b.addEventListener('click', function () { setTheme(b.dataset.themeChoice); });
    });
    group.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var btns = Array.prototype.slice.call(group.querySelectorAll('button'));
      var i = btns.indexOf(document.activeElement);
      var n = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
      n.focus(); n.click(); e.preventDefault();
    });
  });
})();
