// iTunes-style abstract music visualizer — settings-driven
// Technique: partial-fade canvas (no full clear) so every drawn element
// leaves a decaying trail. window.VIZ_SETTINGS is written by the control
// panel (panel script in index.html) and read here on every frame.

const TWO_PI       = Math.PI * 2;
const CURVE_STEPS  = 1500;
const CURVE_PERIOD = Math.PI * 10; // 5 parametric cycles → complex patterns
const MAX_PARTICLES = 200;

// Safe fallback — the panel script runs first and sets these,
// but ??= ensures we never crash if the module loads in isolation.
window.VIZ_SETTINGS ??= {
  fadeAlpha:  0.09,
  curveCount: 2,
  symmetry:   6,
  colorMode:  'cycle',
  particles:  'low',
  reactivity: 0.7,
};

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

    this.track    = null;
    this.analysis = null;
    this.features = null;

    // Playback sync
    this.progressMs = 0;
    this.syncedAt   = performance.now();
    this.isPlaying  = false;

    // Beat tracking
    this.lastBeatIdx   = -1;
    this.lastSectIdx   = -1;
    this.lastSynthBeat = -1;
    this.beatPulse     = 0;
    this.curveBright   = 0;

    // Audio-derived visual state
    this.energy    = 0.35;
    this.valence   = 0.5;
    this.sectionIntensity       = 0.7;
    this.targetSectionIntensity = 0.7;

    // Hue — increments every frame; colorMode controls how it maps to dHue
    this.hue = Math.random() * 360;

    // Three Lissajous curves. curveCount in settings controls how many are drawn.
    // x(t) = amp·sin(a·t + phase),  y(t) = amp·sin(b·t)
    // aRate / bRate drift slowly; they reverse at bounds so the pattern never
    // degenerates into a line or a circle.
    this.curves = [
      { a: 3.0, b: 2.0, phase: 0,            phaseSpeed:  0.40, aRate:  0.10, bRate:  0.08 },
      { a: 5.0, b: 4.0, phase: TWO_PI / 3,   phaseSpeed: -0.32, aRate: -0.08, bRate:  0.11 },
      { a: 7.0, b: 6.0, phase: TWO_PI * 2/3, phaseSpeed:  0.25, aRate:  0.06, bRate: -0.09 },
    ];

    this.particles = [];
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

  _posMs() {
    if (!this.isPlaying) return this.progressMs;
    return this.progressMs + (performance.now() - this.syncedAt);
  }

  _loop(ts) {
    this._rafId = requestAnimationFrame(t => this._loop(t));
    const dt = Math.min((ts - this._lastTs) / 1000, 0.1);
    this._lastTs = ts;
    this._update(dt);
    this._draw();
  }

  _update(dt) {
    const isActive = !!(this.isPlaying && this.track);
    const posSec   = this._posMs() / 1000;
    const s        = window.VIZ_SETTINGS;

    // Hue cycling — always increments; colorMode governs mapping to display hue
    const hueSpeed = isActive ? 18 + this.energy * 15 : 5;
    this.hue = (this.hue + hueSpeed * dt) % 360;

    // Beat detection from full Spotify audio analysis
    if (isActive && this.analysis?.beats) {
      const idx = findCurrentIndex(this.analysis.beats, posSec);
      if (idx >= 0 && idx !== this.lastBeatIdx) {
        this.lastBeatIdx = idx;
        this._onBeat(this.analysis.beats[idx].confidence);
      }
    }

    // Synthetic beats — fires when audio analysis is unavailable (non-premium)
    if (isActive && !this.analysis && this.features?.tempo) {
      const period  = 60 / this.features.tempo;
      const beatIdx = Math.floor(posSec / period);
      if (beatIdx !== this.lastSynthBeat) {
        this.lastSynthBeat = beatIdx;
        this._onBeat(0.65 + this.energy * 0.25);
      }
    }

    // Section-level amplitude from loudness
    if (isActive && this.analysis?.sections) {
      const idx = findCurrentIndex(this.analysis.sections, posSec);
      if (idx >= 0 && idx !== this.lastSectIdx) {
        this.lastSectIdx = idx;
        const sec       = this.analysis.sections[idx];
        const intensity = Math.min(1, Math.max(0, (sec.loudness_max + 60) / 60));
        this.targetSectionIntensity = 0.4 + intensity * 0.6;
      }
    }

    this.sectionIntensity = lerp(this.sectionIntensity, this.targetSectionIntensity, dt * 0.4);

    // Decay
    this.beatPulse   = Math.max(0, this.beatPulse   - dt * 4.5);
    this.curveBright = Math.max(0, this.curveBright - dt * 2.5);

    // Drift Lissajous params
    for (const c of this.curves) {
      c.phase += c.phaseSpeed * dt;
      c.a     += c.aRate * dt;
      c.b     += c.bRate * dt;
      if (c.a > 7.5 || c.a < 1.5) c.aRate *= -1;
      if (c.b > 6.5 || c.b < 1.5) c.bRate *= -1;
    }

    // Particles
    const drag = Math.pow(0.92, dt * 60);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x    += p.vx * dt;
      p.y    += p.vy * dt;
      p.vx   *= drag;
      p.vy   *= drag;
      p.life -= p.decay * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    // Shockwaves
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw    = this.shockwaves[i];
      sw.r       += sw.speed * dt;
      sw.opacity -= dt * 1.8;
      if (sw.opacity <= 0) this.shockwaves.splice(i, 1);
    }
  }

  _onBeat(confidence) {
    const s = window.VIZ_SETTINGS;
    const r = s.reactivity;

    this.beatPulse   = Math.max(this.beatPulse,   confidence * r);
    this.curveBright = Math.min(1, confidence * r);

    // Reactive color mode: hue jumps ~90-190° on each beat
    if (s.colorMode === 'reactive') {
      this.hue = (this.hue + 90 + Math.random() * 100) % 360;
    }

    // Particles — count scaled by level, confidence, and reactivity
    if (s.particles !== 'off' && this.isPlaying && this.track) {
      const base  = s.particles === 'high' ? 20 : 8;
      const count = Math.round(base * (0.5 + confidence * 0.5) * r);
      this._spawnParticles(count);
    }

    // Shockwave ring
    this.shockwaves.push({
      r:       0,
      speed:   (220 + this.energy * 150) * (0.5 + r * 0.5),
      opacity: Math.min(0.85, 0.72 * confidence * r),
      hue:     this.hue,
    });
  }

  _spawnParticles(count) {
    const available = MAX_PARTICLES - this.particles.length;
    if (available <= 0) return;
    const n = Math.min(count, available);

    for (let i = 0; i < n; i++) {
      const angle = Math.random() * TWO_PI;
      const speed = 65 + Math.random() * 200 * (0.4 + this.energy * 0.6);
      this.particles.push({
        x:     0,
        y:     0,
        vx:    Math.cos(angle) * speed,
        vy:    Math.sin(angle) * speed,
        life:  1,
        decay: 0.40 + Math.random() * 0.50,
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
    const s        = window.VIZ_SETTINGS;

    // ── Partial fade — foundation of the trail system ─────────────────────────
    // The settings fadeAlpha is what the user controls directly.
    // Idle mode uses a softer value regardless of the slider.
    const fadeAlpha = isActive ? s.fadeAlpha : Math.min(s.fadeAlpha, 0.03);
    ctx.fillStyle   = `rgba(0, 0, 0, ${fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    // ── Display hue — derived from colorMode ──────────────────────────────────
    let dHue;
    switch (s.colorMode) {
      case 'warm':
        // Oscillate within orange/yellow: 20° – 60°
        dHue = 40 + Math.sin(this.hue * 0.05) * 20;
        break;
      case 'cool':
        // Oscillate within blue/purple: 200° – 280°
        dHue = 240 + Math.sin(this.hue * 0.04) * 40;
        break;
      default:
        // 'cycle' or 'reactive': hue rotates freely, shifted by valence
        dHue = (this.hue + (this.valence - 0.5) * 100 + 360) % 360;
    }

    // ── Amplitude ─────────────────────────────────────────────────────────────
    const baseR = Math.min(W, H) * 0.40;
    const amp   = baseR * (isActive
      ? (0.55 + this.energy * 0.45) * this.sectionIntensity
      : 0.30);

    // ── Curve visual properties ───────────────────────────────────────────────
    const sat       = isActive ? 55 + this.energy * 40 : 28;
    const light     = isActive ? 36 + this.energy * 22 + this.curveBright * 26 : 20;
    const cAlpha    = isActive ? 0.50 + this.curveBright * 0.34 : 0.24;
    const lineWidth = 1.3 + this.beatPulse * 2.2;

    // ── Kaleidoscope — SYMMETRY rotated + alternately-mirrored slices ─────────
    const SYM          = s.symmetry;
    const activeCurves = this.curves.slice(0, s.curveCount);

    ctx.save();
    ctx.translate(cx, cy);

    for (let sym = 0; sym < SYM; sym++) {
      ctx.save();
      ctx.rotate((sym / SYM) * TWO_PI);
      if (sym % 2 === 1) ctx.scale(1, -1); // alternating reflection = true kaleidoscope

      // Lissajous curves — each at a 45° hue offset for harmonic colour spread
      activeCurves.forEach((c, ci) => {
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

      // Particles — each lives at one (x,y); symmetry produces SYM visual copies
      if (s.particles !== 'off') {
        const pLight = 58 + this.energy * 22;
        for (const p of this.particles) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * p.life, 0, TWO_PI);
          ctx.fillStyle = `hsla(${p.hue}, 88%, ${pLight}%, ${p.life * 0.92})`;
          ctx.fill();
        }
      }

      ctx.restore();
    }

    ctx.restore();

    // ── Shockwave rings — screen-space circles, no symmetry needed ─────────────
    for (const sw of this.shockwaves) {
      ctx.beginPath();
      ctx.arc(cx, cy, sw.r, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${sw.hue}, 90%, 76%, ${sw.opacity})`;
      ctx.lineWidth   = 2.5;
      ctx.stroke();
    }
  }
}
