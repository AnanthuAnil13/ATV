export const SYNC_MODES = Object.freeze({
  LIVE: "live",
  BUFFERED: "buffered"
});

export const DEFAULT_SYNC_MODE = SYNC_MODES.LIVE;
export const DEFAULT_INITIAL_BUFFER_SECONDS = 10;
export const MIN_INITIAL_BUFFER_SECONDS = 5;
export const MAX_INITIAL_BUFFER_SECONDS = 30;

export function normalizeSyncMode(value) {
  return value === SYNC_MODES.BUFFERED ? SYNC_MODES.BUFFERED : SYNC_MODES.LIVE;
}

export function clampInitialBufferSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_INITIAL_BUFFER_SECONDS;
  return Math.min(MAX_INITIAL_BUFFER_SECONDS, Math.max(MIN_INITIAL_BUFFER_SECONDS, number));
}

export function shouldActivateBufferedPlayer({ provider, syncMode } = {}) {
  return provider === "ollama" && normalizeSyncMode(syncMode) === SYNC_MODES.BUFFERED;
}

export function validatePlaybackMode({ provider, syncMode } = {}) {
  const normalizedSyncMode = normalizeSyncMode(syncMode);
  if (provider === "openai" && normalizedSyncMode === SYNC_MODES.BUFFERED) {
    throw new Error("Buffered playback is currently only available with Ollama local mode. Switch playback mode to Live or choose Ollama.");
  }
  return normalizedSyncMode;
}
