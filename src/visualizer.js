// FFT-driven music visualizer — 11 visualization modes.
// app.js calls draw(freqData, timeData, ts, beatInfo) every RAF frame.
// window.VIZ_SETTINGS is written by the panel script and read every frame.
//
// Modes:
//   spectrum, waveform, radial, terrain, fractal, lissajous, blob,
//   spiral, polygon, tunnel, rings

const TWO_PI           = Math.PI * 2;
const CURVE_STEPS      = 150;   // low enough to stay smooth at 6× symmetry
const CURVE_PERIOD     = Math.PI * 10;
const BEAT_COOLDOWN_MS = 200;
const BRANCH_STEPS     = 20;   // waveform steps per fractal branch

window.VIZ_SETTINGS ??= {
  fadeAlpha:    0.03,
  curveCount:   2,
  symmetry:     4,
  colorMode:    'cycle',
  fractalDepth: 3,        // depth 2/3/4
  fractalType:  'tree',   // tree, snowflake, sierpinski, fern, dragon
  reactivity:   0.7,
  mode:         'lissajous',
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

    // Beat detection
    this._bassHistory = new Float32Array(60);
    this._bassHistIdx = 0;
    this._lastBeatMs  = 0;
    this._beatPulse   = 0;
    this._lastTs      = 0;

    // Lissajous — three mutating curves
    this.curves = [
      { a: 3.0, b: 2.0, phase: 0,          phaseSpeed:  0.40, aRate:  0.10, bRate:  0.08 },
      { a: 5.0, b: 4.0, phase: TWO_PI/3,   phaseSpeed: -0.32, aRate: -0.08, bRate:  0.11 },
      { a: 7.0, b: 6.0, phase: TWO_PI*2/3, phaseSpeed:  0.25, aRate:  0.06, bRate: -0.09 },
    ];
    this._curveHueOffsets = [0, 120, 240];
    this._shockwaves      = [];
    this._lissDriftX  = 0;
    this._lissDriftY  = 0;
    this._lissDriftVX = 18;
    this._lissDriftVY = 11;
    this._lissRotation = 0;

    // Radial
    this._radialAngle  = 0;
    this._radialAngle2 = Math.PI;

    // Terrain offscreen
    this._terrainBuf = document.createElement('canvas');
    this._terrainCtx = this._terrainBuf.getContext('2d');

    this._prevMode = null;

    // Spectrum peaks
    this._spectrumPeaks = new Array(128).fill(0);

    // Blob
    this._blobPhase = 0;

    // Rings
    this._ringWaves = [];

    // Spiral
    this._spiralAngle = 0;

    // Polygon
    this._polySides      = 3;
    this._polySideTarget = 3;
    this._polyMorphT     = 0;
    this._polyRotation   = 0;

    // Tunnel
    this._tunnelRings = [];
    this._tunnelAngle = 0;
    this._tunnelSpeed = 1;

    // Fractal
    this._fractalPhase = 0;
    // Dragon curve precomputed sequence
    this._dragonSeq = null;
    this._dragonDepth = 0;

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
    this._tunnelRings = [];
  }

  // ── Main entry ─────────────────────────────────────────────────────────────

  draw(freqData, timeData, ts, externalBands) {
    const dt = Math.min((ts - this._lastTs) / 1000, 0.1);
    this._lastTs = ts;

    const s    = window.VIZ_SETTINGS;
    const mode = s.mode ?? 'lissajous';

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
      this._shockwaves.push({ r: 0, speed: 260 + bands.bass * 180, opacity: 0.65, hue: this.hue });
      if (mode === 'polygon') {
        this._polySideTarget = 3 + Math.floor(Math.random() * 6);
        this._polyMorphT = 0;
      }
    }

    for (let i = this._shockwaves.length - 1; i >= 0; i--) {
      const sw = this._shockwaves[i];
      sw.r       += sw.speed * dt;
      sw.opacity -= dt * 2.2;
      if (sw.opacity <= 0) this._shockwaves.splice(i, 1);
    }

    if (mode !== this._prevMode) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._terrainCtx.fillStyle = '#000';
      this._terrainCtx.fillRect(0, 0, this._terrainBuf.width, this._terrainBuf.height);
      if (mode === 'rings')   this._ringWaves   = [];
      if (mode === 'tunnel')  this._tunnelRings  = [];
      if (mode === 'polygon') { this._polyMorphT = 0; this._polySides = 3; this._polySideTarget = 3; }
      this._prevMode = mode;
    }

    switch (mode) {
      case 'spectrum':  this._drawSpectrum(freqData, bands, dt);            break;
      case 'waveform':  this._drawWaveform(timeData, bands);                break;
      case 'radial':    this._drawRadial(freqData, timeData, bands, dt);    break;
      case 'terrain':   this._drawTerrain(freqData);                        break;
      case 'fractal':   this._drawFractal(freqData, timeData, bands, dt);   break;
      case 'lissajous': this._drawLissajous(timeData, bands, dt);           break;
      case 'blob':      this._drawBlob(timeData, bands, dt);                break;
      case 'rings':     this._drawRings(freqData, timeData, bands, dt);     break;
      case 'spiral':    this._drawSpiral(freqData, timeData, bands, dt);    break;
      case 'polygon':   this._drawPolygon(freqData, timeData, bands, dt);   break;
      case 'tunnel':    this._drawTunnel(freqData, timeData, bands, dt);    break;
      default:          this._drawLissajous(timeData, bands, dt);
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

  // Color mode → base hue
  _dHue() {
    const s = window.VIZ_SETTINGS;
    if (s.colorMode === 'warm')     return 40  + Math.sin(this.hue * 0.05) * 20;
    if (s.colorMode === 'cool')     return 240 + Math.sin(this.hue * 0.04) * 40;
    if (s.colorMode === 'reactive') return (this.hue + 200) % 360;
    return this.hue; // cycle
  }

  // ── Fade helper — ALWAYS in source-over, never in screen mode ─────────────
  // Call this BEFORE switching to 'screen' composite for drawing.
  _applyFade(W, H) {
    const s = window.VIZ_SETTINGS;
    const { ctx } = this;
    // Reset to source-over before the fade rect — critical so we never paint
    // the fade rect while in 'screen' mode (which causes grey trails).
    ctx.globalCompositeOperation = 'source-over';
    const fa = Math.max(s.fadeAlpha * 2.5, 0.08);
    ctx.fillStyle = `rgba(0,0,0,${Math.min(fa, 1)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Mode 1: Spectrum ───────────────────────────────────────────────────────

  _drawSpectrum(freqData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const s = window.VIZ_SETTINGS;

    // Fade using direct source-over (spectrum stays source-over throughout)
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    const BAR_COUNT = 128;
    const barW  = W / BAR_COUNT;
    const hue   = this._dHue();
    const cx    = W / 2;
    const pulse = 1 + this._beatPulse * 0.30;

    for (let i = 0; i < BAR_COUNT; i++) {
      const t      = i / BAR_COUNT;
      const binIdx = Math.floor(t * Math.min(freqData.length, 512) * 0.72);
      const val    = freqData[binIdx] / 255;
      const barH   = val * H * 0.88 * pulse;

      // Color flows outward from center — distance from center bar
      const distFrac = Math.abs(i - BAR_COUNT / 2) / (BAR_COUNT / 2);
      const barHue  = (hue + distFrac * 80 + val * 40) % 360;
      const light   = 40 + distFrac * 45;

      let bx = i * barW, bw = barW - 1;
      if (i < 14 && bands.bass > 0.62) {
        const bloom = (bands.bass - 0.62) / 0.38;
        bw += bloom * barW * 1.4;
        bx -= bloom * barW * 0.7;
      }

      ctx.shadowColor = `hsla(${barHue},100%,70%,0.8)`;
      ctx.shadowBlur  = 6 + val * 10;
      ctx.fillStyle   = `hsla(${barHue},82%,${light}%,${0.55 + val * 0.45})`;
      ctx.fillRect(bx, H - barH, bw, barH);
      ctx.shadowBlur  = 0;

      if (barH > this._spectrumPeaks[i]) {
        this._spectrumPeaks[i] = barH;
      } else {
        this._spectrumPeaks[i] = Math.max(0, this._spectrumPeaks[i] - dt * 120);
      }
      ctx.fillStyle = `hsla(${barHue},95%,85%,0.9)`;
      ctx.fillRect(bx, H - this._spectrumPeaks[i], bw, 2);
    }
  }

  // ── Mode 2: Waveform ───────────────────────────────────────────────────────

  _drawWaveform(timeData, bands) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const s = window.VIZ_SETTINGS;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,${Math.max(s.fadeAlpha, 0.04)})`;
    ctx.fillRect(0, 0, W, H);

    const len  = timeData.length;
    const midY = H / 2;
    const amp  = H * 0.36;
    const lw   = 2.5 + bands.bass * 4 + this._beatPulse * 2.5;
    const hue  = this._dHue();
    const cx   = W / 2;

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
    ctx.shadowColor = `hsla(${hue},100%,70%,0.9)`;
    ctx.shadowBlur  = 8 + this._beatPulse * 20;
    drawLine(1, 0.9);
    ctx.shadowBlur  = 0;
  }

  // ── Mode 3: Radial ─────────────────────────────────────────────────────────

  _drawRadial(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const r  = s.reactivity;

    ctx.globalCompositeOperation = 'source-over';
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

    for (let i = 0; i < BARS; i++) {
      const val = freqData[i] / 255;
      if (val < 0.015) continue;
      const startA = i * sliceA + this._radialAngle;
      const endA   = startA + sliceA;
      const outerR = Math.max(innerR + 1, (innerR + val * (maxR - innerR)) * pulse);
      const distFrac = outerR / maxR;
      const barHue   = (hue + distFrac * 80 + val * 30) % 360;
      const light    = 35 + distFrac * 45;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startA, endA);
      ctx.arc(cx, cy, innerR, endA, startA, true);
      ctx.closePath();
      ctx.fillStyle = `hsla(${barHue},80%,${light}%,${0.5 + val * 0.5})`;
      ctx.fill();
    }

    if (timeData && timeData.length > 0) {
      const waveR   = innerR * 1.1;
      const waveAmp = innerR * (0.55 + bands.bass * 0.6 * r);
      const beatSc  = 1 + this._beatPulse * 0.25;
      const waveHue = (hue + 180) % 360;
      const lw      = 2 + this._beatPulse * 3 + bands.mid * 2;

      ctx.shadowColor = `hsla(${waveHue},100%,75%,0.9)`;
      ctx.shadowBlur  = 6 + this._beatPulse * 20;
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
      ctx.strokeStyle = `hsla(${waveHue},90%,75%,0.92)`;
      ctx.lineWidth   = lw;
      ctx.stroke();
      ctx.shadowBlur  = 0;

      // Counter-rotating second ring
      const waveR2   = innerR * 0.62;
      const waveAmp2 = innerR * (0.30 + bands.high * 0.4 * r);
      const waveHue2 = (hue + 90) % 360;
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
      ctx.lineWidth   = 1.5 + bands.high * 2;
      ctx.stroke();

      // Glowing core
      const coreR = innerR * (0.28 + bands.bass * 0.35 * r + this._beatPulse * 0.15);
      const grad  = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      grad.addColorStop(0,   `hsla(${hue},90%,90%,${0.6 + this._beatPulse * 0.3})`);
      grad.addColorStop(0.5, `hsla(${hue},80%,60%,${0.2 + this._beatPulse * 0.2})`);
      grad.addColorStop(1,   'hsla(0,0%,0%,0)');
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

  // ── Fractal branch drawing helper ──────────────────────────────────────────
  // Draws a branch as a waveform-displaced path from (x,y) to (x2,y2).
  // wi = starting waveform index offset, timeData = raw byte array, reactivity = r
  _drawBranch(x, y, x2, y2, wi, timeData, reactivity) {
    const { ctx } = this;
    const dx  = x2 - x;
    const dy  = y2 - y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return;
    const perpX = -dy / len;
    const perpY =  dx / len;
    ctx.beginPath();
    for (let step = 0; step <= BRANCH_STEPS; step++) {
      const t    = step / BRANCH_STEPS;
      const wIdx = Math.floor((wi * BRANCH_STEPS + step) % timeData.length);
      const wave = (timeData[wIdx] / 128 - 1) * len * 0.25 * reactivity;
      const bx   = x + dx * t + perpX * wave;
      const by   = y + dy * t + perpY * wave;
      step === 0 ? ctx.moveTo(bx, by) : ctx.lineTo(bx, by);
    }
    ctx.stroke();
  }

  // ── Mode 5: Fractal ───────────────────────────────────────────────────────

  _drawFractal(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const s      = window.VIZ_SETTINGS;
    const hue    = this._dHue();
    const r      = s.reactivity;
    const depth  = Math.max(2, Math.min(4, s.fractalDepth ?? 3));
    const ftype  = s.fractalType ?? 'tree';

    // Fade BEFORE switching to screen mode
    this._applyFade(W, H);

    this._fractalPhase += dt * (0.3 + bands.mid * 0.8 * r);

    ctx.globalCompositeOperation = 'screen';

    switch (ftype) {
      case 'snowflake': this._drawFractalSnowflake(W, H, hue, r, depth, timeData, bands); break;
      case 'sierpinski': this._drawFractalSierpinski(W, H, hue, r, depth, timeData, bands); break;
      case 'fern':      this._drawFractalFern(W, H, hue, r, depth, timeData, bands); break;
      case 'dragon':    this._drawFractalDragon(W, H, hue, r, depth, timeData, bands); break;
      default:          this._drawFractalTree(W, H, hue, r, depth, timeData, bands); break;
    }

    ctx.globalCompositeOperation = 'source-over';

    const cx = W / 2, cy = H * 0.75;
    for (const sw of this._shockwaves) {
      ctx.beginPath();
      ctx.arc(cx, cy, sw.r, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${sw.hue},90%,76%,${sw.opacity})`;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  // ── Fractal: Tree ─────────────────────────────────────────────────────────

  _drawFractalTree(W, H, hue, r, depth, timeData, bands) {
    const { ctx } = this;
    const baseLen = Math.min(W, H) * (0.22 + bands.bass * 0.08 * r);
    const cx = W / 2;
    const cy = H * 0.75;

    const WAVE_SAMPLES = 32;
    const waveSamples  = new Float32Array(WAVE_SAMPLES);
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const idx = Math.floor((i / WAVE_SAMPLES) * timeData.length);
      waveSamples[i] = (timeData[idx] / 128 - 1);
    }

    const FREQ_SAMPLES = 16;
    const freqSamples  = new Float32Array(FREQ_SAMPLES);
    for (let i = 0; i < FREQ_SAMPLES; i++) {
      const idx = Math.floor((i / FREQ_SAMPLES) * Math.min(bands.bass !== undefined ? 128 : 128, 128));
      // Use timeData as proxy for freq
      freqSamples[i] = Math.abs(waveSamples[i % WAVE_SAMPLES]);
    }

    const stack = [];
    stack.push({ x: cx, y: cy, angle: -Math.PI / 2, len: baseLen, d: depth, wi: 0 });

    let safetyCount = 0;
    const maxNodes  = depth === 4 ? 400 : depth === 3 ? 180 : 80;

    while (stack.length > 0 && safetyCount < maxNodes) {
      safetyCount++;
      const { x, y, angle, len, d, wi } = stack.pop();

      const x2 = x + Math.cos(angle) * len;
      const y2 = y + Math.sin(angle) * len;

      const depthFrac = (depth - d) / depth;
      const branchHue = (hue + depthFrac * 120) % 360;
      const light     = 40 + depthFrac * 45;
      const alpha     = 0.5 + depthFrac * 0.45;
      const lw        = Math.max(0.5, (d + 0.5) * 0.9 + bands.bass * 1.5 * r);

      // Glow on outermost branches only
      if (depthFrac > 0.6) {
        ctx.shadowColor = `hsla(${branchHue},100%,70%,0.7)`;
        ctx.shadowBlur  = depthFrac * (8 + this._beatPulse * 12);
      } else {
        ctx.shadowBlur = 0;
      }
      ctx.strokeStyle = `hsla(${branchHue},85%,${light}%,${alpha})`;
      ctx.lineWidth   = lw;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';

      this._drawBranch(x, y, x2, y2, wi, timeData, r);
      ctx.shadowBlur = 0;

      if (d > 0) {
        const wi1 = (wi + 1) % WAVE_SAMPLES;
        const wi2 = (wi + 3) % WAVE_SAMPLES;
        const spread    = (Math.PI / 4) + waveSamples[wi1] * 0.35 * r;
        const lenScale  = 0.62 + Math.abs(freqSamples[wi % FREQ_SAMPLES]) * 0.18 * r;
        const phaseWarp = Math.sin(this._fractalPhase + depthFrac * Math.PI) * 0.18 * r;
        stack.push({ x: x2, y: y2, angle: angle - spread + phaseWarp, len: len * lenScale, d: d - 1, wi: wi1 });
        stack.push({ x: x2, y: y2, angle: angle + spread + phaseWarp, len: len * lenScale, d: d - 1, wi: wi2 });
      }
    }
  }

  // ── Fractal: Koch Snowflake ────────────────────────────────────────────────

  _drawFractalSnowflake(W, H, hue, r, depth, timeData, bands) {
    const { ctx } = this;
    const cx = W / 2, cy = H / 2;
    const size = Math.min(W, H) * 0.38 * (1 + bands.bass * 0.15 * r);

    // Build Koch snowflake edges iteratively
    // Start with equilateral triangle
    const h3 = (Math.sqrt(3) / 2) * size;
    let pts = [
      { x: cx,          y: cy - h3 * 2 / 3 },
      { x: cx + size/2, y: cy + h3 / 3 },
      { x: cx - size/2, y: cy + h3 / 3 },
    ];

    // Iteratively subdivide edges (Koch curve)
    for (let iter = 0; iter < depth; iter++) {
      const next = [];
      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const a = { x: p1.x + dx / 3, y: p1.y + dy / 3 };
        const b = { x: p1.x + dx * 2 / 3, y: p1.y + dy * 2 / 3 };
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const len = Math.sqrt(dx * dx + dy * dy) / 3;
        const angle = Math.atan2(dy, dx) - Math.PI / 3;
        const peak = { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len };
        next.push(p1, a, peak, b);
      }
      pts = next;
    }

    // Draw each edge as a waveform-displaced branch
    const totalEdges = pts.length;
    for (let i = 0; i < totalEdges; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % totalEdges];
      const distFrac = Math.sqrt((p1.x - cx) ** 2 + (p1.y - cy) ** 2) / (Math.min(W, H) * 0.5);
      const edgeHue  = (hue + distFrac * 80) % 360;
      const light    = 40 + distFrac * 45;
      ctx.strokeStyle = `hsla(${edgeHue},85%,${light}%,0.88)`;
      ctx.lineWidth   = 1.2 + bands.mid * 1.5 * r;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';
      if (distFrac > 0.7) {
        ctx.shadowColor = `hsla(${edgeHue},100%,70%,0.7)`;
        ctx.shadowBlur  = 4 + this._beatPulse * 10;
      } else {
        ctx.shadowBlur = 0;
      }
      this._drawBranch(p1.x, p1.y, p2.x, p2.y, i, timeData, r * 0.4);
      ctx.shadowBlur = 0;
    }
  }

  // ── Fractal: Sierpinski Triangle ──────────────────────────────────────────

  _drawFractalSierpinski(W, H, hue, r, depth, timeData, bands) {
    const { ctx } = this;
    const cx = W / 2, cy = H / 2;
    const size = Math.min(W, H) * 0.42 * (1 + bands.bass * 0.1 * r);
    const h3   = (Math.sqrt(3) / 2) * size;

    // Root triangle
    const rootTri = [
      { x: cx,          y: cy - h3 * 2 / 3 },
      { x: cx + size/2, y: cy + h3 / 3 },
      { x: cx - size/2, y: cy + h3 / 3 },
    ];

    // Iterative Sierpinski via subdivision — collect leaf triangles
    let triangles = [rootTri];
    for (let iter = 0; iter < depth; iter++) {
      const next = [];
      for (const tri of triangles) {
        const [a, b, c] = tri;
        const ab = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const bc = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
        const ca = { x: (c.x + a.x) / 2, y: (c.y + a.y) / 2 };
        next.push([a, ab, ca], [ab, b, bc], [ca, bc, c]);
      }
      triangles = next;
      if (triangles.length > 600) break; // safety cap
    }

    let wi = 0;
    for (const tri of triangles) {
      const centX = (tri[0].x + tri[1].x + tri[2].x) / 3;
      const centY = (tri[0].y + tri[1].y + tri[2].y) / 3;
      const distFrac = Math.sqrt((centX - cx) ** 2 + (centY - cy) ** 2) / (Math.min(W, H) * 0.5);
      const triHue   = (hue + distFrac * 80) % 360;
      const light    = 40 + distFrac * 45;
      ctx.strokeStyle = `hsla(${triHue},85%,${light}%,0.82)`;
      ctx.lineWidth   = 1 + bands.mid * r;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';
      if (distFrac > 0.6) {
        ctx.shadowColor = `hsla(${triHue},100%,70%,0.6)`;
        ctx.shadowBlur  = 3 + this._beatPulse * 8;
      } else {
        ctx.shadowBlur = 0;
      }
      for (let e = 0; e < 3; e++) {
        const p1 = tri[e];
        const p2 = tri[(e + 1) % 3];
        this._drawBranch(p1.x, p1.y, p2.x, p2.y, wi++, timeData, r * 0.3);
      }
      ctx.shadowBlur = 0;
    }
  }

  // ── Fractal: Barnsley Fern ────────────────────────────────────────────────

  _drawFractalFern(W, H, hue, r, depth, timeData, bands) {
    const { ctx } = this;
    const cx = W / 2;
    const baseY = H * 0.88;
    const scaleF = Math.min(W, H) * (0.065 + bands.bass * 0.015 * r);

    // 4 affine transforms for Barnsley fern
    const transforms = [
      { a:  0,     b:  0,     c:  0,     d:  0.16,  e: 0, f: 0,     p: 0.01 },
      { a:  0.85,  b:  0.04,  c: -0.04,  d:  0.85,  e: 0, f: 1.6,   p: 0.85 },
      { a:  0.20,  b: -0.26,  c:  0.23,  d:  0.22,  e: 0, f: 1.6,   p: 0.07 },
      { a: -0.15,  b:  0.28,  c:  0.26,  d:  0.24,  e: 0, f: 0.44,  p: 0.07 },
    ];

    const ITER = depth === 4 ? 4000 : depth === 3 ? 2000 : 1000;
    let fx = 0, fy = 0;

    // Skip first 20 iterations for convergence
    for (let i = 0; i < 20; i++) {
      const rnd = Math.random();
      let cum = 0;
      for (const t of transforms) {
        cum += t.p;
        if (rnd < cum) {
          const nx = t.a * fx + t.b * fy + t.e;
          const ny = t.c * fx + t.d * fy + t.f;
          fx = nx; fy = ny;
          break;
        }
      }
    }

    const wLen = timeData.length;
    for (let i = 0; i < ITER; i++) {
      const rnd = Math.random();
      let cum = 0;
      for (const t of transforms) {
        cum += t.p;
        if (rnd < cum) {
          const nx = t.a * fx + t.b * fy + t.e;
          const ny = t.c * fx + t.d * fy + t.f;
          fx = nx; fy = ny;
          break;
        }
      }

      const sx = cx + fx * scaleF;
      const sy = baseY - fy * scaleF;

      const distFrac = Math.sqrt((sx - cx) ** 2 + (sy - H / 2) ** 2) / (Math.min(W, H) * 0.5);
      const ptHue    = (hue + distFrac * 80 + fy * 5) % 360;
      const light    = 40 + distFrac * 45;

      // Waveform-reactive stroke length
      const wIdx   = i % wLen;
      const wave   = (timeData[wIdx] / 128 - 1) * 3 * r;
      const strokeR = 1.5 + Math.abs(wave) + bands.mid * 2 * r;

      ctx.beginPath();
      ctx.arc(sx, sy, strokeR * 0.5, 0, TWO_PI);
      ctx.fillStyle = `hsla(${ptHue},85%,${light}%,0.7)`;
      ctx.fill();
    }
  }

  // ── Fractal: Dragon Curve ─────────────────────────────────────────────────

  _drawFractalDragon(W, H, hue, r, depth, timeData, bands) {
    const { ctx } = this;
    const cx = W / 2, cy = H / 2;

    // Build dragon curve iteratively
    // Start with a single segment direction sequence [1] means turn right
    const iters = Math.min(depth * 3, 10);
    if (this._dragonSeq === null || this._dragonDepth !== iters) {
      let seq = [1];
      for (let i = 0; i < iters - 1; i++) {
        const copy = seq.slice().reverse().map(x => -x);
        seq = [...seq, 1, ...copy];
      }
      this._dragonSeq  = seq;
      this._dragonDepth = iters;
    }
    const seq = this._dragonSeq;

    const segLen = Math.min(W, H) * 0.36 / Math.pow(Math.sqrt(2), iters);
    let px = cx, py = cy;
    let angle = 0;
    const totalSegs = seq.length + 1;

    for (let i = 0; i < totalSegs; i++) {
      const nx = px + Math.cos(angle) * segLen;
      const ny = py + Math.sin(angle) * segLen;

      const distFrac = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2) / (Math.min(W, H) * 0.5);
      const segHue   = (hue + distFrac * 80 + (i / totalSegs) * 60) % 360;
      const light    = 40 + distFrac * 45;
      ctx.strokeStyle = `hsla(${segHue},85%,${light}%,0.85)`;
      ctx.lineWidth   = 1.2 + bands.mid * r;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';

      if (distFrac > 0.6) {
        ctx.shadowColor = `hsla(${segHue},100%,70%,0.7)`;
        ctx.shadowBlur  = 3 + this._beatPulse * 8;
      } else {
        ctx.shadowBlur = 0;
      }

      this._drawBranch(px, py, nx, ny, i, timeData, r * 0.35);
      ctx.shadowBlur = 0;

      px = nx;
      py = ny;
      if (i < seq.length) {
        angle += seq[i] * Math.PI / 2;
      }
    }
  }

  // ── Mode 6: Lissajous ─────────────────────────────────────────────────────
  // timeData now perturbs the path for subtle waveform character.

  _drawLissajous(timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W  = canvas.width, H = canvas.height;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    // Fade in source-over BEFORE any other drawing
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    // Drift
    const driftAmp = Math.min(W, H) * 0.12;
    this._lissDriftX += this._lissDriftVX * dt;
    this._lissDriftY += this._lissDriftVY * dt;
    if (Math.abs(this._lissDriftX) > driftAmp) this._lissDriftVX *= -1;
    if (Math.abs(this._lissDriftY) > driftAmp) this._lissDriftVY *= -1;
    this._lissRotation += dt * (0.04 + bands.mid * 0.06 * r);

    const driftCX = W / 2 + this._lissDriftX;
    const driftCY = H / 2 + this._lissDriftY;
    const cx = driftCX, cy = driftCY;

    // Animate curves
    for (const c of this.curves) {
      c.phase += c.phaseSpeed * dt;
      c.a     += c.aRate * dt;
      c.b     += c.bRate * dt;
      if (c.a > 7.5 || c.a < 1.5) c.aRate *= -1;
      if (c.b > 6.5 || c.b < 1.5) c.bRate *= -1;
    }

    for (let i = 0; i < this._curveHueOffsets.length; i++) {
      this._curveHueOffsets[i] = (this._curveHueOffsets[i] + (6 + i * 4) * dt) % 360;
    }

    const energy  = bands.mid + bands.bass * 0.5;
    const baseR   = Math.min(W, H) * 0.36;
    const amp     = baseR * (0.55 + energy * 0.45);
    const SYM     = Math.min(s.symmetry, 6);
    const curveIdx = Math.min((s.curveCount ?? 1) - 1, this.curves.length - 1);
    const c        = this.curves[curveIdx];
    const tLen     = timeData ? timeData.length : 0;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._lissRotation);

    for (let sym = 0; sym < SYM; sym++) {
      ctx.save();
      ctx.rotate((sym / SYM) * TWO_PI);
      if (sym % 2 === 1) ctx.scale(1, -1);

      const armHue = (hue + this._curveHueOffsets[sym % 3] + sym * (360 / SYM)) % 360;
      const light  = 58 + energy * 18 + this._beatPulse * 20;
      const alpha  = 0.75 + this._beatPulse * 0.25;
      const lw     = (1.4 + energy * 1.8) * (1 + this._beatPulse * 1.8 * r);

      const SEGS   = CURVE_STEPS;
      const CHUNKS = 6;
      const segLen = Math.floor(SEGS / CHUNKS);

      for (let chunk = 0; chunk < CHUNKS; chunk++) {
        const chunkHue = (armHue + chunk * 18) % 360;
        ctx.shadowColor = chunk >= 3
          ? `hsla(${chunkHue},100%,72%,0.85)`
          : 'transparent';
        ctx.shadowBlur = chunk >= 3 ? (6 + this._beatPulse * 16 * r) : 0;

        ctx.beginPath();
        for (let i = chunk * segLen; i <= Math.min((chunk + 1) * segLen, SEGS); i++) {
          const t     = (i / SEGS) * CURVE_PERIOD;
          let x       = amp * Math.sin(c.a * t + c.phase);
          let y       = amp * Math.sin(c.b * t);
          // Subtle timeData perturbation
          if (tLen > 0) {
            const wIdx = Math.floor((i / SEGS) * tLen) % tLen;
            const wave = (timeData[wIdx] / 128 - 1) * amp * 0.04 * r;
            x += wave;
            y += wave * 0.7;
          }
          i === chunk * segLen ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${chunkHue},88%,${light}%,${alpha})`;
        ctx.lineWidth   = lw;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    ctx.restore();

    // Shockwaves centered on drift position
    for (const sw of this._shockwaves) {
      ctx.beginPath();
      ctx.arc(cx, cy, sw.r, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${sw.hue},90%,76%,${sw.opacity})`;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  // ── Mode 7: Blob ──────────────────────────────────────────────────────────
  // Blob outline driven by timeData samples around perimeter.

  _drawBlob(timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,${s.fadeAlpha})`;
    ctx.fillRect(0, 0, W, H);

    const baseRadius = Math.min(W, H) * 0.25;
    this._blobPhase += dt * (1.5 + bands.mid * 2);
    const tLen = timeData.length;

    for (let layer = 2; layer >= 0; layer--) {
      const layerAlpha = layer === 0 ? 0.85 : 0.15 + layer * 0.1;
      const layerScale = 1 + layer * 0.12;
      const layerHue   = (hue + layer * 40) % 360;
      const STEPS = 120;

      ctx.beginPath();
      for (let i = 0; i <= STEPS; i++) {
        const angle = (i / STEPS) * TWO_PI;
        // Map timeData around perimeter instead of sine noise
        const wIdx   = Math.floor((i / STEPS) * tLen) % tLen;
        const wave   = (timeData[wIdx] / 128 - 1);
        // Blend with a little sine for smoothness even at silence
        const sineNoise = Math.sin(angle * 3 + this._blobPhase) * 0.2;
        const disp   = (wave * 0.8 + sineNoise) * baseRadius * 0.35 * r;
        const rad    = baseRadius * layerScale * (1 + bands.bass * 0.6 * r + this._beatPulse * 0.3) + disp;

        const distFrac = rad / (baseRadius * 2);
        const x = cx + rad * Math.cos(angle);
        const y = cy + rad * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = `hsla(${layerHue},75%,50%,${layerAlpha * 0.4})`;
      ctx.fill();

      if (layer === 0) {
        ctx.shadowColor = `hsla(${layerHue},100%,70%,0.8)`;
        ctx.shadowBlur  = 8 + this._beatPulse * 16;
      }
      ctx.strokeStyle = `hsla(${layerHue},85%,65%,${layerAlpha})`;
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  // ── Mode 8: Rings ─────────────────────────────────────────────────────────
  // Each ring's circumference is driven by timeData — waveform-displaced circle.

  _drawRings(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;
    const tLen = timeData.length;

    // Fade in source-over BEFORE screen mode
    this._applyFade(W, H);

    const maxR   = Math.min(W, H) * 0.45;
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
      const distFrac = ringR / maxR;
      const ringHue  = (hue + distFrac * 80 + energy * 20) % 360;
      const light    = 35 + distFrac * 45;
      const lw       = 2 + energy * 15 * r;

      ctx.shadowColor = `hsla(${ringHue},100%,70%,0.7)`;
      ctx.shadowBlur  = 4 + energy * 12 + (i === 7 ? this._beatPulse * 14 : 0);
      ctx.strokeStyle = `hsla(${ringHue},88%,${light}%,${0.5 + energy * 0.5})`;
      ctx.lineWidth   = lw;
      ctx.lineJoin    = 'round';

      // Draw ring as waveform-displaced circle
      const RING_SEGS = 64;
      ctx.beginPath();
      for (let j = 0; j <= RING_SEGS; j++) {
        const angle  = (j / RING_SEGS) * TWO_PI;
        const wIdx   = Math.floor((j / RING_SEGS) * tLen) % tLen;
        const wave   = (timeData[wIdx] / 128 - 1) * ringR * 0.15 * r * energy;
        const rr     = ringR + wave;
        const x = rr * Math.cos(angle);
        const y = rr * Math.sin(angle);
        j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();

    ctx.globalCompositeOperation = 'source-over';

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
  }

  // ── Mode 9: Spiral ────────────────────────────────────────────────────────

  _drawSpiral(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,${Math.max(s.fadeAlpha, 0.04)})`;
    ctx.fillRect(0, 0, W, H);

    this._spiralAngle += dt * (0.15 + bands.mid * 0.5 * r);

    const maxR    = Math.min(W, H) * 0.46;
    const turns   = 3.5 + bands.mid * 1.5 * r;
    const beatExp = 1 + this._beatPulse * 0.35 * r;
    const len     = timeData.length;

    for (let arm = 0; arm < 2; arm++) {
      const armOffset = arm * Math.PI;
      const armHue    = (hue + arm * 160) % 360;
      const CHUNKS    = 8;
      const chunkLen  = Math.floor(len / CHUNKS);

      for (let chunk = 0; chunk < CHUNKS; chunk++) {
        const outFrac  = chunk / CHUNKS;
        const chunkHue = (armHue + outFrac * 80) % 360;
        const light    = 38 + outFrac * 42;
        const lw       = 1.4 + outFrac * 1.8 + bands.bass * 2 * r + this._beatPulse * 1.5;

        ctx.shadowColor = outFrac > 0.5 ? `hsla(${chunkHue},100%,70%,0.85)` : 'transparent';
        ctx.shadowBlur  = outFrac > 0.5 ? (6 + this._beatPulse * 16 * r) : 0;

        ctx.beginPath();
        const i0 = chunk * chunkLen;
        const i1 = Math.min((chunk + 1) * chunkLen, len - 1);
        for (let i = i0; i <= i1; i++) {
          const t     = i / (len - 1);
          const angle = t * turns * TWO_PI + this._spiralAngle + armOffset;
          const base  = t * maxR * beatExp;
          const disp  = (timeData[i] / 128 - 1) * maxR * 0.12 * r;
          const rr    = base + disp;
          const x = cx + rr * Math.cos(angle);
          const y = cy + rr * Math.sin(angle);
          i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${chunkHue},85%,${light}%,0.88)`;
        ctx.lineWidth   = lw;
        ctx.lineJoin    = 'round';
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    for (const sw of this._shockwaves) {
      ctx.beginPath();
      ctx.arc(cx, cy, sw.r, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${sw.hue},90%,76%,${sw.opacity})`;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  // ── Mode 10: Polygon ──────────────────────────────────────────────────────

  _drawPolygon(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;

    // Fade in source-over before screen
    this._applyFade(W, H);

    this._polyRotation += dt * (0.18 + bands.mid * 0.6 * r);
    this._polyMorphT    = Math.min(1, this._polyMorphT + dt * 2.5);
    const sides = this._polySides + (this._polySideTarget - this._polySides) * this._polyMorphT;
    if (this._polyMorphT >= 1) this._polySides = this._polySideTarget;

    const baseR  = Math.min(W, H) * 0.38;
    const LAYERS = 5;

    const polyPoint = (t, radius, rot) => {
      const sideAngle = TWO_PI / sides;
      const fullAngle = t * TWO_PI;
      const modAngle  = ((fullAngle % sideAngle) + sideAngle) % sideAngle - sideAngle / 2;
      const edgeDist  = radius / Math.cos(modAngle);
      return { x: cx + edgeDist * Math.cos(fullAngle + rot), y: cy + edgeDist * Math.sin(fullAngle + rot) };
    };

    ctx.globalCompositeOperation = 'screen';

    for (let layer = LAYERS; layer >= 1; layer--) {
      const layerT   = layer / LAYERS;
      const layerR   = baseR * layerT * (1 + bands.bass * 0.5 * r + this._beatPulse * 0.25 * r);
      const distFrac = layerR / (Math.min(W, H) * 0.7);
      const layerHue = (hue + distFrac * 80) % 360;
      const light    = 38 + distFrac * 45;
      const alpha    = 0.28 + layerT * 0.55;
      const lw       = 1 + (1 - layerT) * 3 + (layer === LAYERS ? this._beatPulse * 3 : 0);

      ctx.shadowColor = layer === LAYERS ? `hsla(${layerHue},100%,72%,0.9)` : 'transparent';
      ctx.shadowBlur  = layer === LAYERS ? (6 + this._beatPulse * 22 * r) : 0;

      const steps = 200;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t    = i / steps;
        const pt   = polyPoint(t, layerR, this._polyRotation);
        const wIdx = Math.floor(t * timeData.length);
        const disp = (timeData[wIdx] / 128 - 1) * layerR * 0.18 * r * layerT;
        const ang  = t * TWO_PI + this._polyRotation;
        const x    = pt.x + disp * Math.cos(ang);
        const y    = pt.y + disp * Math.sin(ang);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${layerHue},85%,${light}%,${alpha})`;
      ctx.lineWidth   = lw;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }

    ctx.globalCompositeOperation = 'source-over';

    for (const sw of this._shockwaves) {
      ctx.beginPath();
      ctx.arc(cx, cy, sw.r, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${sw.hue},90%,76%,${sw.opacity})`;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  // ── Mode 11: Tunnel ───────────────────────────────────────────────────────
  // Each tunnel ring perimeter is waveform-displaced.

  _drawTunnel(freqData, timeData, bands, dt) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const s  = window.VIZ_SETTINGS;
    const hue = this._dHue();
    const r   = s.reactivity;
    const tLen = timeData.length;

    // Fade in source-over BEFORE screen mode
    this._applyFade(W, H);

    const fallSpeed = 0.8 + bands.bass * 2.5 * r + this._beatPulse * 2.0 * r;
    this._tunnelSpeed += (fallSpeed - this._tunnelSpeed) * dt * 4;
    this._tunnelAngle += dt * (0.4 + bands.mid * 1.5 * r);

    const RING_COUNT = 24;
    if (this._tunnelRings.length < RING_COUNT) {
      const missing = RING_COUNT - this._tunnelRings.length;
      for (let i = 0; i < missing; i++) {
        this._tunnelRings.push({
          z:     (this._tunnelRings.length + i) / RING_COUNT,
          hue:   (hue + i * (360 / RING_COUNT)) % 360,
          twist: Math.random() * TWO_PI,
        });
      }
    }

    for (const ring of this._tunnelRings) {
      ring.z -= dt * this._tunnelSpeed * 0.18;
      ring.hue = (ring.hue + dt * 40) % 360;
      if (ring.z <= 0.02) {
        ring.z    += 1.0;
        ring.hue   = (hue + Math.random() * 60) % 360;
        ring.twist = this._tunnelAngle;
      }
    }

    this._tunnelRings.sort((a, b) => b.z - a.z);

    const minScreenR = Math.min(W, H) * 0.06;
    const project = z => {
      const fov   = 0.55;
      const scale = fov / Math.max(z, 0.001);
      return Math.max(minScreenR, Math.min(scale * Math.min(W, H) * 0.52, Math.max(W, H) * 1.2));
    };

    ctx.globalCompositeOperation = 'screen';

    for (const ring of this._tunnelRings) {
      const radius  = project(ring.z);
      const nearFac = 1 - ring.z;
      const opacity = Math.min(1, nearFac * 2.0) * (0.35 + nearFac * 0.6);
      const lw      = 1.5 + nearFac * 5 + this._beatPulse * 3 * nearFac;

      const binIdx = Math.floor(ring.z * Math.min(freqData.length, 180));
      const energy = freqData[binIdx] / 255;
      const throb  = 1 + energy * 0.35 * r;
      const twist  = ring.twist + nearFac * this._tunnelAngle * 0.3;

      const distFrac = radius / (Math.min(W, H) * 0.7);
      const ringHue  = (ring.hue + distFrac * 80) % 360;
      const light    = 35 + distFrac * 45;

      const SEGS = 64;
      ctx.beginPath();
      for (let i = 0; i <= SEGS; i++) {
        const angle  = (i / SEGS) * TWO_PI + twist;
        const wIdx   = Math.floor((i / SEGS) * tLen) % tLen;
        // Waveform drives ring perimeter shape
        const wave   = (timeData[wIdx] / 128 - 1) * radius * 0.18 * r * nearFac;
        const warpBin = Math.floor((i / SEGS) * Math.min(freqData.length, 256));
        const freqWarp = (freqData[warpBin] / 255) * radius * 0.08 * r * nearFac;
        const rr     = radius * throb + wave + freqWarp;
        const x = cx + rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();

      ctx.shadowColor = nearFac > 0.6 ? `hsla(${ringHue},100%,70%,0.8)` : 'transparent';
      ctx.shadowBlur  = nearFac > 0.6 ? (4 + nearFac * 14 + this._beatPulse * 10) : 0;
      ctx.strokeStyle = `hsla(${ringHue},90%,${light}%,${opacity})`;
      ctx.lineWidth   = lw;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }

    // Central glow
    const coreR = minScreenR * (1.2 + bands.bass * 2 * r + this._beatPulse * 1.5);
    const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    coreG.addColorStop(0,   `hsla(${hue},100%,95%,${0.7 + this._beatPulse * 0.3})`);
    coreG.addColorStop(0.4, `hsla(${hue},90%,65%,${0.25 + this._beatPulse * 0.2})`);
    coreG.addColorStop(1,   'hsla(0,0%,0%,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TWO_PI);
    ctx.fillStyle = coreG;
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
  }
}
