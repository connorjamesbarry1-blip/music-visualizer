import { redirectToSpotify, handleCallback, getAccessToken } from './auth.js';
import { AudioEngine } from './audio.js';
import { Visualizer } from './visualizer.js';
import { CatMode } from './catmode.js';

let audioEngine = null;
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

// ── Cat mode toggle ───────────────────────────────────────────────────────────
// Exposed on window so the inline panel script can wire the button click.

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

// ── Playback control delegates ────────────────────────────────────────────────
// Panel script wires the playback bar buttons to these window functions.

window.playbackPrev   = () => audioEngine?.previousTrack();
window.playbackPlay   = () => {
  if (!audioEngine) return;
  if (audioEngine.isPaused) audioEngine.play();
  else audioEngine.pause();
};
window.playbackNext   = () => audioEngine?.nextTrack();
window.playbackVolume = (v) => audioEngine?.setVolume(v);

// ── RAF loop ──────────────────────────────────────────────────────────────────

function startRaf() {
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (!audioEngine) return;
    visualizer.draw(
      audioEngine.getFrequencyData(),
      audioEngine.getTimeDomainData(),
      ts,
    );
  }
  rafId = requestAnimationFrame(loop);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init() {
  const vizCanvas = document.getElementById('visualizer-canvas');
  const catCanvas = document.getElementById('cat-canvas');

  visualizer = new Visualizer(vizCanvas);
  catMode    = new CatMode(catCanvas);

  visualizer.beatCallback = (confidence, energy) => catMode.onBeat(energy);

  const params = new URLSearchParams(window.location.search);

  if (params.has('code') || params.has('error')) {
    try {
      const ok = await handleCallback();
      if (ok) { await enterVisualizer(); return; }
    } catch (err) {
      console.error('Auth callback failed:', err);
    }
  }

  showScreen('login-screen');
  document.getElementById('login-btn').addEventListener('click', () => {
    redirectToSpotify();
  });
}

async function enterVisualizer() {
  showScreen('visualizer-screen');

  audioEngine = new AudioEngine();

  audioEngine.onTrackChange = (track) => {
    setTrackInfo(track);
    catMode.onTrackChange({ energy: 0.5 });
  };

  audioEngine.onPlayStateChange = (paused) => {
    const btn = document.getElementById('pb-play');
    if (btn) btn.textContent = paused ? '⏯' : '⏸';
  };

  try {
    // Pass a getter so the SDK can request a fresh token at any time.
    await audioEngine.init(() => getAccessToken());
  } catch (err) {
    console.error('AudioEngine init failed:', err);
  }

  startRaf();
}

document.addEventListener('DOMContentLoaded', init);
