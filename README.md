# 🎵 Music Visualizer

A browser-based music visualizer that turns **any playing browser tab** into a real-time light show. It captures tab audio directly through the Web Audio API — no Spotify SDK, no authentication, no backend, and no external API calls. Pure vanilla HTML/CSS/JavaScript with no build step.

Play music in any tab, share that tab's audio, and the whole screen reacts to the beat — with 11 visualization modes and a pixel-art cat dance party on top.

---

## Requirements

- **Google Chrome** (or another Chromium browser like Edge). Firefox and Safari do **not** support tab-audio capture via `getDisplayMedia` and won't work.
- Any tab playing audio — Spotify Web Player, YouTube, SoundCloud, Bandcamp, etc.
- A local HTTP server. Opening `index.html` directly won't work because the app uses ES modules, which browsers block on the `file://` protocol.

---

## Running the app

From the project folder, start a local server:

```bash
# Python (usually already installed)
python -m http.server 8080
```

```bash
# Or with Node
npx serve .
```

Then open **http://localhost:8080** in Chrome.

---

## How to use it

1. **Play music** in another browser tab (Spotify, YouTube, SoundCloud…).
2. Open the visualizer tab and click **Share Tab Audio**.
3. In the popup, **select the tab that's playing music**.
4. **Tick the "Share tab audio" checkbox** — this is the step people miss. Without it, there's no sound to visualize and the app will ask you to try again.
5. Click **Share**. The visualizer takes over the screen and starts reacting.

To stop, click **Stop sharing** in Chrome's sharing bar, and you'll return to the start screen.

> **Note on privacy/echo:** The captured audio is routed only into an analyzer for FFT data — it is *not* played back, so you won't hear an echo. Nothing is recorded, uploaded, or sent anywhere; all processing happens locally in your browser.

---

## Controls

Click the **⚙ gear** in the corner to open the settings panel.

### Presets
Quick starting points that set trails, symmetry, color, and reactivity together:

- **Chill** — slow, minimal, cool tones
- **Balanced** — the default, good all-rounder
- **Intense** — fast, reactive, maxed-out

### Visualization modes
Eleven modes, each reacting to bass, mids, highs, and beats:

| Mode | What it does |
|---|---|
| **Spectrum** | Classic frequency bars with peak-hold caps and a bass bloom |
| **Waveform** | Smooth oscilloscope line that glows and thickens on beats |
| **Radial** | Counter-rotating waveform rings around a pulsing glowing core |
| **Terrain** | Scrolling spectrogram "landscape" that flows across the screen |
| **Particles** | Bass, mid, and high particles bursting with gravity and trails |
| **Lissajous** | Drifting, rotating harmonic curves with per-arm color cycling |
| **Blob** | A layered, wobbling organic shape that breathes with the music |
| **Rings** | Concentric rings plus shockwaves that fire outward on beats |
| **Spiral** | The waveform coiled into a rotating, pulsing spiral |
| **Polygon** | Nested polygons that morph shape (triangle → octagon) on each beat |
| **Tunnel** | An endless psychedelic vortex you fall into, faster on bass |

### Fine-tuning
- **Trail Length** — how long visuals persist, from long smears ("Long") to instant clear ("None").
- **Symmetry** — mirror/kaleidoscope the image 1×–6× (most visible in Lissajous).
- **Color Mode** — Cycle (rainbow drift), Reactive, Warm, or Cool palettes.
- **Reactivity** — how strongly visuals respond to the audio.
- **Lissajous Lines** — curve detail for the Lissajous mode.
- **Polygon Shape** — lock the Polygon mode to a fixed shape or let it morph randomly.
- **Tempo** — a live BPM readout from the built-in beat detector.

### 🐾 Kitty Party Time
A pixel-art cat overlay that dances to the detected beat:

- **Party: ON/OFF** — toggle the dancing cats.
- **Count** — 1 to 100 cats at once.
- **Dance Type** — Random, Bounce, Sidestep, Spin, Headbang, Wiggle, Backflip, Moonwalk, Twerk, Macarena, or Wave.
- **Roam** — let the cats wander around the screen.
- **Roam Speed** — how fast they wander.

---

## How it works (under the hood)

1. **Capture** — `getDisplayMedia({ video: true, audio: true })` lets you pick a tab and share its audio. (Video must be requested for Chrome to surface the "Share tab audio" checkbox, but the video track is never drawn.)
2. **Analysis** — the audio track feeds a Web Audio `AnalyserNode` (FFT size 2048). It is deliberately **not** connected to the speakers, so there's no echo.
3. **Render** — every animation frame, the app reads frequency and time-domain data and hands it to the canvas renderer.
4. **Beat detection** — a rolling buffer of kick-drum energy (40–130 Hz) is autocorrelated to estimate BPM, refined by a phase-locked loop and octave-error correction, so the grid stays aligned to the actual beat.

### Project structure

| File | Responsibility |
|---|---|
| `index.html` | App shell — capture screen, settings panel, control script |
| `src/app.js` | Entry point — wires audio → visualizer → cat mode, runs the render loop |
| `src/audio.js` | Tab-audio capture, FFT analysis, BPM/beat detection |
| `src/visualizer.js` | Canvas 2D rendering for all 11 modes |
| `src/catmode.js` | Pixel-art dancing cat overlay |
| `style.css` | Global styles |

No frameworks, no bundler, no dependencies — every module is plain JavaScript loaded via `<script type="module">`.

---

## Troubleshooting

- **"You need to tick Share tab audio"** — you shared a tab but left the audio checkbox unchecked. Click the button and try again, making sure to tick it.
- **Nothing is moving** — make sure the shared tab is actually playing sound and isn't muted.
- **It won't load / module errors** — you opened the file directly. Serve it over `http://localhost` with one of the commands above.
- **No "Share tab audio" option** — you're not on Chrome/Edge. Switch to a Chromium browser.
