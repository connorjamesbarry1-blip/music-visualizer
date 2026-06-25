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
    if (!this.ready) return { isBeat: false, bpm: 120, bass: 0, mid: 0, high: 0, beatPhase: 0 };

    const freq  = this.freqData;
    const bands = this.getBands(freq);
    return this._beat.detect(bands);
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
    this._history    = new Float32Array(43);  // ~1.4s at 30fps
    this._histIdx    = 0;
    this._beatTimes  = [];                    // last 8 beat timestamps
    this._lastBeat   = 0;
    this._bpm        = 120;
    this._beatPhase  = 0;
    this._lastTs     = 0;
  }

  detect({ bass, mid, high }) {
    const now = performance.now();
    const dt  = now - this._lastTs;
    this._lastTs = now;

    // Rolling average of bass energy
    this._history[this._histIdx % this._history.length] = bass;
    this._histIdx++;
    let sum = 0;
    const len = Math.min(this._histIdx, this._history.length);
    for (let i = 0; i < len; i++) sum += this._history[i];
    const avg = sum / len;

    // Standard deviation
    let variance = 0;
    for (let i = 0; i < len; i++) {
      const d = this._history[i] - avg;
      variance += d * d;
    }
    const sd = Math.sqrt(variance / len);

    const cooldown = 150;
    const isBeat = (
      bass > avg + sd * 1.0 &&
      bass > avg * 1.35 &&
      bass > 0.12 &&
      (now - this._lastBeat) > cooldown
    );

    if (isBeat) {
      const interval = now - this._lastBeat;
      this._lastBeat = now;
      this._beatPhase = 0;

      if (interval > 200 && interval < 2000) {
        this._beatTimes.push(interval);
        if (this._beatTimes.length > 8) this._beatTimes.shift();

        if (this._beatTimes.length >= 3) {
          const sorted = [...this._beatTimes].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          const rawBpm = 60000 / median;
          const clamped = Math.max(60, Math.min(180, rawBpm));
          this._bpm += (clamped - this._bpm) * 0.25;
        }
      }
    } else {
      // Advance beatPhase at current BPM
      const msPerBeat = 60000 / this._bpm;
      this._beatPhase = Math.min(1, this._beatPhase + dt / msPerBeat);
    }

    return {
      isBeat,
      bpm:       this._bpm,
      bass,
      mid,
      high,
      beatPhase: this._beatPhase,
    };
  }
}
