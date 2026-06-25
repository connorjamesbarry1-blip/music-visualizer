import { getAccessToken, clearToken } from './auth.js';

const API = 'https://api.spotify.com/v1';
const POLL_MS = 2000;

let pollTimer = null;
let currentTrackId = null;
let _onTrackChange = null;
let _onPlaybackState = null;
let _onAuthError = null;

// ── Internal fetch wrapper ────────────────────────────────────────────────────

async function apiFetch(path) {
  const token = await getAccessToken();
  if (!token) throw new Error('no_token');

  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    clearToken();
    throw new Error('auth_expired');
  }

  return res;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetches the currently-playing object from the Spotify Web API.
 * Returns null when the player is inactive (204 No Content) or on error.
 */
export async function getCurrentTrack() {
  const res = await apiFetch('/me/player/currently-playing');

  // 204 = player inactive; 202 = context still loading on Spotify's end
  if (res.status === 204 || res.status === 202) return null;
  if (!res.ok) return null;

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

/**
 * Returns the full Spotify audio analysis for a track (beats, bars, sections …).
 * Returns null for non-premium accounts (403) or on any error.
 */
export async function getAudioAnalysis(trackId) {
  try {
    const res = await apiFetch(`/audio-analysis/${trackId}`);
    if (res.status === 403) return null; // non-premium
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Returns audio features (energy, valence, tempo, danceability …) for a track.
 * Available to all account types.
 */
export async function getAudioFeatures(trackId) {
  try {
    const res = await apiFetch(`/audio-features/${trackId}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────

/**
 * Start a 2-second poll loop.
 *
 * onTrackChange(track, analysis, features) — called when the playing track
 *   changes; all three args are null when nothing is playing.
 * onPlaybackState(data) — called every poll tick with the raw API response.
 * onAuthError() — called when the token has expired and polling has stopped.
 */
export function startPolling(onTrackChange, onPlaybackState, onAuthError) {
  _onTrackChange = onTrackChange;
  _onPlaybackState = onPlaybackState;
  _onAuthError = onAuthError;
  _poll();
  pollTimer = setInterval(_poll, POLL_MS);
}

export function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ── Internal poll ─────────────────────────────────────────────────────────────

async function _poll() {
  try {
    const data = await getCurrentTrack();

    _onPlaybackState?.(data);

    const trackId = data?.item?.id ?? null;

    if (trackId !== currentTrackId) {
      currentTrackId = trackId;

      if (!trackId) {
        _onTrackChange?.(null, null, null);
        return;
      }

      // Fetch analysis and features in parallel; a failure in either is fine.
      const [analysis, features] = await Promise.all([
        getAudioAnalysis(trackId),
        getAudioFeatures(trackId),
      ]);

      _onTrackChange?.(data.item, analysis, features);
    }
  } catch (err) {
    if (err.message === 'auth_expired' || err.message === 'no_token') {
      stopPolling();
      _onAuthError?.();
    }
    // Transient network errors are silently ignored; the next tick will retry.
  }
}
