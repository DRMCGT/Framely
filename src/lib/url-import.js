// Framely - url-import.js
// Fetch a direct media URL (video/image) into a File for the existing pipeline.
// Platform watch/share links (YouTube/X/Facebook posts) are NOT downloadable
// client-side (no CORS, ciphered streams, platform ToS) — those are detected
// and routed to a guided download-then-drop fallback instead of a fake feature.

export const URL_FETCH_MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB
export const URL_FETCH_MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB

const PLATFORM_LINK_RE = /(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|vimeo\.com|dailymotion\.com|twitch\.tv|reddit\.com)/i;

/** True when the URL is a platform post link rather than a direct file link. */
export function isPlatformLink(url) {
  return PLATFORM_LINK_RE.test(url || '');
}

/** Guess media kind from URL path + (later) content-type. Returns 'video'|'image'|null. */
function guessKindFromUrl(url) {
  const path = (url.split('?')[0] || '').toLowerCase();
  if (/\.(mp4|webm|mov|m4v|avi|mkv)(\/|$)/.test(path) || /\.mp4$/i.test(path) || /\.(webm|mov|m4v)$/i.test(path)) return 'video';
  if (/\.(png|jpe?g|webp|gif|bmp|avif)(\/|$)/.test(path)) return 'image';
  return null;
}

function fileNameFromUrl(url, fallback) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || fallback;
    return decodeURIComponent(last).split('?')[0] || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Ask Chrome for host access at runtime (no scary upfront <all_urls> warning).
 * Resolves true when fetch may proceed, false when the user denied.
 */
export async function requestHostAccess(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const origin = `${u.protocol}//${u.host}/*`;
    if (typeof chrome !== 'undefined' && chrome.permissions) {
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (has) return true;
      return await chrome.permissions.request({ origins: [origin] });
    }
    // Not in extension context (dev server) — plain fetch applies.
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a direct media URL into a File.
 * @param {string} url
 * @param {'video'|'image'} expected - selects size cap + validation
 * @param {(loaded:number, total:number|null)=>void} [onProgress]
 * @returns Promise<File>
 * Throws friendly Errors for: platform links, denied permission, HTTP errors,
 * wrong content-type, oversize, network/hotlink blocks.
 */
export async function fetchMediaUrl(url, expected, onProgress) {
  const clean = (url || '').trim();
  if (!clean) throw new Error('Paste a link first.');
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) links can be fetched.');
  }
  if (isPlatformLink(clean)) {
    throw platformLinkError();
  }

  const allowed = await requestHostAccess(clean);
  if (!allowed) {
    throw new Error('Permission denied — the browser needs host access to fetch that link. Allow it and try again.');
  }

  let res;
  try {
    res = await fetch(clean, { credentials: 'omit', redirect: 'follow' });
  } catch (e) {
    throw new Error('Could not reach that link (network error or the host blocks embedding). If it is a social post, download the file and drop it here instead.');
  }
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}). Check the link or download the file and drop it here.`);
  }

  const maxBytes = expected === 'video' ? URL_FETCH_MAX_VIDEO_BYTES : URL_FETCH_MAX_IMAGE_BYTES;
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? parseInt(totalHeader, 10) : null;
  if (total && total > maxBytes) {
    throw new Error(`That file is too large (${formatMB(total)}). Download it and try a smaller file.`);
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentTypeMatches(contentType, expected) && !contentType.includes('octet-stream')) {
    throw new Error(`That link serves ${contentType.split(';')[0] || 'an unknown type'}, not ${expected === 'video' ? 'a video' : 'an image'}.`);
  }
  // If headers are generic, require a matching file extension as a sanity check.
  if ((!contentType || contentType.includes('octet-stream')) && !guessKindFromUrl(clean)) {
    throw new Error(`Could not confirm that link is ${expected === 'video' ? 'a video' : 'an image'} — try a direct .${expected === 'video' ? 'mp4' : 'jpg'} link.`);
  }

  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  let blob;
  if (!reader) {
    blob = await res.blob();
  } else {
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`That file is too large (over ${formatMB(maxBytes)}).`);
      }
      chunks.push(value);
      if (onProgress) onProgress(loaded, Number.isFinite(total) ? total : null);
    }
    blob = new Blob(chunks, blobType(blobMime(contentType, expected)));
  }

  if (blob.size < 1000) {
    throw new Error('The download came back empty — the host may block embedding. Download the file and drop it here instead.');
  }
  const name = fileNameFromUrl(clean, expected === 'video' ? 'remote-video.mp4' : 'remote-image.jpg');
  return new File([blob], ensureExtension(name, expected), { type: blob.type || blobMime(contentType, expected) });
}

function platformLinkError() {
  return new Error('That is a social post link (YouTube/X/Facebook/…), not a file — browsers cannot fetch those directly. Open the post, download the video/image, then drop the file here.');
}

function contentTypeMatches(ct, expected) {
  return expected === 'video' ? ct.startsWith('video/') : ct.startsWith('image/');
}

function blobMime(ct, expected) {
  if (ct && (ct.startsWith('video/') || ct.startsWith('image/'))) return ct.split(';')[0];
  return expected === 'video' ? 'video/mp4' : 'image/jpeg';
}

function blobType(mime) {
  return { type: mime };
}

function ensureExtension(name, expected) {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  return name + (expected === 'video' ? '.mp4' : '.jpg');
}

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
}
