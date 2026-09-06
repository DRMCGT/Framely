/* Framely - x-bridge.js
 * Isolated-world content script. Relays MAIN-world hook findings (window
 * postMessage) to the studio page via extension messaging. Plain classic
 * script — no imports/exports.
 */
(function () {
  var NS = 'FRAMELY_X_HOOK';
  window.addEventListener('message', function (e) {
    try {
      var d = e.data;
      if (!d || d.__framely !== NS) return;
      if (d.type !== 'variants' && d.type !== 'note') return;
      chrome.runtime.sendMessage({
        target: 'framely-studio',
        kind: d.type === 'variants' ? 'x-variants' : 'x-note',
        variants: d.variants || [],
        layer: d.layer || null,
        detail: d.detail || null,
        stats: d.stats || null,
        pageState: d.pageState || null
      }).catch(function () {});
    } catch (err) {}
  });
})();
