# Framely 🎬

Give any screen recording a studio look: centered on a background image with rounded corners and a soft shadow. A Chrome extension (Manifest V3) that renders everything **100% client-side** — no upload, no server, no account.

![Chrome 120+](https://img.shields.io/badge/Chrome-120%2B-7c5cff?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-7c5cff)
![100% local](https://img.shields.io/badge/processing-100%25%20local-00c853)

Built by **[Rafa Lamb](https://rafalamb.dev)** — SaaS builder, building in public.

## What it does

Drop in a video + a background image, tweak the look in a live WYSIWYG preview, and export a polished **MP4 (H.264 + AAC)**. Single-pass pipeline: a Canvas still + FFmpeg.wasm overlay that preserves your source's fps, duration, and audio.

## Features

- 🖼️ Drag & drop background (JPG/PNG/WebP) + video (MP4) with live preview and metadata (resolution, duration, size)
- 🔗 **Paste direct links** for video + background — fetched straight into the extension (per-site permission only when you fetch)
- 🐦 **X/Twitter extraction**: paste a tweet link → pick quality → downloads from the CDN using your own login. Zero servers.
- 🎛️ Controls: border radius (0–50px), video scale (50–95%), shadow toggle + intensity, output resolution (1080p / 1440p / 4K / source), quality presets (Fast / Balanced / High)
- 🎯 Source fps preserved exactly (measured via rVFC); duration-accurate; audio copied when AAC, re-encoded otherwise
- 🌙 Dark mode (system + manual toggle), one-variable rebrand (`--accent-color`)
- ⚠️ Soft warn at 200MB (no hard block) + friendly errors for corrupted files, unsupported codecs, OOM, and stalls

## Install

Prereqs: Node 18+, Chrome/Edge 120+.

```bash
npm install
npm run build   # outputs dist/ — this IS the extension
```

1. Open `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the **`dist/` folder** (not the project root!)
3. Click the extension icon → the studio tab opens
4. Drop a video + background, tweak, **Generate Video**, **Download MP4**

> ⚠️ **Always load `dist/`, never the project root.** The root `manifest.json` points at unbundled `src/` (bare `import "@ffmpeg/ffmpeg"`) and will fail in `chrome-extension://`. If dropzones do nothing or you see `Failed to resolve module specifier "@ffmpeg/ffmpeg"`: you loaded the wrong folder — remove it, `npm run build`, load `dist/`.

After rebuilding: `npm run build`, then hit ↻ **Reload** on the extension card.

Dev mode (live reload, not for extension CSP):

```bash
npm run dev  # http://localhost:5173/src/page/studio.html
```

## Usage

1. Upload a background (cover-scaled) and a video — or paste direct links / a tweet link
2. Adjust radius / scale / shadow — the preview is WYSIWYG (same geometry code as export)
3. Pick resolution (1080p default) and quality (Balanced; long clips auto-drop to a faster preset, logged to console)
4. Generate — one composite pass; the result plays inline
5. Download — file is `framely-<timestamp>.mp4`, playable in VLC/QuickTime

## Import from URL & X

- **Direct file links** (`https://…/clip.mp4`, `https://…/bg.jpg`): paste into the "…or paste link" field under each dropzone → **Fetch**. Limits: 500 MB video / 25 MB image. Wrong content-type, 404s, oversize, and hotlink-blocked hosts show a friendly error.
- **X/Twitter post links**: paste a tweet URL → the extension opens it, reads the MP4 versions the page loads, offers a **quality picker**, then downloads from the CDN. Uses your own login; no servers. Other platforms (YouTube/Facebook/…) show a guided download-then-drop fallback.

> Use the X extractor for content you own or are permitted to reuse.

## How it works

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

- **Dedicated tab** (`src/page/studio.html`) opened via `chrome.action.onClicked` — full viewport, survives service-worker idle (not a popup/side panel).
- **Single geometry source**: `computeVideoRect()` in `src/lib/compositor.js` — preview = still = mask = overlay rect, even-snapped for `yuv420`.
- **Single-thread FFmpeg.wasm** (`@ffmpeg/core` bundled locally in `vendor/ffmpeg/`) — no CDN, CSP `wasm-unsafe-eval` only, no `SharedArrayBuffer`.
- Deterministic builds: two consecutive builds → identical bundle hash.

## Project structure

```
.
├── manifest.json
├── vite.config.js
├── vendor/ffmpeg/          # ffmpeg-core.js + .wasm (~31MB) — local, no CDN
├── icons/
├── src/
│   ├── background.js       # opens/focuses the studio tab
│   ├── content/
│   │   ├── x-main-hook.js  # MAIN-world X observer (fetch/XHR/DOM layers)
│   │   └── x-bridge.js     # isolated-world relay to the studio
│   ├── page/
│   │   ├── studio.html
│   │   ├── studio.css      # --accent-color centralized
│   │   └── studio.js       # UI wiring + pipeline orchestration
│   └── lib/
│       ├── compositor.js   # shared geometry, bg still, alpha mask
│       ├── ffmpeg-worker.js # FFmpeg load + single-pass compositePipeline
│       ├── file-utils.js   # dropzones, metadata, fps detection
│       ├── url-import.js   # direct-link fetcher + platform-link guard
│       ├── x-extract.js    # tweet tab orchestration + quality picker
│       └── constants.js
└── dist/                   # built extension (load unpacked from here)
```

## Rebrand

One line in `src/page/studio.css`:

```css
:root { --accent-color: #7c5cff; }
```

Buttons, sliders, progress, and focus rings all use `var(--accent-color)`.

## Scripts

- `npm run build` — production build to `dist/` (use for Load unpacked)
- `npm run dev` — Vite dev server
- `npm run preview` — preview the build

## Roadmap

- [ ] `chrome.tabCapture` recording with manual crop (platform-agnostic capture for any site)
- [ ] `chrome.downloads.download()` for more reliable saves + `showSaveFilePicker()`
- [ ] Batch export queue + "download all as ZIP"
- [ ] License finalization (leaning AGPL-3.0 for the open core)

## Contributing

PRs welcome! The core promise: **everything in this repo stays free, open, and 100% local**. Please keep it that way — no servers, no tracking, no uploads.

1. Fork → branch → `npm run build` → verify via Load unpacked (`dist/`)
2. Confirm the bundle hash in the console before/after your change
3. Open a PR describing what changed and how you tested it

## Author

**[Rafa Lamb](https://rafalamb.dev)** — I build products in public and write about it weekly. Framely is one of them: an open-core Chrome extension, free and local-first by design.
