// Framely - ffmpeg-worker.js
// FFmpeg.wasm wrapper (single-thread core, bundled locally).
// Responsibilities: load FFmpeg, extract audio from original, transcode/mux to MP4 H.264+AAC.
// No geometry filters — Canvas owns compositing.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { QUALITY_PRESETS } from './constants.js';

let ffmpegInstance = null;
let loadingPromise = null;

/**
 * Get (and lazily load) FFmpeg instance.
 * Uses locally bundled core in vendor/ffmpeg — no CDN.
 * Must be called from extension page context (studio.html) where wasm-unsafe-eval is allowed.
 */
export async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onProgress) {
      ffmpeg.on('log', ({ message }) => {
        // optional debug
        // console.debug('[ffmpeg]', message);
      });
      ffmpeg.on('progress', ({ progress }) => {
        // FFmpeg progress 0–1 for current exec; we map externally
        if (onProgress) onProgress({ stage: 'encoding', pct: Math.round(progress * 100) });
      });
    }

    // MV3 extension_pages CSP: script-src 'self' 'wasm-unsafe-eval' — blob: is BLOCKED.
    // Never use toBlobURL() inside the extension (it does fetch+URL.createObjectURL -> blob:).
    // Use direct self URLs (chrome-extension://<id>/... ) which are 'self' and allowed.
    const isExtension = !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

    // Verbose pre-flight to surface 404 / MIME issues before wasm compile
    const coreURLRaw = isExtension
      ? `${chrome.runtime.getURL('vendor/ffmpeg')}/ffmpeg-core.js`
      : '/vendor/ffmpeg/ffmpeg-core.js';
    const wasmURLRaw = isExtension
      ? `${chrome.runtime.getURL('vendor/ffmpeg')}/ffmpeg-core.wasm`
      : '/vendor/ffmpeg/ffmpeg-core.wasm';

    // Quick fetch HEAD check (logs, does not block load if fails)
    try {
      const r = await fetch(coreURLRaw, { method: 'HEAD' });
      console.log('[Framely] ffmpeg core HEAD', r.status, r.headers.get('content-type'), coreURLRaw);
      if (!r.ok) throw new Error(`core fetch failed HTTP ${r.status}`);
    } catch (e) {
      console.warn('[Framely] core preflight failed', e);
    }
    try {
      const r = await fetch(wasmURLRaw, { method: 'HEAD' });
      console.log('[Framely] ffmpeg wasm HEAD', r.status, r.headers.get('content-type'), wasmURLRaw);
      if (!r.ok) throw new Error(`wasm fetch failed HTTP ${r.status}`);
    } catch (e) {
      console.warn('[Framely] wasm preflight failed', e);
    }

    const workerURLRaw = isExtension
      ? chrome.runtime.getURL('vendor/ffmpeg/worker.js')
      : '/vendor/ffmpeg/worker.js';

    console.log('[Framely] loading FFmpeg', { isExtension, coreURL: coreURLRaw, wasmURL: wasmURLRaw, workerURL: workerURLRaw });

    // Verify worker and its ESM deps fetchable before load (helps diagnose packaging regressions)
    // worker.js imports ./const.js and ./errors.js relatively — all must be siblings in vendor/ffmpeg/
    const depsToCheck = [workerURLRaw];
    if (isExtension) {
      const base = chrome.runtime.getURL('vendor/ffmpeg');
      depsToCheck.push(`${base}/const.js`, `${base}/errors.js`);
    } else {
      depsToCheck.push('/vendor/ffmpeg/const.js', '/vendor/ffmpeg/errors.js');
    }
    for (const url of depsToCheck) {
      try {
        const r = await fetch(url, { method: 'HEAD' });
        console.log('[Framely] ffmpeg dep HEAD', r.status, r.headers.get('content-type'), url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        console.warn('[Framely] dep preflight failed', url, e);
        // Fail fast with actionable message instead of silent hang
        if (url.endsWith('const.js') || url.endsWith('errors.js')) {
          loadingPromise = null;
          throw new Error(`FFmpeg worker dependency missing: ${url} — packaging regression (copy const.js/errors.js alongside worker.js)`);
        }
      }
    }

    // Safety net: if worker import fails (e.g. missing const.js), ffmpeg.load may hang
    // instead of rejecting. Race with timeout to surface real error.
    const loadWithTimeout = async (opts) => {
      return Promise.race([
        ffmpeg.load(opts),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Worker load timeout — worker.js or its deps (const.js/errors.js) failed to load, check Network tab for 404')), 10000))
      ]);
    };

    try {
      if (isExtension) {
        // Extension: direct self URLs, explicit worker — no blob: anywhere
        // (worker at stable vendor/ffmpeg/worker.js, not hashed assets)
        await loadWithTimeout({ coreURL: coreURLRaw, wasmURL: wasmURLRaw, classWorkerURL: workerURLRaw });
      } else {
        // Dev server (http://localhost:5173) — blob: allowed, use toBlobURL to avoid CORS
        await loadWithTimeout({
          coreURL: await toBlobURL(coreURLRaw, 'text/javascript'),
          wasmURL: await toBlobURL(wasmURLRaw, 'application/wasm'),
          classWorkerURL: workerURLRaw
        });
      }
      console.log('[Framely] FFmpeg loaded');
    } catch (e) {
      console.error('[Framely] FFmpeg load failed raw', e, e && e.stack, typeof e, JSON.stringify(e, Object.getOwnPropertyNames(e || {})));
      const msg = (e && (e.message || e.toString())) || JSON.stringify(e) || String(typeof e);
      // reset loadingPromise so retry is possible
      loadingPromise = null;
      throw new Error(`FFmpeg load failed: ${msg} | core=${coreURLRaw} worker=${workerURLRaw}`);
    }

    ffmpegInstance = ffmpeg;
    loadingPromise = null;
    return ffmpeg;
  })();

  return loadingPromise;
}

/**
 * Resolve the effective video quality config.
 * Long clips (>15s) or above-1080p output auto-drop to `veryfast` (logged):
 * single-threaded ffmpeg.wasm is ~4x slower on `medium`, which turns a 30s
 * export into a multi-minute stall that looks like a hang. CRF and audio
 * bitrate always honor the user's chosen quality — only the x264 preset adapts.
 */
export function resolveVideoQuality(quality, duration, outputW, outputH) {
  const base = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;
  const longClip = duration && isFinite(duration) && duration > 15;
  const bigFrame = outputW && outputH && outputW * outputH > 1920 * 1080;
  if ((longClip || bigFrame) && base.preset !== 'veryfast' && base.preset !== 'ultrafast') {
    const why = [longClip && 'long clip', bigFrame && 'high res'].filter(Boolean).join('+');
    console.log(`[Framely] preset auto-drop: ${base.preset}→veryfast (${why}; CRF ${base.crf} and audio ${base.audioBitrate} unchanged)`);
    return { ...base, preset: 'veryfast' };
  }
  return base;
}

/**
 * Extract audio from original video file to AAC m4a bytes.
 * Always re-encodes to AAC (deterministic). Returns null for silent sources.
 *
 * NOTE: never use `-c:a copy` here. On sources with no audio track (or a
 * non-AAC track) copy can "succeed" while producing a 0-byte file, and that
 * phantom audio fed as a second mux input stalls ffmpeg at ~98% forever.
 */
export async function extractAudio(originalBlob, quality = 'balanced', onProgress) {
  const ffmpeg = await getFFmpeg(onProgress);
  const data = new Uint8Array(await originalBlob.arrayBuffer());

  const inName = 'input.mp4';
  const outName = 'audio.m4a';
  const qualityCfg = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;

  // Clean previous
  try { await ffmpeg.deleteFile(inName); } catch {}
  try { await ffmpeg.deleteFile(outName); } catch {}

  await ffmpeg.writeFile(inName, data);

  try {
    await ffmpeg.exec(['-i', inName, '-vn', '-c:a', 'aac', '-b:a', qualityCfg.audioBitrate, outName]);
  } catch (e) {
    // No audio track (or undecodable audio) is valid — caller takes silent path.
    // (ffmpeg.wasm exec throws Emscripten exit() objects on failure paths.)
    console.log('[Framely] audio extract: none (no audio track in source)');
    try { await ffmpeg.deleteFile(inName); } catch {}
    return null;
  }

  let audioData = null;
  try {
    const out = await ffmpeg.readFile(outName);
    if (out && out.length > 1024) {
      audioData = out;
      console.log(`[Framely] audio extract: ${out.length} bytes via aac re-encode (${qualityCfg.audioBitrate})`);
    } else {
      console.log(`[Framely] audio extract: none (silent source, got ${out ? out.length : 'null'} bytes)`);
    }
  } catch {
    console.log('[Framely] audio extract: none (read failed — silent source)');
    audioData = null;
  }

  // Cleanup input but keep audio for mux step (caller will mux, then we delete)
  try { await ffmpeg.deleteFile(inName); } catch {}

  return audioData; // Uint8Array or null if no audio
}

/**
 * Shared exec runner: heartbeat logging + progress-based watchdog.
 * Fires only after 90s of ZERO progress (true stall); absolute backstop 20min
 * so legitimately slow single-thread encodes survive.
 * Maps ffmpeg progress 0–100 to onProgress({ stage: 'encoding', pct }).
 */
async function runExecWithWatchdog(ffmpeg, args, onProgress, label) {
  let lastProgress = 0;
  let lastProgressAt = Date.now();
  const progressHandler = ({ progress }) => {
    lastProgress = Math.round(progress * 100);
    lastProgressAt = Date.now();
    if (onProgress) onProgress({ stage: 'encoding', pct: lastProgress });
  };
  ffmpeg.on('progress', progressHandler);
  const execStart = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = ((Date.now() - execStart) / 1000).toFixed(1);
    console.log(`[Framely] heartbeat ${label} — elapsed ${elapsed}s, last progress ${lastProgress}%, args: ${args.join(' ')}`);
  }, 3000);

  const NO_PROGRESS_TIMEOUT_MS = 90_000;
  const ABSOLUTE_TIMEOUT_MS = 20 * 60_000;
  let stallTimer = null;
  const stallWatch = new Promise((_, rej) => {
    stallTimer = setInterval(() => {
      const idle = Date.now() - lastProgressAt;
      const total = Date.now() - execStart;
      if (idle > NO_PROGRESS_TIMEOUT_MS) {
        clearInterval(stallTimer);
        rej(new Error(`Encoding stalled: no progress for ${Math.round(idle / 1000)}s (last ${lastProgress}%). Check the args logged above.`));
      } else if (total > ABSOLUTE_TIMEOUT_MS) {
        clearInterval(stallTimer);
        rej(new Error(`Encoding timed out after ${Math.round(total / 1000)}s (last ${lastProgress}%). Try a shorter clip, 1080p, or Fast quality.`));
      }
    }, 5000);
  });
  try {
    await Promise.race([ffmpeg.exec(args), stallWatch]);
  } catch (e) {
    // Handle Emscripten exit(0) thrown as error
    if (e && String(e).includes('exit(0)')) {
      // success — ignore
    } else {
      throw new Error('Encoding failed: ' + (e?.message || String(e)));
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(stallTimer);
    ffmpeg.off('progress', progressHandler);
    const total = ((Date.now() - execStart) / 1000).toFixed(1);
    console.log(`[Framely] ffmpeg exec finished (${label}) — total ${total}s, last progress ${lastProgress}%`);
  }
}

/**
 * Single-pass composite: background still (with transparent rounded window)
 * + ORIGINAL video via overlay filter. The video keeps its original
 * timestamps/fps/duration — nothing is re-timed, so speed is bit-faithful to
 * the upload. Audio is mapped straight from the original (copy iff AAC, else
 * re-encode); silent sources get `-an`. No extract step, no phantom inputs.
 */
export async function compositePipeline({ bgPngBlob, maskPngBlob, originalBlob, rect, srcFps, duration, outputW, outputH, quality = 'balanced', onProgress }) {
  const ffmpeg = await getFFmpeg();
  const qualityCfg = resolveVideoQuality(quality, duration, outputW, outputH);

  const bgName = 'bg.png';
  const maskName = 'mask.png';
  const inName = 'input.mp4';
  const outName = 'output.mp4';
  for (const f of [bgName, maskName, inName, outName]) try { await ffmpeg.deleteFile(f); } catch {}

  await ffmpeg.writeFile(bgName, new Uint8Array(await bgPngBlob.arrayBuffer()));
  await ffmpeg.writeFile(maskName, new Uint8Array(await maskPngBlob.arrayBuffer()));
  await ffmpeg.writeFile(inName, new Uint8Array(await originalBlob.arrayBuffer()));

  // Probe source streams via demux logs so audio presence/codec is KNOWN
  // before args are built — a phantom second input becomes impossible.
  let audioCodec = null;
  const logSniffer = ({ message }) => {
    const m = /Audio:\s+([a-z0-9_]+)/i.exec(message || '');
    if (m) audioCodec = m[1].toLowerCase();
  };
  ffmpeg.on('log', logSniffer);
  try { await ffmpeg.exec(['-i', inName]); } catch {}
  ffmpeg.off('log', logSniffer);
  const hasAudio = !!audioCodec;
  const copyAudio = audioCodec === 'aac';
  console.log(`[Framely] source streams: audio=${audioCodec || 'none'} → ${!hasAudio ? 'silent (-an)' : copyAudio ? 'copy' : 'aac re-encode'}`);

  const tFlag = duration && isFinite(duration) && duration > 0 ? String(duration.toFixed(2)) : null;
  // alphamerge gives the scaled video true rounded alpha from the mask —
  // without it overlay composites an opaque SQUARE and the radius is lost.
  // Mask is rect.w×rect.h (same as fg) — alphamerge requires equal dims.
  const vf = `[1:v]scale=${rect.w}:${rect.h}:flags=bilinear,format=rgba[fg];[fg][2:v]alphamerge[fgm];[0:v][fgm]overlay=${rect.x}:${rect.y}:format=auto,format=yuv420p[outv]`;
  const args = [
    '-framerate', String(srcFps), '-loop', '1',
    ...(tFlag ? ['-t', tFlag] : []),
    '-i', bgName,
    '-i', inName,
    '-framerate', String(srcFps), '-loop', '1',
    ...(tFlag ? ['-t', tFlag] : []),
    '-i', maskName,
    '-filter_complex', vf,
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-preset', qualityCfg.preset,
    '-crf', String(qualityCfg.crf),
    '-pix_fmt', 'yuv420p',
    '-r', String(srcFps),
    ...(hasAudio
      ? ['-map', '1:a:0', '-c:a', copyAudio ? 'copy' : 'aac', ...(!copyAudio ? ['-b:a', qualityCfg.audioBitrate] : []), '-shortest']
      : ['-an']),
  ];
  if (tFlag) args.push('-t', tFlag);
  args.push(outName);

  console.log('[Framely] ffmpeg composite', args.join(' '), `bg=${bgPngBlob.size} bytes, mask=${maskPngBlob.size} bytes, src=${originalBlob.size} bytes, rect=${rect.x},${rect.y} ${rect.w}x${rect.h} r=${rect.r}, fps=${srcFps} t=${tFlag} preset=${qualityCfg.preset} crf=${qualityCfg.crf}`);

  if (onProgress) onProgress({ stage: 'compositing', pct: 5 });
  await runExecWithWatchdog(ffmpeg, args, ({ pct }) => {
    if (onProgress) onProgress({ stage: 'encoding', pct });
  }, 'composite');

  const outData = await ffmpeg.readFile(outName);
  // Never hand a broken download to the UI — fail loudly instead of a dead file.
  if (!outData || outData.length < 100_000) {
    for (const f of [bgName, maskName, inName, outName]) try { await ffmpeg.deleteFile(f); } catch {}
    throw new Error(`Encoding produced no usable output (${outData ? outData.length : 0} bytes). Try Fast quality, 1080p, or a shorter clip.`);
  }
  for (const f of [bgName, maskName, inName, outName]) try { await ffmpeg.deleteFile(f); } catch {}

  const finalBlob = new Blob([outData], { type: 'video/mp4' });
  if (onProgress) onProgress({ stage: 'done', pct: 100 });
  return finalBlob;
}

/**
 * Mux silent video (WebM/MP4 blob from canvas) + audio bytes into final MP4 H.264+AAC.
 * Handles quality/resolution via re-encode of video stream.
 * If no audioData, just transcodes silent video to MP4.
 * LEGACY two-pass path — kept until compositePipeline is verified, then remove.
 */
export async function muxToMP4({ silentBlob, audioData, outputW, outputH, quality = 'balanced', fps = 30, duration, onProgress }) {
  const ffmpeg = await getFFmpeg(onProgress);
  // Duration-aware preset: long/high-res clips auto-drop to veryfast (logged).
  const qualityCfg = resolveVideoQuality(quality, duration, outputW, outputH);

  const silentName = silentBlob.type.includes('mp4') ? 'silent.mp4' : 'silent.webm';
  const audioName = 'audio.m4a';
  const outName = 'output.mp4';

  // Cleanup
  for (const f of [silentName, audioName, outName]) try { await ffmpeg.deleteFile(f); } catch {}

  const silentBytes = new Uint8Array(await silentBlob.arrayBuffer());
  await ffmpeg.writeFile(silentName, silentBytes);
  // Never feed a phantom (empty/tiny) audio file as a second input — ffmpeg
  // waits for its packets forever and the bar freezes at ~98% with no error.
  let hasAudio = false;
  if (audioData && audioData.length > 1024) {
    await ffmpeg.writeFile(audioName, audioData);
    hasAudio = true;
  }
  console.log(`[Framely] mux branch: ${hasAudio ? 'audio' : 'silent'} (audioBytes=${audioData ? audioData.length : 0})`);

  // Build FFmpeg args — robust against infinite-duration inputs.
  // Our pipeline is canvas-based (no -loop 1), so no infinite image stream exists,
  // but -shortest + explicit -t guard against silent hangs if any input is ever
  // considered infinite (e.g., looped image, mismatched audio/video durations).
  // -shortest is required whenever two inputs are combined; we add it in BOTH
  // branches, and also bound with -t <duration> when known.
  // Keep the flag set minimal: -shortest + -t only. Extra demuxer flags
  // (-fflags +shortest, -max_interleave_delta) were removed — they add no
  // protection here and complicate stall diagnosis.
  // Bilinear, not lanczos: the silent WebM is already at outputW×outputH by
  // construction (workCanvas is sized to it), so this scaler is a pass-through.
  // Lanczos on ~1000 frames of single-threaded wasm is pure stall time.
  const vfScale = `scale=${outputW}:${outputH}:flags=bilinear`;
  const args = [];
  // Add duration guard if available (seconds) — use 2 decimal places
  const tFlag = duration && isFinite(duration) && duration > 0 ? String(duration.toFixed(2)) : null;

  if (hasAudio) {
    args.push(
      '-i', silentName,
      '-i', audioName,
      '-c:v', 'libx264',
      '-preset', qualityCfg.preset,
      '-crf', String(qualityCfg.crf),
      '-pix_fmt', 'yuv420p',
      '-vf', vfScale,
      '-r', String(fps),
      '-c:a', 'aac',
      '-b:a', qualityCfg.audioBitrate,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest'
    );
    if (tFlag) args.push('-t', tFlag);
    // NOTE: -movflags +faststart intentionally omitted. It forces a second,
    // progress-silent remux pass (moving the moov atom to the front) which
    // is only needed for progressive web streaming, not for a file the user
    // downloads locally. On single-threaded ffmpeg.wasm this pass produced
    // no progress events and looked exactly like a hang at ~97%.
    args.push(outName);
  } else {
    args.push(
      '-i', silentName,
      '-c:v', 'libx264',
      '-preset', qualityCfg.preset,
      '-crf', String(qualityCfg.crf),
      '-pix_fmt', 'yuv420p',
      '-vf', vfScale,
      '-r', String(fps),
      '-an',
      '-shortest'
    );
    if (tFlag) args.push('-t', tFlag);
    // See note above — no +faststart.
    args.push(outName);
  }

    // Heartbeat + watchdog: log every 3s while exec runs so silent hangs are visible
  // ffmpeg.on('progress') already maps to onProgress, but add explicit heartbeat
  let lastProgress = 0;
  let lastProgressAt = Date.now();
  const progressHandler = ({ progress }) => {
    lastProgress = Math.round(progress * 100);
    lastProgressAt = Date.now();
  };
  ffmpeg.on('progress', progressHandler);
  let heartbeat = null;
  let execStart = Date.now();
  heartbeat = setInterval(() => {
    const elapsed = ((Date.now() - execStart) / 1000).toFixed(1);
    console.log(`[Framely] heartbeat mux still running — elapsed ${elapsed}s, last progress ${lastProgress}%, args: ${args.join(' ')}`);
  }, 3000);

  // Also log full command for debugging -loop/-shortest
  console.log('[Framely] ffmpeg exec', args.join(' '), `silent=${silentBlob.type} ${silentBlob.size} bytes, hasAudio=${hasAudio}, audioBytes=${audioData ? audioData.length : 0}, output ${outputW}x${outputH} fps=${fps} t=${tFlag} preset=${qualityCfg.preset} crf=${qualityCfg.crf}`);

  // Progress-based watchdog: fail only when exec makes NO progress for a long
  // stretch (true stall, e.g. waiting on a phantom input). An absolute timer
  // would false-positive on legitimately slow encodes (31s/1080p single-thread
  // wasm takes minutes) — those keep emitting progress, so they survive.
  const NO_PROGRESS_TIMEOUT_MS = 90_000;
  const ABSOLUTE_TIMEOUT_MS = 20 * 60_000;
  let stallTimer = null;
  const stallWatch = new Promise((_, rej) => {
    stallTimer = setInterval(() => {
      const idle = Date.now() - lastProgressAt;
      const total = Date.now() - execStart;
      if (idle > NO_PROGRESS_TIMEOUT_MS) {
        clearInterval(stallTimer);
        rej(new Error(`Encoding stalled: no progress for ${Math.round(idle / 1000)}s (last ${lastProgress}%). This usually means ffmpeg is waiting on an input stream (e.g. an empty audio track). Check the args logged above.`));
      } else if (total > ABSOLUTE_TIMEOUT_MS) {
        clearInterval(stallTimer);
        rej(new Error(`Encoding timed out after ${Math.round(total / 1000)}s (last ${lastProgress}%). Try a shorter clip, 1080p, or Fast quality.`));
      }
    }, 5000);
  });
  try {
    await Promise.race([
      ffmpeg.exec(args),
      stallWatch
    ]);
  } catch (e) {
    // Handle Emscripten exit(0) thrown as error
    if (e && String(e).includes('exit(0)')) {
      // success — ignore
    } else {
      throw new Error('Encoding failed: ' + (e?.message || String(e)));
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(stallTimer);
    ffmpeg.off('progress', progressHandler);
    const total = ((Date.now() - execStart) / 1000).toFixed(1);
    console.log(`[Framely] ffmpeg exec finished — total ${total}s, last progress ${lastProgress}%`);
  }

  const outData = await ffmpeg.readFile(outName);
  // Never hand a broken download to the UI — fail loudly instead of a dead file.
  if (!outData || outData.length < 100_000) {
    for (const f of [silentName, audioName, outName]) try { await ffmpeg.deleteFile(f); } catch {}
    throw new Error(`Encoding produced no usable output (${outData ? outData.length : 0} bytes). Try Fast quality, 1080p, or a shorter clip.`);
  }
  // Cleanup
  for (const f of [silentName, audioName, outName]) try { await ffmpeg.deleteFile(f); } catch {}

  return new Blob([outData], { type: 'video/mp4' });
}

/**
 * Convenience: full pipeline from silentBlob + originalBlob to final MP4.
 */
export async function transcodePipeline({ silentBlob, originalBlob, outputW, outputH, quality, fps, duration, onProgress }) {
  // Stage: extracting audio (10%)
  if (onProgress) onProgress({ stage: 'muxing', pct: 88 });
  let audioData = null;
  try {
    audioData = await extractAudio(originalBlob, quality, onProgress);
  } catch (e) {
    // No audio is not fatal — continue silent
    console.warn('Audio extract skipped:', e.message);
    audioData = null;
  }
  if (onProgress) onProgress({ stage: 'encoding', pct: 92 });
  const finalBlob = await muxToMP4({ silentBlob, audioData, outputW, outputH, quality, fps, duration, onProgress });
  if (onProgress) onProgress({ stage: 'done', pct: 100 });
  return finalBlob;
}
