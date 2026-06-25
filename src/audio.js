// Patch window.AudioContext before the Spotify SDK loads so the SDK's internal
// AudioContext automatically exposes an AnalyserNode via window._vizAnalyser.
const NativeAC = window.AudioContext || window.webkitAudioContext;

class PatchedAudioContext extends NativeAC {
  constructor(...args) {
    super(...args);
    const analyser               = this.createAnalyser();
    analyser.fftSize             = 2048;
    analyser.smoothingTimeConstant = 0.82;
    const realDest               = this.destination;
    analyser.connect(realDest);
    Object.defineProperty(this, 'destination', { get: () => analyser });
    window._vizAnalyser     = analyser;
    window._vizAudioContext = this;
  }
}

window.AudioContext = window.webkitAudioContext = PatchedAudioContext;

// ── Helpers ───────────────────────────────────────────────────────────────────

function binAvg(arr, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += arr[i];
  return sum / (end - start);
}

function loadSDK() {
  return new Promise(resolve => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src   = 'https://sdk.scdn.co/spotify-player.js';
    document.head.appendChild(s);
  });
}

// ── AudioEngine ───────────────────────────────────────────────────────────────

export class AudioEngine {
  constructor() {
    this._getToken         = null;
    this._deviceId         = null;
    this._paused           = true;
    this.player            = null;
    this.onTrackChange     = null;
    this.onPlayStateChange = null;
  }

  async init(getToken) {
    this._getToken = getToken;
    await loadSDK();

    this.player = new Spotify.Player({
      name:          'Spotify Visualizer',
      getOAuthToken: cb => { this._getToken().then(t => { if (t) cb(t); }); },
      volume:        0.8,
    });

    this.player.addListener('ready', ({ device_id }) => {
      this._deviceId = device_id;
      this._transferPlayback(device_id);
    });

    this.player.addListener('player_state_changed', state => {
      if (!state) return;
      this._paused = state.paused;
      const tr     = state.track_window.current_track;
      this.onTrackChange?.({
        name:   tr.name,
        artist: tr.artists.map(a => a.name).join(', '),
        id:     tr.id,
      });
      this.onPlayStateChange?.(state.paused);
    });

    this.player.addListener('not_ready',           ({ device_id }) =>
      console.warn('[AudioEngine] Device offline:', device_id));
    this.player.addListener('initialization_error', ({ message }) =>
      console.error('[AudioEngine] Init error:', message));
    this.player.addListener('authentication_error', ({ message }) =>
      console.error('[AudioEngine] Auth error:', message));
    this.player.addListener('account_error',        ({ message }) =>
      console.error('[AudioEngine] Premium required:', message));

    await this.player.connect();
  }

  // ── FFT data (called every RAF frame) ────────────────────────────────────

  getFrequencyData() {
    if (!window._vizAnalyser) return new Uint8Array(1024);
    const d = new Uint8Array(window._vizAnalyser.frequencyBinCount);
    window._vizAnalyser.getByteFrequencyData(d);
    return d;
  }

  getTimeDomainData() {
    if (!window._vizAnalyser) {
      const d = new Uint8Array(1024);
      d.fill(128); // 128 = silence in time-domain data
      return d;
    }
    const d = new Uint8Array(window._vizAnalyser.frequencyBinCount);
    window._vizAnalyser.getByteTimeDomainData(d);
    return d;
  }

  getBands(freqData) {
    return {
      bass: binAvg(freqData, 0,  6)   / 255,
      mid:  binAvg(freqData, 6,  94)  / 255,
      high: binAvg(freqData, 94, 256) / 255,
    };
  }

  get isPaused() { return this._paused; }

  // ── Playback control ──────────────────────────────────────────────────────

  play()          { return this.player?.resume(); }
  pause()         { return this.player?.pause(); }
  nextTrack()     { return this.player?.nextTrack(); }
  previousTrack() { return this.player?.previousTrack(); }
  setVolume(v)    { return this.player?.setVolume(Math.max(0, Math.min(1, v))); }
  disconnect()    { this.player?.disconnect(); }

  _transferPlayback(deviceId) {
    this._getToken().then(token => {
      if (!token) return;
      fetch('https://api.spotify.com/v1/me/player', {
        method:  'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ device_ids: [deviceId], play: true }),
      }).catch(err => console.warn('[AudioEngine] Transfer error:', err));
    });
  }
}
