// FFT-driven music visualizer — 14 visualization modes.
// app.js calls draw(freqData, timeData, ts, beatInfo) every RAF frame.
// window.VIZ_SETTINGS is written by the panel script and read every frame.

const TWO_PI           = Math.PI * 2;
const CURVE_STEPS      = 50;
const CURVE_PERIOD     = Math.PI * 10;
const BEAT_COOLDOWN_MS = 200;

window.VIZ_SETTINGS ??= {
  fadeAlpha:  0.09,
  curveCount: 2,
  symmetry:   6,
  colorMode:  'cycle',
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

    this._bassHistory = new Float32Array(60);
    this._bassHistIdx = 0;
    this._lastBeatMs  = 0;
    this._beatPulse   = 0;
    this._lastTs      = 0;

    // Smoothed band values (EMA) + lerped beat scale
    this._sBass     = 0;
    this._sMid      = 0;
    this._sHigh     = 0;
    this._beatScale = 1;

    // Lissajous
    this.curves = [
      { a: 3.0, b: 2.0, phase: 0,          phaseSpeed:  0.40, aRate:  0.10, bRate:  0.08 },
      { a: 5.0, b: 4.0, phase: TWO_PI/3,   phaseSpeed: -0.32, aRate: -0.08, bRate:  0.11 },
      { a: 7.0, b: 6.0, phase: TWO_PI*2/3, phaseSpeed:  0.25, aRate:  0.06, bRate: -0.09 },
    ];
    this._curveHueOffsets = [0, 120, 240];
    this._lissDriftX  = 0;
    this._lissDriftY  = 0;
    this._lissDriftVX = 18;
    this._lissDriftVY = 11;
    this._lissRotation = 0;

    // Particles
    this._bassParticles = [];
    this._midParticles  = [];
    this._highParticles = [];
    this._gravWellT     = 0;

    // Radial
    this._radialAngle  = 0;
    this._radialAngle2 = Math.PI;

    // Terrain offscreen buffer
    this._terrainBuf = document.createElement('canvas');
    this._terrainCtx = this._terrainBuf.getContext('2d');

    this._prevMode = null;

    // Spectrum peak hold
    this._spectrumPeaks = new Array(128).fill(0);

    // Blob
    this._blobPhase = 0;

    // Rings
    this._ringWaves = [];

    // Spiral
    this._spiralAngle  = 0;
    this._spiralPoints = [];

    // Polygon
    this._polyPhase      = 0;
    this._polySides      = 3;
    this._polySideTarget = 3;
    this._polyMorphT     = 0;
    this._polyRotation   = 0;
    this._polyWaveOffset = 0;

    // Tunnel
    this._tunnelRings = [];
    this._tunnelAngle = 0;
    this._tunnelSpeed = 1;

    // ── NEW MODE STATE ─────────────────────────────────────────────────────────

    // Galaxy
    this._stars       = [];
    this._galaxySpin  = 0;
    this._warpAmount  = 0;
    this._warpTarget  = 0;

    // Mandala
    this._mandalaAngle = 0;
    this._mandalaPhase = 0;
    this._mandalaDepth = 3;

    // Fluid
    this._fluidGrid = null;
    this._fluidCols = 40;
    this._fluidRows = 25;
    this._fluidW    = 0;
    this._fluidH    = 0;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
  }

  stop() { window.removeEventListener('resize', this._onResize); }

  // ── Utilities ──────────────────────────────────────────────────────────────

  _lerp(a, b, t) { return a + (b - a) * t; }

  _updateSmoothedBands(bands, dt) {
    const k = 1 - Math.exp(-dt * 8);
    this._sBass = this._lerp(this._sBass, bands.bass, k);
    this._sMid  = this._lerp(this._sMid,  bands.mid,  k);
    this._sHigh = this._lerp(this._sHigh, bands.high, k);
    const r = window.VIZ_SETTINGS.reactivity ?? 0.7;
    if (this._beatPulse > 0.85) {
      this._beatScale = 1 + 0.3 * r;
    } else {
      this._beatScale = this._lerp(this._beatScale, 1.0, dt * 4);
    }
  }

  // ── Fade helper ─────────────────────────────────────────────────────────────
  _applyFade(minAlpha = 0) {
    const { ctx, canvas } = this;
    const s     = window.VIZ_SETTINGS;
    const alpha = Math.max(s.fadeAlpha, minAlpha);
    if (alpha <= 0.008) return;
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'destination-out';
    const effective = Math.min(alpha * 3, 1.0);
    ctx.fillStyle = `rgba(255,255,255,${effective})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = prev;
  }

  _resize() {
    const W = window.innerWidth, H = window.innerHeight;
    this.canvas.width  = W;
    this.canvas.height = H;
    this._terrainBuf.width  = W;
    this._terrainBuf.height = H;
    this._terrainCtx.fillStyle = '#000';
    this._terrainCtx.fillRect(0, 0, W, H);
    this._tunnelRings = [];
    this._fluidGrid   = null;
  }

  // ── Main entry ─────────────────────────────────────────────────────────────

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
    this._updateSmoothedBands(bands, dt);

    const isBeat = this._detectBeat(bands);
    if (isBeat) {
      this._beatPulse = 1;
      if (this.beatCallback) this.beatCallback(1.0, bands.bass);
      if (mode === 'polygon') {
        const ps = s.polyShape ?? 'random';
        if (ps === 'random') this._polySideTarget = 3 + Math.floor(Math.random() * 6);
        this._polyMorphT = 0;
      }
    }

    if (mode !== this._prevMode) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._terrainCtx.fillStyle = '#000';
      this._terrainCtx.fillRect(0, 0, this._terrainBuf.width, this._terrainBuf.height);
      if (mode === 'particles') { this._bassParticles = []; this._midParticles = []; this._highParticles = []; }
      if (mode === 'rings')   this._ringWaves    = [];
      if (mode === 'spiral')  this._spiralPoints = [];
      if (mode === 'tunnel')  this._tunnelRings  = [];
      if (mode === 'galaxy')  this._stars        = [];
      if (mode === 'fluid')   this._fluidGrid    = null;
      if (mode === 'polygon') {
        const ps = s.polyShape ?? 'random';
        const initSides = ps === 'random' ? 3 : parseInt(ps, 10);
        this._polyMorphT = 0; this._polySides = initSides; this._polySideTarget = initSides;
      }
      this._prevMode = mode;
    }

    switch (mode) {
      case 'spectrum':  this._drawSpectrum(freqData, bands, dt);             break;
      case 'waveform':  this._drawWaveform(timeData, bands, dt);             break;
      case 'radial':    this._drawRadial(freqData, timeData, bands, dt);     break;
      case 'terrain':   this._drawTerrain(freqData, bands, dt);              break;
      case 'particles': this._drawParticlesMode(bands, dt);                  break;
      case 'lissajous': this._drawLissajous(freqData, timeData, bands, dt);  break;
      case 'blob':      this._drawBlob(freqData, bands, dt);                 break;
      case 'rings':     this._drawRings(freqData, bands, dt);                break;
      case 'spiral':    this._drawSpiral(freqData, timeData, bands, dt);     break;
      case 'polygon':   this._drawPolygon(freqData, timeData, bands, dt);    break;
      case 'tunnel':    this._drawTunnel(freqData, timeData, bands, dt);     break;
      case 'galaxy':    this._drawGalaxy(freqData, bands, dt, isBeat);       break;
      case 'mandala':   this._drawMandala(freqData, bands, dt);              break;
      case 'fluid':     this._drawFluid(freqData, timeData, bands, dt, isBeat); break;
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

    this._applyFade();

    const BAR_COUNT = 128;
    const barW  = W / BAR_COUNT;
    const hue   = this._dHue();
    const pulse  = 1 + this._beatPulse * 0.30;

    // Main bars
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
      ctx.fillStyle = `hsla(${barHue},90%,${Math.min(light + 20, 95)}%,0.9)`;
      ctx.fillRect(bx, H - this._spectrumPeaks[i], bw, 2);
    }

    // Neon bloom on beat
    if (this._beatPulse > 0.4) {
      ctx.save();
      ctx.filter = 'blur(6px)';
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < BAR_COUNT; i++) {
        const t      = i / BAR_COUNT;
        const binIdx = Math.floor(t * Math.min(freqData.length, 512) * 0.72);
        const val    = freqData[binIdx] / 255;
        if (val < 0.2) continue;
        const barH   = val * H * 0.88 * pulse;
        const barHue = (hue + t * 60) % 360;
        ctx.fillStyle = `hsla(${barHue},90%,70%,${val * this._beatPulse * 0.5})`;
        ctx.fillRect(i * barW, H - barH, barW - 1, barH);
      }
      ctx.restore();
    }

    // Chromatic aberration on bass bins
    if (this._beatPulse > 0.5 && bands.bass > 0.65) {
      const chromStr = Math.min(1, (this._beatPulse - 0.5) * 2 * ((bands.bass - 0.65) / 0.35));
      const off = chromStr * 6;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 18; i++) {
        const t      = i / BAR_COUNT;
        const binIdx = Math.floor(t * Math.min(freqData.length, 512) * 0.72);
        const val    = freqData[binIdx] / 255;
        const barH   = val * H * 0.88 * pulse;
        ctx.fillStyle = `rgba(255,40,40,${val * 0.38 * chromStr})`;
        ctx.fillRect(i * barW - off, H - barH, barW - 1, barH);
        ctx.fillStyle = `rgba(40,255,255,${val * 0.38 * chromStr})`;
        ctx.fillRect(i * barW + off, H - barH, barW - 1, barH);
      }
      ctx.restore();
    }
  }

  // ── Mode 2: Waveform ───────────────────────────────────────────────────────

  _drawWaveform(timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;

    this._applyFade(0.055);

    const len  = timeData.length;
    const midY = H / 2;
    const amp  = H * 0.36 * this._beatScale;
    const lw   = 2.5 + this._sBass * 4 + this._beatPulse * 2.5;
    const hue  = this._dHue();

    const drawPath = (yScale) => {
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
    };

    // Faint mirror
    drawPath(-1);
    ctx.strokeStyle = `hsla(${hue},84%,65%,0.28)`;
    ctx.lineWidth = lw; ctx.lineJoin = 'round';
    ctx.stroke();

    // Glow on beat
    if (this._beatPulse > 0) {
      ctx.save();
      ctx.filter = `blur(8px)`;
      drawPath(1);
      ctx.strokeStyle = `hsla(${hue},84%,65%,${0.15 * this._beatPulse})`;
      ctx.lineWidth = lw * 3; ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    // Chromatic aberration on beat
    if (this._beatPulse > 0.5) {
      const chromStr = (this._beatPulse - 0.5) * 2;
      const off = chromStr * 4;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.translate(-off, 0); drawPath(1);
      ctx.strokeStyle = `rgba(255,60,60,${chromStr * 0.4})`;
      ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.translate(off, 0); drawPath(1);
      ctx.strokeStyle = `rgba(60,255,255,${chromStr * 0.4})`;
      ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
    }

    // Main crisp line
    drawPath(1);
    ctx.strokeStyle = `hsla(${hue},84%,65%,0.88)`;
    ctx.lineWidth = lw; ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // ── Mode 3: Radial ─────────────────────────────────────────────────────────

  _drawRadial(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;

    this._applyFade();

    this._radialAngle  = (this._radialAngle  + 0.20 * dt) % TWO_PI;
    this._radialAngle2 = (this._radialAngle2 - 0.13 * dt + TWO_PI) % TWO_PI;

    const hue    = this._dHue();
    const maxR   = Math.min(W, H) * 0.45;
    const innerR = maxR * 0.16;
    const pulse  = 1 + this._beatPulse * 0.22;
    const BARS   = 256;
    const sliceA = TWO_PI / BARS;

    for (let i = 0; i < BARS; i++) {
      const val    = freqData[i] / 255;
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

    if (timeData && timeData.length > 0) {
      const r      = s.reactivity;
      const waveR  = innerR * 1.1;
      const waveAmp = innerR * (0.55 + this._sBass * 0.6 * r);
      const beatSc  = 1 + this._beatPulse * 0.25;
      const waveHue = (hue + 180) % 360;
      const lw      = 2 + this._beatPulse * 3 + this._sMid * 2;

      ctx.save();
      ctx.filter = `blur(${4 + this._beatPulse * 8}px)`;
      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 2) {
        const angle = (i / timeData.length) * TWO_PI + this._radialAngle;
        const disp  = (timeData[i] / 128 - 1) * waveAmp;
        const rr    = (waveR + disp) * beatSc;
        const x = cx + rr * Math.cos(angle), y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue},90%,70%,${0.35 + this._beatPulse * 0.3})`;
      ctx.lineWidth = lw * 2.5; ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 2) {
        const angle = (i / timeData.length) * TWO_PI + this._radialAngle;
        const disp  = (timeData[i] / 128 - 1) * waveAmp;
        const rr    = (waveR + disp) * beatSc;
        const x = cx + rr * Math.cos(angle), y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue},85%,72%,0.9)`;
      ctx.lineWidth = lw; ctx.stroke();

      const waveR2  = innerR * 0.62;
      const waveAmp2 = innerR * (0.30 + this._sHigh * 0.4 * r);
      const waveHue2 = (hue + 90) % 360;
      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 3) {
        const angle = (i / timeData.length) * TWO_PI + this._radialAngle2;
        const disp  = (timeData[i] / 128 - 1) * waveAmp2;
        const rr    = (waveR2 + disp) * beatSc;
        const x = cx + rr * Math.cos(angle), y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue2},80%,65%,0.65)`;
      ctx.lineWidth = 1.5 + this._sHigh * 2; ctx.stroke();

      const coreR = innerR * (0.28 + this._sBass * 0.35 * r + this._beatPulse * 0.15);
      const grad  = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      grad.addColorStop(0, `hsla(${hue},90%,90%,${0.6 + this._beatPulse * 0.3})`);
      grad.addColorStop(0.5, `hsla(${hue},80%,60%,${0.2 + this._beatPulse * 0.2})`);
      grad.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, TWO_PI);
      ctx.fillStyle = grad; ctx.fill();
    }
  }

  // ── Mode 4: Terrain (with perspective tilt + horizon glow) ────────────────

  _drawTerrain(freqData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const tc  = this._terrainCtx;
    const tb  = this._terrainBuf;
    const hue = this._dHue();

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
        const l = 7 + val * 70;
        tc.fillStyle = `hsl(${h},${s}%,${l}%)`;
      }
      tc.fillRect(W - 3, H - (i + 1) * barH, 3, barH + 1);
    }

    ctx.clearRect(0, 0, W, H);

    // Sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, H * 0.5);
    skyGrad.addColorStop(0, `hsla(${hue},40%,7%,1)`);
    skyGrad.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);

    // Perspective blit
    ctx.save();
    ctx.transform(1, 0, -0.06, 0.88, W * 0.03, H * 0.08);
    ctx.drawImage(tb, 0, 0);
    ctx.restore();

    // Horizon glow
    const horizGrad = ctx.createLinearGradient(0, H * 0.15, 0, H * 0.42);
    horizGrad.addColorStop(0, `hsla(${hue},80%,55%,${0.04 + this._sBass * 0.2})`);
    horizGrad.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = horizGrad;
    ctx.fillRect(0, H * 0.15, W, H * 0.32);
  }

  // ── Mode 5: Particles (with gravity well) ─────────────────────────────────

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

  _tickPool(pool, dt, well = null) {
    const ctx = this.ctx;
    for (let i = pool.length - 1; i >= 0; i--) {
      const p = pool[i];
      if (p.trail) {
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 4) p.trail.shift();
      }
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      p.vy += p.gy * dt;

      if (well) {
        const dx = well.x - p.x, dy = well.y - p.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 25);
        const force = well.strength / dist;
        p.vx += (dx / dist) * force * dt;
        p.vy += (dy / dist) * force * dt;
      }

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
    const s   = window.VIZ_SETTINGS;
    const r   = s.reactivity;
    const hue = this._dHue();

    this._applyFade(0.04);

    // Drifting gravity well
    this._gravWellT += dt;
    const wellX = W / 2 + Math.sin(this._gravWellT * 0.31) * W * 0.28;
    const wellY = H / 2 + Math.cos(this._gravWellT * 0.23) * H * 0.22;
    const wellStr = this._sBass * r * 180;

    const wellR = 6 + this._sBass * 20;
    const wellGrad = ctx.createRadialGradient(wellX, wellY, 0, wellX, wellY, wellR);
    wellGrad.addColorStop(0, `hsla(${hue},80%,65%,${0.08 + this._sBass * 0.18})`);
    wellGrad.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.beginPath();
    ctx.arc(wellX, wellY, wellR, 0, TWO_PI);
    ctx.fillStyle = wellGrad; ctx.fill();

    if (bands.bass > 0.45) {
      const n = Math.ceil((bands.bass - 0.45) * 6 * r);
      for (let i = 0; i < n; i++) {
        this._addParticle(this._bassParticles, 80, {
          x: W / 2 + (Math.random() - 0.5) * W * 0.5,
          y: H / 2 + (Math.random() - 0.5) * H * 0.4,
          speed: 15 + bands.bass * 45, dvy: -25, gy: 85,
          decay: 0.22 + Math.random() * 0.12,
          size: 9 + bands.bass * 13, hue: (hue + 5) % 360,
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
          size: 3 + bands.mid * 6, hue: (hue + 35) % 360,
        });
      }
    }
    if (bands.high > 0.20) {
      const n = Math.ceil(bands.high * 7 * r);
      for (let i = 0; i < n; i++) {
        this._addParticle(this._highParticles, 110, {
          x: Math.random() * W, y: H * 0.25 + Math.random() * H * 0.75,
          speed: 70 + bands.high * 160, dvy: -(55 + bands.high * 75), gy: -35,
          decay: 0.85 + Math.random() * 0.55,
          size: 1 + bands.high * 3, hue: (hue + 65) % 360,
        });
      }
    }

    this._tickPool(this._bassParticles, dt);
    this._tickPool(this._midParticles,  dt, { x: wellX, y: wellY, strength: wellStr });
    this._tickPool(this._highParticles, dt);
  }

  // ── Mode 6: Lissajous ─────────────────────────────────────────────────────

  _drawLissajous(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const s   = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    this._applyFade();

    const driftAmp = Math.min(W, H) * 0.12;
    this._lissDriftX += this._lissDriftVX * dt;
    this._lissDriftY += this._lissDriftVY * dt;
    if (Math.abs(this._lissDriftX) > driftAmp) this._lissDriftVX *= -1;
    if (Math.abs(this._lissDriftY) > driftAmp) this._lissDriftVY *= -1;
    this._lissRotation += dt * (0.04 + this._sMid * 0.08 * r);

    const cx = W / 2 + this._lissDriftX;
    const cy = H / 2 + this._lissDriftY;

    for (const c of this.curves) {
      c.phase += c.phaseSpeed * dt;
      c.a     += c.aRate * dt;
      c.b     += c.bRate * dt;
      if (c.a > 7.5 || c.a < 1.5) c.aRate *= -1;
      if (c.b > 6.5 || c.b < 1.5) c.bRate *= -1;
    }
    for (let i = 0; i < this._curveHueOffsets.length; i++) {
      this._curveHueOffsets[i] = (this._curveHueOffsets[i] + (8 + i * 5) * dt) % 360;
    }

    const energy  = this._sMid + this._sBass * 0.5;
    const baseR   = Math.min(W, H) * 0.36;
    const amp     = baseR * (0.55 + energy * 0.45);
    const sat     = 55 + energy * 40;
    const lineW   = (1.0 + energy * 2.5) * (1 + this._beatPulse * 3.5 * r);
    const SYM     = Math.max(1, s.symmetry);
    const nCurves = Math.min(s.curveCount ?? 2, this.curves.length);
    const steps   = Math.max(5, Math.min(50, s.lissSteps ?? CURVE_STEPS));

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._lissRotation);

    for (let sym = 0; sym < SYM; sym++) {
      ctx.save();
      ctx.rotate((sym / SYM) * TWO_PI);
      if (sym % 2 === 1) ctx.scale(1, -1);

      this.curves.slice(0, nCurves).forEach((c, ci) => {
        const cHue  = (hue + this._curveHueOffsets[ci] + sym * (360 / SYM) * 0.4) % 360;
        const light = 36 + energy * 22 + this._beatPulse * 26;
        const alpha = 0.50 + this._beatPulse * 0.34;

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
          ctx.lineWidth = lineW * 3; ctx.stroke();
          ctx.restore();
        }

        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const t = (i / steps) * CURVE_PERIOD;
          const x = amp * Math.sin(c.a * t + c.phase);
          const y = amp * Math.sin(c.b * t);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${cHue},${sat}%,${light}%,${alpha})`;
        ctx.lineWidth = lineW; ctx.stroke();
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
    const s   = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    this._applyFade();

    const baseRadius = Math.min(W, H) * 0.25;
    this._blobPhase += dt * (1.5 + this._sMid * 2);

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
        const disp   = (noise1 + noise2 * this._sMid * r + noise3 * this._sHigh * r) * baseRadius * 0.35;
        const rad    = baseRadius * layerScale * (1 + this._sBass * 0.6 * r + this._beatPulse * 0.3) + disp;
        const x = cx + rad * Math.cos(angle), y = cy + rad * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      const layerHue = (hue + layer * 40) % 360;
      ctx.fillStyle   = `hsla(${layerHue},75%,50%,${layerAlpha * 0.5})`;
      ctx.fill();
      ctx.strokeStyle = `hsla(${layerHue},80%,65%,${layerAlpha})`;
      ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  // ── Mode 8: Rings ─────────────────────────────────────────────────────────

  _drawRings(freqData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s   = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    this._applyFade(0.08);

    const maxR   = Math.min(W, H) * 0.45;
    const innerR = maxR * 0.1;

    ctx.save();
    ctx.translate(cx, cy);
    this._radialAngle += dt * (0.2 + this._sMid * 2 * r);
    ctx.rotate(this._radialAngle);
    ctx.globalCompositeOperation = 'screen';

    for (let i = 0; i < 8; i++) {
      const binStart = Math.floor((i / 8) * 90);
      const binEnd   = Math.floor(((i + 1) / 8) * 90);
      let energy = 0;
      for (let b = binStart; b < binEnd; b++) energy += freqData[b] / 255;
      energy /= (binEnd - binStart);

      const baseR = innerR + (i / 7) * (maxR - innerR);
      const ringR = baseR + energy * 120 * r + this._beatPulse * 20;
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
      ctx.lineWidth   = rw.lineWidth; ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Mode 9: Spiral ────────────────────────────────────────────────────────

  _drawSpiral(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s   = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    this._applyFade(0.06);
    this._spiralAngle += dt * (0.15 + this._sMid * 0.5 * r);

    const maxR    = Math.min(W, H) * 0.46;
    const turns   = 3.5 + this._sMid * 1.5 * r;
    const beatExp = 1 + this._beatPulse * 0.35 * r;
    const len     = timeData.length;

    for (let arm = 0; arm < 2; arm++) {
      const armOffset = arm * Math.PI;
      const armHue    = (hue + arm * 160) % 360;

      ctx.beginPath();
      for (let i = 0; i < len; i++) {
        const t     = i / (len - 1);
        const angle = t * turns * TWO_PI + this._spiralAngle + armOffset;
        const base  = t * maxR * beatExp;
        const disp  = (timeData[i] / 128 - 1) * maxR * 0.12 * r;
        const rr    = base + disp;
        const x = cx + rr * Math.cos(angle), y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }

      const lw = 1.8 + this._sBass * 3 * r + this._beatPulse * 2.5;
      ctx.save();
      ctx.filter = `blur(${3 + this._beatPulse * 6}px)`;
      ctx.strokeStyle = `hsla(${armHue},85%,65%,${0.25 + this._beatPulse * 0.25})`;
      ctx.lineWidth = lw * 2.5; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = `hsla(${armHue},80%,68%,0.88)`;
      ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke();
    }
  }

  // ── Mode 10: Polygon ──────────────────────────────────────────────────────

  _drawPolygon(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s   = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    this._applyFade(0.07);
    this._polyRotation += dt * (0.18 + this._sMid * 0.6 * r);

    const ps = s.polyShape ?? 'random';
    if (ps !== 'random') {
      const fixed = parseInt(ps, 10);
      this._polySideTarget = fixed; this._polySides = fixed; this._polyMorphT = 1;
    }

    this._polyMorphT = Math.min(1, this._polyMorphT + dt * 2.5);
    const sides = this._polySides + (this._polySideTarget - this._polySides) * this._polyMorphT;
    if (this._polyMorphT >= 1) this._polySides = this._polySideTarget;

    const baseR  = Math.min(W, H) * 0.38;
    const LAYERS = 5;

    const polyPoint = (t, radius, rot) => {
      const fullAngle = t * TWO_PI;
      const sideF     = Math.floor(sides);
      const frac      = sides - sideF;
      const angleA    = Math.round(fullAngle / (TWO_PI / sideF)) * (TWO_PI / sideF);
      const angleB    = Math.round(fullAngle / (TWO_PI / (sideF + 1))) * (TWO_PI / (sideF + 1));
      const angle     = angleA + (angleB - angleA) * frac;
      const sideAngle = TWO_PI / sides;
      const modAngle  = ((fullAngle % sideAngle) + sideAngle) % sideAngle - sideAngle / 2;
      const edgeDist  = radius / Math.cos(modAngle);
      return { x: cx + edgeDist * Math.cos(fullAngle + rot), y: cy + edgeDist * Math.sin(fullAngle + rot) };
    };

    ctx.globalCompositeOperation = 'screen';

    for (let layer = LAYERS; layer >= 1; layer--) {
      const layerT     = layer / LAYERS;
      const layerR     = baseR * layerT * (1 + this._sBass * 0.5 * r + this._beatPulse * 0.25 * r);
      const layerHue   = (hue + layer * 28) % 360;
      const layerAlpha = 0.25 + layerT * 0.55;
      const lw         = 1 + (1 - layerT) * 3 + (layer === LAYERS ? this._beatPulse * 3 : 0);

      const steps = 300;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t     = i / steps;
        const pt    = polyPoint(t, layerR, this._polyRotation);
        const wIdx  = Math.floor(t * timeData.length);
        const wDisp = (timeData[wIdx] / 128 - 1) * layerR * 0.18 * r * layerT;
        const angle = t * TWO_PI + this._polyRotation;
        const x = pt.x + wDisp * Math.cos(angle), y = pt.y + wDisp * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();

      if (layer === LAYERS && this._beatPulse > 0.3) {
        ctx.save();
        ctx.filter = `blur(${this._beatPulse * 8}px)`;
        ctx.strokeStyle = `hsla(${layerHue},90%,70%,${this._beatPulse * 0.4})`;
        ctx.lineWidth = lw * 3; ctx.stroke();
        ctx.restore();
      }
      ctx.strokeStyle = `hsla(${layerHue},82%,62%,${layerAlpha})`;
      ctx.lineWidth = lw; ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Mode 11: Tunnel (heavy edge distortion on highs) ──────────────────────

  _drawTunnel(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s   = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    this._applyFade(0.22);

    const fallSpeed = 0.8 + this._sBass * 2.5 * r + this._beatPulse * 2.0 * r;
    this._tunnelSpeed += (fallSpeed - this._tunnelSpeed) * dt * 4;
    this._tunnelAngle += dt * (0.4 + this._sMid * 1.5 * r);

    const RING_COUNT = 28;
    if (this._tunnelRings.length < RING_COUNT) {
      const missing = RING_COUNT - this._tunnelRings.length;
      for (let i = 0; i < missing; i++) {
        this._tunnelRings.push({
          z: i / RING_COUNT, hue: (hue + i * (360 / RING_COUNT)) % 360,
          sides: 0, twist: Math.random() * TWO_PI,
        });
      }
    }

    for (const ring of this._tunnelRings) {
      ring.z   -= dt * this._tunnelSpeed * 0.18;
      ring.hue  = (ring.hue + dt * 40) % 360;
      if (ring.z <= 0) { ring.z += 1.0; ring.hue = (hue + Math.random() * 60) % 360; ring.twist = this._tunnelAngle; }
    }
    this._tunnelRings.sort((a, b) => b.z - a.z);

    const project = z => {
      const scale = 0.6 / Math.max(z, 0.001);
      return Math.min(scale * Math.min(W, H) * 0.55, Math.max(W, H) * 1.2);
    };

    ctx.globalCompositeOperation = 'screen';

    for (const ring of this._tunnelRings) {
      const radius  = project(ring.z);
      const opacity = Math.min(1, (1 - ring.z) * 1.8) * (0.4 + (1 - ring.z) * 0.55);
      const lw      = 1.5 + (1 - ring.z) * 5 + this._beatPulse * 3 * (1 - ring.z);
      const binIdx  = Math.floor(ring.z * Math.min(freqData.length, 180));
      const energy  = freqData[binIdx] / 255;
      const throb   = 1 + energy * 0.35 * r;
      const twist   = ring.twist + (1 - ring.z) * this._tunnelAngle * 0.3;

      // High-frequency edge distortion multiplier — strongest near z=0
      const highBoost = 1 + this._sHigh * 3.5 * r * (1 - ring.z);

      const SEGS = 80;
      ctx.beginPath();
      for (let i = 0; i <= SEGS; i++) {
        const angle   = (i / SEGS) * TWO_PI + twist;
        const warpBin = Math.floor((i / SEGS) * Math.min(freqData.length, 256));
        const warp    = (freqData[warpBin] / 255) * radius * 0.15 * r * (1 - ring.z) * highBoost;
        const twistJitter = ring.z < 0.3
          ? this._sHigh * Math.sin(angle * 7 + this._tunnelAngle * 3) * radius * 0.06 * r
          : 0;
        const rr = radius * throb + warp + twistJitter;
        const x = cx + rr * Math.cos(angle), y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      const light = 45 + (1 - ring.z) * 35;
      ctx.strokeStyle = `hsla(${ring.hue},90%,${light}%,${opacity})`;
      ctx.lineWidth   = lw; ctx.stroke();
    }

    if (timeData && timeData.length > 0) {
      const waveR   = Math.min(W, H) * 0.06;
      const waveAmp = waveR * (0.55 + this._sBass * 0.6 * r);
      const beatSc  = 1 + this._beatPulse * 0.25;
      const waveHue = (hue + 180) % 360;
      const lw      = 2 + this._beatPulse * 3 + this._sMid * 2;

      ctx.save();
      ctx.filter = `blur(${4 + this._beatPulse * 8}px)`;
      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 2) {
        const angle = (i / timeData.length) * TWO_PI + this._tunnelAngle;
        const disp  = (timeData[i] / 128 - 1) * waveAmp;
        const rr    = (waveR + disp) * beatSc;
        const x = cx + rr * Math.cos(angle), y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue},90%,70%,${0.35 + this._beatPulse * 0.3})`;
      ctx.lineWidth = lw * 2.5; ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      for (let i = 0; i < timeData.length; i += 2) {
        const angle = (i / timeData.length) * TWO_PI + this._tunnelAngle;
        const disp  = (timeData[i] / 128 - 1) * waveAmp;
        const rr    = (waveR + disp) * beatSc;
        const x = cx + rr * Math.cos(angle), y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${waveHue},85%,72%,0.9)`;
      ctx.lineWidth = lw; ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Mode 12: Galaxy / Starfield ───────────────────────────────────────────

  _drawGalaxy(freqData, bands, dt, isBeat) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s   = window.VIZ_SETTINGS;
    const r   = s.reactivity;
    const hue = this._dHue();

    if (this._stars.length === 0) {
      for (let i = 0; i < 600; i++) {
        this._stars.push({
          x: (Math.random() - 0.5) * 2,
          y: (Math.random() - 0.5) * 2,
          z: Math.random() * 0.99 + 0.01,
          px: 0, py: 0,
          bright: Math.random(),
        });
      }
    }

    this._applyFade(0.12);

    this._warpTarget = this._beatPulse > 0.7 ? 1.0 : 0.0;
    this._warpAmount = this._lerp(this._warpAmount, this._warpTarget, dt * 5);

    const fallSpeed = 0.4 + this._sBass * 2.0 * r + this._warpAmount * 4.0;
    this._galaxySpin += dt * (0.04 + this._sMid * 0.4 * r);

    ctx.globalCompositeOperation = 'screen';

    for (const star of this._stars) {
      const prevPX = star.px;
      const prevPY = star.py;

      star.z -= fallSpeed * dt * 0.25;
      if (star.z <= 0.001) {
        star.z = 1.0;
        star.x = (Math.random() - 0.5) * 2;
        star.y = (Math.random() - 0.5) * 2;
        star.px = 0; star.py = 0;
        continue;
      }

      // Spin in XY plane
      const spin = this._galaxySpin * dt * 0.5;
      const cosS = Math.cos(spin), sinS = Math.sin(spin);
      const nx = star.x * cosS - star.y * sinS;
      const ny = star.x * sinS + star.y * cosS;
      star.x = nx; star.y = ny;

      const sx = (star.x / star.z) * 0.5 * (W / 2) + cx;
      const sy = (star.y / star.z) * 0.5 * (H / 2) + cy;
      star.px = sx; star.py = sy;

      const brightness = (1 - star.z) * 0.8 + star.bright * 0.2;
      const starHue = s.colorMode === 'warm' ? (hue + star.z * 40) % 360
                    : s.colorMode === 'cool' ? (200 + star.z * 60) % 360
                    : (hue + star.z * 120) % 360;

      if (this._warpAmount > 0.05 && prevPX !== 0) {
        const streakX = cx + (prevPX - cx) * (1 + this._warpAmount * 2.5);
        const streakY = cy + (prevPY - cy) * (1 + this._warpAmount * 2.5);
        ctx.beginPath();
        ctx.moveTo(streakX, streakY);
        ctx.lineTo(sx, sy);
        ctx.strokeStyle = `hsla(${starHue},90%,${70 + brightness * 25}%,${brightness * 0.9})`;
        ctx.lineWidth = 0.8 + (1 - star.z) * 1.5 + this._warpAmount * 2;
        ctx.stroke();
      } else {
        const size = (1 - star.z) * 2.5 + this._sBass * 1.5 + 0.3;
        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, TWO_PI);
        ctx.fillStyle = `hsla(${starHue},85%,${70 + brightness * 25}%,${brightness * 0.85})`;
        ctx.fill();
      }
    }

    // Beat flash
    if (this._beatPulse > 0.3) {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * 0.35);
      grad.addColorStop(0, `rgba(255,255,255,${this._beatPulse * 0.3})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Mode 13: Fractal / Mandala ────────────────────────────────────────────

  _drawMandala(freqData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s   = window.VIZ_SETTINGS;
    const r   = s.reactivity;
    const hue = this._dHue();

    this._mandalaAngle += dt * (0.3 + this._sMid * 1.2 * r);
    this._mandalaPhase += dt * (0.8 + this._sHigh * 2.0 * r);

    const targetDepth = Math.min(4, 2 + Math.round(this._sBass * 2 * r));
    this._mandalaDepth = this._lerp(this._mandalaDepth, targetDepth, dt * 3);
    const maxDepth = Math.floor(this._mandalaDepth);

    this._applyFade(0.04);

    const baseLen = Math.min(W, H) * (0.16 + this._sBass * 0.08 * r);
    const SYM = Math.max(2, s.symmetry ?? 6);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._mandalaAngle);
    ctx.globalCompositeOperation = 'screen';

    for (let k = 0; k < SYM; k++) {
      ctx.save();
      ctx.rotate((k / SYM) * TWO_PI);
      ctx.scale(1, k % 2 === 1 ? -1 : 1);
      this._drawMandalaTree(ctx, 0, 0, -Math.PI / 2, baseLen, 0, maxDepth, freqData, hue, r);
      ctx.restore();
    }

    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';

    // Center glow
    const coreR = Math.min(W, H) * 0.04 * (1 + this._beatPulse * 2);
    const grad  = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    grad.addColorStop(0, `hsla(${hue},90%,90%,${0.5 + this._beatPulse * 0.4})`);
    grad.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TWO_PI);
    ctx.fillStyle = grad; ctx.fill();
  }

  _drawMandalaTree(ctx, x, y, angle, len, depth, maxDepth, freqData, hue, r) {
    if (depth >= maxDepth || len < 3) return;

    const binIdx  = Math.min(freqData.length - 1, depth * 30 + Math.floor(Math.abs(angle * 10)) % 20);
    const freqVal = freqData[binIdx] / 255;
    const wobble  = Math.sin(this._mandalaPhase * 0.12 * (depth + 1) + angle) * 0.12;
    const endLen  = len * (0.8 + freqVal * 0.4 + wobble);
    const endX    = x + Math.cos(angle) * endLen;
    const endY    = y + Math.sin(angle) * endLen;

    const lineHue = (hue + depth * 45) % 360;
    const light   = 45 + freqVal * 35;
    const lw      = Math.max(0.5, (maxDepth - depth) * 1.2 - 0.3);
    const alpha   = 0.5 + freqVal * 0.45;

    if (this._beatPulse > 0.4 && depth < 2) {
      ctx.save();
      ctx.filter = `blur(${this._beatPulse * 4}px)`;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, endY);
      ctx.strokeStyle = `hsla(${lineHue},90%,${light}%,${alpha * 0.4})`;
      ctx.lineWidth = lw * 3; ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, endY);
    ctx.strokeStyle = `hsla(${lineHue},80%,${light}%,${alpha})`;
    ctx.lineWidth = lw; ctx.stroke();

    const branchAngle = 0.35 + freqVal * 0.3;
    const childLen    = len * (0.60 + freqVal * 0.15);

    this._drawMandalaTree(ctx, endX, endY, angle - branchAngle, childLen, depth + 1, maxDepth, freqData, hue, r);
    this._drawMandalaTree(ctx, endX, endY, angle + branchAngle, childLen, depth + 1, maxDepth, freqData, hue, r);
    if (depth === 0) {
      this._drawMandalaTree(ctx, endX, endY, angle, len * 0.7, depth + 1, maxDepth, freqData, hue, r);
    }
  }

  // ── Mode 14: Fluid Matrix ─────────────────────────────────────────────────

  _initFluidGrid(W, H) {
    const cols = this._fluidCols, rows = this._fluidRows;
    const grid = [];
    for (let row = 0; row < rows; row++) {
      grid[row] = [];
      for (let col = 0; col < cols; col++) {
        const rx = (col / (cols - 1)) * W;
        const ry = (row / (rows - 1)) * H;
        grid[row][col] = { rx, ry, x: rx, y: ry, vx: 0, vy: 0 };
      }
    }
    this._fluidGrid = grid;
    this._fluidW = W;
    this._fluidH = H;
  }

  _drawFluid(freqData, timeData, bands, dt, isBeat) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const s   = window.VIZ_SETTINGS;
    const r   = s.reactivity;
    const hue = this._dHue();

    if (!this._fluidGrid || this._fluidW !== W || this._fluidH !== H) {
      this._initFluidGrid(W, H);
    }

    this._applyFade(0.05);

    const grid  = this._fluidGrid;
    const cols  = this._fluidCols, rows = this._fluidRows;
    const cellW = W / (cols - 1);
    const stiffness   = 80;
    const damping     = 5;
    const neighborPull = 30;

    // Inject waveform at edges
    const tStep  = Math.floor(timeData.length / cols);
    const tStep2 = Math.floor(timeData.length / rows);
    for (let c = 0; c < cols; c++) {
      const wave = (timeData[Math.min(c * tStep, timeData.length - 1)] / 128 - 1);
      grid[0][c].vy += wave * this._sMid * 280 * r;
    }
    for (let row = 0; row < rows; row++) {
      const wave = (timeData[Math.min(row * tStep2, timeData.length - 1)] / 128 - 1);
      grid[row][0].vx += wave * this._sBass * 280 * r;
    }

    // Beat shockwave from center
    if (isBeat) {
      const midC = Math.floor(cols / 2), midR = Math.floor(rows / 2);
      for (let row = 0; row < rows; row++) {
        for (let c = 0; c < cols; c++) {
          const dx = c - midC, dy = row - midR;
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const force = bands.bass * 700 * r / (dist + 1);
          grid[row][c].vx += (dx / dist) * force;
          grid[row][c].vy += (dy / dist) * force;
        }
      }
    }

    // Physics
    const maxDisp = cellW * 1.5;
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < cols; c++) {
        const node = grid[row][c];
        const dX = node.x - node.rx, dY = node.y - node.ry;
        let nx = 0, ny = 0, nc = 0;
        if (row > 0)      { nx += grid[row-1][c].x - grid[row-1][c].rx; ny += grid[row-1][c].y - grid[row-1][c].ry; nc++; }
        if (row < rows-1) { nx += grid[row+1][c].x - grid[row+1][c].rx; ny += grid[row+1][c].y - grid[row+1][c].ry; nc++; }
        if (c > 0)        { nx += grid[row][c-1].x - grid[row][c-1].rx; ny += grid[row][c-1].y - grid[row][c-1].ry; nc++; }
        if (c < cols-1)   { nx += grid[row][c+1].x - grid[row][c+1].rx; ny += grid[row][c+1].y - grid[row][c+1].ry; nc++; }
        if (nc > 0) { nx /= nc; ny /= nc; }

        const ax = -stiffness * dX - damping * node.vx + neighborPull * (nx - dX);
        const ay = -stiffness * dY - damping * node.vy + neighborPull * (ny - dY);
        node.vx += ax * dt;
        node.vy += ay * dt;
        node.x  += node.vx * dt;
        node.y  += node.vy * dt;

        const ddx = node.x - node.rx, ddy = node.y - node.ry;
        const dd  = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dd > maxDisp) {
          node.x  = node.rx + ddx / dd * maxDisp;
          node.y  = node.ry + ddy / dd * maxDisp;
          node.vx *= 0.5; node.vy *= 0.5;
        }
      }
    }

    // Render
    ctx.globalCompositeOperation = 'screen';
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < cols; c++) {
        const node = grid[row][c];
        const dx   = node.x - node.rx, dy = node.y - node.ry;
        const disp = Math.sqrt(dx * dx + dy * dy) / cellW;
        const lineHue = (hue + disp * 180) % 360;
        const light   = 30 + disp * 45;
        const alpha   = 0.35 + Math.min(disp * 0.6, 0.6);
        const lw      = 0.5 + disp * 2.5;

        ctx.strokeStyle = `hsla(${lineHue},80%,${light}%,${alpha})`;
        ctx.lineWidth   = lw;

        if (c < cols - 1) {
          const nb = grid[row][c + 1];
          ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(nb.x, nb.y); ctx.stroke();
        }
        if (row < rows - 1) {
          const nb = grid[row + 1][c];
          ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(nb.x, nb.y); ctx.stroke();
        }

        if (disp > 0.08) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, 0.5 + disp * 3.5, 0, TWO_PI);
          ctx.fillStyle = `hsla(${lineHue},90%,75%,${alpha * 0.8})`;
          ctx.fill();
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
