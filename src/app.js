// app.js — entry point.
//
// Spotify login is now OPTIONAL.  The visualizer works entirely via browser
// tab-audio capture (getDisplayMedia) with no Spotify API calls required.
//
// If the user has previously authenticated with Spotify (token stored by
// auth.js), we show track metadata as a bonus — but we poll at a very slow
// rate (once per minute on demand) so we never hammer the endpoint.
//
// The old 3-second setInterval that caused ~4 k API calls/hour is gone.

import { redirectToSpotify, handleCallback, getAccessToken } from './auth.js';
import { getCurrentTrack } from './spotify.js';
import { AudioEngine } from './audio.js';
import { Visualizer } from './visualizer.js';
import { CatMode } from './catmode.js';

let audioEngine = new AudioEngine();
let visualizer  = null;
let catMode     = null;
let rafId       = null;

// ── Screen transitions ────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

// ── Track info overlay ────────────────────────────────────────────────────────

function setTrackInfo(track) {
  const info = document.getElementById('track-info');
  const idle = document.getElementById('not-playing');
  if (track?.name) {
    document.getElementById('song-name').textContent   = track.name;
    document.getElementById('artist-name').textContent = track.artist ?? '';
    info.classList.remove('hidden');
    idle.classList.add('hidden');
  } else {
    info.classList.add('hidden');
    idle.classList.remove('hidden');
  }
}

// ── Spotify metadata — single lazy fetch, no polling loop ────────────────────
//
// We fetch once when the visualizer starts, then again at most once per minute
// if the user is still connected to Spotify.  This replaces the old 3-second
// setInterval that was producing ~4 000 API calls per hour.

let _lastMetaFetchMs = 0;
const META_THROTTLE_MS = 60_000; // 1 fetch per minute at most

async function fetchTrackMeta() {
  try {
    const token = await getAccessToken();
    if (!token) return; // not logged in — skip silently
    const now = performance.now();
    if (now - _lastMetaFetchMs < META_THROTTLE_MS) return;
    _lastMetaFetchMs = now;
    const data = await getCurrentTrack();
    if (data?.item) {
      setTrackInfo({
        name:   data.item.name,
        artist: data.item.artists.map(a => a.name).join(', '),
      });
      catMode?.onTrackChange({ energy: 0.5 });
    }
    // If nothing is playing we just leave the overlay hidden — no need to clear.
  } catch {
    // Transient error or auth expired — silently skip; we never throw here.
  }
}

// ── Cat mode toggle ───────────────────────────────────────────────────────────

window.toggleCatMode = function () {
  const entering  = !catMode.active;
  const catCanvas = document.getElementById('cat-canvas');
  const btn       = document.getElementById('cat-mode-btn');

  if (entering) {
    catMode.enable();
    catCanvas.style.opacity = '1';
  } else {
    catMode.disable();
    catCanvas.style.opacity = '0';
  }

  if (btn) {
    btn.textContent = entering ? '🐾 Cats: ON' : '🐾 Cats: OFF';
    btn.classList.toggle('active', entering);
  }
};

window.setCatCount = function (n) {
  catMode.setCatCount(n);
};

// ── RAF loop ──────────────────────────────────────────────────────────────────

let _bpmDisplayTs   = 0;
let _metaRefreshTs  = 0;

function startRaf() {
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    const freq     = audioEngine.getFrequencyData();
    const time     = audioEngine.getTimeDomainData();
    const beatInfo = audioEngine.getBeatInfo();

    visualizer.draw(freq, time, ts, beatInfo);
    catMode.tick(ts, beatInfo);

    // BPM display — update at most once per second
    if (ts - _bpmDisplayTs > 1000) {
      _bpmDisplayTs = ts;
      const el = document.getElementById('bpm-display');
      if (el) el.textContent = `${beatInfo.bpm} BPM`;
    }

    // Track metadata — refresh at most once per minute (no busy polling)
    if (ts - _metaRefreshTs > META_THROTTLE_MS) {
      _metaRefreshTs = ts;
      fetchTrackMeta();
    }
  }
  rafId = requestAnimationFrame(loop);
}

function stopRaf() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// ── Tab audio capture ─────────────────────────────────────────────────────────

function resetCaptureBtn() {
  const btn = document.getElementById('start-capture-btn');
  btn.disabled    = false;
  btn.textContent = 'Share Tab Audio';
}

async function startCapture() {
  const btn = document.getElementById('start-capture-btn');
  const err = document.getElementById('capture-error');

  btn.disabled    = true;
  btn.textContent = 'Opening…';
  err.hidden      = true;

  // Neutralise any previous onStopped handler before calling stop(),
  // since track.stop() fires the ended event synchronously.
  audioEngine.onStopped = null;
  audioEngine.stop();

  try {
    await audioEngine.start();

    audioEngine.onStopped = () => {
      stopRaf();
      showScreen('capture-screen');
      resetCaptureBtn();
    };

    // Lazy-fetch track info once right as the visualizer opens (if logged in)
    _metaRefreshTs = -META_THROTTLE_MS; // force immediate fetch on first RAF tick
    showScreen('visualizer-screen');
    startRaf();
  } catch (e) {
    if (e.message === 'NO_AUDIO') {
      err.textContent = 'You need to tick "Share tab audio" in the popup. Click to try again.';
    } else if (e.name === 'NotAllowedError') {
      err.textContent = 'Cancelled. Click to try again.';
    } else {
      err.textContent = `Could not start capture: ${e.message}. Click to try again.`;
    }
    err.hidden = false;
    resetCaptureBtn();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
//
// Flow:
//   1. Spotify OAuth callback (?code=…) → store token → capture screen
//   2. Anything else → capture screen directly (no login required)
//
// The old "show login-screen by default" behaviour is removed.  Spotify login
// is now reached only via the optional "Connect Spotify" link in the UI.

async function init() {
  const vizCanvas = document.getElementById('visualizer-canvas');
  const catCanvas = document.getElementById('cat-canvas');

  visualizer = new Visualizer(vizCanvas);
  catMode    = new CatMode(catCanvas);

  document.getElementById('start-capture-btn')
    .addEventListener('click', startCapture);

  // Optional Spotify connect button (may not exist if HTML is simplified)
  document.getElementById('spotify-login-btn')
    ?.addEventListener('click', () => redirectToSpotify());

  const params = new URLSearchParams(window.location.search);

  if (params.has('code') || params.has('error')) {
    // Returning from Spotify OAuth — complete the exchange then go to capture.
    try {
      await handleCallback();
    } catch (err) {
      console.error('Spotify auth callback failed:', err);
    }
    // Clean the URL so a refresh doesn't re-run the callback
    history.replaceState({}, '', window.location.pathname);
  }

  // Everyone lands on the capture screen — no login wall.
  showScreen('capture-screen');
}

document.addEventListener('DOMContentLoaded', init);
