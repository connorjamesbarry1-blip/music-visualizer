// app.js — entry point.
//
// The visualizer works entirely via browser tab-audio capture
// (getDisplayMedia).  No external API calls required.

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
    btn.textContent = entering ? '🐾 Party: ON' : '🐾 Party: OFF';
    btn.classList.toggle('active', entering);
  }
};

window.setCatCount = function (n) {
  catMode.setCatCount(n);
};

window.setCatDance = function (type) {
  catMode.setDanceType(type);
};

window.toggleCatRoam = function () {
  const entering = !catMode._roaming;
  catMode.setRoaming(entering);
  const btn = document.getElementById('cat-roam-btn');
  if (btn) {
    btn.textContent = entering ? '🚶 Roam: ON' : '🚶 Roam: OFF';
    btn.classList.toggle('active', entering);
  }
};

window.setCatSpeed = function (pct) {
  catMode.setRoamSpeed(pct);
};

// ── RAF loop ──────────────────────────────────────────────────────────────────

let _bpmDisplayTs = 0;

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

  // Everyone lands on the capture screen.
  showScreen('capture-screen');
}

document.addEventListener('DOMContentLoaded', init);
