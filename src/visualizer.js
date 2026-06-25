// ── Constants ─────────────────────────────────────────────────────────────────

const BAR_COUNT   = 80;
const BAR_MIN     = 4;
const BAR_MAX     = 130;
const ART_RADIUS  = 110;              // album art circle radius (px)
const BAR_INNER   = ART_RADIUS + 18; // bars radiate outward from this radius
const BAR_WIDTH   = 3;
const DEFAULT_HUE = 141;             // Spotify green starting hue

// ── Small utilities ───────────────────────────────────────────────────────────

/**
 * Return the index of the last item whose .start <= positionSeconds.
 * Used to find the current beat / bar / section.
 */
function findCurrentIndex(items, posSec) {
  if (!items?.length) return -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (posSec >= items[i].start) return i;
  }
  return -1;
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ── Visualizer ────────────────────────────────────────────────────────────────

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    // Current track data
    this.track    = null;
    this.analysis = null;   // from /audio-analysis — may be null (non-premium)
    this.features = null;   // from /audio-features

    // Album art
    this.artImage = null;
    this.artUrl   = null;

    // Playback position reference — updated every poll cycle (every 2 s).
    // Between updates we advance by wall-clock time.
    this.progressMs = 0;
    this.syncedAt   = 0;    // performance.now() value when progressMs was set
    this.isPlaying  = false;

    // Beat animation
    this.beatPulse    = 0;  // 0–1, decays over time
    this.lastBeatIdx  = -1;
    this.lastBarIdx   = -1;
    this.lastSectIdx  = -1;

    // Per-bar random seeds — stable per Visualizer instance, refreshed on
    // new track so the pattern changes between songs.
    this.barFreq      = new Float32Array(BAR_COUNT);
    this.barPhase     = new Float32Array(BAR_COUNT);
    this.barVariation = new Float32Array(BAR_COUNT);
    this._seedBars();

    // Smoothed heights (actual) vs targets
    this.barHeights = new Float32Array(BAR_COUNT).fill(BAR_MIN);
    this.barTargets = new Float32Array(BAR_COUNT).fill(BAR_MIN);

    // Expanding ring pulses spawned on each beat: [{ r, opacity, hue }]
    this.rings = [];

    // Smoothly-interpolated colour values
    this.hue          = DEFAULT_HUE;
    this.targetHue    = DEFAULT_HUE;
    this.saturation   = 70;
    this.targetSat    = 70;
    this.bgLightness  = 5;
    this.targetBgL    = 5;

    this._rafId   = null;
    this._lastTs  = 0;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
  }

  // ── Public interface ────────────────────────────────────────────────────────

  /**
   * Call when the playing track changes (including when nothing is playing).
   * track / analysis / features may all be null.
   */
  setTrack(track, analysis, features) {
    this.track    = track;
    this.analysis = analysis;
    this.features = features;

    // Reset beat state for the new track
    this.beatPulse   = 0;
    this.lastBeatIdx = -1;
    this.lastBarIdx  = -1;
    this.lastSectIdx = -1;
    this.rings       = [];

    this._seedBars(); // fresh random per-bar variation

    // Derive target colours from audio features
    if (features) {
      // valence (happiness) → hue: 0 = blue/sad (240°), 1 = yellow/happy (60°)
      this.targetHue = 240 - features.valence * 180;
      // energy → saturation and background darkness
      this.targetSat = 40 + features.energy * 55;
      this.targetBgL = 4  + features.energy * 6;
    } else {
      this.targetHue = DEFAULT_HUE;
      this.targetSat = 70;
      this.targetBgL = 5;
    }

    // Load album art (only when the URL actually changes)
    const url = track?.album?.images?.[0]?.url ?? null;
    if (url !== this.artUrl) {
      this.artUrl   = url;
      this.artImage = null;
      if (url) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { this.artImage = img; };
        img.src = url;
      }
    }
  }

  /**
   * Called every poll cycle to keep our playback position in sync.
   * Between calls we interpolate using wall-clock time.
   */
  updatePlayback(progressMs, isPlaying) {
    this.progressMs = progressMs;
    this.syncedAt   = performance.now();
    this.isPlaying  = isPlaying;
  }

  start() {
    if (this._rafId) return;
    this._lastTs = performance.now();
    this._rafId  = requestAnimationFrame(ts => this._loop(ts));
  }

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    window.removeEventListener('resize', this._onResize);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  _seedBars() {
    for (let i = 0; i < BAR_COUNT; i++) {
      this.barFreq[i]      = 0.3 + Math.random() * 0.8;  // 0.3–1.1 Hz ambient sway
      this.barPhase[i]     = Math.random() * Math.PI * 2;
      this.barVariation[i] = 0.5 + Math.random() * 0.5;  // relative spike height
    }
  }

  /** Estimated current playback position in milliseconds. */
  _posMs() {
    if (!this.isPlaying) return this.progressMs;
    return this.progressMs + (performance.now() - this.syncedAt);
  }

  _loop(ts) {
    this._rafId = requestAnimationFrame(t => this._loop(t));
    const dt = Math.min((ts - this._lastTs) / 1000, 0.1); // seconds; cap at 100 ms
    this._lastTs = ts;
    this._update(dt, ts);
    this._draw();
  }

  _update(dt, ts) {
    const posSec = this._posMs() / 1000;
    const tWall  = ts / 1000; // wall-clock seconds (for ambient oscillation)

    // ── Beat detection (from audio analysis or synthetic fallback) ────────────

    if (this.analysis?.beats && this.isPlaying) {
      const idx = findCurrentIndex(this.analysis.beats, posSec);

      if (idx >= 0 && idx !== this.lastBeatIdx) {
        this.lastBeatIdx = idx;
        const beat = this.analysis.beats[idx];

        // Pulse strength is scaled by the beat's own confidence value
        this.beatPulse = Math.max(this.beatPulse, beat.confidence);

        // Spawn an expanding ring at the art boundary
        this.rings.push({ r: BAR_INNER, opacity: 0.75, hue: this.hue });
      }

    } else if (this.features?.tempo && this.isPlaying) {
      // Synthetic beat for non-premium users (no audio analysis available)
      const period    = 60 / this.features.tempo;
      const beatPhase = (posSec % period) / period;
      if (beatPhase < 0.06) {
        const pulse = this.features.energy * (1 - beatPhase / 0.06);
        if (pulse > this.beatPulse) {
          this.beatPulse = pulse;
          this.rings.push({ r: BAR_INNER, opacity: 0.5, hue: this.hue });
        }
      }
    }

    // ── Bar-level colour shift (each bar ≈ one measure) ──────────────────────

    if (this.analysis?.bars) {
      const idx = findCurrentIndex(this.analysis.bars, posSec);
      if (idx >= 0 && idx !== this.lastBarIdx) {
        this.lastBarIdx = idx;
        // Nothing extra needed — beat handling above covers the animation.
      }
    }

    // ── Section-level background shift ───────────────────────────────────────

    if (this.analysis?.sections) {
      const idx = findCurrentIndex(this.analysis.sections, posSec);
      if (idx >= 0 && idx !== this.lastSectIdx) {
        this.lastSectIdx = idx;
        const sec       = this.analysis.sections[idx];
        // loudness_max runs roughly −60 to 0 dB; map to 0–1 intensity
        const intensity = Math.min(1, Math.max(0, (sec.loudness_max + 60) / 60));
        this.targetBgL  = 3 + intensity * 10;
      }
    }

    // ── Decay beat pulse ──────────────────────────────────────────────────────
    this.beatPulse = Math.max(0, this.beatPulse - dt * 5);

    // ── Advance / cull rings ──────────────────────────────────────────────────
    const ringMax = BAR_INNER + BAR_MAX + 70;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.r       += dt * 230;
      ring.opacity -= dt * 2.2;
      if (ring.opacity <= 0 || ring.r > ringMax) this.rings.splice(i, 1);
    }

    // ── Bar target heights ────────────────────────────────────────────────────
    for (let i = 0; i < BAR_COUNT; i++) {
      // Gentle organic ambient sway — each bar at its own frequency / phase
      const ambient = 5 + 9 * (Math.sin(tWall * this.barFreq[i] + this.barPhase[i]) * 0.5 + 0.5);

      // Beat spike — each bar has slightly different height via barVariation
      const spike = (BAR_MAX - BAR_MIN) * this.beatPulse * this.barVariation[i];

      this.barTargets[i] = BAR_MIN + ambient + spike;
    }

    // ── Smooth bar heights toward targets ─────────────────────────────────────
    const lerpT = Math.min(1, dt * 10);
    for (let i = 0; i < BAR_COUNT; i++) {
      this.barHeights[i] = lerp(this.barHeights[i], this.barTargets[i], lerpT);
    }

    // ── Smooth colour transitions ─────────────────────────────────────────────
    const cLerp = Math.min(1, dt * 0.8);
    this.hue         = lerp(this.hue,         this.targetHue, cLerp);
    this.saturation  = lerp(this.saturation,  this.targetSat, cLerp);
    this.bgLightness = lerp(this.bgLightness, this.targetBgL, cLerp);
  }

  _draw() {
    const { ctx, canvas, hue, saturation, bgLightness, beatPulse } = this;
    const W  = canvas.width;
    const H  = canvas.height;
    const cx = W / 2;
    const cy = H / 2;

    // ── Background ────────────────────────────────────────────────────────────
    ctx.fillStyle = `hsl(${hue}, 15%, ${bgLightness}%)`;
    ctx.fillRect(0, 0, W, H);

    // Subtle warm radial bloom from centre
    const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.65);
    bloom.addColorStop(0, `hsla(${hue}, 35%, ${bgLightness + 7}%, 0.4)`);
    bloom.addColorStop(1, 'transparent');
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, W, H);

    // ── Radial bars ───────────────────────────────────────────────────────────
    const barLightness = 45 + beatPulse * 22;
    const barAlpha     = 0.78 + beatPulse * 0.17;

    ctx.save();
    ctx.translate(cx, cy);

    for (let i = 0; i < BAR_COUNT; i++) {
      const angle     = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
      const h         = this.barHeights[i];
      const hueShift  = (i / BAR_COUNT) * 28 - 14; // ±14° shimmer across the ring

      ctx.save();
      ctx.rotate(angle);

      // Gradient: solid at root, fades at tip
      const grad = ctx.createLinearGradient(0, BAR_INNER, 0, BAR_INNER + h);
      grad.addColorStop(0,   `hsla(${hue + hueShift},      ${saturation}%,      ${barLightness}%,      ${barAlpha})`);
      grad.addColorStop(0.6, `hsla(${hue + hueShift + 12}, ${saturation + 8}%,  ${barLightness + 12}%, ${barAlpha * 0.55})`);
      grad.addColorStop(1,   `hsla(${hue + hueShift + 25}, ${saturation}%,      ${barLightness + 20}%, 0)`);

      ctx.fillStyle = grad;
      ctx.fillRect(-BAR_WIDTH / 2, BAR_INNER, BAR_WIDTH, h);

      ctx.restore();
    }

    ctx.restore();

    // ── Expanding beat rings ──────────────────────────────────────────────────
    for (const ring of this.rings) {
      ctx.beginPath();
      ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${ring.hue}, ${saturation + 20}%, 72%, ${ring.opacity})`;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    // ── Glow halo around the art circle ──────────────────────────────────────
    const glowA   = 0.28 + beatPulse * 0.48;
    const glowOut = ctx.createRadialGradient(cx, cy, ART_RADIUS - 6, cx, cy, ART_RADIUS + 44);
    glowOut.addColorStop(0, `hsla(${hue}, ${saturation + 20}%, 68%, ${glowA})`);
    glowOut.addColorStop(1, 'transparent');
    ctx.fillStyle = glowOut;
    ctx.beginPath();
    ctx.arc(cx, cy, ART_RADIUS + 44, 0, Math.PI * 2);
    ctx.fill();

    // ── Album art circle ──────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, ART_RADIUS, 0, Math.PI * 2);
    ctx.clip();

    if (this.artImage) {
      ctx.drawImage(
        this.artImage,
        cx - ART_RADIUS, cy - ART_RADIUS,
        ART_RADIUS * 2,  ART_RADIUS * 2,
      );
    } else {
      // Placeholder: gradient disc with a music note
      const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, ART_RADIUS);
      disc.addColorStop(0, `hsl(${hue}, 28%, 22%)`);
      disc.addColorStop(1, `hsl(${hue}, 22%, 10%)`);
      ctx.fillStyle = disc;
      ctx.fillRect(cx - ART_RADIUS, cy - ART_RADIUS, ART_RADIUS * 2, ART_RADIUS * 2);

      ctx.fillStyle    = `hsla(${hue}, 40%, 65%, 0.3)`;
      ctx.font         = `${ART_RADIUS * 0.58}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♪', cx, cy);
    }

    ctx.restore();

    // Beat shimmer on art border
    if (beatPulse > 0.04) {
      ctx.beginPath();
      ctx.arc(cx, cy, ART_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue}, 90%, 88%, ${beatPulse * 0.5})`;
      ctx.lineWidth   = 4;
      ctx.stroke();
    }
  }
}
