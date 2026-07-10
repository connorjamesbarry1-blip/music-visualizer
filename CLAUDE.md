# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A browser-based music visualizer — vanilla HTML/CSS/JS with no build step, no bundler, and no external API dependencies. Audio is captured directly from any playing browser tab via the Web Audio API (`getDisplayMedia`). No authentication, no Spotify SDK, no backend.

## Running the App

This is a fully static site. Serve it with a local HTTP server (opening `index.html` directly won't work due to ES module restrictions):

```powershell
# Python (usually available)
python -m http.server 8080

# Node (if installed)
npx serve .
```

Then open `http://localhost:8080` in Chrome. When prompted, select the tab playing music and tick **Share tab audio**.

> Chrome is required — Firefox and Safari do not support tab audio capture via `getDisplayMedia`.

## Architecture

No bundler, no framework — all modules are plain JS files loaded via `<script type="module">` in `index.html`.

| File | Responsibility |
|---|---|
| `src/app.js` | Entry point — wires AudioEngine → Visualizer → CatMode, runs RAF loop |
| `src/audio.js` | Tab audio capture (`getDisplayMedia`), FFT analysis, beat detection (BPM via autocorrelation + PLL) |
| `src/visualizer.js` | Canvas 2D rendering — 11 visualization modes |
| `src/catmode.js` | Pixel-art cat overlay that dances to the beat |
| `style.css` | Global styles |
| `index.html` | App shell — settings panel, control script, canvas elements |

## Audio Pipeline

1. `AudioEngine.start()` calls `getDisplayMedia({ video: true, audio: true })` — the user selects a tab and ticks "Share tab audio"
2. The audio track is routed into a Web Audio `AnalyserNode` (FFT size 2048, **not** connected to `destination` — no echo)
3. Each RAF frame: `getFrequencyData()` + `getTimeDomainData()` feed into `Visualizer.draw()`
4. `BeatDetector` runs autocorrelation on a 50 Hz kick-energy ring buffer to estimate BPM, with a phase-locked loop for grid alignment

## Settings

`window.VIZ_SETTINGS` is a plain object written by the inline panel script in `index.html` and read every frame by `visualizer.js`. No module imports needed between them.
