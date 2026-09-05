// Video Background Studio - studio.js
// Main UI wiring. No inline wasm here — delegates to compositor.js & ffmpeg-worker.js.

import { RESOLUTION_PRESETS, DEFAULTS, SOFT_SIZE_WARN_BYTES } from '../lib/constants.js';
import { formatBytes, formatDuration, wireDropzone, loadVideoMetadata, loadImageFile, revokeIfNeeded, checkDimensionWarning, validateVideoFile, detectSourceFps } from '../lib/file-utils.js';
import { drawCompositedFrame, getOutputSize, renderBackgroundStill, renderVideoMask } from '../lib/compositor.js';
import { getFFmpeg, compositePipeline } from '../lib/ffmpeg-worker.js';
import { fetchMediaUrl, isPlatformLink } from '../lib/url-import.js';
import { isXLink, extractXVariants, variantLabel } from '../lib/x-extract.js';

// --- DOM refs ---
const dropBg = document.getElementById('dropBg');
const inputBg = document.getElementById('inputBg');
const bgPreview = document.getElementById('bgPreview');
const bgMeta = document.getElementById('bgMeta');
const clearBg = document.getElementById('clearBg');

const dropVideo = document.getElementById('dropVideo');
const inputVideo = document.getElementById('inputVideo');
const videoPreview = document.getElementById('videoPreview');
const videoMeta = document.getElementById('videoMeta');
const videoInfo = document.getElementById('videoInfo');
const clearVideo = document.getElementById('clearVideo');
const urlBg = document.getElementById('urlBg');
const fetchBg = document.getElementById('fetchBg');
const urlVideo = document.getElementById('urlVideo');
const fetchVideo = document.getElementById('fetchVideo');
const xVariants = document.getElementById('xVariants');

const statusEl = document.getElementById('status');
const radius = document.getElementById('radius');
const radiusVal = document.getElementById('radiusVal');
const scale = document.getElementById('scale');
const scaleVal = document.getElementById('scaleVal');
const shadowToggle = document.getElementById('shadowToggle');
const shadowIntensity = document.getElementById('shadowIntensity');
const shadowVal = document.getElementById('shadowVal');
const shadowGroup = document.getElementById('shadowGroup');
const resolution = document.getElementById('resolution');
const quality = document.getElementById('quality');
const generateBtn = document.getElementById('generateBtn');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressStage = document.getElementById('progressStage');
const progressPct = document.getElementById('progressPct');

const previewCanvas = document.getElementById('previewCanvas');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const previewStage = document.getElementById('previewStage');
// NOTE: workCanvas/workVideo hidden elements remain in studio.html for the
// legacy two-pass path (kept until compositePipeline is verified), then remove.

const resultVideo = document.getElementById('resultVideo');
const resultPlaceholder = document.getElementById('resultPlaceholder');
const resultInfo = document.getElementById('resultInfo');
const downloadBtn = document.getElementById('downloadBtn');
const themeToggle = document.getElementById('themeToggle');

// --- State ---
let bgFile = null;
let bgImg = null;
let bgW = 0, bgH = 0;
let bgObjectUrl = null;

let videoFile = null;
let videoObjectUrl = null;
let videoW = 0, videoH = 0, videoDuration = 0;

let resultBlobUrl = null;
let isGenerating = false;

// Controls state
const state = {
  radius: DEFAULTS.radius,
  scale: DEFAULTS.scale,
  shadow: DEFAULTS.shadow,
  shadowIntensity: DEFAULTS.shadowIntensity,
  resolution: DEFAULTS.resolution,
  quality: DEFAULTS.quality
};

// --- Theme ---
function initTheme() {
  const saved = localStorage.getItem('vbs-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const isDark = cur ? cur === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('vbs-theme', next);
  });
}
initTheme();

// --- Status helpers ---
function showStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = `status show ${type}`;
}
function clearStatus() { statusEl.className = 'status'; statusEl.textContent = ''; }
function showProgress(pct, stage) {
  progressWrap.classList.add('active');
  progressFill.style.width = pct + '%';
  progressPct.textContent = pct + '%';
  progressStage.textContent = stage;
}
function hideProgress() {
  progressWrap.classList.remove('active');
  progressFill.style.width = '0%';
}

// --- Controls wiring ---
function bindControls() {
  radius.addEventListener('input', () => {
    state.radius = parseInt(radius.value, 10);
    radiusVal.textContent = state.radius + 'px';
    drawPreview();
  });
  scale.addEventListener('input', () => {
    state.scale = parseInt(scale.value, 10);
    scaleVal.textContent = state.scale + '%';
    drawPreview();
  });
  const toggleShadow = () => {
    state.shadow = !state.shadow;
    shadowToggle.classList.toggle('on', state.shadow);
    shadowToggle.setAttribute('aria-checked', String(state.shadow));
    shadowGroup.style.opacity = state.shadow ? '1' : '0.4';
    shadowIntensity.disabled = !state.shadow;
    drawPreview();
  };
  shadowToggle.addEventListener('click', toggleShadow);
  shadowToggle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleShadow(); } });
  shadowIntensity.addEventListener('input', () => {
    state.shadowIntensity = parseInt(shadowIntensity.value, 10);
    shadowVal.textContent = String(state.shadowIntensity);
    drawPreview();
  });
  resolution.addEventListener('change', () => { state.resolution = resolution.value; drawPreview(); });
  quality.addEventListener('change', () => { state.quality = quality.value; });

  // init display
  radiusVal.textContent = state.radius + 'px';
  scaleVal.textContent = state.scale + '%';
  shadowVal.textContent = String(state.shadowIntensity);
}
bindControls();

// --- Preview drawing ---
function drawPreview() {
  const hasBoth = !!(bgImg && videoFile && videoW);
  if (!hasBoth) {
    previewCanvas.classList.add('hidden');
    previewPlaceholder.style.display = 'block';
    return;
  }
  previewCanvas.classList.remove('hidden');
  previewPlaceholder.style.display = 'none';

  // preview size: use 1280x720 or match output aspect
  const out = getOutputSize(state.resolution, videoW, videoH);
  // For preview, render smaller to keep perf, but keep aspect
  const maxPreview = 1280;
  let pw = out.w, ph = out.h;
  if (pw > maxPreview) {
    const s = maxPreview / pw;
    pw = Math.round(pw * s);
    ph = Math.round(ph * s);
  }
  previewCanvas.width = pw;
  previewCanvas.height = ph;
  const ctx = previewCanvas.getContext('2d', { alpha: false });
  // Use current videoPreview element as frame source (ensure it has current frame)
  // If workVideo not set, use videoPreview
  const srcVideo = videoPreview;
  drawCompositedFrame(ctx, bgImg, bgW, bgH, srcVideo, {
    radius: state.radius,
    scalePct: state.scale,
    shadow: state.shadow,
    shadowIntensity: state.shadowIntensity,
    canvasW: pw,
    canvasH: ph
  });
}

// Keep preview updating while video preview is playing (drag scrub)
let previewRaf = null;
function startPreviewLoop() {
  if (previewRaf) cancelAnimationFrame(previewRaf);
  const loop = () => {
    if (bgImg && videoFile) drawPreview();
    previewRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopPreviewLoop() { if (previewRaf) cancelAnimationFrame(previewRaf); }

// --- File handling ---
wireDropzone({
  dropEl: dropBg,
  inputEl: inputBg,
  accept: 'image/png,image/jpeg,image/webp,image/jpg',
  onFile: (file, err) => {
    if (err) return showStatus(err, 'error');
    handleBgFile(file);
  }
});
wireDropzone({
  dropEl: dropVideo,
  inputEl: inputVideo,
  accept: 'video/mp4,video/webm,video/quicktime,video/*',
  onFile: (file, err) => {
    if (err) return showStatus(err, 'error');
    handleVideoFile(file);
  }
});

// --- URL import (direct media links; platform post links get guided fallback) ---
async function fetchUrlInto(inputEl, btnEl, expected, handler) {
  const raw = (inputEl.value || '').trim();
  if (!raw) return showStatus('Paste a link first.', 'error');
  if (isPlatformLink(raw)) {
    showStatus('That is a social post link (YouTube/X/Facebook/…), not a file — open the post, download the ' + (expected === 'video' ? 'video' : 'image') + ', then drop the file here.', 'warn');
    return;
  }
  const label = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = 'Fetching…';
  try {
    showStatus('Fetching…', 'info');
    const file = await fetchMediaUrl(raw, expected, (loaded) => {
      statusEl.textContent = `Fetching… ${formatBytes(loaded)}`;
      statusEl.className = 'status show info';
    });
    inputEl.value = '';
    await handler(file);
  } catch (e) {
    showStatus(e.message, /Permission denied/.test(e.message) ? 'warn' : 'error');
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = label;
  }
}
fetchBg.addEventListener('click', () => fetchUrlInto(urlBg, fetchBg, 'image', handleBgFile));
fetchVideo.addEventListener('click', () => {
  const raw = (urlVideo.value || '').trim();
  if (raw && isXLink(raw)) return runXExtract(raw);
  fetchUrlInto(urlVideo, fetchVideo, 'video', handleVideoFile);
});

// --- X post extraction: open tweet -> read its MP4 variants -> quality picker ---
async function runXExtract(statusUrl) {
  xVariants.innerHTML = '';
  xVariants.classList.add('hidden');
  const label = fetchVideo.textContent;
  fetchVideo.disabled = true;
  fetchVideo.textContent = 'Extracting…';
  try {
    const variants = await extractXVariants(statusUrl, {
      onStatus: (msg) => showStatus(msg, 'info')
    });
    urlVideo.value = '';
    renderVariantPicker(variants);
  } catch (e) {
    showStatus(e.message, 'error');
  } finally {
    fetchVideo.disabled = false;
    fetchVideo.textContent = label;
  }
}

function renderVariantPicker(variants) {
  xVariants.innerHTML = '';
  variants.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'variant-row';
    const name = document.createElement('span');
    name.textContent = variantLabel(v, i);
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = 'Fetch';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = 'Fetching…';
      try {
        const file = await fetchMediaUrl(v.url, 'video', (loaded) => {
          statusEl.textContent = `Fetching… ${formatBytes(loaded)}`;
          statusEl.className = 'status show info';
        });
        await handleVideoFile(file);
      } catch (e) {
        showStatus(e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
    row.appendChild(name);
    row.appendChild(btn);
    xVariants.appendChild(row);
  });
  xVariants.classList.remove('hidden');
}
urlBg.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchBg.click(); } });
urlVideo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchVideo.click(); } });

async function handleBgFile(file) {
  clearStatus();
  if (!file) return;
  if (!file.type.startsWith('image/')) return showStatus('Please choose an image file (JPG/PNG/WebP).', 'error');

  // revoke previous
  revokeIfNeeded(bgObjectUrl);
  bgFile = file;
  try {
    const { img, width, height, objectUrl } = await loadImageFile(file);
    bgImg = img;
    bgW = width;
    bgH = height;
    bgObjectUrl = objectUrl;
    bgPreview.src = objectUrl;
    bgPreview.style.display = 'block';
    dropBg.classList.add('has-file');
    bgMeta.textContent = `${file.name} • ${width}×${height} • ${formatBytes(file.size)}`;
    clearBg.classList.remove('hidden');
    drawPreview();
    updateGenerateState();
  } catch (e) {
    showStatus(e.message, 'error');
  }
}

async function handleVideoFile(file) {
  clearStatus();
  if (!file) return;
  const v = validateVideoFile(file);
  if (!v.ok) return showStatus(v.error, 'error');
  if (v.warning) showStatus(v.warning, 'warn');

  // soft warn already shown — continue
  revokeIfNeeded(videoObjectUrl);
  videoFile = file;

  try {
    const meta = await loadVideoMetadata(file, videoPreview);
    videoObjectUrl = meta.objectUrl;
    videoW = meta.width;
    videoH = meta.height;
    videoDuration = meta.duration;
    dropVideo.classList.add('has-file');
    videoPreview.style.display = 'block';
    videoMeta.textContent = `${file.name} • ${formatBytes(file.size)}`;
    const dimWarn = checkDimensionWarning(videoW, videoH);
    if (dimWarn) showStatus(dimWarn, 'warn');
    videoInfo.textContent = `${videoW}×${videoH} • ${formatDuration(videoDuration)} • ${formatBytes(file.size)}`;
    clearVideo.classList.remove('hidden');

    // wire preview loop on video events
    videoPreview.addEventListener('loadeddata', drawPreview);
    videoPreview.addEventListener('seeked', drawPreview);
    videoPreview.currentTime = 0;
    // small delay then draw
    setTimeout(drawPreview, 200);
    startPreviewLoop();
    // stop loop after 3s of inactivity? Keep running but cheap
    updateGenerateState();
  } catch (e) {
    showStatus(e.message, 'error');
    videoFile = null;
    updateGenerateState();
  }
}

clearBg.addEventListener('click', () => {
  revokeIfNeeded(bgObjectUrl);
  bgFile = null; bgImg = null; bgW = 0; bgH = 0; bgObjectUrl = null;
  bgPreview.removeAttribute('src');
  bgPreview.style.display = 'none';
  dropBg.classList.remove('has-file');
  bgMeta.textContent = '';
  clearBg.classList.add('hidden');
  inputBg.value = '';
  drawPreview();
  updateGenerateState();
});
clearVideo.addEventListener('click', () => {
  revokeIfNeeded(videoObjectUrl);
  videoFile = null; videoW = 0; videoH = 0; videoDuration = 0; videoObjectUrl = null;
  videoPreview.removeAttribute('src');
  videoPreview.load();
  videoPreview.style.display = 'none';
  dropVideo.classList.remove('has-file');
  videoMeta.textContent = '';
  videoInfo.textContent = '';
  clearVideo.classList.add('hidden');
  inputVideo.value = '';
  stopPreviewLoop();
  drawPreview();
  updateGenerateState();
});

function updateGenerateState() {
  const ready = !!(bgFile && videoFile && videoW && videoDuration);
  generateBtn.disabled = !ready || isGenerating;
  if (ready) clearStatus();
}

// --- Generate pipeline ---
generateBtn.addEventListener('click', async () => {
  if (isGenerating) return;
  if (!bgFile || !videoFile) return showStatus('Upload both a video and a background image first.', 'error');

  isGenerating = true;
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating…';
  hideProgress(); // will show again
  resultPlaceholder.textContent = 'Generating…';
  resultVideo.classList.add('hidden');
  downloadBtn.classList.add('hidden');
  resultInfo.textContent = '';
  // revoke previous result
  if (resultBlobUrl) { URL.revokeObjectURL(resultBlobUrl); resultBlobUrl = null; }

  try {
    const out = getOutputSize(state.resolution, videoW, videoH);
    // ensure even dims
    const outputW = out.w - (out.w % 2);
    const outputH = out.h - (out.h % 2);

    // Preload FFmpeg early to show loading progress
    showProgress(5, 'Loading encoder…');
    await getFFmpeg().catch(e => {
      const raw = e && (e.message || String(e)) || JSON.stringify(e) || String(typeof e);
      console.error('[VBS] getFFmpeg failed', e, e && e.stack);
      throw new Error('Failed to load encoder: ' + raw);
    });

    // Measure the source fps — the export preserves it exactly (no re-timing).
    showProgress(8, 'Reading video…');
    const srcFps = await detectSourceFps(videoPreview);
    console.log('[VBS] source', { videoW, videoH, videoDuration, srcFps, outputW, outputH });

    // Single static background still with a transparent rounded window.
    // The original video is overlaid through that window in ONE ffmpeg pass,
    // keeping its own timestamps — speed/duration/fps stay bit-faithful.
    showProgress(12, 'Preparing background…');
    const { blob: bgPngBlob, rect } = await renderBackgroundStill({
      bgSource: bgImg,
      bgW, bgH,
      videoW, videoH,
      outputW, outputH,
      opts: {
        radius: state.radius,
        scalePct: state.scale,
        shadow: state.shadow,
        shadowIntensity: state.shadowIntensity
      }
    });

    if (bgPngBlob.size < 1000) throw new Error('Background render failed — try a different image.');
    // Rounded-corner alpha mask: without it the overlay composites an opaque
    // square and the radius setting is lost in the export.
    const maskPngBlob = await renderVideoMask(rect);
    if (maskPngBlob.size < 100) throw new Error('Mask render failed — try again.');
    console.log('[VBS] background still', { bytes: bgPngBlob.size, maskBytes: maskPngBlob.size, rect });

    // Single-pass composite (15→99, 100 reserved for the explicit 'done')
    const onCompProgress = ({ stage, pct }) => {
      if (stage === 'done') {
        showProgress(100, 'Done');
        return;
      }
      showProgress(Math.min(99, 15 + Math.round(pct * 0.84)), 'Compositing…');
    };

    const finalBlob = await compositePipeline({
      bgPngBlob,
      maskPngBlob,
      originalBlob: videoFile,
      rect,
      srcFps,
      duration: videoDuration,
      outputW, outputH,
      quality: state.quality,
      onProgress: onCompProgress
    });

    showProgress(100, 'Done');
    // Show result
    resultBlobUrl = URL.createObjectURL(finalBlob);
    resultVideo.src = resultBlobUrl;
    resultVideo.classList.remove('hidden');
    resultPlaceholder.style.display = 'none';
    resultInfo.textContent = `${outputW}×${outputH} • ${formatBytes(finalBlob.size)} • MP4 H.264 + AAC`;
    downloadBtn.classList.remove('hidden');
    downloadBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = resultBlobUrl;
      a.download = `vbs-${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    // Auto-scroll to result
    document.getElementById('resultStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showStatus('Video generated — preview above. Click Download to save.', 'info');

  } catch (e) {
    console.error('[VBS] pipeline failed', e, e && e.stack);
    let msg = (e && (e.message || String(e))) || JSON.stringify(e) || String(typeof e);
    if (msg.includes('memory') || msg.includes('OOM') || msg.includes('abort')) {
      msg = 'Out of memory — the file is too large for this device. Try 1080p, a shorter clip, or close other tabs and retry.';
    } else if (msg.includes('codec') || msg.includes('decode')) {
      msg += ' — try exporting your video as MP4 H.264 + AAC.';
    }
    showStatus('Generation failed: ' + msg, 'error');
    showProgress(0, 'Failed');
  } finally {
    isGenerating = false;
    generateBtn.disabled = !(bgFile && videoFile);
    generateBtn.textContent = 'Generate Video';
    setTimeout(() => { if (!isGenerating) hideProgress(); }, 1500);
  }
});

// Also redraw preview when window resizes or theme changes
window.addEventListener('resize', drawPreview);
// Initial: ensure preview hidden
drawPreview();
