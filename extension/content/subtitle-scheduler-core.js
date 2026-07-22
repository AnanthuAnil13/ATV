(function installSubtitleSchedulerCore(global) {
  if (global.AutoTranslateSubtitleSchedulerCore) return;

  const MAX_TEXT_LENGTH = 280;
  const MAX_SOURCE_TEXT_LENGTH = 220;
  const DEFAULT_QUEUE_LIMIT = 200;
  const DEFAULT_MAX_ACTIVE_CUES = 2;
  const LATE_CUE_TOLERANCE_MS = 250;
  const EXTRAPOLATION_LIMIT_MS = 500;

  function normalizeSubtitleCue(raw = {}, context = {}) {
    const id = normalizeId(raw.id);
    const bufferedSessionId = normalizeId(raw.bufferedSessionId ?? context.bufferedSessionId);
    const generation = normalizeNonNegativeInteger(raw.generation ?? context.generation);
    const sequence = normalizeNonNegativeInteger(raw.sequence ?? context.sequence) ?? 0;
    const startMs = normalizeMediaTimeMs(raw.startMs);
    const endMs = normalizeMediaTimeMs(raw.endMs);
    const translatedText = normalizeText(raw.translatedText, MAX_TEXT_LENGTH);

    if (!id) return null;
    if (!bufferedSessionId) return null;
    if (generation === null) return null;
    if (startMs === null || endMs === null || endMs <= startMs) return null;
    if (typeof raw.translatedText !== "string") return null;

    const cue = {
      id,
      bufferedSessionId,
      generation,
      sequence,
      startMs,
      endMs,
      translatedText
    };
    if (context.showSourceTranscript && typeof raw.sourceText === "string") {
      cue.sourceText = normalizeText(raw.sourceText, MAX_SOURCE_TEXT_LENGTH);
    }
    return cue;
  }

  function createSubtitleCueQueue(options = {}) {
    const queueLimit = normalizePositiveInteger(options.queueLimit) ?? DEFAULT_QUEUE_LIMIT;
    const state = {
      bufferedSessionId: normalizeId(options.bufferedSessionId),
      generation: normalizeNonNegativeInteger(options.generation) ?? 0,
      pending: [],
      active: [],
      seenKeys: new Set(),
      droppedLateCueCount: 0,
      queueLimit
    };
    return state;
  }

  function insertSubtitleCues(state, rawCues, context = {}) {
    if (!state || !Array.isArray(rawCues)) return { inserted: 0, rejected: 0, duplicates: 0, late: 0 };
    const effectiveContext = {
      bufferedSessionId: state.bufferedSessionId,
      generation: state.generation,
      ...context
    };
    const nowMs = normalizeMediaTimeMs(context.delayedSourceTimeMs);
    const stats = { inserted: 0, rejected: 0, duplicates: 0, late: 0 };

    for (const rawCue of rawCues) {
      const cue = normalizeSubtitleCue(rawCue, effectiveContext);
      if (!cue) {
        stats.rejected += 1;
        continue;
      }
      if (state.bufferedSessionId && cue.bufferedSessionId !== state.bufferedSessionId) {
        stats.rejected += 1;
        continue;
      }
      if (cue.generation !== state.generation) {
        stats.rejected += 1;
        continue;
      }
      if (nowMs !== null && isCueSeverelyLate(cue, nowMs, context.lateToleranceMs)) {
        state.droppedLateCueCount += 1;
        stats.late += 1;
        continue;
      }

      const key = cueDedupKey(cue);
      if (state.seenKeys.has(key)) {
        stats.duplicates += 1;
        continue;
      }
      state.seenKeys.add(key);
      state.pending.push(cue);
      stats.inserted += 1;
    }

    sortCues(state.pending);
    enforceQueueLimit(state, nowMs);
    return stats;
  }

  function selectActiveCues(state, delayedSourceTimeMs, options = {}) {
    if (!state) return [];
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    if (timeMs === null) return [];

    discardExpiredCues(state, timeMs, options);
    const candidates = [...state.active, ...state.pending]
      .filter((cue) => shouldDisplayCue(cue, timeMs))
      .sort(compareCues);
    const active = candidates.slice(0, normalizePositiveInteger(options.maxActiveCues) ?? DEFAULT_MAX_ACTIVE_CUES);
    const activeKeys = new Set(active.map(cueDedupKey));
    state.active = active;
    state.pending = state.pending
      .filter((cue) => !activeKeys.has(cueDedupKey(cue)) && cue.endMs > timeMs)
      .sort(compareCues);
    return active;
  }

  function discardExpiredCues(state, delayedSourceTimeMs, options = {}) {
    if (!state) return { expired: 0, late: 0 };
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    if (timeMs === null) return { expired: 0, late: 0 };
    const tolerance = normalizeMediaTimeMs(options.lateToleranceMs) ?? LATE_CUE_TOLERANCE_MS;
    let expired = 0;
    let late = 0;
    const keep = (cue) => {
      if (cue.endMs < timeMs - tolerance) {
        expired += 1;
        late += 1;
        state.droppedLateCueCount += 1;
        return false;
      }
      if (cue.endMs <= timeMs) {
        expired += 1;
        return false;
      }
      return true;
    };
    state.pending = state.pending.filter(keep);
    state.active = state.active.filter(keep);
    return { expired, late };
  }

  function removeStaleGenerationCues(state, generation) {
    if (!state) return state;
    const nextGeneration = normalizeNonNegativeInteger(generation);
    if (nextGeneration === null) return state;
    state.generation = nextGeneration;
    state.pending = state.pending.filter((cue) => cue.generation === nextGeneration);
    state.active = state.active.filter((cue) => cue.generation === nextGeneration);
    state.seenKeys = new Set(
      [...state.pending, ...state.active]
        .filter((cue) => cue.generation === nextGeneration)
        .map(cueDedupKey)
    );
    return state;
  }

  function reduceSubtitleSchedulerState(state, action = {}) {
    if (!state) return state;
    if (action.type === "RESET_SESSION") {
      state.bufferedSessionId = normalizeId(action.bufferedSessionId);
      state.generation = normalizeNonNegativeInteger(action.generation) ?? 0;
      state.pending = [];
      state.active = [];
      state.seenKeys = new Set();
      state.droppedLateCueCount = 0;
      return state;
    }
    if (action.type === "GENERATION_CHANGE" || action.type === "SEEK_RESET") {
      state.generation = normalizeNonNegativeInteger(action.generation) ?? state.generation;
      state.pending = [];
      state.active = [];
      state.seenKeys = new Set();
      return state;
    }
    if (action.type === "STOP") {
      state.pending = [];
      state.active = [];
      state.seenKeys = new Set();
      return state;
    }
    return state;
  }

  function renderCueLines(activeCues, options = {}) {
    const cues = Array.isArray(activeCues)
      ? activeCues.slice(0, normalizePositiveInteger(options.maxActiveCues) ?? DEFAULT_MAX_ACTIVE_CUES)
      : [];
    return {
      targetText: cues.map((cue) => cue.translatedText).filter(Boolean).join("\n"),
      sourceText: options.showSourceTranscript
        ? cues.map((cue) => cue.sourceText || "").filter(Boolean).join("\n")
        : ""
    };
  }

  function shouldDisplayCue(cue, delayedSourceTimeMs) {
    const timeMs = normalizeMediaTimeMs(delayedSourceTimeMs);
    return Boolean(cue && timeMs !== null && cue.startMs <= timeMs && timeMs < cue.endMs);
  }

  function shouldUseBufferedSubtitleScheduler(config = {}) {
    return config.provider === "ollama" &&
      config.syncMode === "buffered" &&
      (config.outputMode === "subtitles" || config.outputMode === "both");
  }

  function cueDedupKey(cue) {
    return `${cue.bufferedSessionId}:${cue.generation}:${cue.id}`;
  }

  function calculateDelayedSourceTime(delayedMediaTimeMs, ranges, options = {}) {
    const mediaTime = normalizeMediaTimeMs(delayedMediaTimeMs);
    if (mediaTime === null) return null;
    const normalized = normalizeClockRanges(ranges, options);
    if (!normalized.length) return null;

    for (const range of normalized) {
      if (mediaTime >= range.delayedMediaStartMs && mediaTime <= range.delayedMediaEndMs) {
        return interpolatePlaybackClock(mediaTime, range);
      }
    }

    const before = normalized.find((range) => mediaTime < range.delayedMediaStartMs);
    if (before && before.delayedMediaStartMs - mediaTime <= EXTRAPOLATION_LIMIT_MS) {
      return boundedExtrapolate(mediaTime, before);
    }
    const after = normalized.slice().reverse().find((range) => mediaTime > range.delayedMediaEndMs);
    if (after && mediaTime - after.delayedMediaEndMs <= EXTRAPOLATION_LIMIT_MS) {
      return boundedExtrapolate(mediaTime, after);
    }
    return null;
  }

  function interpolatePlaybackClock(delayedMediaTimeMs, range) {
    const mediaTime = normalizeMediaTimeMs(delayedMediaTimeMs);
    const normalized = normalizeClockRange(range);
    if (mediaTime === null || !normalized) return null;
    const mediaSpan = normalized.delayedMediaEndMs - normalized.delayedMediaStartMs;
    const sourceSpan = normalized.sourceEndMs - normalized.sourceStartMs;
    const progress = (mediaTime - normalized.delayedMediaStartMs) / mediaSpan;
    const sourceTime = normalized.sourceStartMs + progress * sourceSpan;
    return Number.isFinite(sourceTime) && sourceTime >= 0 ? sourceTime : null;
  }

  function normalizeClockRange(range, options = {}) {
    if (!range || typeof range !== "object") return null;
    if (
      options.pipelineEpoch !== undefined &&
      Number.isInteger(range.pipelineEpoch) &&
      range.pipelineEpoch !== options.pipelineEpoch
    ) {
      return null;
    }
    const generation = normalizeNonNegativeInteger(range.generation ?? options.generation);
    const delayedMediaStartMs = normalizeMediaTimeMs(range.delayedMediaStartMs);
    const delayedMediaEndMs = normalizeMediaTimeMs(range.delayedMediaEndMs);
    const sourceStartMs = normalizeMediaTimeMs(range.sourceStartMs);
    const sourceEndMs = normalizeMediaTimeMs(range.sourceEndMs);
    if (generation === null || delayedMediaStartMs === null || delayedMediaEndMs === null) return null;
    if (sourceStartMs === null || sourceEndMs === null) return null;
    if (delayedMediaEndMs <= delayedMediaStartMs || sourceEndMs < sourceStartMs) return null;
    return {
      generation,
      pipelineEpoch: Number.isInteger(range.pipelineEpoch) ? range.pipelineEpoch : undefined,
      delayedMediaStartMs,
      delayedMediaEndMs,
      sourceStartMs,
      sourceEndMs
    };
  }

  function normalizeClockRanges(ranges, options = {}) {
    return Array.from(ranges || [])
      .map((range) => normalizeClockRange(range, options))
      .filter(Boolean)
      .sort((left, right) => left.delayedMediaStartMs - right.delayedMediaStartMs || left.sourceStartMs - right.sourceStartMs);
  }

  function sortCues(cues) {
    cues.sort(compareCues);
    return cues;
  }

  function compareCues(left, right) {
    return left.generation - right.generation ||
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.sequence - right.sequence ||
      left.id.localeCompare(right.id);
  }

  function enforceQueueLimit(state, delayedSourceTimeMs) {
    if (!state || state.pending.length + state.active.length <= state.queueLimit) return;
    if (delayedSourceTimeMs !== null) discardExpiredCues(state, delayedSourceTimeMs);
    const activeKeys = new Set(state.active.map(cueDedupKey));
    state.pending = state.pending
      .filter((cue) => !activeKeys.has(cueDedupKey(cue)))
      .sort(compareCues);
    while (state.pending.length + state.active.length > state.queueLimit && state.pending.length) {
      state.pending.pop();
    }
  }

  function boundedExtrapolate(mediaTime, range) {
    const interpolated = interpolatePlaybackClock(mediaTime, range);
    if (interpolated === null) return null;
    const min = Math.min(range.sourceStartMs, range.sourceEndMs);
    const max = Math.max(range.sourceStartMs, range.sourceEndMs);
    return Math.min(max, Math.max(min, interpolated));
  }

  function isCueSeverelyLate(cue, delayedSourceTimeMs, lateToleranceMs = LATE_CUE_TOLERANCE_MS) {
    const tolerance = normalizeMediaTimeMs(lateToleranceMs) ?? LATE_CUE_TOLERANCE_MS;
    return cue.endMs < delayedSourceTimeMs - tolerance;
  }

  function normalizeId(value) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
  }

  function normalizeText(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function normalizeMediaTimeMs(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function normalizeNonNegativeInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function normalizePositiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  global.AutoTranslateSubtitleSchedulerCore = Object.freeze({
    DEFAULT_QUEUE_LIMIT,
    DEFAULT_MAX_ACTIVE_CUES,
    LATE_CUE_TOLERANCE_MS,
    EXTRAPOLATION_LIMIT_MS,
    normalizeSubtitleCue,
    createSubtitleCueQueue,
    insertSubtitleCues,
    selectActiveCues,
    discardExpiredCues,
    removeStaleGenerationCues,
    reduceSubtitleSchedulerState,
    renderCueLines,
    shouldDisplayCue,
    shouldUseBufferedSubtitleScheduler,
    calculateDelayedSourceTime,
    interpolatePlaybackClock,
    normalizeClockRange,
    normalizeClockRanges,
    sortCues,
    compareCues,
    cueDedupKey,
    isCueSeverelyLate
  });
})(globalThis);
