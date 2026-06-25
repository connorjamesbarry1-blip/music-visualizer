import { redirectToSpotify, handleCallback } from './auth.js';
import { startPolling, stopPolling } from './spotify.js';
import { Visualizer } from './visualizer.js';
import { CatMode } from './catmode.js';

let visualizer = null;
let catMode    = null;

// ── Screen transitions ────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

// ── Track info overlay ────────────────────────────────────────────────────────

function setTrackInfo(track) {
  const info = document.getElementById('track-info');
  const idle = document.getElementById('not-playing');

  if (track) {
    document.getElementById('song-name').textContent = track.name;
    document.getElementById('artist-name').textContent =
      track.artists.map(a => a.name).join(', ');
    info.classList.remove('hidden');
    idle.classList.add('hidden');
  } else {
    info.classList.add('hidden');
    idle.classList.remove('hidden');
  }
}

// ── Polling callbacks ─────────────────────────────────────────────────────────

function onTrackChange(track, analysis, features) {
  setTrackInfo(track);
  visualizer.setTrack(track, analysis, features);
  catMode.onTrackChange(features);
}

function onPlaybackState(data) {
  if (data?.item) {
    visualizer.updatePlayback(data.progress_ms, data.is_playing);
  } else {
    visualizer.updatePlayback(0, false);
  }
}

function onAuthError() {
  stopPolling();
  visualizer.stop();
  showScreen('login-screen');
}

// ── Cat mode toggle ───────────────────────────────────────────────────────────
// Exposed as window.toggleCatMode so the inline panel script (which loads
// before this module) can wire the button click.

window.toggleCatMode = function () {
  const entering  = !catMode.active;
  const vizCanvas = document.getElementById('visualizer-canvas');
  const catCanvas = document.getElementById('cat-canvas');
  const btn       = document.getElementById('cat-mode-btn');

  if (entering) {
    catMode.enable();
    vizCanvas.style.opacity       = '0';
    catCanvas.style.opacity       = '1';
    catCanvas.style.pointerEvents = 'auto';
  } else {
    catMode.disable();
    vizCanvas.style.opacity       = '';
    catCanvas.style.opacity       = '0';
    catCanvas.style.pointerEvents = 'none';
  }

  if (btn) {
    btn.textContent = entering ? '🐾 Cats: ON' : '🐾 Cats: OFF';
    btn.classList.toggle('active', entering);
  }
};

// ── Entry point ───────────────────────────────────────────────────────────────

async function init() {
  const vizCanvas = document.getElementById('visualizer-canvas');
  const catCanvas = document.getElementById('cat-canvas');

  visualizer = new Visualizer(vizCanvas);
  catMode    = new CatMode(catCanvas);

  // Forward detected beats from the visualizer RAF loop to cat mode
  visualizer.beatCallback = (confidence, energy) => catMode.onBeat(energy);

  const params = new URLSearchParams(window.location.search);

  if (params.has('code') || params.has('error')) {
    try {
      const ok = await handleCallback();
      if (ok) {
        enterVisualizer();
        return;
      }
    } catch (err) {
      console.error('Auth callback failed:', err);
      // Fall through to login
    }
  }

  showScreen('login-screen');
  document.getElementById('login-btn').addEventListener('click', () => {
    redirectToSpotify();
  });
}

function enterVisualizer() {
  showScreen('visualizer-screen');
  visualizer.start();
  startPolling(onTrackChange, onPlaybackState, onAuthError);
}

document.addEventListener('DOMContentLoaded', init);
