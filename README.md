# Fabinator WeakFrames

A browser app for reviewing segmentation **weak frames** and exporting the keepers as a
frame-exact **ProRes 422 LT** (or ProRes Proxy / H.264) video for the Fabinator.

Everything runs **locally on the machine that opens the page** — frames are read straight
from your disk via the browser's File System Access API, and the video is encoded in-browser
by FFmpeg compiled to WebAssembly. Nothing is ever uploaded.

---

## Hosting it (pick one)

The app is 100% static files — any static host works.

**GitHub Pages (recommended — gives everyone a URL):**
1. Create a repo and push the contents of this folder to it (`index.html` at the repo root).
2. Repo → *Settings* → *Pages* → Source: *Deploy from a branch* → `main` / `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` in Chrome or Edge. Done.

**Local, zero setup:**
```powershell
cd fabinator_weakframes_app
python -m http.server 8080
# then open http://localhost:8080 in Chrome/Edge
```

> The page must be served over **https or localhost** (browser security requirement for
> folder access). Opening `index.html` via double-click (`file://`) is not supported.

## Requirements

| Thing | Why |
|---|---|
| **Chrome or Edge, desktop** | The File System Access API (folder open/move/delete) isn't in Firefox/Safari. |
| Internet on first export | The FFmpeg engine (~31 MB) downloads from a CDN once, then it's browser-cached. |
| Nothing else | No installs, no Python/Node on the reviewing machine, no server backend. |

**Fully offline / air-gapped option:** put the FFmpeg core next to the app so no CDN is needed —
```powershell
mkdir vendor
curl -Lo vendor/ffmpeg-core.js   https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js
curl -Lo vendor/ffmpeg-core.wasm https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm
```
The app auto-detects `vendor/` and prefers it. The small ffmpeg.wasm wrapper is already
shipped in `lib/ffmpeg/` (it **must** be same-origin — its Web Worker chunk `814.ffmpeg.js`
cannot be constructed cross-origin from a CDN), so with `vendor/` in place the app makes
zero external requests.

## How pairing works (Tab 2)

The folder you open is scanned **recursively**. In each subfolder, files pair by frame number,
**extension-agnostic** (bmp/png/jpg/jpeg/tif/tiff/webp):

| Original | Segmented partner (any of) |
|---|---|
| `0.bmp`, `0012.png`, … | `segmneted_0.bmp` · `segmented_0.png` · `0_segmneted.bmp` · `0-segmented.jpg` |

Anything else (`Thumbs.db`, videos, …) is ignored. Files with no partner are listed as
*unpaired* with a one-click "move to to_delete" option. Pairing never crosses folders.

## Review workflow

| Key | Action |
|---|---|
| `←` / `→` | previous / next pair (skips deleted) |
| `Space` | toggle original ⇄ segmented |
| `O` | overlay segmented on original (opacity slider) |
| `D` / `X` / `Del` | mark pair for deletion |
| `Z` (or `Ctrl+Z`) | undo |
| `R` | restore the viewed pair from to_delete (any pair — click its row in the Pairs list first) |
| `Home` / `End` | first / last pair |

Marking a pair **moves it into a `to_delete/` folder inside your frames folder** (mirroring the
subfolder structure) — nothing is destroyed. *Delete selected permanently* empties `to_delete`
after a confirmation; *Restore all* puts everything back. `to_delete` survives page reloads,
so you can review across sessions.

## Export (Tab 3)

Takes every pair that survived review (original frames only), ordered by folder then frame
number, and encodes **one image → one video frame**: no interpolation, no scaling, no
duplicate/dropped frames. The app verifies the encoder's reported frame count against the
input count and tells you.

| Format | Notes |
|---|---|
| **ProRes 422 LT** | **Default — best for most exports.** 10-bit 4:2:2, `.mov`, Rec.709-tagged. |
| ProRes 422 Proxy | Same family, ~half the bitrate. |
| H.264 High Quality | CRF 12 High profile `.mp4` — small, but 4:2:0 chroma. |

Default frame rate is **59.94** (60000/1001). Output name defaults to
`<folder>_<format>_<fps>.mov`.

> **Save location:** the browser's save dialog opens *inside* your frames folder — hop up one
> level to land in its parent. (Browsers can't pre-select a folder you haven't granted access to.)

**Speed & size expectations:** WebAssembly encoding is single-threaded — a few hundred
1080p frames typically take **2–5 minutes** (a progress bar tracks frames). Around ~1,500+
frames you may approach the browser's 2 GB WASM memory ceiling for the output buffer;
split very large exports.

You'll get an in-page banner **and a desktop notification** (if you allow it) when the export
finishes. The banner prints the exported file's location as **copy-pasteable text** with a Copy
button. Browsers never reveal absolute paths, so by default that path is relative to your frames
folder — paste the frames folder's full path once into the **Frames folder full path** box
(remembered per folder) and exports print a complete path you can drop straight into Explorer's
address bar.

## Development

- `core.js` — pure logic (pairing, sorting, ffmpeg args, image-header parsing). No DOM.
- `app.js` — UI, File System Access, ffmpeg.wasm orchestration.
- Tests: open `test_core.html` in a browser, or headless:
  ```powershell
  chrome --headless=new --dump-dom test_core.html   # look for "TESTRESULT: ALL PASS"
  ```

- `test_export.html` — end-to-end wasm encode test (needs `test_assets/` with 10 BMPs named
  `frame_000000.bmp`…; generate with
  `ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30 -frames:v 10 -start_number 0 -pix_fmt bgr24 test_assets/frame_%06d.bmp`).
  Beacons its verdict as a `GET /EXPORTRESULT_…` request you can read in the server log.

Pinned dependencies: `@ffmpeg/ffmpeg@0.12.10` + `@ffmpeg/util@0.12.1` (vendored in `lib/ffmpeg/` —
must stay same-origin), `@ffmpeg/core@0.12.6` (CDN, or self-host in `vendor/`).
