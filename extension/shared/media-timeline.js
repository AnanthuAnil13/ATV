(function installAutoTranslateMediaTimeline(global) {
  if (global.AutoTranslateMediaTimeline) return;

  const DEFAULT_PLAYBACK_RATE = 1;
  const DEFAULT_SEEK_DEBOUNCE_MS = 1000;
  const DEFAULT_RATE_TOLERANCE = 0.001;
  const MIN_MEANINGFUL_CHUNK_MS = 750;

  function createTimelineSnapshotFromVideo(video, options = {}) {
    if (!video) throw new Error("Source video is unavailable.");
    const sourceTimeMs = secondsToMediaTimeMs(video.currentTime);
    if (sourceTimeMs === null) {
      throw new Error("The source video currentTime is invalid.");
    }

    const durationMs = secondsToMediaTimeMs(video.duration);
    return normalizeTimelineSnapshot({
      sessionId: options.sessionId,
      generation: options.generation,
      sourceTimeMs,
      observedAtEpochMs: options.observedAtEpochMs ?? Date.now(),
      playbackRate: video.playbackRate,
      paused: video.paused,
      seeking: video.seeking,
      ended: video.ended,
      durationMs,
      eventType: options.eventType
    });
  }

  function normalizeTimelineSnapshot(raw = {}, options = {}) {
    const sessionId = normalizeSessionId(raw.sessionId);
    const generation = normalizeGeneration(raw.generation);
    const sourceTimeMs = normalizeMediaTimeMs(raw.sourceTimeMs);
    if (!sessionId || generation === null || sourceTimeMs === null) return null;

    const observedAtEpochMs = normalizeObservedAt(raw.observedAtEpochMs, options.now ?? Date.now());
    const playbackRate = normalizePlaybackRate(raw.playbackRate);
    const durationMs = normalizeMediaTimeMs(raw.durationMs);
    const snapshot = {
      sessionId,
      generation,
      sourceTimeMs,
      observedAtEpochMs,
      playbackRate,
      paused: raw.paused === true,
      seeking: raw.seeking === true,
      ended: raw.ended === true,
      eventType: normalizeEventType(raw.eventType)
    };
    if (durationMs !== null) snapshot.durationMs = durationMs;
    return snapshot;
  }

  function sameTimelineSession(left, right) {
    const leftId = normalizeSessionId(typeof left === "string" ? left : left?.sessionId);
    const rightId = normalizeSessionId(typeof right === "string" ? right : right?.sessionId);
    return Boolean(leftId && rightId && leftId === rightId);
  }

  function sameTimelineGeneration(left, right) {
    return sameTimelineSession(left, right) &&
      normalizeGeneration(left?.generation) !== null &&
      left.generation === right?.generation;
  }

  function isStaleTimelineSnapshot(snapshot, current) {
    if (!snapshot || !current) return true;
    if (!sameTimelineSession(snapshot, current)) return true;
    return normalizeGeneration(snapshot.generation) < normalizeGeneration(current.generation);
  }

  function recordingCrossedGenerationBoundary(startSnapshot, endSnapshot) {
    if (!sameTimelineGeneration(startSnapshot, endSnapshot)) return true;
    return endSnapshot.sourceTimeMs < startSnapshot.sourceTimeMs;
  }

  function recordingCrossedPlaybackRateChange(startSnapshot, endSnapshot, tolerance = DEFAULT_RATE_TOLERANCE) {
    if (!sameTimelineGeneration(startSnapshot, endSnapshot)) return true;
    return Math.abs(startSnapshot.playbackRate - endSnapshot.playbackRate) > tolerance;
  }

  function hasMeaningfulChunkDuration(startSnapshot, endSnapshot, captureStartEpochMs, captureEndEpochMs) {
    const capturedMs = normalizeMediaTimeMs(captureEndEpochMs - captureStartEpochMs) ?? 0;
    if (capturedMs < MIN_MEANINGFUL_CHUNK_MS) return false;
    return endSnapshot.sourceTimeMs >= startSnapshot.sourceTimeMs;
  }

  function updateSequenceForGeneration(state, generation) {
    const nextGeneration = normalizeGeneration(generation);
    const currentGeneration = normalizeGeneration(state?.generation);
    if (nextGeneration === null) {
      return {
        generation: currentGeneration ?? 0,
        sequence: normalizeSequence(state?.sequence)
      };
    }
    if (currentGeneration !== nextGeneration) {
      return { generation: nextGeneration, sequence: 0 };
    }
    return {
      generation: currentGeneration,
      sequence: normalizeSequence(state?.sequence)
    };
  }

  function applySeekCycleEvent(state = {}, event = {}) {
    const eventType = normalizeEventType(event.eventType || event.type);
    const observedAtEpochMs = normalizeObservedAt(event.observedAtEpochMs, Date.now());
    const generation = normalizeGeneration(state.generation) ?? 0;
    const seekInProgress = state.seekInProgress === true;
    const lastCompletedAt = Number.isFinite(Number(state.lastCompletedAtEpochMs))
      ? Number(state.lastCompletedAtEpochMs)
      : null;
    const debounceMs = Number.isFinite(Number(event.debounceMs))
      ? Math.max(0, Number(event.debounceMs))
      : DEFAULT_SEEK_DEBOUNCE_MS;

    if (eventType === "seeking") {
      return {
        generation,
        seekInProgress: true,
        seekStartedAtEpochMs: state.seekStartedAtEpochMs || observedAtEpochMs,
        lastCompletedAtEpochMs: lastCompletedAt,
        changed: false
      };
    }

    if (eventType === "seeked") {
      if (seekInProgress) {
        return {
          generation: generation + 1,
          seekInProgress: false,
          seekStartedAtEpochMs: null,
          lastCompletedAtEpochMs: observedAtEpochMs,
          changed: true
        };
      }
      if (lastCompletedAt !== null && observedAtEpochMs - lastCompletedAt <= debounceMs) {
        return {
          generation,
          seekInProgress: false,
          seekStartedAtEpochMs: null,
          lastCompletedAtEpochMs: lastCompletedAt,
          changed: false
        };
      }
      return {
        generation: generation + 1,
        seekInProgress: false,
        seekStartedAtEpochMs: null,
        lastCompletedAtEpochMs: observedAtEpochMs,
        changed: true
      };
    }

    if (eventType === "timeline-jump") {
      if (seekInProgress || (lastCompletedAt !== null && observedAtEpochMs - lastCompletedAt <= debounceMs)) {
        return {
          generation,
          seekInProgress,
          seekStartedAtEpochMs: state.seekStartedAtEpochMs || null,
          lastCompletedAtEpochMs: lastCompletedAt,
          changed: false
        };
      }
      return {
        generation: generation + 1,
        seekInProgress: false,
        seekStartedAtEpochMs: null,
        lastCompletedAtEpochMs: observedAtEpochMs,
        changed: true
      };
    }

    return {
      generation,
      seekInProgress,
      seekStartedAtEpochMs: state.seekStartedAtEpochMs || null,
      lastCompletedAtEpochMs: lastCompletedAt,
      changed: false
    };
  }

  function detectTimelineJump(previous, current, options = {}) {
    if (!previous || !current) return { jumped: false, reason: "missing-snapshot" };
    if (previous.paused || current.paused || previous.seeking || current.seeking) {
      return { jumped: false, reason: "paused-or-seeking" };
    }
    if (!sameTimelineSession(previous, current) || previous.generation !== current.generation) {
      return { jumped: false, reason: "different-generation" };
    }

    const observedDeltaMs = current.observedAtEpochMs - previous.observedAtEpochMs;
    if (!Number.isFinite(observedDeltaMs) || observedDeltaMs <= 0) {
      return { jumped: false, reason: "invalid-clock-delta" };
    }

    const toleranceMs = Number.isFinite(Number(options.toleranceMs))
      ? Math.max(0, Number(options.toleranceMs))
      : 2500;
    const expectedDeltaMs = observedDeltaMs * normalizePlaybackRate(previous.playbackRate);
    const actualDeltaMs = current.sourceTimeMs - previous.sourceTimeMs;
    const driftMs = actualDeltaMs - expectedDeltaMs;
    return {
      jumped: Math.abs(driftMs) > toleranceMs,
      expectedDeltaMs,
      actualDeltaMs,
      driftMs,
      toleranceMs,
      reason: Math.abs(driftMs) > toleranceMs ? "timeline-jump" : "within-tolerance"
    };
  }

  function isCurrentPipelineEpoch(expectedEpoch, currentEpoch) {
    return Number.isInteger(expectedEpoch) && expectedEpoch === currentEpoch;
  }

  function secondsToMediaTimeMs(seconds) {
    const number = Number(seconds);
    if (!Number.isFinite(number) || number < 0) return null;
    return number * 1000;
  }

  function normalizeMediaTimeMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return number;
  }

  function normalizePlaybackRate(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : DEFAULT_PLAYBACK_RATE;
  }

  function normalizeGeneration(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function normalizeSequence(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : 0;
  }

  function normalizeObservedAt(value, fallback) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber) && fallbackNumber > 0 ? fallbackNumber : Date.now();
  }

  function normalizeSessionId(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function normalizeEventType(value) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : "snapshot";
  }

  global.AutoTranslateMediaTimeline = Object.freeze({
    DEFAULT_PLAYBACK_RATE,
    DEFAULT_SEEK_DEBOUNCE_MS,
    DEFAULT_RATE_TOLERANCE,
    MIN_MEANINGFUL_CHUNK_MS,
    createTimelineSnapshotFromVideo,
    normalizeTimelineSnapshot,
    sameTimelineSession,
    sameTimelineGeneration,
    isStaleTimelineSnapshot,
    recordingCrossedGenerationBoundary,
    recordingCrossedPlaybackRateChange,
    hasMeaningfulChunkDuration,
    updateSequenceForGeneration,
    applySeekCycleEvent,
    detectTimelineJump,
    isCurrentPipelineEpoch,
    normalizePlaybackRate
  });
})(globalThis);
