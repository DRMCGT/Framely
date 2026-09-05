// Video Background Studio - guard.js
// Externalized from inline <script> to satisfy MV3 CSP (script-src 'self' 'wasm-unsafe-eval').
// Catches the "Failed to resolve module specifier" error when src/ is loaded unbundled
// (should be dist/) and shows actionable status instead of silent broken UI.

window.addEventListener('error', function (e) {
  var msg = (e && e.message) || '';
  if (msg.indexOf('Failed to resolve module specifier') !== -1 && msg.indexOf('@ffmpeg') !== -1) {
    var el = document.getElementById('status');
    if (el) {
      el.textContent = 'Bundle not built — run "npm install && npm run build" then Load unpacked from dist/ (not project root). See README.';
      el.className = 'status show error';
    }
    console.error('[VBS] Bare import error — you loaded src/ instead of dist/. Build first and load dist/.', e);
  }
});

window.addEventListener('unhandledrejection', function (e) {
  var msg = (e && e.reason && e.reason.message) || '';
  if (msg.indexOf('Failed to resolve module specifier') !== -1) {
    var el = document.getElementById('status');
    if (el) {
      el.textContent = 'Bundle not built — run "npm install && npm run build" then Load unpacked from dist/.';
      el.className = 'status show error';
    }
  }
});
