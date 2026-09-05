// Video Background Studio - x-extract.js
// Studio-side orchestration for X/Twitter extraction:
// open tweet tab -> inject bridge (isolated) + hook (MAIN world) ->
// collect MP4 variants -> close tab. No servers, no API keys — the user's own
// logged-in page does the auth; we only read the file URLs it already loads.

const X_HOST_RE = /(^|\.)(x\.com|twitter\.com)$/i;
const NEEDED_ORIGINS = [
  'https://x.com/*',
  'https://twitter.com/*',
  'https://*.twimg.com/*'
];
const INJECT_TIMEOUT_MS = 15000;

/** True for x.com / twitter.com post links. */
export function isXLink(url) {
  try {
    return X_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function hasExtApis() {
  return typeof chrome !== 'undefined' && !!(chrome.tabs && chrome.scripting && chrome.runtime && chrome.permissions);
}

async function ensureOrigins() {
  const granted = await chrome.permissions.request({ origins: NEEDED_ORIGINS });
  if (!granted) throw new Error('Permission denied — allow access to x.com when asked, then try again.');
}

async function tabIsComplete(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return t.status === 'complete';
  } catch {
    return false;
  }
}

function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    // Race-safe: the tab may already be complete before we subscribe.
    tabIsComplete(tabId).then((already) => {
      if (already) {
        chrome.tabs.onUpdated.removeListener(onUpd);
        clearTimeout(to);
        resolve();
      }
    });
    const to = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      reject(new Error('The tweet tab took too long to load. Check your connection and try again.'));
    }, timeoutMs);
    function onUpd(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(to);
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

/**
 * Open a tweet URL and extract its MP4 variants.
 * @param {string} statusUrl
 * @param {{ onStatus?: (msg:string)=>void, timeoutMs?: number }} [opts]
 * @returns Promise<Array<{url:string, bitrate:number}>> sorted best-first
 */
export async function extractXVariants(statusUrl, opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const timeoutMs = opts.timeoutMs || INJECT_TIMEOUT_MS;
  if (!isXLink(statusUrl)) throw new Error('That is not an X/Twitter link.');
  if (!hasExtApis()) {
    throw new Error('Extraction needs the built extension (chrome tabs/scripting APIs). Load dist/ as unpacked and try again.');
  }

  onStatus('Requesting access to x.com…');
  await ensureOrigins();

  onStatus('Opening the post…');
  const tab = await chrome.tabs.create({ url: statusUrl, active: true });
  let variants = [];
  let layer = null;
  let done = false;
  let pageState = null;
  let lastStats = null;
  let injectedOnce = false;

  const onMsg = (msg) => {
    if (!msg || msg.target !== 'vbs-studio') return;
    if (msg.kind === 'x-note') {
      if (msg.pageState) pageState = msg.pageState;
      if (msg.stats) lastStats = msg.stats;
      console.log('[VBS] x-hook note:', msg.detail || '', msg.stats || '', `page=${msg.pageState || '?'}`);
      return;
    }
    if (msg.kind !== 'x-variants') return;
    if (msg.variants && msg.variants.length && !done) {
      done = true;
      variants = msg.variants;
      layer = msg.layer || null;
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);

  // Inject bridge (isolated relay) + hook (MAIN-world observer).
  // Must run BEFORE X's app code fetches tweet data — never wait for 'complete' first.
  const tryInject = async () => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/x-bridge.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/x-main-hook.js'], world: 'MAIN' });
      if (!injectedOnce) {
        injectedOnce = true;
        console.log('[VBS] x-hook injected into tab', tab.id);
      }
    } catch {
      // Tab not ready yet or navigating — the onUpdated re-inject covers it.
    }
  };
  const onUpdInject = (id, info) => {
    if (id === tab.id && (info.status === 'loading' || info.status === 'complete')) tryInject();
  };
  chrome.tabs.onUpdated.addListener(onUpdInject);

  const finish = async () => {
    chrome.runtime.onMessage.removeListener(onMsg);
    chrome.tabs.onUpdated.removeListener(onUpdInject);
    try { await chrome.tabs.remove(tab.id); } catch {}
  };

  try {
    // Fire immediately: the page may still be loading, which is exactly when
    // the fetch/XHR wrappers need to exist.
    await tryInject();
    await waitTabComplete(tab.id);
    onStatus('Reading the video… (play it if it does not autoplay)');
    // Late safety net in case every early attempt raced a navigation.
    await tryInject();

    const deadline = Date.now() + timeoutMs + 5000;
    while (!done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!done || !variants.length) {
      const s = lastStats || {};
      const summary = `(scanned ${s.apiJson || 0} API + ${s.xhrJson || 0} XHR responses, ${s.videoEls || 0} video tags; page: ${pageState || 'unknown'})`;
      if ((pageState || '') === 'loginwall') {
        throw new Error(`X is showing a login wall ${summary} — log in to X in this browser, then retry.`);
      }
      throw new Error(`No video found in that post ${summary} — it may be text-only or age-gated. Open it and check, then retry.`);
    }
    console.log(`[VBS] x-extract: ${variants.length} variant(s) via ${layer}`);
    onStatus(`Found ${variants.length} version${variants.length > 1 ? 's' : ''} — pick one below.`);
    return variants;
  } finally {
    await finish();
  }
}

/** Human label for a variant row (bitrate -> approx quality). */
export function variantLabel(v, index) {
  const kbps = Math.round((v.bitrate || 0) / 1000);
  let tag = 'SD';
  if (kbps >= 2000) tag = 'HD 1080p';
  else if (kbps >= 800) tag = 'HD 720p';
  else if (kbps >= 300) tag = '540p';
  const best = index === 0 ? ' • Best' : '';
  return kbps > 0 ? `${tag} (~${kbps} kbps${best})` : `Source${best}`;
}
