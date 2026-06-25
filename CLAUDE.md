# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A browser-based Spotify visualizer — vanilla HTML/CSS/JS with no build step or bundler. It uses the Spotify Web API and likely the Web Audio API for visualization.

## Running the App

Since this is a static site and Spotify OAuth requires an HTTPS or localhost redirect URI, serve it with a local HTTP server rather than opening `index.html` directly:

```powershell
# Python (usually available)
python -m http.server 8080

# Node (if installed)
npx serve .
```

Then open `http://localhost:8080` in a browser. The Spotify redirect URI must be registered in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and must match the origin you're serving from.

## Architecture

No bundler, no framework — all modules are plain JS files loaded via `<script>` tags in `index.html`.

| File | Responsibility |
|---|---|
| `src/auth.js` | Spotify OAuth (PKCE flow or implicit grant), token storage/refresh |
| `src/spotify.js` | Spotify Web API calls (currently playing, audio features, etc.) |
| `src/visualizer.js` | Canvas/WebGL/Web Audio rendering loop |
| `src/app.js` | Entry point — wires auth → API → visualizer together |
| `style.css` | Global styles |

## Spotify API Notes

- The app uses the Spotify Web API; a `client_id` is required (no `client_secret` in a pure browser app).
- PKCE authorization code flow is the correct grant type for SPAs — do not use the implicit grant.
- The `Authorization Code with PKCE` flow requires no server; the access token is obtained entirely in the browser.
- Relevant scopes: `user-read-currently-playing`, `user-read-playback-state`, `streaming` (if using Playback SDK).
