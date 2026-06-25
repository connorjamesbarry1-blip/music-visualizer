import { redirectToSpotify, handleCallback } from './auth.js';
import { startPolling, stopPolling } from './spotify.js';
import { Visualizer } from './visualizer.js';

let visualizer = null;

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

// ── Entry point ───────────────────────────────────────────────────────────────

async function init() {
  visualizer = new Visualizer(document.getElementById('visualizer-canvas'));

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

  // Tokens are in-memory only, so every fresh page load needs a new login.
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
