// iTunes-style abstract music visualizer
// Technique: partial-fade canvas (no full clear) so every drawn element
// leaves a decaying trail automatically — no explicit trail bookkeeping.

const TWO_PI        = Math.PI * 2;
const SYMMETRY      = 6;          // kaleidoscope fold count
const CURVE_STEPS   = 1500;       // parametric resolution per Lissajous curve
const CURVE_PERIOD  = Math.PI * 10; // 5 full parametric cycles → complex patterns
const MAX_PARTICLES = 450;

// ── Utilities ─────────────────────────────────────────────────────────────────

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

    // Spotify data
    this.track    = null;
    this.analysis = null;
    this.features = null;

    // Playback sync — progressMs is set on every poll; we interpolate between polls.
    this.progressMs = 0;
    this.syncedAt   = performance.now();
    this.isPlaying  = false;

    // Beat state
    this.lastBeatIdx  = -1;
    this.lastSectIdx  = -1;
    this.lastSynthBeat = -1;  // beat index for synthetic (non-premium) detection
    this.beatPulse    = 0;    // 0–1, decays each frame
    this.curveBright  = 0;    // brief boost to curve brightness on beat

    // Audio-visual params (set from features, updated on track change)
    this.energy    = 0.35;
    this.valence   = 0.5;
    this.sectionIntensity       = 0.7;
    this.targetSectionIntensity = 0.7;

    // Hue — cycles continuously, shifted by valence
    this.hue = Math.random() * 360;

    // Three Lissajous curves with slowly drifting parameters.
    // x(t) = amp * sin(a*t + phase),  y(t) = amp * sin(b*t)
    // aRate / bRate: how fast a and b drift (units / second); reversed at bounds.
    this.curves = [
      { a: 3.0, b: 2.0, phase: 0,            phaseSpeed:  0.40, aRate:  0.10, bRate:  0.08 },
      { a: 5.0, b: 4.0, phase: TWO_PI / 3,   phaseSpeed: -0.32, aRate: -0.08, bRate:  0.11 },
      { a: 7.0, b: 6.0, phase: TWO_PI * 2/3, phaseSpeed:  0.25, aRate:  0.06, bRate: -0.09 },
    ];

    // Particles — live positions (kaleidoscope handles visual copies)
    this.particles = [];

    // Shockwave rings spawned on each beat
    this.shockwaves = [];

    this._rafId  = null;
    this._lastTs = 0;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
  }

  // ── Public interface ────────────────────────────────────────────────────────

  setTrack(track, analysis, features) {
    this.track    = track;
    this.analysis = analysis;
    this.features = features;

    this.lastBeatIdx = -1;
    this.lastSectIdx = -1;
    this.shockwaves  = [];

    // Seed synthetic-beat tracker at current position to avoid a spurious
    // immediate fire the first time _update runs after a track change.
    if (features?.tempo && track) {
      const period = 60 / features.tempo;
      this.lastSynthBeat = Math.floor(this._posMs() / 1000 / period);
    } else {
      this.lastSynthBeat = -1;
    }

    if (features) {
      this.energy  = features.energy;
      this.valence = features.valence;
    } else if (!track) {
      // Idle: soft defaults
      this.energy  = 0.3;
      this.valence = 0.5;
    }
  }

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

  /** Estimated playback position in ms, interpolated since last poll. */
  _posMs() {
    if (!this.isPlaying) return this.progressMs;
    return this.progressMs + (performance.now() - this.syncedAt);
  }

  _loop(ts) {
    this._rafId = requestAnimationFrame(t => this._loop(t));
    const dt = Math.min((ts - this._lastTs) / 1000, 0.1); // cap at 100 ms
    this._lastTs = ts;
    this._update(dt);
    this._draw();
  }

  _update(dt) {
    const isActive = !!(this.isPlaying && this.track);
    const posSec   = this._posMs() / 1000;

    // ── Hue cycling ──────────────────────────────────────────────────────────
    // Faster when something energetic is playing.
    const hueSpeed = isActive ? 18 + this.energy * 15 : 5;
    this.hue = (this.hue + hueSpeed * dt) % 360;

    // ── Beat detection from Spotify audio analysis ────────────────────────────
    if (isActive && this.analysis?.beats) {
      const idx = findCurrentIndex(this.analysis.beats, posSec);
      if (idx >= 0 && idx !== this.lastBeatIdx) {
        this.lastBeatIdx = idx;
        this._onBeat(this.analysis.beats[idx].confidence);
      }
    }

    // ── Synthetic beats for non-premium accounts (no audio analysis) ──────────
    if (isActive && !this.analysis && this.features?.tempo) {
      const period   = 60 / this.features.tempo;
      const beatIdx  = Math.floor(posSec / period);
      if (beatIdx !== this.lastSynthBeat) {
        this.lastSynthBeat = beatIdx;
        this._onBeat(0.65 + this.energy * 0.25);
      }
    }

    // ── Section intensity from loudness_max ───────────────────────────────────
    if (isActive && this.analysis?.sections) {
      const idx = findCurrentIndex(this.analysis.sections, posSec);
      if (idx >= 0 && idx !== this.lastSectIdx) {
        this.lastSectIdx = idx;
        const sec       = this.analysis.sections[idx];
        // loudness_max runs roughly −60 dB (silent) to 0 dB (loud)
        const intensity = Math.min(1, Math.max(0, (sec.loudness_max + 60) / 60));
        this.targetSectionIntensity = 0.4 + intensity * 0.6;
      }
    }

    this.sectionIntensity = lerp(this.sectionIntensity, this.targetSectionIntensity, dt * 0.4);

    // ── Decay per-beat values ─────────────────────────────────────────────────
    this.beatPulse   = Math.max(0, this.beatPulse   - dt * 4.5);
    this.curveBright = Math.max(0, this.curveBright - dt * 2.5);

    // ── Drift Lissajous frequency params ─────────────────────────────────────
    for (const c of this.curves) {
      c.phase += c.phaseSpeed * dt;
      c.a     += c.aRate * dt;
      c.b     += c.bRate * dt;
      // Bounce at bounds to keep patterns interesting and avoid degeneracy
      if (c.a > 7.5 || c.a < 1.5) c.aRate *= -1;
      if (c.b > 6.5 || c.b < 1.5) c.bRate *= -1;
    }

    // ── Particles ─────────────────────────────────────────────────────────────
    // Frame-rate-independent drag: velocity multiplied by (drag)^(dt*60) each frame.
    const drag = Math.pow(0.92, dt * 60);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p  = this.particles[i];
      p.x     += p.vx * dt;
      p.y     += p.vy * dt;
      p.vx    *= drag;
      p.vy    *= drag;
      p.life  -= p.decay * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    // ── Shockwaves ────────────────────────────────────────────────────────────
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw     = this.shockwaves[i];
      sw.r        += sw.speed * dt;
      sw.opacity  -= dt * 1.8;
      if (sw.opacity <= 0) this.shockwaves.splice(i, 1);
    }
  }

  _onBeat(confidence) {
    this.beatPulse   = Math.max(this.beatPulse,   confidence);
    this.curveBright = confidence;

    // Only burst particles when actively playing (not in idle mode)
    if (this.isPlaying && this.track) {
      const count = Math.floor(28 + confidence * 20 + this.energy * 12);
      this._spawnParticles(count);
    }

    // Shockwave ring — expands and fades over ~0.5 s
    this.shockwaves.push({
      r:       0,
      speed:   260 + this.energy * 190,
      opacity: 0.78 * confidence,
      hue:     this.hue,
    });
  }

  _spawnParticles(count) {
    const available = MAX_PARTICLES - this.particles.length;
    if (available <= 0) return;
    const n = Math.min(count, available);

    for (let i = 0; i < n; i++) {
      const angle = Math.random() * TWO_PI;
      const speed = 65 + Math.random() * 210 * (0.4 + this.energy * 0.6);
      this.particles.push({
        x:     0,
        y:     0,
        vx:    Math.cos(angle) * speed,
        vy:    Math.sin(angle) * speed,
        life:  1,
        decay: 0.38 + Math.random() * 0.48,
        size:  1.4 + Math.random() * 3.0,
        hue:   (this.hue + (Math.random() - 0.5) * 70 + 360) % 360,
      });
    }
  }

  _draw() {
    const { ctx, canvas } = this;
    const W  = canvas.width;
    const H  = canvas.height;
    const cx = W / 2;
    const cy = H / 2;

    const isActive = !!(this.isPlaying && this.track);

    // ── Partial fade — the core of the trail system ───────────────────────────
    // Instead of clearing the canvas, we lay a semi-transparent black over it.
    // Everything drawn this frame persists into the next, fading by `fadeAlpha`
    // each frame. High energy → faster fade → snappier short trails.
    const fadeAlpha = isActive ? 0.042 + this.energy * 0.065 : 0.025;
    ctx.fillStyle   = `rgba(0, 0, 0, ${fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    // ── Derived colour values ─────────────────────────────────────────────────
    // Valence: positive → warmer (+50° toward yellow/orange)
    //          negative → cooler (−50° toward blue/purple)
    const valenceShift = (this.valence - 0.5) * 100;
    const dHue = (this.hue + valenceShift + 360) % 360;

    // Amplitude: fraction of the shorter screen dimension
    const baseR = Math.min(W, H) * 0.40;
    const amp   = baseR * (isActive
      ? (0.55 + this.energy * 0.45) * this.sectionIntensity
      : 0.30);

    // Saturation and lightness driven by energy, boosted briefly on beat
    const sat       = isActive ? 55 + this.energy * 40 : 28;
    const light     = isActive ? 36 + this.energy * 22 + this.curveBright * 26 : 20;
    const cAlpha    = isActive ? 0.48 + this.curveBright * 0.34 : 0.24;
    const lineWidth = 1.3 + this.beatPulse * 2.2;

    // ── Kaleidoscope: draw into SYMMETRY rotated + mirrored slices ─────────────
    // All drawing is done in canvas-space centred on (cx, cy).
    // Alternating slices are reflected on the Y axis — this gives a true mirror
    // effect rather than pure rotation, matching the classic iTunes look.
    ctx.save();
    ctx.translate(cx, cy);

    for (let sym = 0; sym < SYMMETRY; sym++) {
      ctx.save();
      ctx.rotate((sym / SYMMETRY) * TWO_PI);
      if (sym % 2 === 1) ctx.scale(1, -1);

      // ── Three Lissajous curves ──────────────────────────────────────────────
      // Each rendered at a 45° hue offset for harmonic colour spread.
      this.curves.forEach((c, ci) => {
        const cHue = (dHue + ci * 45) % 360;

        ctx.beginPath();
        for (let i = 0; i <= CURVE_STEPS; i++) {
          const t = (i / CURVE_STEPS) * CURVE_PERIOD;
          const x = amp * Math.sin(c.a * t + c.phase);
          const y = amp * Math.sin(c.b * t);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${cHue}, ${sat}%, ${light}%, ${cAlpha})`;
        ctx.lineWidth   = lineWidth;
        ctx.stroke();
      });

      // ── Particles ───────────────────────────────────────────────────────────
      // Each particle lives at one (x,y); the kaleidoscope loop renders SYMMETRY
      // rotated copies automatically. Trails are left by the canvas fade above.
      const pLight = 58 + this.energy * 22;
      for (const p of this.particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, TWO_PI);
        ctx.fillStyle = `hsla(${p.hue}, 88%, ${pLight}%, ${p.life * 0.92})`;
        ctx.fill();
      }

      ctx.restore();
    }

    ctx.restore(); // remove the centre translation

    // ── Shockwave rings ───────────────────────────────────────────────────────
    // Drawn directly in screen space — they're already circles, no need to
    // replicate them through the kaleidoscope.
    for (const sw of this.shockwaves) {
      ctx.beginPath();
      ctx.arc(cx, cy, sw.r, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${sw.hue}, 90%, 76%, ${sw.opacity})`;
      ctx.lineWidth   = 2.5;
      ctx.stroke();
    }
  }
}
