// Framely - file-utils.js
// Drag/drop, validation, metadata, objectURL lifecycle. No FFmpeg/Canvas here.

import { SOFT_SIZE_WARN_BYTES, RECOMMENDED_MAX_DIM } from './constants.js';

/**
 * Format bytes to human readable.
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Validate file and return { ok, warning?, error? }
 */
export function validateVideoFile(file) {
  if (!file) return { ok: false, error: 'No file selected.' };
  if (file.size === 0) return { ok: false, error: 'File is empty.' };
  // soft warn only
  if (file.size > SOFT_SIZE_WARN_BYTES) {
    return {
      ok: true,
      warning: `Large file (${formatBytes(file.size)}). Processing is 100% local and may use significant memory. If the browser struggles, try a lower output resolution or a shorter clip. You can continue.`
    };
  }
  return { ok: true };
}

export function validateImageFile(file) {
  if (!file) return { ok: false, error: 'No file selected.' };
  if (file.size === 0) return { ok: false, error: 'File is empty.' };
  if (!file.type.startsWith('image/')) return { ok: false, error: 'Not an image file.' };
  return { ok: true };
}

/**
 * Wire a dropzone element to a hidden file input.
 * Calls onFile(file) when a valid file is dropped/chosen.
 */
export function wireDropzone({ dropEl, inputEl, accept, onFile }) {
  const pick = () => inputEl.click();

  dropEl.addEventListener('click', (e) => {
    // avoid double trigger when clicking label
    if (e.target.closest('input')) return;
    pick();
  });
  dropEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick();
    }
  });

  ['dragenter', 'dragover'].forEach(ev =>
    dropEl.addEventListener(ev, (e) => {
      e.preventDefault();
      dropEl.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach(ev =>
    dropEl.addEventListener(ev, (e) => {
      if (ev === 'dragleave' && e.target !== dropEl) return;
      dropEl.classList.remove('dragover');
    })
  );
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (accept && !matchesAccept(file, accept)) {
      onFile(null, `Unsupported type: ${file.type || file.name}`);
      return;
    }
    // sync to input for consistency
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      inputEl.files = dt.files;
    } catch {}
    onFile(file);
  });

  inputEl.addEventListener('change', () => {
    const file = inputEl.files?.[0];
    if (!file) return;
    onFile(file);
  });
}

function matchesAccept(file, accept) {
  // accept like "video/mp4,video/webm,video/*"
  const parts = accept.split(',').map(s => s.trim()).filter(Boolean);
  return parts.some(p => {
    if (p.endsWith('/*')) return file.type.startsWith(p.slice(0, -2));
    if (p.startsWith('.')) return file.name.toLowerCase().endsWith(p.toLowerCase());
    return file.type === p;
  });
}

/**
 * Load video metadata. Returns { width, height, duration }.
 * Resolves after loadedmetadata, rejects on error/timeout.
 */
export function loadVideoMetadata(file, videoEl) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    let done = false;
    const cleanup = () => {
      videoEl.removeEventListener('loadedmetadata', onMeta);
      videoEl.removeEventListener('error', onError);
    };
    const onMeta = () => {
      if (done) return;
      done = true;
      cleanup();
      const w = videoEl.videoWidth;
      const h = videoEl.videoHeight;
      const d = videoEl.duration;
      // keep object URL for preview; caller manages revoke
      resolve({ width: w, height: h, duration: d, objectUrl: url, videoEl });
    };
    const onError = () => {
      if (done) return;
      done = true;
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error('Could not read video — file may be corrupted or codec unsupported (try MP4 H.264).'));
    };
    videoEl.addEventListener('loadedmetadata', onMeta);
    videoEl.addEventListener('error', onError);
    videoEl.preload = 'metadata';
    videoEl.src = url;
    videoEl.load();
    // timeout
    setTimeout(() => {
      if (!done) {
        cleanup();
        // don't revoke - still trying? But we reject
        reject(new Error('Timed out reading video metadata. File may be corrupted.'));
      }
    }, 8000);
  });
}

/**
 * Load image via object URL.
 */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, width: img.naturalWidth, height: img.naturalHeight, objectUrl: url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image — file may be corrupted.'));
    };
    img.src = url;
  });
}

/**
 * Measure the source video's real framerate via requestVideoFrameCallback.
 * Snaps to common rates (24/25/30/50/60) within 6%, else clamps 15–120.
 * Falls back to 30 when rVFC is unavailable or the sample fails.
 * Briefly plays the element if paused; restores pause state + time after.
 */
export async function detectSourceFps(videoEl, sampleMs = 1200) {
  if (!videoEl || typeof videoEl.requestVideoFrameCallback !== 'function') return 30;
  if (videoEl.readyState < 2) return 30;
  const savedTime = videoEl.currentTime;
  const wasPaused = videoEl.paused;
  try {
    await videoEl.play().catch(() => {});
    const raw = await new Promise((resolve) => {
      let frames = 0;
      let t0 = -1;
      const to = setTimeout(() => resolve(0), sampleMs + 1500);
      const tick = (now) => {
        if (t0 < 0) t0 = now;
        frames++;
        if (now - t0 < sampleMs) {
          videoEl.requestVideoFrameCallback(tick);
        } else {
          clearTimeout(to);
          resolve(frames / ((now - t0) / 1000));
        }
      };
      try {
        videoEl.requestVideoFrameCallback(tick);
      } catch {
        clearTimeout(to);
        resolve(0);
      }
    });
    if (!raw || !isFinite(raw)) return 30;
    for (const c of [24, 25, 30, 50, 60]) {
      if (Math.abs(raw - c) / c < 0.06) return c;
    }
    return Math.min(120, Math.max(15, Math.round(raw)));
  } finally {
    try {
      if (wasPaused) videoEl.pause();
      if (Math.abs(videoEl.currentTime - savedTime) > 0.05) videoEl.currentTime = savedTime;
    } catch {}
  }
}

export function revokeIfNeeded(url) {
  if (url && url.startsWith('blob:')) {
    try { URL.revokeObjectURL(url); } catch {}
  }
}

export function checkDimensionWarning(w, h) {
  const longest = Math.max(w, h);
  if (longest > RECOMMENDED_MAX_DIM) {
    return `Source is ${w}×${h} (> ${RECOMMENDED_MAX_DIM}px). Export at 1080p is recommended for stability.`;
  }
  return null;
}
