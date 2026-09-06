/* Framely - x-main-hook.js
 * Runs in the PAGE's MAIN world (not the isolated content-script world) so it
 * can observe the same API responses and player state the X page itself uses.
 * Plain classic script — no imports/exports (injected via scripting.executeScript).
 *
 * CRITICAL: this file is injected IMMEDIATELY after the tab opens (before the
 * page finishes loading) so the fetch/XHR wrappers exist BEFORE X's app code
 * fetches TweetDetail data. Injecting after 'complete' misses everything.
 *
 * Layers (first hit wins, all reported):
 *  1a. fetch-hook: TweetDetail GraphQL JSON -> video_info.variants[]
 *  1b. xhr-hook: same via XMLHttpRequest (older/fallback code paths)
 *  2. embedded JSON: <script> blobs scanned on an interval
 *  3. video element: currentSrc/poster fallback signal
 * Plus: auto-play driver (triggers lazy loads) and heartbeat/stats notes so a
 * failure is diagnosable instead of generic.
 *
 * Pure parsing lives in __framelyXHook.extractMp4Variants() so it stays unit-testable.
 * Every page interaction is guarded — never break the host page.
 */
(function () {
  var NS = 'FRAMELY_X_HOOK';
  var SCAN_MS = 15000;

  var stats = { apiJson: 0, xhrJson: 0, embeddedScans: 0, videoEls: 0 };
  var gotHit = false;

  function post(msg) {
    try {
      window.postMessage({ __framely: NS, type: msg.type, variants: msg.variants || null, layer: msg.layer || null, detail: msg.detail || null, stats: msg.stats || null, pageState: msg.pageState || pageState() }, '*');
    } catch (e) { /* never break the host page */ }
  }

  function pageState() {
    try {
      if (document.querySelector('article[data-testid="tweet"]')) return 'tweet';
      var href = location.href || '';
      if (/\/login|\/i\/flow/.test(href)) return 'loginwall';
      var body = (document.body && document.body.innerText || '').slice(0, 2000);
      if (/log in to X|sign up for X/i.test(body)) return 'loginwall';
    } catch (e) {}
    return 'unknown';
  }

  /** Keep the best MP4 variant list from a video_info object. */
  function pickVariants(videoInfo) {
    if (!videoInfo || !videoInfo.variants || !videoInfo.variants.length) return [];
    var seen = {};
    var out = [];
    for (var i = 0; i < videoInfo.variants.length; i++) {
      var v = videoInfo.variants[i] || {};
      if (v.content_type !== 'video/mp4' || !v.url) continue; // skip m3u8 manifests
      if (seen[v.url]) continue;
      seen[v.url] = true;
      out.push({ url: v.url, bitrate: v.bitrate || 0 });
    }
    out.sort(function (a, b) { return b.bitrate - a.bitrate; });
    return out;
  }

  /** Deep-walk any JSON for video_info objects; merge+dedupe all MP4 variants. */
  function extractMp4Variants(root) {
    var best = [];
    var seenUrls = {};
    var stack = [root];
    var guard = 0;
    while (stack.length && guard++ < 50000) {
      var node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.video_info && node.video_info.variants) {
        var got = pickVariants(node.video_info);
        for (var i = 0; i < got.length; i++) {
          if (!seenUrls[got[i].url]) {
            seenUrls[got[i].url] = true;
            best.push(got[i]);
          }
        }
      }
      if (Array.isArray(node)) {
        for (var a = 0; a < node.length; a++) stack.push(node[a]);
      } else {
        for (var k in node) {
          if (Object.prototype.hasOwnProperty.call(node, k)) {
            var child = node[k];
            if (child && typeof child === 'object') stack.push(child);
          }
        }
      }
    }
    best.sort(function (a, b) { return b.bitrate - a.bitrate; });
    return best;
  }

  // Exposed for the node unit-test harness (harmless on the page).
  try {
    window.__framelyXHook = { extractMp4Variants: extractMp4Variants, pickVariants: pickVariants };
  } catch (e) {}

  function emitIfAny(variants, layer) {
    if (variants && variants.length && !gotHit) {
      gotHit = true;
      try { if (origFetch) window.fetch = origFetch; } catch (e) {} // stop shadowing the page
      post({ type: 'variants', variants: variants, layer: layer, stats: stats });
      return true;
    }
    return !!(variants && variants.length);
  }

  function scanJsonPayload(j, layer, counter) {
    try {
      if (counter) stats[counter]++;
      emitIfAny(extractMp4Variants(j), layer);
    } catch (e) {}
  }

  // --- Layer 1a: hook page fetch (TweetDetail GraphQL etc.) ---
  var origFetch = null;
  try {
    if (typeof window.fetch === 'function') {
      origFetch = window.fetch.bind(window);
      window.fetch = function () {
        var p;
        try {
          p = origFetch.apply(null, arguments);
        } catch (e) {
          return Promise.reject(e);
        }
        return p.then(function (res) {
          try {
            if (gotHit) return res;
            var ct = '';
            try { ct = res.headers.get('content-type') || ''; } catch (e2) {}
            if (ct.indexOf('json') !== -1 && res.clone) {
              res.clone().json().then(function (j) {
                scanJsonPayload(j, 'fetch-hook', 'apiJson');
              }).catch(function () {});
            }
          } catch (e3) {}
          return res;
        });
      };
    }
  } catch (e) {}

  // --- Layer 1b: hook XMLHttpRequest (fallback code paths) ---
  try {
    if (typeof window.XMLHttpRequest === 'function') {
      var OrigXHR = window.XMLHttpRequest;
      var origOpen = OrigXHR.prototype.open;
      OrigXHR.prototype.open = function () {
        try { this.__framelyUrl = arguments.length > 1 ? arguments[1] : ''; } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      var origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.send = function () {
        try {
          this.addEventListener('load', function () {
            try {
              if (gotHit) return;
              var ct = '';
              try { ct = this.getResponseHeader('content-type') || ''; } catch (e) {}
              if (ct.indexOf('json') !== -1 && this.responseText) {
                scanJsonPayload(JSON.parse(this.responseText), 'xhr-hook', 'xhrJson');
              }
            } catch (e2) {}
          });
        } catch (e3) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {}

  // --- Layer 2: embedded JSON blobs ---
  function scanEmbedded() {
    stats.embeddedScans++;
    var found = false;
    try {
      var el = document.getElementById('__NEXT_DATA__');
      if (el && el.textContent) {
        try {
          if (emitIfAny(extractMp4Variants(JSON.parse(el.textContent)), 'embedded-json')) found = true;
        } catch (e) {}
      }
      if (!found) {
        var scripts = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]');
        for (var i = 0; i < scripts.length && !found; i++) {
          try {
            var j = JSON.parse(scripts[i].textContent || 'null');
            if (emitIfAny(extractMp4Variants(j), 'embedded-json')) found = true;
          } catch (e2) {}
        }
      }
    } catch (e3) {}
    return found;
  }

  // --- Layer 3: live <video> element signal ---
  function scanVideoEl() {
    try {
      var vids = document.querySelectorAll('video');
      stats.videoEls = Math.max(stats.videoEls, vids.length);
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        var src = v.currentSrc || v.src || '';
        if (src && src.indexOf('blob:') !== 0 && /\.mp4(\?|$)/i.test(src)) {
          return emitIfAny([{ url: src, bitrate: 0 }], 'video-element');
        }
      }
    } catch (e) {}
    return false;
  }

  // --- Auto-play driver: scroll video into view + play (triggers lazy loads) ---
  function tryAutoplay() {
    try {
      if (gotHit) return;
      var v = document.querySelector('video');
      if (!v) return;
      try { v.scrollIntoView({ block: 'center' }); } catch (e) {}
      if (v.paused) {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
  }

  function scanAll() {
    if (gotHit) return;
    if (scanEmbedded()) return;
    scanVideoEl();
  }

  // Heartbeat first: proves hook alive + page state even when nothing found.
  post({ type: 'note', detail: 'hook alive', stats: stats });
  scanAll();
  var scanTimer = setInterval(function () {
    if (gotHit) { clearInterval(scanTimer); return; }
    scanAll();
  }, 1000);
  var statsTimer = setInterval(function () {
    if (gotHit) { clearInterval(statsTimer); return; }
    post({ type: 'note', detail: 'stats', stats: stats });
  }, 5000);
  setTimeout(function () { clearInterval(scanTimer); clearInterval(statsTimer); }, SCAN_MS);
  setTimeout(tryAutoplay, 2500);
  setTimeout(tryAutoplay, 7000);
})();
