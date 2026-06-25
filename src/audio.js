// Tab-capture audio engine.
// Uses getDisplayMedia to tap the rendered audio of a browser tab, then feeds
// it into a Web Audio AnalyserNode for real-time FFT data.
// No Spotify SDK, no DRM — we read the audio the OS already decoded.

export class AudioEngine {
  constructor() {
    this.stream   = null;
    this.ctx      = null;
    this.analyser = null;
    this.freqData = null;
    this.timeData = null;
    this.binWidth = 0;
    this.ready    = false;
    this.onStopped = null;
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

  stop() {
    this.ready = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.stream   = null;
    this.ctx      = null;
    this.analyser = null;
  }
}
