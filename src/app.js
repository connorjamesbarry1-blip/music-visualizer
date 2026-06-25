import { redirectToSpotify, handleCallback } from './auth.js';
import { getCurrentTrack } from './spotify.js';
import { AudioEngine } from './audio.js';
import { Visualizer } from './visualizer.js';
import { CatMode } from './catmode.js';

let audioEngine = new AudioEngine();
let visualizer  = null;
let catMode     = null;
let rafId       = null;
let metaPollId  = null;

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

// ── Metadata poll — track name / artist via Spotify Web API ──────────────────

async function pollOnce() {
  try {
    const data = await getCurrentTrack();
    if (data?.item) {
      setTrackInfo({
        name:   data.item.name,
        artist: data.item.artists.map(a => a.name).join(', '),
      });
      catMode.onTrackChange({ energy: 0.5 });
    } else {
      setTrackInfo(null);
    }
  } catch { /* transient error — next tick will retry */ }
}

function startMetadataPoll() {
  pollOnce();
  metaPollId = setInterval(pollOnce, 3000);
}

function stopMetadataPoll() {
  clearInterval(metaPollId);
  metaPollId = null;
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

function startRaf() {
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    const freq     = audioEngine.getFrequencyData();
    const time     = audioEngine.getTimeDomainData();
    const beatInfo = audioEngine.getBeatInfo();
    // beatInfo already contains bass/mid/high — pass directly to visualizer
    visualizer.draw(freq, time, ts, beatInfo);
    catMode.tick(ts, beatInfo);
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

async function init() {
  const vizCanvas = document.getElementById('visualizer-canvas');
  const catCanvas = document.getElementById('cat-canvas');

  visualizer = new Visualizer(vizCanvas);
  catMode    = new CatMode(catCanvas);

  document.getElementById('start-capture-btn')
    .addEventListener('click', startCapture);

  const params = new URLSearchParams(window.location.search);

  if (params.has('code') || params.has('error')) {
    try {
      const ok = await handleCallback();
      if (ok) {
        startMetadataPoll();
        showScreen('capture-screen');
        return;
      }
    } catch (err) {
      console.error('Auth callback failed:', err);
    }
  }

  showScreen('login-screen');
  document.getElementById('login-btn').addEventListener('click', () => {
    redirectToSpotify();
  });
}

document.addEventListener('DOMContentLoaded', init);
