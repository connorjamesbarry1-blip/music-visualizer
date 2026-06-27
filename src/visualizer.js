// FFT-driven music visualizer — 11 visualization modes.
// app.js calls draw(freqData, timeData, ts, beatInfo) every RAF frame.
// window.VIZ_SETTINGS is written by the panel script and read every frame.
//
// Modes:
//   spectrum, waveform, radial, terrain, particles, lissajous, blob,
//   spiral, polygon, tunnel, rings

const TWO_PI             = Math.PI * 2;
const CURVE_STEPS        = 50;
const CURVE_PERIOD       = Math.PI * 10;
const BEAT_COOLDOWN_MS   = 200;

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
    // Per-curve independent hue offset for color split
    this._curveHueOffsets = [0, 120, 240];
    // Lissajous drift — the whole figure drifts slowly around the screen
    this._lissDriftX  = 0;
    this._lissDriftY  = 0;
    this._lissDriftVX = 18;
    this._lissDriftVY = 11;
    this._lissRotation = 0;

    // Particles mode pools
    this._bassParticles = [];
    this._midParticles  = [];
    this._highParticles = [];

    // Radial rotation accumulator
    this._radialAngle  = 0;
    this._radialAngle2 = Math.PI; // second ring starts opposite

    // Terrain offscreen buffer
    this._terrainBuf = document.createElement('canvas');
    this._terrainCtx = this._terrainBuf.getContext('2d');

    this._prevMode = null;

    // Spectrum peak hold
    this._spectrumPeaks = new Array(128).fill(0);

    // Blob mode
    this._blobPhase = 0;

    // Rings mode
    this._ringWaves = [];

    // ── NEW MODE STATE ─────────────────────────────────────────────────────────

    // Spiral mode
    this._spiralAngle  = 0;
    this._spiralPoints = []; // rolling history of waveform-on-spiral positions

    // Polygon mode
    this._polyPhase   = 0;
    this._polySides   = 3;    // morphs 3–8
    this._polySideTarget = 3;
    this._polyMorphT  = 0;   // 0..1 blend between current and target polygon
    this._polyRotation = 0;
    this._polyWaveOffset = 0;

    // Tunnel mode
    this._tunnelRings   = [];  // { z, hue, radius }
    this._tunnelAngle   = 0;
    this._tunnelSpeed   = 1;

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
    // Re-seed tunnel rings on resize so they fill the new dimensions
    this._tunnelRings = [];
  }

  // ── Main entry — called every RAF frame ────────────────────────────────────

  draw(freqData, timeData, ts, externalBands) {
    const dt = Math.min((ts - this._lastTs) / 1000, 0.1);
    this._lastTs = ts;

    const s    = window.VIZ_SETTINGS;
    const mode = s.mode ?? 'spectrum';

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
      // Polygon: trigger a side-count morph on beat
      if (mode === 'polygon') {
        const ps = s.polyShape ?? 'random';
        if (ps === 'random') {
          this._polySideTarget = 3 + Math.floor(Math.random() * 6); // 3–8
        }
        this._polyMorphT = 0;
      }
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
      if (mode === 'rings')   this._ringWaves   = [];
      if (mode === 'spiral')  this._spiralPoints = [];
      if (mode === 'tunnel')  this._tunnelRings  = [];
      if (mode === 'polygon') {
        const ps = (window.VIZ_SETTINGS.polyShape ?? 'random');
        const initSides = ps === 'random' ? 3 : parseInt(ps, 10);
        this._polyMorphT = 0; this._polySides = initSides; this._polySideTarget = initSides;
      }
      this._prevMode = mode;
    }

    switch (mode) {
      case 'spectrum':  this._drawSpectrum(freqData, bands, dt);          break;
      case 'waveform':  this._drawWaveform(timeData, bands);              break;
      case 'radial':    this._drawRadial(freqData, timeData, bands, dt);  break;
      case 'terrain':   this._drawTerrain(freqData);                      break;
      case 'particles': this._drawParticlesMode(bands, dt);               break;
      case 'lissajous': this._drawLissajous(freqData, timeData, bands, dt); break;
      case 'blob':      this._drawBlob(freqData, bands, dt);              break;
      case 'rings':     this._drawRings(freqData, bands, dt);             break;
      case 'spiral':    this._drawSpiral(freqData, timeData, bands, dt);  break;
      case 'polygon':   this._drawPolygon(freqData, timeData, bands, dt); break;
      case 'tunnel':    this._drawTunnel(freqData, timeData, bands, dt);  break;
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

      if (barH > this._spectrumPeaks[i]) {
        this._spectrumPeaks[i] = barH;
      } else {
        this._spectrumPeaks[i] = Math.max(0, this._spectrumPeaks[i] - dt * 120);
      }
      const peakY = H - this._spectrumPeaks[i];
      ctx.fillStyle = `hsla(${barHue},90%,${Math.min(light + 20, 95)}%,0.9)`;
      ctx.fillRect(bx, peakY, bw, 2);
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

    drawLine(-1, 0.28);

    if (this._beatPulse > 0) {
      ctx.save();
      ctx.filter = 'blur(8px)';
      ctx.beginPath();
      ctx.moveTo(0, midY + (timeData[0] / 128 - 1) * amp);
      for (let i = 1; i < len; i++) {
        const x  = (i / (len - 1)) * W;
        const y  = midY + (timeData[i]     / 128 - 1) * amp;
        const px = ((i - 1) / (len - 1)) * W;
        const py = midY + (timeData[i - 1] / 128 - 1) * amp;
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
      }
      ctx.lineTo(W, midY + (timeData[len - 1] / 128 - 1) * amp);
      ctx.strokeStyle = `hsla(${hue},84%,65%,${0.15 * this._beatPulse})`;
      ctx.lineWidth   = lw * 3;
      ctx.lineJoin    = 'round';
      ctx.stroke();
      ctx.restore();
    }

    drawLine(1, 0.88);
  }

  // ── Mode 3: Radial ─────────────────────────────────────────────────────────
  // Enhanced: two counter-rotating waveform rings + inner glow core

  _drawRadial(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;

    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    this._radialAngle  = (this._radialAngle  + 0.20 * dt) % TWO_PI;
    this._radialAngle2 = (this._radialAngle2 - 0.13 * dt + TWO_PI) % TWO_PI;

    const hue    = this._dHue();
    const maxR   = Math.min(W, H) * 0.45;
    const innerR = maxR * 0.16;
    const pulse  = 1 + this._beatPulse * 0.22;
    const BARS   = 256;
    const sliceA = TWO_PI / BARS;

    // Outer FFT bars
    for (let i = 0; i < BARS; i++) {
      const val = freqData[i] / 255;
      if (val < 0.015) continue;
      const startA = i * sliceA + this._radialAngle;
      const endA   = startA + sliceA;
      const outerR = Math.max(innerR + 1, (innerR + val * (maxR - innerR)) * pulse);
      const barHue = (hue + (i / BARS) * 80) % 360;
      const light  = 28 + val * 44;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startA, endA);
      ctx.arc(cx, cy, innerR, endA, startA, true);
      ctx.closePath();
      ctx.fillStyle = `hsla(${barHue},76%,${light}%,${0.5 + val * 0.5})`;
      ctx.fill();
    }

    // ── Primary inner waveform ring ─────────────────────────────────────────
    if (timeData && timeData.length > 0) {
      const r = s.reactivity;
      const waveR    = innerR * 1.1;
      const waveAmp  = innerR * (0.55 + bands.bass * 0.6 * r);
      const beatSc   = 1 + this._beatPulse * 0.25;
      const waveHue  = (hue + 180) % 360;
      const lw       = 2 + this._beatPulse * 3 + bands.mid * 2;

      // Glow pass
      ctx.save();
      ctx.filter = `blur(${4 + this._beatPulse * 8}px)`;
      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 2) {
        const angle = (i / timeData.length) * TWO_PI + this._radialAngle;
        const disp  = (timeData[i] / 128 - 1) * waveAmp;
        const rr    = (waveR + disp) * beatSc;
        const x = cx + rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue},90%,70%,${0.35 + this._beatPulse * 0.3})`;
      ctx.lineWidth = lw * 2.5;
      ctx.stroke();
      ctx.restore();

      // Crisp pass
      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 2) {
        const angle = (i / timeData.length) * TWO_PI + this._radialAngle;
        const disp  = (timeData[i] / 128 - 1) * waveAmp;
        const rr    = (waveR + disp) * beatSc;
        const x = cx + rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue},85%,72%,0.9)`;
      ctx.lineWidth = lw;
      ctx.stroke();

      // ── Counter-rotating second waveform ring ───────────────────────────
      const waveR2   = innerR * 0.62;
      const waveAmp2 = innerR * (0.30 + bands.high * 0.4 * r);
      const waveHue2 = (hue + 90) % 360;
      const lw2      = 1.5 + bands.high * 2;

      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 3) {
        const angle = (i / timeData.length) * TWO_PI + this._radialAngle2;
        const disp  = (timeData[i] / 128 - 1) * waveAmp2;
        const rr    = (waveR2 + disp) * beatSc;
        const x = cx + rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue2},80%,65%,0.65)`;
      ctx.lineWidth = lw2;
      ctx.stroke();

      // ── Glowing core ───────────────────────────────────────────────────
      const coreR = innerR * (0.28 + bands.bass * 0.35 * r + this._beatPulse * 0.15);
      const grad  = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      grad.addColorStop(0, `hsla(${hue},90%,90%,${0.6 + this._beatPulse * 0.3})`);
      grad.addColorStop(0.5, `hsla(${hue},80%,60%,${0.2 + this._beatPulse * 0.2})`);
      grad.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, TWO_PI);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  // ── Mode 4: Terrain ────────────────────────────────────────────────────────

  _drawTerrain(freqData) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const tc = this._terrainCtx;
    const tb = this._terrainBuf;

    tc.drawImage(tb, -2, 0);

    const BINS = Math.min(freqData.length, 256);
    const barH = H / BINS;

    for (let i = 0; i < BINS; i++) {
      const val = freqData[i] / 255;
      if (val < 0.015) {
        tc.fillStyle = '#040408';
      } else {
        const h = 260 - val * 190;
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
      trail: [],
    });
  }

  _tickPool(pool, dt) {
    const ctx = this.ctx;
    for (let i = pool.length - 1; i >= 0; i--) {
      const p = pool[i];
      if (p.trail) {
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 4) p.trail.shift();
      }
      p.x    += p.vx * dt; p.y  += p.vy * dt;
      p.vy   += p.gy * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) { pool.splice(i, 1); continue; }
      if (p.trail) {
        for (let t = 0; t < p.trail.length; t++) {
          const frac = t / p.trail.length;
          ctx.beginPath();
          ctx.arc(p.trail[t].x, p.trail[t].y, p.size * p.life * frac * 0.6, 0, TWO_PI);
          ctx.fillStyle = `hsla(${p.hue},85%,65%,${p.life * frac * 0.4})`;
          ctx.fill();
        }
      }
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

    if (bands.bass > 0.45) {
      const n = Math.ceil((bands.bass - 0.45) * 6 * r);
      for (let i = 0; i < n; i++) {
        this._addParticle(this._bassParticles, 80, {
          x: W / 2 + (Math.random() - 0.5) * W * 0.5,
          y: H / 2 + (Math.random() - 0.5) * H * 0.4,
          speed: 15 + bands.bass * 45,
          dvy:  -25, gy: 85,
          decay: 0.22 + Math.random() * 0.12,
          size:  9 + bands.bass * 13,
          hue:   (hue + 5) % 360,
        });
      }
    }

    {
      const n = Math.ceil((0.4 + bands.mid * 2.5) * r);
      for (let i = 0; i < n; i++) {
        this._addParticle(this._midParticles, 130, {
          x: Math.random() * W, y: Math.random() * H,
          speed: 35 + bands.mid * 90, gy: 0,
          decay: 0.48 + Math.random() * 0.42,
          size:  3 + bands.mid * 6,
          hue:   (hue + 35) % 360,
        });
      }
    }

    if (bands.high > 0.20) {
      const n = Math.ceil(bands.high * 7 * r);
      for (let i = 0; i < n; i++) {
        this._addParticle(this._highParticles, 110, {
          x: Math.random() * W,
          y: H * 0.25 + Math.random() * H * 0.75,
          speed: 70 + bands.high * 160,
          dvy:  -(55 + bands.high * 75), gy: -35,
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

  // ── Mode 6: Lissajous — upgraded ──────────────────────────────────────────
  // - Whole figure drifts and slow-rotates around screen
  // - Per-arm independent color cycling
  // - Reactive line thickness that explodes on beats
  // - Waveform data layered inside the figure

  _drawLissajous(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W  = canvas.width, H = canvas.height;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    // ── Drift the whole figure gently around the screen ───────────────────
    const driftAmp = Math.min(W, H) * 0.12;
    this._lissDriftX += this._lissDriftVX * dt;
    this._lissDriftY += this._lissDriftVY * dt;
    // Soft bounce off edges
    if (Math.abs(this._lissDriftX) > driftAmp) this._lissDriftVX *= -1;
    if (Math.abs(this._lissDriftY) > driftAmp) this._lissDriftVY *= -1;
    // Slow global rotation
    this._lissRotation += dt * (0.04 + bands.mid * 0.08 * r);

    const cx = W / 2 + this._lissDriftX;
    const cy = H / 2 + this._lissDriftY;

    // ── Animate curves ─────────────────────────────────────────────────────
    for (const c of this.curves) {
      c.phase += c.phaseSpeed * dt;
      c.a     += c.aRate * dt;
      c.b     += c.bRate * dt;
      if (c.a > 7.5 || c.a < 1.5) c.aRate *= -1;
      if (c.b > 6.5 || c.b < 1.5) c.bRate *= -1;
    }

    // Advance per-curve hue offsets independently
    for (let i = 0; i < this._curveHueOffsets.length; i++) {
      this._curveHueOffsets[i] = (this._curveHueOffsets[i] + (8 + i * 5) * dt) % 360;
    }

    const energy   = bands.mid + bands.bass * 0.5;
    const baseR    = Math.min(W, H) * 0.36;
    const amp      = baseR * (0.55 + energy * 0.45);
    const sat      = 55 + energy * 40;
    // Line width explodes on beat, thin on quiet
    const lineW    = (1.0 + energy * 2.5) * (1 + this._beatPulse * 3.5 * r);
    const SYM      = Math.max(1, s.symmetry);
    const nCurves  = Math.min(s.curveCount ?? 2, this.curves.length);
    const steps    = Math.max(5, Math.min(50, s.lissSteps ?? CURVE_STEPS));

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._lissRotation);

    for (let sym = 0; sym < SYM; sym++) {
      ctx.save();
      ctx.rotate((sym / SYM) * TWO_PI);
      if (sym % 2 === 1) ctx.scale(1, -1);

      this.curves.slice(0, nCurves).forEach((c, ci) => {
        // Each arm + each curve gets its own independently cycling hue
        const cHue  = (hue + this._curveHueOffsets[ci] + sym * (360 / SYM) * 0.4) % 360;
        const light = 36 + energy * 22 + this._beatPulse * 26;
        const alpha = 0.50 + this._beatPulse * 0.34;

        // Glow pass on beat
        if (this._beatPulse > 0.3) {
          ctx.save();
          ctx.filter = `blur(${this._beatPulse * 6}px)`;
          ctx.beginPath();
          for (let i = 0; i <= steps; i++) {
            const t = (i / steps) * CURVE_PERIOD;
            const x = amp * Math.sin(c.a * t + c.phase);
            const y = amp * Math.sin(c.b * t);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsla(${cHue},${sat}%,${light}%,${alpha * 0.4})`;
          ctx.lineWidth   = lineW * 3;
          ctx.stroke();
          ctx.restore();
        }

        // Crisp pass
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const t = (i / steps) * CURVE_PERIOD;
          const x = amp * Math.sin(c.a * t + c.phase);
          const y = amp * Math.sin(c.b * t);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${cHue},${sat}%,${light}%,${alpha})`;
        ctx.lineWidth   = lineW;
        ctx.stroke();
      });

      ctx.restore();
    }

    ctx.restore();
  }

  // ── Mode 7: Blob ──────────────────────────────────────────────────────────

  _drawBlob(freqData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r = s.reactivity;

    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    const baseRadius = Math.min(W, H) * 0.25;
    this._blobPhase += dt * (1.5 + bands.mid * 2);

    for (let layer = 2; layer >= 0; layer--) {
      const phaseOff   = layer * 0.7;
      const layerAlpha = layer === 0 ? 0.85 : 0.15 + layer * 0.1;
      const layerScale = 1 + layer * 0.12;

      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const angle = (i / 120) * TWO_PI;
        const phase = this._blobPhase + phaseOff;
        const noise1 = Math.sin(angle * 3 + phase) * Math.cos(angle * 2 + phase * 0.7);
        const noise2 = Math.sin(angle * 5 + phase * 1.3) * 0.5;
        const noise3 = Math.sin(angle * 8 + phase * 2.1) * 0.25;
        const displacement = (noise1 + noise2 * bands.mid * r + noise3 * bands.high * r) * baseRadius * 0.35;
        const rad = baseRadius * layerScale * (1 + bands.bass * 0.6 * r + this._beatPulse * 0.3) + displacement;
        const x = cx + rad * Math.cos(angle);
        const y = cy + rad * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();

      const layerHue = (hue + layer * 40) % 360;
      ctx.fillStyle   = `hsla(${layerHue},75%,50%,${layerAlpha * 0.5})`;
      ctx.fill();
      ctx.strokeStyle = `hsla(${layerHue},80%,65%,${layerAlpha})`;
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }
  }

  // ── Mode 8: Rings ─────────────────────────────────────────────────────────

  _drawRings(freqData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r = s.reactivity;

    ctx.fillStyle = `rgba(0,0,0,${Math.max(s.fadeAlpha, 0.08)})`;
    ctx.fillRect(0, 0, W, H);

    const maxR  = Math.min(W, H) * 0.45;
    const innerR = maxR * 0.1;

    ctx.save();
    ctx.translate(cx, cy);
    this._radialAngle += dt * (0.2 + bands.mid * 2 * r);
    ctx.rotate(this._radialAngle);

    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 8; i++) {
      const binStart = Math.floor((i / 8) * 90);
      const binEnd   = Math.floor(((i + 1) / 8) * 90);
      let energy = 0;
      for (let b = binStart; b < binEnd; b++) energy += freqData[b] / 255;
      energy /= (binEnd - binStart);

      const baseR  = innerR + (i / 7) * (maxR - innerR);
      const ringR  = baseR + energy * 120 * r + this._beatPulse * 20;

      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${(hue + i * 25) % 360},85%,${50 + energy * 30}%,${0.5 + energy * 0.5})`;
      ctx.lineWidth   = 2 + energy * 15 * r;
      ctx.stroke();
    }
    ctx.restore();

    if (this._beatPulse > 0.8) {
      this._ringWaves.push({
        r: innerR, speed: 400 + bands.bass * 600 * r,
        opacity: 0.9, hue, lineWidth: 3 + bands.bass * 8 * r,
      });
      this._beatPulse = 0.5;
    }

    for (let i = this._ringWaves.length - 1; i >= 0; i--) {
      const rw = this._ringWaves[i];
      rw.r       += rw.speed * dt;
      rw.opacity -= dt * 1.5;
      if (rw.opacity <= 0 || rw.r > Math.max(W, H) * 1.5) { this._ringWaves.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(cx, cy, rw.r, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${rw.hue},90%,65%,${rw.opacity})`;
      ctx.lineWidth   = rw.lineWidth;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Mode 9: Spiral ────────────────────────────────────────────────────────
  // Waveform coils into an expanding spiral. Beat = spiral pulses outward.
  // The whole spiral slowly rotates and the coil density reacts to mids.

  _drawSpiral(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    ctx.fillStyle = `rgba(0,0,0,${Math.max(s.fadeAlpha, 0.06)})`;
    ctx.fillRect(0, 0, W, H);

    // Spiral rotation speeds up with mids
    this._spiralAngle += dt * (0.15 + bands.mid * 0.5 * r);

    const maxR    = Math.min(W, H) * 0.46;
    const turns   = 3.5 + bands.mid * 1.5 * r;   // coil density
    const beatExp = 1 + this._beatPulse * 0.35 * r; // outward pulse on beat
    const len     = timeData.length;

    // Draw two interleaved spiral arms for figure-8 feel
    for (let arm = 0; arm < 2; arm++) {
      const armOffset = arm * Math.PI;
      const armHue    = (hue + arm * 160) % 360;

      ctx.beginPath();
      for (let i = 0; i < len; i++) {
        const t     = i / (len - 1);                       // 0..1 along waveform
        const angle = t * turns * TWO_PI + this._spiralAngle + armOffset;
        const base  = t * maxR * beatExp;
        // Waveform displacement pushes radially in/out
        const disp  = (timeData[i] / 128 - 1) * maxR * 0.12 * r;
        const rr    = base + disp;
        const x = cx + rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }

      const lw = 1.8 + bands.bass * 3 * r + this._beatPulse * 2.5;

      // Glow
      ctx.save();
      ctx.filter = `blur(${3 + this._beatPulse * 6}px)`;
      ctx.strokeStyle = `hsla(${armHue},85%,65%,${0.25 + this._beatPulse * 0.25})`;
      ctx.lineWidth   = lw * 2.5;
      ctx.lineJoin    = 'round';
      ctx.stroke();
      ctx.restore();

      // Crisp
      ctx.strokeStyle = `hsla(${armHue},80%,68%,0.88)`;
      ctx.lineWidth   = lw;
      ctx.lineJoin    = 'round';
      ctx.stroke();
    }

  }

  // ── Mode 10: Polygon ──────────────────────────────────────────────────────
  // The waveform rides along morphing polygon outlines (triangle → octagon).
  // On each beat the polygon morphs to a new side count (random or fixed).
  // Multiple nested polygons scale with bass/mids. Whole shape rotates.

  _drawPolygon(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    ctx.fillStyle = `rgba(0,0,0,${Math.max(s.fadeAlpha, 0.07)})`;
    ctx.fillRect(0, 0, W, H);

    // Rotation speeds up with energy
    this._polyRotation += dt * (0.18 + bands.mid * 0.6 * r);

    // If polyShape is fixed, lock target to that value
    const ps = s.polyShape ?? 'random';
    if (ps !== 'random') {
      const fixed = parseInt(ps, 10);
      this._polySideTarget = fixed;
      this._polySides      = fixed;
      this._polyMorphT     = 1;
    }

    // Morph sides smoothly toward target
    this._polyMorphT = Math.min(1, this._polyMorphT + dt * 2.5);
    const sides = this._polySides + (this._polySideTarget - this._polySides) * this._polyMorphT;
    if (this._polyMorphT >= 1) this._polySides = this._polySideTarget;

    const baseR   = Math.min(W, H) * 0.38;
    const LAYERS  = 5;

    // Helper: get a point on a smooth polygon outline at parameter t (0..1)
    // sides can be fractional for morphing
    const polyPoint = (t, radius, rot) => {
      const fullAngle = t * TWO_PI;
      const sideF     = Math.floor(sides);
      const frac      = sides - sideF;

      // Interpolate between sideF-gon and (sideF+1)-gon
      const angleA = Math.round(fullAngle / (TWO_PI / sideF)) * (TWO_PI / sideF);
      const angleB = Math.round(fullAngle / (TWO_PI / (sideF + 1))) * (TWO_PI / (sideF + 1));
      const angle  = angleA + (angleB - angleA) * frac;

      // Distance to polygon edge at this angle (exact for integer sides)
      const sideAngle = TWO_PI / sides;
      const modAngle  = ((fullAngle % sideAngle) + sideAngle) % sideAngle - sideAngle / 2;
      const edgeDist  = radius / Math.cos(modAngle);

      return {
        x: cx + edgeDist * Math.cos(fullAngle + rot),
        y: cy + edgeDist * Math.sin(fullAngle + rot),
      };
    };

    ctx.globalCompositeOperation = 'screen';

    for (let layer = LAYERS; layer >= 1; layer--) {
      const layerT    = layer / LAYERS;
      const layerR    = baseR * layerT * (1 + bands.bass * 0.5 * r + this._beatPulse * 0.25 * r);
      const layerHue  = (hue + layer * 28) % 360;
      const layerAlpha = 0.25 + layerT * 0.55;
      const lw        = 1 + (1 - layerT) * 3 + (layer === LAYERS ? this._beatPulse * 3 : 0);

      const steps = 300;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t   = i / steps;
        const pt  = polyPoint(t, layerR, this._polyRotation);
        // Waveform displacement: push outward/inward along the normal
        const wIdx   = Math.floor(t * timeData.length);
        const wDisp  = (timeData[wIdx] / 128 - 1) * layerR * 0.18 * r * layerT;
        const angle  = t * TWO_PI + this._polyRotation;
        const x = pt.x + wDisp * Math.cos(angle);
        const y = pt.y + wDisp * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();

      if (layer === LAYERS && this._beatPulse > 0.3) {
        ctx.save();
        ctx.filter = `blur(${this._beatPulse * 8}px)`;
        ctx.strokeStyle = `hsla(${layerHue},90%,70%,${this._beatPulse * 0.4})`;
        ctx.lineWidth   = lw * 3;
        ctx.stroke();
        ctx.restore();
      }

      ctx.strokeStyle = `hsla(${layerHue},82%,62%,${layerAlpha})`;
      ctx.lineWidth   = lw;
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Mode 11: Tunnel ───────────────────────────────────────────────────────
  // You are falling into a psychedelic color vortex.
  // Rings spawn at the center and rush toward the viewer (z → 0).
  // Bass accelerates the fall. Beat = sudden zoom + color shift.
  // The tunnel twists (rotates) with the mids.

  _drawTunnel(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    // Solid black background — tunnel needs depth
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, H);

    // Fall speed: bass drives it, beat gives a lurch
    const fallSpeed = 0.8 + bands.bass * 2.5 * r + this._beatPulse * 2.0 * r;
    this._tunnelSpeed += (fallSpeed - this._tunnelSpeed) * dt * 4;

    // Twist angle accumulates with mids
    this._tunnelAngle += dt * (0.4 + bands.mid * 1.5 * r);

    // Spawn new rings at z=1 (far away)
    const RING_COUNT = 28;
    if (this._tunnelRings.length < RING_COUNT) {
      const missing = RING_COUNT - this._tunnelRings.length;
      for (let i = 0; i < missing; i++) {
        this._tunnelRings.push({
          z:    i / RING_COUNT,           // spread them out initially
          hue:  (hue + i * (360 / RING_COUNT)) % 360,
          sides: 0,                        // 0 = circle; >0 = polygon variant
          twist: Math.random() * TWO_PI,
        });
      }
    }

    // Advance rings toward viewer
    for (const ring of this._tunnelRings) {
      ring.z -= dt * this._tunnelSpeed * 0.18;
      ring.hue = (ring.hue + dt * 40) % 360;
      if (ring.z <= 0) {
        // Reset to back of tunnel
        ring.z    += 1.0;
        ring.hue  = (hue + Math.random() * 60) % 360;
        ring.twist = this._tunnelAngle;
      }
    }

    // Sort back-to-front so closer rings draw on top
    this._tunnelRings.sort((a, b) => b.z - a.z);

    // Map z (0..1) to projected radius: z=1 tiny, z→0 fills screen
    const project = z => {
      const fov    = 0.6;
      const scale  = fov / Math.max(z, 0.001);
      return Math.min(scale * Math.min(W, H) * 0.55, Math.max(W, H) * 1.2);
    };

    ctx.globalCompositeOperation = 'screen';

    for (const ring of this._tunnelRings) {
      const radius  = project(ring.z);
      const opacity = Math.min(1, (1 - ring.z) * 1.8) * (0.4 + (1 - ring.z) * 0.55);
      const lw      = 1.5 + (1 - ring.z) * 5 + this._beatPulse * 3 * (1 - ring.z);

      // Sample a freq bin for this ring's energy to make it throb
      const binIdx = Math.floor(ring.z * Math.min(freqData.length, 180));
      const energy = freqData[binIdx] / 255;
      const throb  = 1 + energy * 0.35 * r;

      // Twist: each ring is slightly rotated more than the last
      const twist = ring.twist + (1 - ring.z) * this._tunnelAngle * 0.3;

      // Draw as a circle (could add polygon variant here later)
      const SEGS = 80;
      ctx.beginPath();
      for (let i = 0; i <= SEGS; i++) {
        const angle = (i / SEGS) * TWO_PI + twist;
        // Slight warp from freq data
        const warpBin  = Math.floor((i / SEGS) * Math.min(freqData.length, 256));
        const warp     = (freqData[warpBin] / 255) * radius * 0.15 * r * (1 - ring.z);
        const rr       = radius * throb + warp;
        const x = cx + rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();

      const light = 45 + (1 - ring.z) * 35;
      ctx.strokeStyle = `hsla(${ring.hue},90%,${light}%,${opacity})`;
      ctx.lineWidth   = lw;
      ctx.stroke();
    }

    // Central waveform circle — replaces radial glow
    if (timeData && timeData.length > 0) {
      const waveR   = Math.min(W, H) * 0.06;
      const waveAmp = waveR * (0.55 + bands.bass * 0.6 * r);
      const beatSc  = 1 + this._beatPulse * 0.25;
      const waveHue = (hue + 180) % 360;
      const lw      = 2 + this._beatPulse * 3 + bands.mid * 2;

      // Glow pass
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.filter = `blur(${4 + this._beatPulse * 8}px)`;
      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 2) {
        const angle = (i / timeData.length) * TWO_PI + this._tunnelAngle;
        const disp  = (timeData[i] / 128 - 1) * waveAmp;
        const rr    = (waveR + disp) * beatSc;
        const x = cx + rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue},90%,70%,${0.35 + this._beatPulse * 0.3})`;
      ctx.lineWidth = lw * 2.5;
      ctx.stroke();
      ctx.restore();

      // Crisp pass
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 2) {
        const angle = (i / timeData.length) * TWO_PI + this._tunnelAngle;
        const disp  = (timeData[i] / 128 - 1) * waveAmp;
        const rr    = (waveR + disp) * beatSc;
        const x = cx + rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue},85%,72%,0.9)`;
      ctx.lineWidth = lw;
      ctx.stroke();
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'source-over';
  }
}
