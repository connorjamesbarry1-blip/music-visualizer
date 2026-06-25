// FFT-driven music visualizer — 6 visualization modes.
// app.js calls draw(freqData, timeData, ts) every RAF frame.
// window.VIZ_SETTINGS is written by the panel script and read every frame.

const TWO_PI            = Math.PI * 2;
const CURVE_STEPS       = 1500;
const CURVE_PERIOD      = Math.PI * 10;
const MAX_LISS_PARTICLES = 200;
const BEAT_COOLDOWN_MS  = 200;

window.VIZ_SETTINGS ??= {
  fadeAlpha:  0.09,
  curveCount: 2,
  symmetry:   6,
  colorMode:  'cycle',
  particles:  'low',
  reactivity: 0.7,
  mode:       'spectrum',
};

function avgRange(buf, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i];
  return sum / (end - start);
}

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    this.hue          = Math.random() * 360;
    this.beatCallback = null;

    // Beat detection state
    this._bassHistory = new Float32Array(60);
    this._bassHistIdx = 0;
    this._lastBeatMs  = 0;
    this._beatPulse   = 0;
    this._lastTs      = 0;

    // Lissajous mode
    this.curves = [
      { a: 3.0, b: 2.0, phase: 0,           phaseSpeed:  0.40, aRate:  0.10, bRate:  0.08 },
      { a: 5.0, b: 4.0, phase: TWO_PI/3,    phaseSpeed: -0.32, aRate: -0.08, bRate:  0.11 },
      { a: 7.0, b: 6.0, phase: TWO_PI*2/3,  phaseSpeed:  0.25, aRate:  0.06, bRate: -0.09 },
    ];
    this._lissParticles = [];
    this._shockwaves    = [];

    // Particles mode pools
    this._bassParticles = [];
    this._midParticles  = [];
    this._highParticles = [];

    // Radial rotation accumulator
    this._radialAngle = 0;

    // Terrain offscreen buffer
    this._terrainBuf = document.createElement('canvas');
    this._terrainCtx = this._terrainBuf.getContext('2d');

    this._prevMode = null;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
  }

  stop() {
    window.removeEventListener('resize', this._onResize);
  }

  _resize() {
    const W = window.innerWidth, H = window.innerHeight;
    this.canvas.width  = W;
    this.canvas.height = H;
    this._terrainBuf.width  = W;
    this._terrainBuf.height = H;
    this._terrainCtx.fillStyle = '#000';
    this._terrainCtx.fillRect(0, 0, W, H);
  }

  // ── Main entry — called every RAF frame ────────────────────────────────────

  draw(freqData, timeData, ts, externalBands) {
    const dt = Math.min((ts - this._lastTs) / 1000, 0.1);
    this._lastTs = ts;

    const s    = window.VIZ_SETTINGS;
    const mode = s.mode ?? 'spectrum';

    // Prefer bands from the audio engine (Hz-accurate); fall back to bin-range estimate.
    const bands = externalBands ?? {
      bass: avgRange(freqData, 0,  6)   / 255,
      mid:  avgRange(freqData, 6,  94)  / 255,
      high: avgRange(freqData, 94, 256) / 255,
    };

    this.hue = (this.hue + (12 + bands.mid * 22) * dt) % 360;
    window.VIZ_HUE = this.hue;

    this._beatPulse = Math.max(0, this._beatPulse - dt * 4.5);

    const isBeat = this._detectBeat(bands);
    if (isBeat) {
      this._beatPulse = 1;
      if (this.beatCallback) this.beatCallback(1.0, bands.bass);
      this._shockwaves.push({ r: 0, speed: 260 + bands.bass * 180, opacity: 0.70, hue: this.hue });
      if (mode === 'lissajous') this._spawnLissParticles(bands, s);
    }

    for (let i = this._shockwaves.length - 1; i >= 0; i--) {
      const sw = this._shockwaves[i];
      sw.r       += sw.speed * dt;
      sw.opacity -= dt * 1.8;
      if (sw.opacity <= 0) this._shockwaves.splice(i, 1);
    }

    if (mode !== this._prevMode) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._terrainCtx.fillStyle = '#000';
      this._terrainCtx.fillRect(0, 0, this._terrainBuf.width, this._terrainBuf.height);
      if (mode === 'particles') {
        this._bassParticles = [];
        this._midParticles  = [];
        this._highParticles = [];
      }
      this._prevMode = mode;
    }

    switch (mode) {
      case 'spectrum':  this._drawSpectrum(freqData, bands, dt);  break;
      case 'waveform':  this._drawWaveform(timeData, bands);      break;
      case 'radial':    this._drawRadial(freqData, bands, dt);    break;
      case 'terrain':   this._drawTerrain(freqData);              break;
      case 'particles': this._drawParticlesMode(bands, dt);       break;
      case 'lissajous': this._drawLissajous(bands, dt);           break;
      default:          this._drawSpectrum(freqData, bands, dt);
    }
  }

  // ── Beat detection ─────────────────────────────────────────────────────────

  _detectBeat(bands) {
    this._bassHistory[this._bassHistIdx++ % 60] = bands.bass;
    let avg = 0;
    for (let i = 0; i < 60; i++) avg += this._bassHistory[i];
    avg /= 60;
    const now = performance.now();
    if (bands.bass > avg * 1.45 + 0.07 && (now - this._lastBeatMs) > BEAT_COOLDOWN_MS) {
      this._lastBeatMs = now;
      return true;
    }
    return false;
  }

  // Maps colorMode to a display hue
  _dHue() {
    const s = window.VIZ_SETTINGS;
    if (s.colorMode === 'warm') return 40  + Math.sin(this.hue * 0.05) * 20;
    if (s.colorMode === 'cool') return 240 + Math.sin(this.hue * 0.04) * 40;
    return this.hue;
  }

  // ── Mode 1: Spectrum ───────────────────────────────────────────────────────

  _drawSpectrum(freqData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const s = window.VIZ_SETTINGS;

    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    const BAR_COUNT = 128;
    const barW  = W / BAR_COUNT;
    const hue   = this._dHue();
    const pulse = 1 + this._beatPulse * 0.30;

    for (let i = 0; i < BAR_COUNT; i++) {
      const t      = i / BAR_COUNT;
      const binIdx = Math.floor(t * Math.min(freqData.length, 512) * 0.72);
      const val    = freqData[binIdx] / 255;
      const barH   = val * H * 0.88 * pulse;
      const barHue = (hue + t * 60) % 360;
      const light  = 28 + val * 44;

      let bx = i * barW, bw = barW - 1;
      if (i < 14 && bands.bass > 0.62) {
        const bloom = (bands.bass - 0.62) / 0.38;
        bw += bloom * barW * 1.4;
        bx -= bloom * barW * 0.7;
      }

      ctx.fillStyle = `hsla(${barHue},78%,${light}%,${0.52 + val * 0.48})`;
      ctx.fillRect(bx, H - barH, bw, barH);
    }
  }

  // ── Mode 2: Waveform ───────────────────────────────────────────────────────

  _drawWaveform(timeData, bands) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const s = window.VIZ_SETTINGS;

    ctx.fillStyle = `rgba(0,0,0,${Math.max(s.fadeAlpha, 0.055)})`;
    ctx.fillRect(0, 0, W, H);

    const len  = timeData.length;
    const midY = H / 2;
    const amp  = H * 0.36;
    const lw   = 2.5 + bands.bass * 4 + this._beatPulse * 2.5;
    const hue  = this._dHue();

    const drawLine = (yScale, opacity) => {
      ctx.beginPath();
      ctx.moveTo(0, midY + (timeData[0] / 128 - 1) * amp * yScale);
      for (let i = 1; i < len; i++) {
        const x  = (i / (len - 1)) * W;
        const y  = midY + (timeData[i]     / 128 - 1) * amp * yScale;
        const px = ((i - 1) / (len - 1)) * W;
        const py = midY + (timeData[i - 1] / 128 - 1) * amp * yScale;
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
      }
      ctx.lineTo(W, midY + (timeData[len - 1] / 128 - 1) * amp * yScale);
      ctx.strokeStyle = `hsla(${hue},84%,65%,${opacity})`;
      ctx.lineWidth   = lw;
      ctx.lineJoin    = 'round';
      ctx.stroke();
    };

    drawLine(-0.42, 0.28); // mirrored reflection
    drawLine(1,     0.88); // primary line
  }

  // ── Mode 3: Radial ─────────────────────────────────────────────────────────

  _drawRadial(freqData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;

    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    this._radialAngle = (this._radialAngle + 0.20 * dt) % TWO_PI;

    const hue    = this._dHue();
    const maxR   = Math.min(W, H) * 0.45;
    const innerR = maxR * 0.16;
    const pulse  = 1 + this._beatPulse * 0.22;
    const BARS   = 256;
    const sliceA = TWO_PI / BARS;

    for (let i = 0; i < BARS; i++) {
      const val = freqData[i] / 255;
      if (val < 0.015) continue;

      const startA = i * sliceA + this._radialAngle;
      const endA   = startA + sliceA;
      const outerR = Math.max(innerR + 1, (innerR + val * (maxR - innerR)) * pulse);
      const barHue = (hue + (i / BARS) * 80) % 360;
      const light  = 28 + val * 44;

      ctx.beginPath();
      ctx.arc(cx, cy, outerR,  startA, endA);
      ctx.arc(cx, cy, innerR,  endA, startA, true);
      ctx.closePath();
      ctx.fillStyle = `hsla(${barHue},76%,${light}%,${0.5 + val * 0.5})`;
      ctx.fill();
    }
  }

  // ── Mode 4: Terrain (spectrogram waterfall) ────────────────────────────────

  _drawTerrain(freqData) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const tc = this._terrainCtx;
    const tb = this._terrainBuf;

    // Shift existing data 2px left (source and dest are the same canvas — spec allows this)
    tc.drawImage(tb, -2, 0);

    // Draw new frequency column on right edge; bass at bottom, highs at top
    const BINS = Math.min(freqData.length, 256);
    const barH = H / BINS;

    for (let i = 0; i < BINS; i++) {
      const val = freqData[i] / 255;
      if (val < 0.015) {
        tc.fillStyle = '#040408';
      } else {
        const h = 260 - val * 190; // purple → cyan-green
        const s = 72 + val * 28;
        const l = 7  + val * 70;
        tc.fillStyle = `hsl(${h},${s}%,${l}%)`;
      }
      tc.fillRect(W - 3, H - (i + 1) * barH, 3, barH + 1);
    }

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(tb, 0, 0);
  }

  // ── Mode 5: Particles ──────────────────────────────────────────────────────

  _addParticle(pool, maxN, opts) {
    if (pool.length >= maxN) return;
    const a = Math.random() * TWO_PI;
    pool.push({
      x: opts.x, y: opts.y,
      vx:    Math.cos(a) * opts.speed + (opts.dvx ?? 0),
      vy:    Math.sin(a) * opts.speed + (opts.dvy ?? 0),
      gy:    opts.gy   ?? 0,
      life:  1,
      decay: opts.decay,
      size:  opts.size,
      hue:   opts.hue,
    });
  }

  _tickPool(pool, dt) {
    const ctx = this.ctx;
    for (let i = pool.length - 1; i >= 0; i--) {
      const p = pool[i];
      p.x    += p.vx * dt; p.y  += p.vy * dt;
      p.vy   += p.gy * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) { pool.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, TWO_PI);
      ctx.fillStyle = `hsla(${p.hue},85%,65%,${p.life * 0.88})`;
      ctx.fill();
    }
  }

  _drawParticlesMode(bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const s = window.VIZ_SETTINGS;
    const r = s.reactivity;
    const hue = this._dHue();

    ctx.fillStyle = `rgba(0,0,0,${Math.max(s.fadeAlpha, 0.04)})`;
    ctx.fillRect(0, 0, W, H);

    // Bass: large, slow, sink with gravity
    if (bands.bass > 0.45) {
      const n = Math.ceil((bands.bass - 0.45) * 6 * r);
      for (let i = 0; i < n; i++) {
        this._addParticle(this._bassParticles, 80, {
          x: W / 2 + (Math.random() - 0.5) * W * 0.5,
          y: H / 2 + (Math.random() - 0.5) * H * 0.4,
          speed: 15 + bands.bass * 45,
          dvy:  -25,
          gy:    85,
          decay: 0.22 + Math.random() * 0.12,
          size:  9 + bands.bass * 13,
          hue:   (hue + 5) % 360,
        });
      }
    }

    // Mid: medium particles distributed across canvas
    {
      const n = Math.ceil((0.4 + bands.mid * 2.5) * r);
      for (let i = 0; i < n; i++) {
        this._addParticle(this._midParticles, 130, {
          x: Math.random() * W, y: Math.random() * H,
          speed: 35 + bands.mid * 90,
          gy:    0,
          decay: 0.48 + Math.random() * 0.42,
          size:  3 + bands.mid * 6,
          hue:   (hue + 35) % 360,
        });
      }
    }

    // High: tiny fast particles that float upward
    if (bands.high > 0.20) {
      const n = Math.ceil(bands.high * 7 * r);
      for (let i = 0; i < n; i++) {
        this._addParticle(this._highParticles, 110, {
          x: Math.random() * W,
          y: H * 0.25 + Math.random() * H * 0.75,
          speed: 70 + bands.high * 160,
          dvy:  -(55 + bands.high * 75),
          gy:   -35,
          decay: 0.85 + Math.random() * 0.55,
          size:  1 + bands.high * 3,
          hue:   (hue + 65) % 360,
        });
      }
    }

    this._tickPool(this._bassParticles, dt);
    this._tickPool(this._midParticles,  dt);
    this._tickPool(this._highParticles, dt);
  }

  // ── Mode 6: Lissajous (iTunes style, driven by FFT bands) ─────────────────

  _spawnLissParticles(bands, s) {
    if (s.particles === 'off') return;
    const base  = s.particles === 'high' ? 20 : 8;
    const count = Math.round(base * (0.5 + bands.bass * 0.5) * s.reactivity);
    const n     = Math.min(count, MAX_LISS_PARTICLES - this._lissParticles.length);
    for (let i = 0; i < n; i++) {
      const a   = Math.random() * TWO_PI;
      const spd = 65 + Math.random() * 200 * (0.4 + bands.mid * 0.6);
      this._lissParticles.push({
        x: 0, y: 0,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        life:  1,
        decay: 0.40 + Math.random() * 0.50,
        size:  1.4 + Math.random() * 3,
        hue:   (this.hue + (Math.random() - 0.5) * 70 + 360) % 360,
      });
    }
  }

  _drawLissajous(bands, dt) {
    const { ctx, canvas } = this;
    const W  = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();

    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    for (const c of this.curves) {
      c.phase += c.phaseSpeed * dt;
      c.a     += c.aRate * dt;
      c.b     += c.bRate * dt;
      if (c.a > 7.5 || c.a < 1.5) c.aRate *= -1;
      if (c.b > 6.5 || c.b < 1.5) c.bRate *= -1;
    }

    const drag = Math.pow(0.92, dt * 60);
    for (let i = this._lissParticles.length - 1; i >= 0; i--) {
      const p = this._lissParticles[i];
      p.x  += p.vx * dt; p.y  += p.vy * dt;
      p.vx *= drag;       p.vy *= drag;
      p.life -= p.decay * dt;
      if (p.life <= 0) this._lissParticles.splice(i, 1);
    }

    const energy   = bands.mid + bands.bass * 0.5;
    const baseR    = Math.min(W, H) * 0.40;
    const amp      = baseR * (0.55 + energy * 0.45);
    const sat      = 55 + energy * 40;
    const light    = 36 + energy * 22 + this._beatPulse * 26;
    const cAlpha   = 0.50 + this._beatPulse * 0.34;
    const lineW    = 1.3 + this._beatPulse * 2.2;
    const SYM      = s.symmetry;
    const nCurves  = Math.min(s.curveCount ?? 2, this.curves.length);

    ctx.save();
    ctx.translate(cx, cy);

    for (let sym = 0; sym < SYM; sym++) {
      ctx.save();
      ctx.rotate((sym / SYM) * TWO_PI);
      if (sym % 2 === 1) ctx.scale(1, -1);

      this.curves.slice(0, nCurves).forEach((c, ci) => {
        const cHue = (hue + ci * 45) % 360;
        ctx.beginPath();
        for (let i = 0; i <= CURVE_STEPS; i++) {
          const t = (i / CURVE_STEPS) * CURVE_PERIOD;
          const x = amp * Math.sin(c.a * t + c.phase);
          const y = amp * Math.sin(c.b * t);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${cHue},${sat}%,${light}%,${cAlpha})`;
        ctx.lineWidth   = lineW;
        ctx.stroke();
      });

      if (s.particles !== 'off') {
        const pLight = 58 + energy * 22;
        for (const p of this._lissParticles) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * p.life, 0, TWO_PI);
          ctx.fillStyle = `hsla(${p.hue},88%,${pLight}%,${p.life * 0.92})`;
          ctx.fill();
        }
      }

      ctx.restore();
    }

    ctx.restore();

    for (const sw of this._shockwaves) {
      ctx.beginPath();
      ctx.arc(cx, cy, sw.r, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${sw.hue},90%,76%,${sw.opacity})`;
      ctx.lineWidth   = 2.5;
      ctx.stroke();
    }
  }
}
