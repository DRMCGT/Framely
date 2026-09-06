# SESSION.md — Framely build log

Chrome MV3 extension. Centers a screen recording on a background image with
rounded corners + soft shadow. 100% client-side (Canvas + FFmpeg.wasm,
single-thread core bundled in `vendor/ffmpeg/`). Remote:
https://github.com/DRMCGT/Framely

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

## Product & licensing decisions (roadmap session)

**Business model: open core.**
- The MVP ships fully open source. Everything currently in the repo (Canvas compositor, single-pass FFmpeg overlay pipeline, direct-URL import, X/Twitter extractor) stays free and open source indefinitely — this is the product's core trust argument ("100% local, auditable code") and must not be paywalled.
- License: recommend AGPL-3.0 for the open core (same choice as Cap.so, the closest direct comp — an open-source Loom alternative with local editing free and cloud/AI features paid). AGPL specifically discourages someone standing up a closed-source hosted competitor without contributing back. Confirm final license choice before the first public release; not yet finalized.
- Paid features are anything that costs *us* money to run (cloud compute or third-party API calls) — that's the actual dividing line, not "premium UI" or feature-gating things that already run free locally. Planned paid-tier candidates (not yet built, roadmap only): cloud rendering for long/heavy videos, AI-generated background images, hosted sharing links for generated results, team/brand-preset collaboration features.
- Decision: stay a Chrome extension, do not pivot to a centralized SaaS downloader. Rationale: a user's own browser fetching content the user already has access to (direct link, or the existing X extractor, or screen-capturing what's already rendering on their own screen) carries meaningfully less legal exposure than operating a centralized server that fetches and redistributes third-party video content at scale. A paid account/cloud layer can sit behind the free extension for the paid features above without requiring the whole product to become server-centric.

**"Any site" video import roadmap:**
- Keep the existing X/Twitter extractor as-is (network-hook based). Do **not** extend the same active-scraping approach to YouTube, TikTok, Instagram, or Facebook — Chrome Web Store policy is explicit against extensions that circumvent those platforms' download restrictions, and this is the highest-risk area for the whole extension getting rejected or delisted.
- New approach for "any other site": `chrome.tabCapture`. This records on-screen pixels the user is already viewing (same legal category as any screen recorder, e.g. Loom/Cap/the tab-recording extension the user already uses daily) rather than extracting a protected file — meaningfully lower risk, and platform-agnostic by construction (works identically regardless of which site is playing the video).
- Known trade-off to keep in mind when scoping this: tab recording is real-time (a 45s clip takes 45s to capture) and the tab generally needs to stay active/visible while recording — more friction than the instant X extractor, but it removes the need to build and maintain a per-platform scraper for every new site.
- Planned implementation, in order:
  1. **MVP of this feature:** record the full tab via `chrome.tabCapture`, then let the user manually crop a rectangle around the video region in the Studio (reuse `computeVideoRect`/the existing Canvas compositor — this is just cropping a rectangle out of the recording before the existing background/rounded-corner/shadow pipeline runs on it). No page content-script changes needed for this version.
  2. **Later improvement:** auto-detect the on-page `<video>` element's `getBoundingClientRect()` via a content script and crop that region live during capture, so the user doesn't have to draw the crop box manually. Deferred until the manual-crop version is validated with real users — has more edge cases (scroll mid-recording, ads covering the player, fullscreen transitions).
- Sequencing: ship the open-source MVP (current pipeline + X extractor) first. `tabCapture` (manual-crop version) is the next feature after MVP launch, ahead of any paid cloud features.

**Download/export improvements (post-MVP, already discussed, lower priority than the above):**
- Replace `<a download>` with `chrome.downloads.download()` for more reliable saves with conflict handling — note: this is purely a save-reliability improvement and has no bearing on Web Store review risk (that risk lives entirely in how source video is acquired, not how the output file is saved).
- `showSaveFilePicker()` for user-chosen destination/filename.
- Batch export queue + "download all as ZIP" (JSZip) once multi-video workflows (e.g. from the X extractor) are common enough to justify it.

## Conventions learned the hard way

- Load `dist/`, never root, as unpacked extension; `npm run build` then
  ↻ Reload; confirm the bundle hash in console before debugging.
- Never feed sub-1 KB files as ffmpeg inputs; validate every stage's output.
- Watchdogs must be progress-based, never absolute-time.
- Timing must come from the source file, never from wall-time recording.
