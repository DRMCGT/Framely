# Framely — Chrome Extension (MV3)

Center a screen recording on a background image with rounded corners and soft shadow. **100% client-side** — no upload, no server. Single-pass pipeline: Canvas stills + FFmpeg.wasm overlay to MP4 H.264 + AAC, preserving the source's fps, duration, and audio.

## Features
- Drag & drop background (JPG/PNG/WebP) + video (MP4) with live preview and metadata (resolution, duration, size)
- **Paste direct links** for video + background (URL import, per-site permission on demand)
- **X/Twitter extraction**: paste a tweet link → pick quality → downloads straight from the CDN (your login, zero servers)
- Controls: border radius 0–50px (default 10), scale 50–95% (85), shadow toggle + intensity, output resolution 1080p/1440p/4K/source, quality Fast/Balanced/High (CRF + adaptive preset + audio bitrate)
- Live WYSIWYG preview — same geometry code as export (`computeVideoRect`)
- Source fps preserved exactly (measured via rVFC); duration-accurate; audio copied iff AAC
- Result preview + Download MP4 (H.264 + AAC, `yuv420p`)
- Dark mode (system + manual toggle), accent centralized as `--accent-color: #7c5cff`
- Soft warn at 200MB (no hard block), friendly errors (corrupted, unsupported codec, OOM, stalls)

## Architecture
- **Dedicated tab** `src/page/studio.html` opened via `chrome.action.onClicked` (not popup/side panel — needs full viewport, survives SW idle)
- **Single-pass composite**: Canvas renders one background still (cover + shadow + punched rounded window) and one rounded-corner alpha mask; FFmpeg overlays the **original** video through the mask (`scale → alphamerge → overlay`) — original timestamps/fps/duration untouched, audio mapped from the source
- **Single-thread FFmpeg.wasm** `@ffmpeg/core` bundled locally in `vendor/ffmpeg/` — no CDN, CSP `wasm-unsafe-eval` only, no `SharedArrayBuffer`/`crossOriginIsolated`

## Project Structure
```
.
├── manifest.json
├── vite.config.js
├── vendor/ffmpeg/          # ffmpeg-core.js + .wasm (~31MB) — local, no CDN
├── icons/
├── src/
│   ├── background.js       # opens/focuses studio tab
│   ├── content/
│   │   ├── x-main-hook.js  # MAIN-world X page observer (fetch/XHR/DOM layers)
│   │   └── x-bridge.js     # isolated-world relay to studio
│   ├── page/
│   │   ├── studio.html
│   │   ├── studio.css      # --accent-color centralized
│   │   └── studio.js       # UI wiring + pipeline orchestration
│   └── lib/
│       ├── constants.js
│       ├── file-utils.js   # dropzones, metadata, fps detection
│       ├── url-import.js   # direct-link fetcher + platform-link guard
│       ├── x-extract.js    # tweet tab orchestration + quality picker data
│       ├── compositor.js   # shared geometry, bg still, alpha mask
│       └── ffmpeg-worker.js # FFmpeg load + single-pass compositePipeline
└── dist/                   # built extension (load unpacked from here)
```

## Install & Load Unpacked

Prereqs: Node 18+, Chrome/Edge 120+

```bash
npm install
npm run build   # outputs dist/ — this is the extension
```

> ⚠️ **Load `dist/`, not project root.** The project root `manifest.json` points at unbundled `src/` which uses bare `import "@ffmpeg/ffmpeg"` and will fail with `Failed to resolve module specifier "@ffmpeg/ffmpeg"` in `chrome-extension://`. Always Load unpacked from `Framely/dist`.

1. Open `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select **`dist/` folder** (e.g. `/home/lamb/Dev/OpenSource/Framely/dist`) — **not** `Framely/`
3. If you see `Failed to resolve module specifier "@ffmpeg/ffmpeg"` or dropzones do nothing: you loaded the wrong folder. Remove the extension, `npm run build` again, and load `dist/`.
4. Click the extension icon → studio tab opens at `chrome-extension://<id>/src/page/studio.html`
5. Drop a video + background, tweak controls (preview updates live), click **Generate Video**, then **Download MP4**

Reload after rebuild:
```bash
npm run build
# then in chrome://extensions click ↻ Reload on the card
```

Dev mode (live reload, not for extension CSP):
```bash
npm run dev  # http://localhost:5173/src/page/studio.html
```

## Import from URL
- Paste a **direct file link** (`https://…/clip.mp4`, `https://…/bg.jpg`) into the "…or paste link" field under each dropzone and hit **Fetch**. The file is downloaded straight into the extension (100% local from there) and flows through the same validation + preview as uploads.
- The browser asks for host access **only when you fetch** (optional permission, per-site) — nothing is granted at install time.
- **X/Twitter post links**: paste a tweet URL → the extension opens it, reads the MP4 versions the page loads, and offers a **quality picker** — then downloads straight from the CDN. Uses your own login; no servers. Other platforms (YouTube/Facebook/…) show a guided download-then-drop fallback.
- Limits: videos up to 500 MB, images up to 25 MB; wrong content-type, 404s, oversize, and hotlink-blocked hosts show a friendly error.

> Use the X extractor for content you own or are permitted to reuse.

## Usage
1. Upload background (cover-scaled) and video (shows WxH, duration) — or paste direct links / a tweet link
2. Adjust radius/scale/shadow — preview is WYSIWYG
3. Pick resolution (1080p default) and quality (Balanced; long clips auto-drop to a faster preset, logged)
4. Generate — single composite pass; result plays inline
5. Download — file is `framely-<timestamp>.mp4`, playable in VLC/QuickTime

## Limits & Errors
- Soft warn >200MB; no hard block — if browser struggles, retry at 1080p or shorter clip. Threshold is tunable after real-memory testing.
- Unsupported codec → `Could not read video — try MP4 H.264 + AAC`
- Corrupted/truncated → timeout after 8s with friendly message
- OOM → `Out of memory — try 1080p, shorter clip, or close tabs`

## CSP & Bundling Notes
- `manifest.json` → `extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"` — only `wasm-unsafe-eval` allowed in MV3
- `vendor/ffmpeg/*` bundled locally; `chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.*')` at runtime; `toBlobURL` fallback handled in `ffmpeg-worker.js`
- `web_accessible_resources: ["vendor/ffmpeg/*"]` for completeness

## Rebrand
Change one line in `src/page/studio.css:4`:
```css
:root { --accent-color: #7c5cff; }
```
All buttons, sliders, progress, focus rings use `var(--accent-color)` — no component edits needed.

## Scripts
- `npm run build` — production build to `dist/` (use for Load unpacked)
- `npm run dev` — Vite dev server
- `npm run preview` — preview build

## Acceptance Checklist
- [x] Loads without errors via Load unpacked (dist)
- [x] Video + image upload with preview & metadata
- [x] Direct-URL import (video + image) with friendly errors
- [x] X post link → quality picker → import
- [x] Controls visibly affect preview and export (radius matches via alpha mask)
- [x] Output duration ±0.2 s, motion speed identical, source fps preserved
- [x] Generated MP4 has synced audio (copied iff AAC, else re-encoded)
- [x] Final file is valid MP4 H.264+AAC, plays outside extension
- [x] Zero processing egress — 100% local (vendor/ffmpeg bundled; only user-requested URL fetches hit the network)
- [x] Deterministic builds (two consecutive builds → identical bundle hash)
