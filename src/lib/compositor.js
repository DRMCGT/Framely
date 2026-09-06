// Framely - compositor.js
// Canvas compositing: background (cover) + rounded-corners clip + soft shadow.
// Same function is used for live preview (single frame) and export (frame loop).
// Never uses FFmpeg filters for geometry — that path is fragile.

/**
 * Draw a rounded-rect path. Uses native roundRect if available, else arcTo fallback.
 */
function roundedRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  // Fallback for Firefox <122 / Safari <16.4
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Compute cover rect: scale source to fill dest, cropping excess.
 * Returns { sx, sy, sw, sh, dx, dy, dw, dh } for drawImage.
 * We draw bg with full canvas cover: dest = canvas.
 */
function computeCoverParams(srcW, srcH, dstW, dstH) {
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;
  let sw, sh, sx, sy;
  if (srcRatio > dstRatio) {
    // source wider — crop sides
    sh = srcH;
    sw = sh * dstRatio;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    sw = srcW;
    sh = sw / dstRatio;
    sx = 0;
    sy = (srcH - sh) / 2;
  }
  return { sx, sy, sw, sh, dx: 0, dy: 0, dw: dstW, dh: dstH };
}

/**
 * Centered video rect shared by preview, stills, and the FFmpeg overlay filter.
 * Single source of truth so WYSIWYG preview == export.
 * Snaps x/y/w/h to even values (yuv420p overlay/scale requirement; ≤1px shift).
 */
export function computeVideoRect(vw, vh, opts) {
  const { radius, scalePct, canvasW: W, canvasH: H } = opts;
  const scale = scalePct / 100;
  const sw = vw || 1280;
  const sh = vh || 720;
  const boxW = Math.round(W * scale);
  const boxH = Math.round(H * scale);
  const boxRatio = boxW / boxH;
  const vidRatio = sw / sh;
  let drawW, drawH;
  if (vidRatio > boxRatio) {
    drawW = boxW;
    drawH = Math.round(boxW / vidRatio);
  } else {
    drawH = boxH;
    drawW = Math.round(boxH * vidRatio);
  }
  const even = (v) => Math.max(0, v - (v % 2));
  const w = even(drawW);
  const h = even(drawH);
  const x = even(Math.round((W - w) / 2));
  const y = even(Math.round((H - h) / 2));
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  return { x, y, w, h, r };
}

/**
 * Render ONE static background still (PNG with a transparent rounded window
 * where the video goes). The composited video keeps its ORIGINAL timestamps —
 * nothing is re-timed, so speed/duration/fps are bit-faithful to the upload.
 * @returns Promise<{ blob: Blob, rect: {x,y,w,h,r} }>
 */
export function renderBackgroundStill({ bgSource, bgW, bgH, videoW, videoH, outputW, outputH, opts }) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = outputW;
      canvas.height = outputH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D not available.');
      const rect = computeVideoRect(videoW, videoH, { ...opts, canvasW: outputW, canvasH: outputH });
      const { x, y, w, h, r } = rect;
      const { shadow, shadowIntensity } = opts;

      // 1) Background cover (same as live frame)
      if (bgSource && bgW && bgH) {
        const p = computeCoverParams(bgW, bgH, outputW, outputH);
        try {
          ctx.drawImage(bgSource, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
        } catch {
          ctx.drawImage(bgSource, 0, 0, outputW, outputH);
        }
      } else {
        ctx.fillStyle = '#0b0b0e';
        ctx.fillRect(0, 0, outputW, outputH);
      }

      // 2) Shadow shape underneath (same as frame path)
      if (shadow && shadowIntensity > 0) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = shadowIntensity;
        ctx.shadowOffsetY = Math.round(shadowIntensity * 0.35);
        roundedRectPath(ctx, x, y, w, h, r);
        ctx.fillStyle = 'rgba(0,0,0,0.9)';
        ctx.fill();
        ctx.restore();
      }

      // 3) Punch the transparent window the original video shows through
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      roundedRectPath(ctx, x, y, w, h, r);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.restore();

      // 4) Hairline border on the hole edge (mirrors the frame path's stroke)
      if (r > 0) {
        ctx.save();
        roundedRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0, r - 0.5));
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('Failed to render background still.')); return; }
        resolve({ blob, rect });
      }, 'image/png');
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Render the rounded-corner alpha mask for the export overlay.
 * Black rect.w×rect.h frame + white rounded rect (same r as the video rect).
 * The overlay filter would otherwise composite an opaque SQUARE — this mask
 * (via alphamerge) gives the video true rounded alpha matching the preview.
 * @returns Promise<Blob> grayscale PNG mask
 */
export function renderVideoMask(rect) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = rect.w;
      canvas.height = rect.h;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvas 2D not available.');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, rect.w, rect.h);
      roundedRectPath(ctx, 0, 0, rect.w, rect.h, rect.r);
      ctx.fillStyle = '#fff';
      ctx.fill();
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('Failed to render video mask.')); return; }
        resolve(blob);
      }, 'image/png');
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Single composited draw. Mutates ctx.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bgSource - background (image)
 * @param {number} bgW - bg natural width
 * @param {number} bgH - bg natural height
 * @param {HTMLVideoElement} videoEl - current video frame source
 * @param {object} opts { radius, scalePct, shadow, shadowIntensity, canvasW, canvasH }
 */
export function drawCompositedFrame(ctx, bgSource, bgW, bgH, videoEl, opts) {
  const { radius, scalePct, shadow, shadowIntensity, canvasW, canvasH } = opts;
  const W = canvasW;
  const H = canvasH;

  ctx.clearRect(0, 0, W, H);

  // 1) Background cover
  if (bgSource && bgW && bgH) {
    const p = computeCoverParams(bgW, bgH, W, H);
    try {
      ctx.drawImage(bgSource, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
    } catch (e) {
      // fallback: stretch
      ctx.drawImage(bgSource, 0, 0, W, H);
    }
  } else {
    // no bg yet — dark placeholder
    ctx.fillStyle = '#0b0b0e';
    ctx.fillRect(0, 0, W, H);
  }

  // If no video, stop
  if (!videoEl || videoEl.readyState < 2) return;

  // Centered video rect — shared with stills/export (single source of truth)
  const { x, y, w: drawW, h: drawH, r } = computeVideoRect(
    videoEl.videoWidth, videoEl.videoHeight,
    { radius, scalePct, canvasW: W, canvasH: H }
  );

  // 2) Shadow underneath (before clip)
  if (shadow && shadowIntensity > 0) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = shadowIntensity;
    ctx.shadowOffsetY = Math.round(shadowIntensity * 0.35);
    // Draw shadow shape as filled rounded rect
    roundedRectPath(ctx, x, y, drawW, drawH, r);
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fill();
    ctx.restore();
  }

  // 3) Video with rounded clip
  ctx.save();
  roundedRectPath(ctx, x, y, drawW, drawH, r);
  ctx.clip();
  // draw video — if readyState <2, skip
  try {
    ctx.drawImage(videoEl, x, y, drawW, drawH);
  } catch {}
  ctx.restore();

  // Optional subtle border for definition on light bgs
  if (r > 0) {
    ctx.save();
    roundedRectPath(ctx, x + 0.5, y + 0.5, drawW - 1, drawH - 1, Math.max(0, r - 0.5));
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Get output canvas dimensions from resolution preset + source size.
 */
export function getOutputSize(resolution, sourceW, sourceH) {
  if (resolution === 'source' && sourceW && sourceH) {
    // cap to 4K on longest side to avoid OOM, keep aspect
    const longest = Math.max(sourceW, sourceH);
    if (longest > 3840) {
      const scale = 3840 / longest;
      return { w: Math.round(sourceW * scale), h: Math.round(sourceH * scale) };
    }
    // ensure even dimensions for H.264
    return { w: sourceW - (sourceW % 2), h: sourceH - (sourceH % 2) };
  }
  const map = {
    '1080p': { w: 1920, h: 1080 },
    '1440p': { w: 2560, h: 1440 },
    '4k': { w: 3840, h: 2160 }
  };
  return map[resolution] || map['1080p'];
}

/**
 * Render loop for export. Captures composited frames via MediaRecorder.
 * Returns a Blob (video/webm) of the silent composited video.
 *
 * Strategy:
 *  - Set workCanvas size to output size
 *  - Play workVideo from 0, draw each frame to canvas in a deterministic loop
 *  - Use canvas.captureStream(fps) + MediaRecorder to record
 *  - Fallback to requestVideoFrameCallback pacing if MediaRecorder drops frames
 *
 * Progress cb: onProgress({ stage, pct }) where stage='rendering'
 */
export async function renderToSilentWebM({
  workCanvas,
  workVideo,
  bgSource,
  bgW,
  bgH,
  duration,
  fps = 30,
  outputW,
  outputH,
  opts, // { radius, scalePct, shadow, shadowIntensity }
  onProgress
}) {
  const ctx = workCanvas.getContext('2d', { alpha: false, desynchronized: true });
  workCanvas.width = outputW;
  workCanvas.height = outputH;

  // Ensure video ready and seek to 0
  workVideo.muted = true;
  workVideo.playsInline = true;
  await seekVideo(workVideo, 0);

  // Determine fps: try to use source fps if detectable ~ duration/frameCount, else 30
  // We honor the passed fps (30) for simplicity; high fps handled via quality preset externally.

  const stream = workCanvas.captureStream(fps);
  const mime = pickMimeType();
  if (!mime) throw new Error('MediaRecorder not supported in this browser. Please use Chrome/Edge 120+.');
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000 // high for intermediate; final FFmpeg will re-encode at chosen CRF
  });

  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  const done = new Promise((resolve, reject) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      resolve(blob);
    };
    recorder.onerror = (e) => reject(new Error('MediaRecorder error: ' + (e.error?.message || 'unknown')));
  });

  recorder.start(100); // timeslice 100ms

  // Frame loop — drive video.currentTime manually for deterministic export
  // We step through duration at 1/fps increments.
  // NOTE: duration here must already be clamped to the workVideo's real seekable
  // range (see studio.js effDuration). We still keep a 0.05s end-epsilon so the
  // final seeks never land beyond EOF, where the frame would go blank and the
  // recorder would capture a wallpaper-only tail.
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const frameInterval = 1 / fps;

  // Helper to draw current frame
  const drawOpts = { ...opts, canvasW: outputW, canvasH: outputH };

  // For RVFC, we prefer manual stepping; RVFC is throttled to display fps so we don't rely on it
  let drewFrames = 0;
  for (let i = 0; i < totalFrames; i++) {
    const t = Math.min(i * frameInterval, Math.max(0, duration - 0.05));
    // Seek — this is seek-heavy but ensures correct frame. For long videos we could use play() + rVFC.
    // Optimization: if video is playing, just wait for next frame instead of seek.
    // Use seek for reliability across browsers.
    const seekOk = await seekVideo(workVideo, t);
    // If the seek failed or the frame isn't ready, REUSE the previous canvas
    // content (last good frame) instead of drawing a wallpaper-only frame.
    // drawCompositedFrame early-returns on readyState<2 after painting only the
    // background, which is exactly the wallpaper-tail bug — so never call it
    // without a ready frame once we have drawn at least once.
    if (seekOk && workVideo.readyState >= 2) {
      drawCompositedFrame(ctx, bgSource, bgW, bgH, workVideo, drawOpts);
      drewFrames++;
    } else if (drewFrames === 0) {
      // No good frame yet (very first seek failed) — wait briefly and retry once
      // rather than recording a blank/background frame.
      await waitMs(100);
      if (workVideo.readyState >= 2) {
        drawCompositedFrame(ctx, bgSource, bgW, bgH, workVideo, drawOpts);
        drewFrames++;
      }
    }
    // else: keep previous canvas pixels (last good frame) — intentional.
    // Allow captureStream to grab this frame. Need to wait at least one frame interval in wall time.
    // Since captureStream is realtime, we must pace wall time ~ frameInterval.
    await waitMs(1000 / fps);
    // Emit 0–100; the caller maps this into its overall progress range.
    if (onProgress) onProgress({ stage: 'rendering', pct: Math.round(((i + 1) / totalFrames) * 100) });
    // Yield to keep UI responsive
    if (i % 10 === 0) await yieldToMain();
  }

  if (drewFrames === 0) throw new Error('Could not decode any video frames — try exporting your video as MP4 H.264.');

  // Give recorder a bit extra to flush the final (good) frame
  await waitMs(300);
  recorder.stop();
  stream.getTracks().forEach(t => t.stop());

  const silentBlob = await done;
  return silentBlob;
}

function pickMimeType() {
  const cands = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4' // Safari fallback, but captureStream rarely supports mp4
  ];
  for (const c of cands) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

function seekVideo(video, time) {
  // Resolves true when the seek landed (seeked event + ready frame),
  // false on timeout/failure so the caller can reuse the last good frame
  // instead of painting a wallpaper-only frame.
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      resolve(ok);
    };
    const onSeeked = () => finish(video.readyState >= 2);
    video.addEventListener('seeked', onSeeked, { once: true });
    // Fallback after 800ms to avoid hang on bad seek (e.g. beyond EOF)
    setTimeout(() => finish(video.readyState >= 2), 800);
    try { video.currentTime = time; } catch { finish(false); }
  });
}

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }
function yieldToMain() { return new Promise(r => setTimeout(r, 0)); }
