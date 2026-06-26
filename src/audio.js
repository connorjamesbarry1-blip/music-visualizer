// Tab-capture audio engine.
// Uses getDisplayMedia to tap the rendered audio of a browser tab, then feeds
// it into a Web Audio AnalyserNode for real-time FFT data.
// No Spotify SDK, no DRM — we read the audio the OS already decoded.

export class AudioEngine {
  constructor() {
    this.stream    = null;
    this.ctx       = null;
    this.analyser  = null;
    this.freqData  = null;
    this.timeData  = null;
    this.binWidth  = 0;
    this.ready     = false;
    this.onStopped = null;
    this._beat     = new BeatDetector();
  }

  async start() {
    // getDisplayMedia requires video: true to surface the tab-audio checkbox.
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });

    const audioTracks = this.stream.getAudioTracks();
    if (audioTracks.length === 0) {
      // User didn't tick "Share tab audio" — clean up and let app.js show guidance.
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      throw new Error('NO_AUDIO');
    }

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const source   = this.ctx.createMediaStreamSource(this.stream);
    this.analyser  = this.ctx.createAnalyser();
    this.analyser.fftSize             = 2048;
    this.analyser.smoothingTimeConstant = 0.80;

    // Connect source → analyser ONLY.
    // Do NOT connect to ctx.destination — that would echo the audio.
    source.connect(this.analyser);

    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Uint8Array(this.analyser.frequencyBinCount);
    this.binWidth = this.ctx.sampleRate / this.analyser.fftSize;
    this.ready    = true;

    // Fire onStopped when the user clicks "Stop sharing" in the browser chrome.
    audioTracks[0].onended = () => this.onStopped?.();
  }

  getFrequencyData() {
    if (!this.ready) return new Uint8Array(1024);
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  getTimeDomainData() {
    if (!this.ready) {
      const d = new Uint8Array(1024);
      d.fill(128); // 128 = silence in time-domain encoding
      return d;
    }
    this.analyser.getByteTimeDomainData(this.timeData);
    return this.timeData;
  }

  getBands(freqData) {
    if (!this.ready || !this.binWidth) return { bass: 0, mid: 0, high: 0 };

    const hzToBin = hz => Math.min(
      Math.round(hz / this.binWidth),
      freqData.length - 1
    );

    const avg = (a, b) => {
      if (b <= a) return 0;
      let s = 0;
      for (let i = a; i < b; i++) s += freqData[i];
      return s / ((b - a) * 255);
    };

    return {
      bass: avg(hzToBin(20),   hzToBin(250)),
      mid:  avg(hzToBin(250),  hzToBin(4000)),
      high: avg(hzToBin(4000), hzToBin(16000)),
    };
  }

  getBeatInfo() {
    if (!this.ready) return {
      gridBeat: false, isKick: false, bpm: 120,
      beatPhase: 0, kick: 0, bass: 0, mid: 0, high: 0,
    };
    const bands = this.getBands(this.freqData);
    return this._beat.detect(bands, this.freqData, this.binWidth);
  }

  stop() {
    this.ready = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.stream   = null;
    this.ctx      = null;
    this.analyser = null;
    this._beat    = new BeatDetector();
  }
}

class BeatDetector {
  constructor() {
    // ── Kick-energy ring buffer sampled at 50 Hz (4s = 200 samples) ───────────
    this._kickBuf      = new Float32Array(200);
    this._kickBufIdx   = 0;
    this._kickBufReady = false;
    this._lastSlowTs   = 0;
    this._slowStepMs   = 20;         // 20ms → 50 Hz

    // ── Autocorrelation schedule ───────────────────────────────────────────────
    this._lastAcorrTs    = 0;
    this._acorrIntervalMs = 500;

    // ── Per-frame onset detector ───────────────────────────────────────────────
    this._onsetHistory = new Float32Array(43);
    this._onsetIdx     = 0;
    this._lastOnsetTs  = 0;
    this._onsetTimes   = [];         // recent real-kick timestamps (for Rayleigh R)

    // ── BPM & PLL state ───────────────────────────────────────────────────────
    this._bpm   = 120;
    this._phase = 0;
    this._lastTs = 0;
  }

  detect(bands, freqData, binWidth) {
    const now = performance.now();
    const dt  = this._lastTs === 0 ? 16 : Math.min(now - this._lastTs, 100);
    this._lastTs = now;

    // ── Kick energy (40–130 Hz, narrower than broad bass) ─────────────────────
    const kick = this._computeKick(freqData, binWidth);

    // ── Slow-clock: write kick into ring buffer every ~20ms ───────────────────
    if (now - this._lastSlowTs >= this._slowStepMs) {
      this._lastSlowTs = now;
      this._kickBuf[this._kickBufIdx % 200] = kick;
      this._kickBufIdx++;
      if (!this._kickBufReady && this._kickBufIdx >= 100) this._kickBufReady = true;
    }

    // ── Autocorrelation every 500ms (once enough data) ────────────────────────
    if (this._kickBufReady && now - this._lastAcorrTs >= this._acorrIntervalMs) {
      this._lastAcorrTs = now;
      const candidate = this._autocorrelate();
      if (candidate > 0) {
        this._bpm += (candidate - this._bpm) * 0.2;
        this._bpm  = Math.max(60, Math.min(180, this._bpm));
      }
    }

    // ── Per-frame onset detector ───────────────────────────────────────────────
    const isKick = this._detectOnset(kick, now);

    // ── PLL: advance phase by elapsed time at current BPM ─────────────────────
    const msPerBeat = 60000 / this._bpm;
    this._phase += dt / msPerBeat;

    let gridBeat = false;
    if (this._phase >= 1.0) {
      this._phase -= Math.floor(this._phase); // handles large dt gracefully
      gridBeat = true;
    }

    // ── PLL correction: nudge grid toward real kicks (gain 0.1) ───────────────
    if (isKick) {
      const err = this._phase < 0.5 ? -this._phase : (1.0 - this._phase);
      this._phase = Math.max(0, Math.min(1, this._phase + err * 0.1));
    }

    return {
      gridBeat,
      isKick,
      bpm:       Math.round(this._bpm),
      beatPhase: Math.max(0, Math.min(1, this._phase)),
      kick,
      bass:  bands.bass,
      mid:   bands.mid,
      high:  bands.high,
    };
  }

  // ── Kick energy: average of 40–130 Hz FFT bins ──────────────────────────────
  _computeKick(freqData, binWidth) {
    if (!freqData || !binWidth) return 0;
    const hzToBin = hz => Math.min(Math.round(hz / binWidth), freqData.length - 1);
    const a = hzToBin(40), b = hzToBin(130);
    if (b <= a) return 0;
    let sum = 0;
    for (let i = a; i < b; i++) sum += freqData[i];
    return sum / ((b - a) * 255);
  }

  // ── Per-frame onset: rolling mean + σ threshold on kick energy ───────────────
  _detectOnset(kick, now) {
    this._onsetHistory[this._onsetIdx % this._onsetHistory.length] = kick;
    this._onsetIdx++;
    const len = Math.min(this._onsetIdx, this._onsetHistory.length);
    let mean = 0;
    for (let i = 0; i < len; i++) mean += this._onsetHistory[i];
    mean /= len;
    let variance = 0;
    for (let i = 0; i < len; i++) { const d = this._onsetHistory[i] - mean; variance += d * d; }
    const sd = Math.sqrt(variance / len);

    const isKick = kick > mean + sd && kick > mean * 1.35 && kick > 0.12 &&
                   now - this._lastOnsetTs > 150;
    if (isKick) {
      this._lastOnsetTs = now;
      this._onsetTimes.push(now);
      if (this._onsetTimes.length > 16) this._onsetTimes.shift();
    }
    return isKick;
  }

  // ── Autocorrelation on 50Hz-sampled kick ring buffer ─────────────────────────
  _autocorrelate() {
    const BUFSIZE = 200;
    const N = Math.min(this._kickBufIdx, BUFSIZE);
    const x = new Float32Array(N);

    if (this._kickBufIdx < BUFSIZE) {
      for (let i = 0; i < N; i++) x[i] = this._kickBuf[i];
    } else {
      for (let i = 0; i < N; i++) x[i] = this._kickBuf[(this._kickBufIdx + i) % BUFSIZE];
    }

    // Remove DC
    let mean = 0;
    for (let i = 0; i < N; i++) mean += x[i];
    mean /= N;
    for (let i = 0; i < N; i++) x[i] -= mean;

    let energy = 0;
    for (let i = 0; i < N; i++) energy += x[i] * x[i];
    if (energy < 1e-8) return 0; // silence

    // Lag range: 180 BPM (333ms) → 17 samples; 60 BPM (1000ms) → 50 samples
    const LAG_MIN = Math.max(1, Math.round(60000 / (180 * this._slowStepMs)));
    const LAG_MAX = Math.min(Math.floor(N / 2), Math.round(60000 / (60 * this._slowStepMs)));

    let bestLag = LAG_MIN, bestCorr = -Infinity;
    for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
      let corr = 0;
      for (let i = 0; i < N - lag; i++) corr += x[i] * x[i + lag];
      corr /= energy;
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }

    let bpm = 60000 / (bestLag * this._slowStepMs);

    // Octave-error correction — prefer the candidate with better Rayleigh R
    if (bpm < 80) {
      const dbl = bpm * 2;
      if (dbl <= 180 && this._rayleighR(dbl) > this._rayleighR(bpm)) bpm = dbl;
    } else if (bpm > 160) {
      const half = bpm / 2;
      if (half >= 60 && this._rayleighR(half) > this._rayleighR(bpm)) bpm = half;
    }

    return bpm;
  }

  // ── Rayleigh R: circular concentration of recent onsets at a given BPM ──────
  // Returns 0..1 — higher means onsets cluster on-beat.
  _rayleighR(bpm) {
    if (this._onsetTimes.length < 3) return 0;
    const msPerBeat = 60000 / bpm;
    let sx = 0, sy = 0;
    for (const t of this._onsetTimes) {
      const angle = ((t % msPerBeat) / msPerBeat) * Math.PI * 2;
      sx += Math.cos(angle);
      sy += Math.sin(angle);
    }
    const n = this._onsetTimes.length;
    return Math.sqrt(sx * sx + sy * sy) / n;
  }
}
