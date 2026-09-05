# SESSION.md — Framely (Video Background Studio) build log

Chrome MV3 extension. Centers a screen recording on a background image with
rounded corners + soft shadow. 100% client-side (Canvas + FFmpeg.wasm,
single-thread core bundled in `vendor/ffmpeg/`). Remote:
https://github.com/DRMCGT/Video-BS

## Architecture (current)

```
Drop / paste URL / X-extract  →  video File + bg image
  → detectSourceFps (rVFC, snapped 24/25/30/50/60)
  → renderBackgroundStill (cover bg + shadow + punched rounded window, PNG)
  → renderVideoMask (black + white rounded rect, PNG)
  → compositePipeline: ONE ffmpeg pass
      [1:v]scale,rgba[fg]; [fg][2:v]alphamerge[fgm];
      [0:v][fgm]overlay=x:y → libx264 + audio (copy iff AAC)
  → MP4 H.264 + AAC, source fps/duration preserved
```

Single geometry source: `computeVideoRect()` in `src/lib/compositor.js`
(preview = still = mask = overlay rect, even-snapped for yuv420).

## Session history (bug → cause → fix)

1. **Stuck at 97%, wallpaper flash at end.** `dist/` was stale (built before
   `src` fix): still contained `-movflags +faststart` (progress-silent second
   remux pass) and no watchdog. Fix: rebuild + reload; removed faststart,
   added 120 s watchdog + heartbeat logs. Lesson: always compare bundle hash
   after building.
2. **Progress bar lied (double-scaling).** Compositor emitted 0–85, studio
   mapped it again as 8→85 (capped ~73%). Fix: compositor emits 0–100,
   studio maps once (render 8→85, mux 88→99, 100 on done).
3. **Wallpaper-only tail in exports.** Metadata `duration` overshot the work
   video's seekable range; failed seeks painted bg-only frames.
   Fix (two-pass era): `effDuration` clamp + `seekVideo` success flag + reuse
   last good frame. (Superseded by single-pass rewrite.)
4. **Hang at 98% with `hasAudio=true, audioBytes=0`.** `-c:a copy` "succeeded"
   on silent sources while writing a 0-byte `audio.m4a`; fed as second `-i`
   input, ffmpeg waited for its packets forever. Fix: always re-encode audio
   to AAC, `>1 KB` validation, silent path otherwise; mux guard `>1024`;
   post-exec `<100 KB` output validation. Also found the user's bundle hash
   differed from a clean build → pinned ffmpeg deps exact, builds verified
   deterministic (two builds → same hash).
5. **Absolute 120 s watchdog killed healthy encodes.** 31 s/1080p/medium ≈
   4 min single-thread. Fix: progress-based watchdog (fires after 90 s of
   zero progress; 20 min absolute backstop).
6. **Slow encodes.** Fix: duration-adaptive preset (>15 s or >1080p → veryfast,
   CRF/audio kept, logged); `lanczos` → `bilinear` (scaler is a pass-through:
   canvas is already at target dims).
7. **Tab switch froze progress (planned, not built).** Realtime
   MediaRecorder/captureStream + clamped timers in hidden tabs. Planned fix:
   offline encode (WebCodecs) — superseded by single-pass rewrite, which uses
   wasm compute instead of wall-time recording and degrades gracefully.
8. **Slow-motion + truncated exports (major rewrite).** Realtime canvas
   recording re-timed every frame (seek + 33 ms wait per frame → wall-time
   stretch), then `-t` truncated it. Fix: single-pass overlay — original
   timestamps/fps/duration preserved; audio mapped straight from the source
   (no extract step). `detectSourceFps`, `renderBackgroundStill`,
   `compositePipeline`. Legacy two-pass code tree-shaken out of the bundle.
9. **URL import.** `src/lib/url-import.js`: direct media links → File
   (500 MB video / 25 MB image caps, content-type sniff, streamed progress);
   runtime `optional_host_permissions` (no install warning); platform post
   links detected → guided download-then-drop fallback. Studio URL rows +
   `fetchMediaUrl` wiring. README section added.
10. **X/Twitter extraction (twittervideodownloader-style UX, zero servers).**
    `src/content/x-main-hook.js` (MAIN world: fetch/XHR hooks + embedded-JSON
    + video-element layers, pure `extractMp4Variants` parser, unit-tested) +
    `x-bridge.js` relay + `src/lib/x-extract.js` orchestration (open tab →
    inject → quality picker → fetch → close tab). Programmatic injection via
    `scripting` (silent perms); `tabs` for tab management.
11. **"No video found" on loaded tweet.** Hook was injected after tab
    `complete` — X had already fetched TweetDetail; blob: MSE + wrong
    embedded-JSON spots + scans stopping at 5 s made fallbacks blind.
    Fix: inject immediately after `tabs.create` (+ re-inject on navigation,
    race-safe load wait), 1 s interval scans to 15 s, XHR hook, auto-play
    driver, heartbeat/page-state/stats notes, specific errors (incl. login
    wall), bridge relays notes. Parser test kept green.
12. **Radius ignored in exports.** Overlay composited an opaque square over
    the punched hole (`overlay=…:format=yuv420`). Fix: `renderVideoMask()` +
    third looped input + `alphamerge` → `overlay … :format=auto`. Preview
    already clipped via canvas — now they match.

## Pending / ideas

- Delete legacy two-pass code (`extractAudio`, `muxToMP4`, `transcodePipeline`,
  `renderToSilentWebM`, hidden work elements) once single-pass is fully trusted.
- Open & Capture (`chrome.tabCapture` + offscreen) for YouTube/Facebook links.
- Auto-play/fullscreen injector for X (needs `scripting` — already granted).
- Release 1.1: version bump, changelog, checklist refresh.

## Conventions learned the hard way

- Load `dist/`, never root, as unpacked extension; `npm run build` then
  ↻ Reload; confirm the bundle hash in console before debugging.
- Never feed sub-1 KB files as ffmpeg inputs; validate every stage's output.
- Watchdogs must be progress-based, never absolute-time.
- Timing must come from the source file, never from wall-time recording.
