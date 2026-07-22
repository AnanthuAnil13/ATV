(function installTimedDubSchedulerCore(global) {
  if (global.AutoTranslateTimedDubSchedulerCore) return;

  const DEFAULT_QUEUE_LIMIT = 64;
  const DEFAULT_MAX_ACTIVE_TIMED_DUBS = 2;
  const LATE_DUB_TOLERANCE_MS = 250;
  const END_TOLERANCE_MS = 75;
  const MIN_PLAYABLE_REMAINDER_MS = 100;
  const MAX_AUDIO_BASE64_CHARS = 8 * 1024 * 1024;
  const MAX_DECODED_AUDIO_BYTES = 6 * 1024 * 1024;
  const MAX_ID_LENGTH = 160;
  const MAX_SPEAKER_ID_LENGTH = 80;
  const MAX_VOICE_ID_LENGTH = 160;
  const CLOCK_WAIT_TIMEOUT_MS = 15_000;
  const CLOCK_RETRY_INTERVAL_MS = 250;
  const TIMED_DUB_PLAYBACK_RATE = 1;
  const ALLOWED_AUDIO_MIME_TYPES = new Set([
    "audio/wav",
    "audio/wave",
    "audio/x-wav",
    "audio/vnd.wave"
  ]);
  const CLIP_STATES = new Set([
    "queued",
    "decoding",
    "ready",
    "playing",
    "completed",
    "dropped",
    "failed"
  ]);
  const CLOCK_STATUSES = new Set([
    "buffering",
    "rebuffering",
    "playing",
    "paused",
    "ended",
    "error",
    "stopped"
  ]);

  function createTimedDubQueue(options = {}) {
    const queueLimit = normalizePositiveInteger(options.queueLimit) ?? DEFAULT_QUEUE_LIMIT;
    const maxActiveClips = normalizePositiveInteger(options.maxActiveClips) ?? DEFAULT_MAX_ACTIVE_TIMED_DUBS;
    return {
      bufferedSessionId: normalizeId(options.bufferedSessionId),
      generation: normalizeNonNegativeInteger(options.generation) ?? 0,
      pipelineEpoch: normalizeNonNegativeInteger(options.pipelineEpoch),
      schedulerEpoch: 0,
      queueLimit,
      maxActiveClips,
      pending: [],
      active: [],
      seenKeys: new Set(),
      counters: createCounters()
    };
  }

  function createCounters() {
    return {
      received: 0,
      decoded: 0,
      played: 0,
      lateStarted: 0,
      droppedExpired: 0,
      droppedStale: 0,
      decodeFailed: 0
    };
  }

  function normalizeTimedDubClip(raw = {}, context = {}) {
    const id = normalizeId(raw.id);
    const bufferedSessionId = normalizeId(raw.bufferedSessionId ?? context.bufferedSessionId);
    const generation = normalizeNonNegativeInteger(raw.generation ?? context.generation);
    const sequence = normalizeNonNegativeInteger(raw.sequence ?? context.sequence) ?? 0;
    const startMs = normalizeMediaTimeMs(raw.startMs);
    const endMs = normalizeMediaTimeMs(raw.endMs);
    const audioDurationMs = normalizePositiveNumber(raw.audioDurationMs);
    const audioMime = normalizeAudioMime(raw.audioMime);
    const audioBase64 = normalizeBase64Payload(raw.audioBase64, {
      maxBase64Chars: context.maxBase64Chars,
      maxDecodedBytes: context.maxDecodedBytes
    });
    const speakerId = normalizeShortIdentifier(raw.speakerId, MAX_SPEAKER_ID_LENGTH);
    const voiceId = normalizeShortIdentifier(raw.voiceId, MAX_VOICE_ID_LENGTH);

    if (!id || !bufferedSessionId || generation === null) return null;
    if (startMs === null || endMs === null || endMs <= startMs) return null;
    if (audioDurationMs === null || !audioMime || !audioBase64 || !speakerId || !voiceId) return null;

    const targetWindowDurationMs = normalizePositiveNumber(raw.targetWindowDurationMs) ?? (endMs - startMs);
    const durationRatio = normalizePositiveNumber(raw.durationRatio) ?? audioDurationMs / targetWindowDurationMs;
    if (!Number.isFinite(targetWindowDurationMs) || targetWindowDurationMs <= 0) return null;
    if (!Number.isFinite(durationRatio) || durationRatio <= 0) return null;

    const state = CLIP_STATES.has(raw.state) ? raw.state : "queued";
    const clip = {
      key: "",
      id,
      bufferedSessionId,
      generation,
      sequence,
      startMs,
      endMs,
      speakerId,
      voiceId,
      audioBase64,
      audioMime,
      audioDurationMs,
      targetWindowDurationMs,
      durationRatio,
      state
    };
    clip.key = timedDubClipKey(clip);
    return clip;
  }

  function insertTimedDubClips(state, rawClips, context = {}) {
    if (!state || !Array.isArray(rawClips)) {
      return { inserted: 0, rejected: 0, duplicates: 0, late: 0, stale: 0 };
    }

    const stats = { inserted: 0, rejected: 0, duplicates: 0, late: 0, stale: 0 };
    const delayedSourceTimeMs = normalizeMediaTimeMs(context.delayedSourceTimeMs);
    const effectiveContext = {
      bufferedSessionId: state.bufferedSessionId,
      generation: state.generation,
      ...context
    };

    for (const rawClip of rawClips) {
      state.counters.received += 1;
      const clip = normalizeTimedDubClip(rawClip, effectiveContext);
      if (!clip) {
        stats.rejected += 1;
        continue;
      }
      if (state.bufferedSessionId && clip.bufferedSessionId !== state.bufferedSessionId) {
        stats.stale += 1;
        state.counters.droppedStale += 1;
        continue;
      }
      if (clip.generation !== state.generation) {
        stats.stale += 1;
        state.counters.droppedStale += 1;
        continue;
      }
      if (delayedSourceTimeMs !== null && isClipExpired(clip, delayedSourceTimeMs, context.lateToleranceMs)) {
        clip.state = "dropped";
        stats.late += 1;
        state.counters.droppedExpired += 1;
        continue;
      }
      if (state.seenKeys.has(clip.key)) {
        stats.duplicates += 1;
        continue;
      }

      state.seenKeys.add(clip.key);
      state.pending.push(clip);
      stats.inserted += 1;
    }

    sortTimedDubClips(state.pending);
    enforceTimedDubQueueLimit(state, delayedSourceTimeMs);
    return stats;
  }

  function markClipDecoded(state, clipKey, audioBuffer, decodedDurationMs) {
    const clip = findClipByKey(state?.pending, clipKey);
    if (!clip || clip.state !== "decoding") return null;
    const durationMs = normalizePositiveNumber(decodedDurationMs ?? audioBuffer?.duration * 1000);
    if (!durationMs) {
      clip.state = "failed";
      state.counters.decodeFailed += 1;
      return null;
    }
    clip.audioBuffer = audioBuffer;
    clip.decodedDurationMs = durationMs;
    clip.audioBase64 = "";
    clip.state = "ready";
    state.counters.decoded += 1;
    return clip;
  }

  function markClipDecodeFailed(state, clipKey) {
    const clip = findClipByKey(state?.pending, clipKey);
    if (!clip) return null;
    clip.audioBase64 = "";
    clip.state = "failed";
    if (state?.counters) state.counters.decodeFailed += 1;
    return clip;
  }

  function selectDueTimedDubClips(state, delayedSourceTimeMs, options = {}) {
    if (!state) return [];
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    if (timeMs === null) return [];
    discardExpiredTimedDubClips(state, timeMs, options);
    const maxActive = normalizePositiveInteger(options.maxActiveClips) ?? state.maxActiveClips ?? DEFAULT_MAX_ACTIVE_TIMED_DUBS;
    const slots = Math.max(0, maxActive - state.active.filter((clip) => clip.state === "playing").length);
    if (!slots) return [];
    return state.pending
      .filter((clip) => clip.state === "ready" && isClipDue(clip, timeMs))
      .sort(compareTimedDubClips)
      .slice(0, slots);
  }

  function markClipPlaying(state, clip, playback = {}) {
    if (!state || !clip) return null;
    const key = clip.key;
    state.pending = state.pending.filter((item) => item.key !== key);
    clip.state = "playing";
    clip.audioSource = playback.audioSource;
    clip.startedAtAudioOffsetMs = normalizeMediaTimeMs(playback.audioOffsetMs) ?? 0;
    clip.startedAtSourceTimeMs = normalizeMediaTimeMs(playback.delayedSourceTimeMs) ?? clip.startMs;
    clip.startedLate = Boolean(playback.startedLate);
    state.active.push(clip);
    sortTimedDubClips(state.active);
    state.counters.played += 1;
    if (clip.startedLate) state.counters.lateStarted += 1;
    return clip;
  }

  function markClipTerminal(state, clipOrKey, terminalState = "completed") {
    if (!state) return null;
    const key = typeof clipOrKey === "string" ? clipOrKey : clipOrKey?.key;
    if (!key) return null;
    let matched = null;
    state.active = state.active.filter((clip) => {
      if (clip.key !== key) return true;
      matched = clip;
      return false;
    });
    state.pending = state.pending.filter((clip) => {
      if (clip.key !== key) return true;
      matched = matched || clip;
      return false;
    });
    if (matched) {
      matched.state = CLIP_STATES.has(terminalState) ? terminalState : "completed";
      matched.audioSource = null;
      matched.audioBuffer = null;
    }
    return matched;
  }

  function discardExpiredTimedDubClips(state, delayedSourceTimeMs, options = {}) {
    if (!state) return { expired: 0 };
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    if (timeMs === null) return { expired: 0 };
    let expired = 0;
    const keep = (clip) => {
      if (clip.state === "playing") return true;
      if (isClipExpired(clip, timeMs, options.lateToleranceMs)) {
        clip.state = "dropped";
        expired += 1;
        state.counters.droppedExpired += 1;
        return false;
      }
      return !isTerminalState(clip.state);
    };
    state.pending = state.pending.filter(keep);
    return { expired };
  }

  function reduceTimedDubSchedulerState(state, action = {}) {
    if (!state) return state;
    if (action.type === "RESET_SESSION") {
      state.bufferedSessionId = normalizeId(action.bufferedSessionId);
      state.generation = normalizeNonNegativeInteger(action.generation) ?? 0;
      state.pipelineEpoch = normalizeNonNegativeInteger(action.pipelineEpoch);
      state.pending = [];
      state.active = [];
      state.seenKeys = new Set();
      state.schedulerEpoch += 1;
      return state;
    }
    if (action.type === "GENERATION_CHANGE" || action.type === "SEEK_RESET" || action.type === "PIPELINE_RESET") {
      state.generation = normalizeNonNegativeInteger(action.generation) ?? state.generation;
      state.pipelineEpoch = normalizeNonNegativeInteger(action.pipelineEpoch ?? state.pipelineEpoch);
      state.pending = [];
      state.active = [];
      state.seenKeys = new Set();
      state.schedulerEpoch += 1;
      return state;
    }
    if (action.type === "STOP") {
      state.pending = [];
      state.active = [];
      state.seenKeys = new Set();
      state.schedulerEpoch += 1;
      return state;
    }
    return state;
  }

  function enforceTimedDubQueueLimit(state, delayedSourceTimeMs) {
    if (!state) return state;
    state.pending = state.pending.filter((clip) => !isTerminalState(clip.state));
    state.active = state.active.filter((clip) => !isTerminalState(clip.state));
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    if (timeMs !== null) discardExpiredTimedDubClips(state, timeMs);
    sortTimedDubClips(state.pending);
    sortTimedDubClips(state.active);

    while (state.pending.length + state.active.length > state.queueLimit && state.pending.length) {
      const dropIndex = state.pending.length - 1;
      const [dropped] = state.pending.splice(dropIndex, 1);
      if (dropped) {
        dropped.state = "dropped";
        state.counters.droppedExpired += 1;
      }
    }
    return state;
  }

  function buildPlaybackStartDecision(clip, delayedSourceTimeMs, options = {}) {
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    if (!clip || timeMs === null) return { action: "wait", reason: "invalid-clock" };
    if (timeMs < clip.startMs) return { action: "wait", reason: "future" };
    if (timeMs >= clip.endMs) return { action: "drop", reason: "expired" };

    const decodedDurationMs = normalizePositiveNumber(options.decodedDurationMs ?? clip.decodedDurationMs ?? clip.audioBuffer?.duration * 1000);
    if (!decodedDurationMs) return { action: "wait", reason: "not-decoded" };
    const windowDurationMs = clip.endMs - clip.startMs;
    const windowProgress = clamp((timeMs - clip.startMs) / windowDurationMs, 0, 1);
    const audioOffsetMs = clamp(decodedDurationMs * windowProgress, 0, decodedDurationMs);
    const remainingAudioMs = decodedDurationMs - audioOffsetMs;
    const remainingWindowMs = clip.endMs - timeMs;
    const minRemainder = normalizePositiveNumber(options.minPlayableRemainderMs) ?? MIN_PLAYABLE_REMAINDER_MS;

    if (audioOffsetMs >= decodedDurationMs || remainingAudioMs < minRemainder || remainingWindowMs < minRemainder) {
      return {
        action: "drop",
        reason: "tiny-remainder",
        windowProgress,
        audioOffsetMs,
        remainingAudioMs,
        remainingWindowMs
      };
    }

    return {
      action: "play",
      reason: timeMs > clip.startMs ? "late-start" : "on-time",
      startedLate: timeMs > clip.startMs,
      windowProgress,
      audioOffsetMs,
      remainingAudioMs,
      remainingWindowMs
    };
  }

  function shouldStopActiveClip(clip, delayedSourceTimeMs, options = {}) {
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    if (!clip || timeMs === null) return false;
    const tolerance = normalizeMediaTimeMs(options.endToleranceMs) ?? END_TOLERANCE_MS;
    return timeMs >= clip.endMs + tolerance;
  }

  function shouldSuspendForClockStatus(status) {
    return status === "paused" || status === "buffering" || status === "rebuffering";
  }

  function shouldResumeForClockStatus(status) {
    return status === "playing";
  }

  function normalizeClockSnapshot(snapshot = {}, context = {}) {
    const bufferedSessionId = normalizeId(snapshot.bufferedSessionId);
    const generation = normalizeNonNegativeInteger(snapshot.generation);
    const pipelineEpoch = normalizeNonNegativeInteger(snapshot.pipelineEpoch);
    const delayedSourceTimeMs = snapshot.delayedSourceTimeMs === null
      ? null
      : normalizeMediaTimeMs(snapshot.delayedSourceTimeMs);
    const status = CLOCK_STATUSES.has(snapshot.status) ? snapshot.status : "";
    if (!bufferedSessionId || generation === null || !status) return null;
    if (context.bufferedSessionId && bufferedSessionId !== context.bufferedSessionId) return null;
    if (delayedSourceTimeMs === null && status === "playing") return null;
    return {
      bufferedSessionId,
      generation,
      pipelineEpoch,
      status,
      delayedSourceTimeMs,
      delayedMediaTimeMs: normalizeMediaTimeMs(snapshot.delayedMediaTimeMs),
      sourceTimeMs: normalizeMediaTimeMs(snapshot.sourceTimeMs),
      playbackRate: normalizePositiveNumber(snapshot.playbackRate) ?? 1,
      bufferedSeconds: normalizeNonNegativeNumber(snapshot.bufferedSeconds),
      observedAtEpochMs: normalizePositiveNumber(snapshot.observedAtEpochMs)
    };
  }

  function classifyClockSnapshot(snapshot, state) {
    const normalized = normalizeClockSnapshot(snapshot, {
      bufferedSessionId: state?.bufferedSessionId
    });
    if (!normalized) return { action: "reject", reason: "clock-session-mismatch" };
    if (normalized.generation < state.generation) return { action: "ignore", reason: "old-generation", snapshot: normalized };
    if (normalized.generation > state.generation) return { action: "reset", reason: "generation-change", snapshot: normalized };
    if (
      normalized.pipelineEpoch !== null &&
      state.pipelineEpoch !== null &&
      normalized.pipelineEpoch !== state.pipelineEpoch
    ) {
      return { action: "reset", reason: "pipeline-epoch-change", snapshot: normalized };
    }
    return { action: "accept", snapshot: normalized };
  }

  function getDuckedOriginalVolume({ activeClipCount = 0, outputMode, originalVolume } = {}) {
    const volume = clampVolume(originalVolume);
    const active = normalizeNonNegativeInteger(activeClipCount) ?? 0;
    if (active <= 0) return volume;
    if (outputMode === "dub") return 0;
    if (outputMode === "both") return clampVolume(volume * 0.2);
    return volume;
  }

  function shouldUseTimedDubScheduler(config = {}) {
    return config.provider === "ollama" &&
      config.syncMode === "buffered" &&
      (config.outputMode === "dub" || config.outputMode === "both");
  }

  function shouldRetryClockWait(startedAtEpochMs, nowEpochMs, timeoutMs = CLOCK_WAIT_TIMEOUT_MS) {
    const started = normalizePositiveNumber(startedAtEpochMs);
    const now = normalizePositiveNumber(nowEpochMs);
    const timeout = normalizePositiveNumber(timeoutMs) ?? CLOCK_WAIT_TIMEOUT_MS;
    return Boolean(started && now && now - started <= timeout);
  }

  function isCurrentSchedulerEpoch(epoch, state) {
    return Number.isInteger(epoch) && Boolean(state) && epoch === state.schedulerEpoch;
  }

  function getTimedDubPlaybackRate() {
    return TIMED_DUB_PLAYBACK_RATE;
  }

  function timedDubClipKey(clip) {
    return `${clip.bufferedSessionId}:${clip.generation}:${clip.id}`;
  }

  function isClipDue(clip, delayedSourceTimeMs) {
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    return Boolean(clip && timeMs !== null && clip.startMs <= timeMs && timeMs < clip.endMs);
  }

  function isClipExpired(clip, delayedSourceTimeMs, lateToleranceMs = LATE_DUB_TOLERANCE_MS) {
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    if (!clip || timeMs === null) return false;
    const tolerance = normalizeMediaTimeMs(lateToleranceMs) ?? LATE_DUB_TOLERANCE_MS;
    return timeMs >= clip.endMs || clip.endMs < timeMs - tolerance;
  }

  function sortTimedDubClips(clips) {
    clips.sort(compareTimedDubClips);
    return clips;
  }

  function compareTimedDubClips(left, right) {
    return left.generation - right.generation ||
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.sequence - right.sequence ||
      left.id.localeCompare(right.id);
  }

  function normalizeAudioMime(value) {
    const mime = typeof value === "string" ? value.trim().toLowerCase() : "";
    return ALLOWED_AUDIO_MIME_TYPES.has(mime) ? mime : "";
  }

  function normalizeBase64Payload(value, options = {}) {
    if (typeof value !== "string") return "";
    const compact = value.replace(/\s+/g, "");
    if (!compact) return "";
    const maxChars = normalizePositiveInteger(options.maxBase64Chars) ?? MAX_AUDIO_BASE64_CHARS;
    if (compact.length > maxChars) return "";
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return "";
    if (compact.length % 4 !== 0) return "";
    const decodedBytes = estimateDecodedBase64Bytes(compact);
    const maxDecoded = normalizePositiveInteger(options.maxDecodedBytes) ?? MAX_DECODED_AUDIO_BYTES;
    if (!Number.isFinite(decodedBytes) || decodedBytes <= 0 || decodedBytes > maxDecoded) return "";
    return compact;
  }

  function decodeBase64ToArrayBuffer(value, options = {}) {
    const compact = normalizeBase64Payload(value, options);
    if (!compact) throw new Error("Invalid timed dub audio payload.");
    if (typeof global.atob !== "function") {
      throw new Error("Base64 decoding is not available in this page.");
    }
    let binary;
    try {
      binary = global.atob(compact);
    } catch {
      throw new Error("Invalid timed dub audio payload.");
    }
    if (!binary.length) throw new Error("Invalid timed dub audio payload.");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  function estimateDecodedBase64Bytes(value) {
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return (value.length / 4) * 3 - padding;
  }

  function normalizeId(value) {
    return typeof value === "string" && value.trim()
      ? value.trim().slice(0, MAX_ID_LENGTH)
      : "";
  }

  function normalizeShortIdentifier(value, maxLength) {
    if (typeof value !== "string") return "";
    const normalized = value.trim().slice(0, maxLength);
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "";
  }

  function normalizeMediaTimeMs(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function normalizePositiveNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function normalizeNonNegativeNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function normalizeNonNegativeInteger(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function normalizePositiveInteger(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function clampVolume(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function findClipByKey(clips, key) {
    return Array.isArray(clips) ? clips.find((clip) => clip.key === key) : null;
  }

  function isTerminalState(state) {
    return state === "completed" || state === "dropped" || state === "failed";
  }

  global.AutoTranslateTimedDubSchedulerCore = Object.freeze({
    DEFAULT_QUEUE_LIMIT,
    DEFAULT_MAX_ACTIVE_TIMED_DUBS,
    LATE_DUB_TOLERANCE_MS,
    END_TOLERANCE_MS,
    MIN_PLAYABLE_REMAINDER_MS,
    MAX_AUDIO_BASE64_CHARS,
    MAX_DECODED_AUDIO_BYTES,
    CLOCK_WAIT_TIMEOUT_MS,
    CLOCK_RETRY_INTERVAL_MS,
    TIMED_DUB_PLAYBACK_RATE,
    ALLOWED_AUDIO_MIME_TYPES,
    createTimedDubQueue,
    normalizeTimedDubClip,
    insertTimedDubClips,
    markClipDecoded,
    markClipDecodeFailed,
    selectDueTimedDubClips,
    markClipPlaying,
    markClipTerminal,
    discardExpiredTimedDubClips,
    reduceTimedDubSchedulerState,
    enforceTimedDubQueueLimit,
    buildPlaybackStartDecision,
    shouldStopActiveClip,
    shouldSuspendForClockStatus,
    shouldResumeForClockStatus,
    normalizeClockSnapshot,
    classifyClockSnapshot,
    getDuckedOriginalVolume,
    shouldUseTimedDubScheduler,
    shouldRetryClockWait,
    isCurrentSchedulerEpoch,
    getTimedDubPlaybackRate,
    timedDubClipKey,
    isClipDue,
    isClipExpired,
    sortTimedDubClips,
    compareTimedDubClips,
    normalizeBase64Payload,
    decodeBase64ToArrayBuffer,
    estimateDecodedBase64Bytes
  });
})(globalThis);
