(function installTranslationReadinessCore(global) {
  if (global.AutoTranslateTranslationReadinessCore) return;

  const COVERAGE_GAP_TOLERANCE_MS = 250;
  const TRANSLATION_READINESS_TIMEOUT_MS = 90_000;
  const MAX_TRANSLATION_COVERAGE_RANGES = 256;

  function createTranslationReadinessState(options = {}) {
    const state = {
      bufferedSessionId: normalizeId(options.bufferedSessionId),
      generation: normalizeNonNegativeInteger(options.generation) ?? 0,
      required: Boolean(options.required),
      initialBufferSeconds: normalizePositiveNumber(options.initialBufferSeconds) ?? 10,
      ranges: [],
      seenKeys: new Set(),
      translationCoverageStartMs: null,
      translationReadyThroughMs: null,
      translationReadyLeadMs: 0,
      translationReady: !Boolean(options.required),
      translationCoverageCount: 0,
      waitingStartedAtEpochMs: null,
      waitingPausedAtEpochMs: null,
      waitingPausedDurationMs: 0,
      timedOut: false,
      errorCode: "",
      maxRanges: normalizePositiveInteger(options.maxRanges) ?? MAX_TRANSLATION_COVERAGE_RANGES
    };
    updateReadinessWatermark(state, options);
    return state;
  }

  function normalizeTranslationCoverageRange(raw = {}, context = {}) {
    const bufferedSessionId = normalizeId(raw.bufferedSessionId ?? context.bufferedSessionId);
    const generation = normalizeNonNegativeInteger(raw.generation ?? context.generation);
    const sequence = normalizeNonNegativeInteger(raw.sequence ?? context.sequence);
    const startMs = normalizeMediaTimeMs(raw.startMs);
    const endMs = normalizeMediaTimeMs(raw.endMs);
    const translatedSegmentCount = normalizeNonNegativeInteger(raw.translatedSegmentCount);

    if (!bufferedSessionId || generation === null || sequence === null) return null;
    if (startMs === null || endMs === null || endMs <= startMs) return null;
    if (translatedSegmentCount === null) return null;

    return {
      key: coverageKey({ bufferedSessionId, generation, sequence }),
      bufferedSessionId,
      generation,
      sequence,
      startMs,
      endMs,
      empty: raw.empty === true,
      translatedSegmentCount
    };
  }

  function insertTranslationCoverageRange(state, rawRange, context = {}) {
    const stats = { inserted: 0, rejected: 0, duplicates: 0, stale: 0 };
    if (!state) {
      stats.rejected = 1;
      return stats;
    }
    const range = normalizeTranslationCoverageRange(rawRange, {
      bufferedSessionId: state.bufferedSessionId,
      generation: state.generation,
      ...context
    });
    if (!range) {
      stats.rejected = 1;
      return stats;
    }
    if (state.bufferedSessionId && range.bufferedSessionId !== state.bufferedSessionId) {
      stats.stale = 1;
      return stats;
    }
    if (range.generation !== state.generation) {
      stats.stale = 1;
      return stats;
    }
    if (state.seenKeys.has(range.key)) {
      stats.duplicates = 1;
      return stats;
    }

    state.seenKeys.add(range.key);
    state.ranges.push(range);
    state.ranges = normalizeTranslationCoverageRanges(state.ranges, {
      bufferedSessionId: state.bufferedSessionId,
      generation: state.generation
    });
    enforceCoverageRangeLimit(state);
    updateReadinessWatermark(state, context);
    stats.inserted = 1;
    return stats;
  }

  function normalizeTranslationCoverageRanges(ranges, context = {}) {
    const seen = new Set();
    const normalized = [];
    for (const raw of Array.from(ranges || [])) {
      const range = normalizeTranslationCoverageRange(raw, context);
      if (!range) continue;
      if (context.bufferedSessionId && range.bufferedSessionId !== context.bufferedSessionId) continue;
      if (context.generation !== undefined && range.generation !== Number(context.generation)) continue;
      if (seen.has(range.key)) continue;
      seen.add(range.key);
      normalized.push(range);
    }
    return sortCoverageRanges(normalized);
  }

  function mergeTranslationCoverageRanges(ranges, options = {}) {
    const tolerance = normalizeMediaTimeMs(options.gapToleranceMs) ?? COVERAGE_GAP_TOLERANCE_MS;
    const normalized = normalizeTranslationCoverageRanges(ranges, options);
    const merged = [];

    for (const range of normalized) {
      const current = merged[merged.length - 1];
      if (!current || range.startMs > current.endMs + tolerance) {
        merged.push({
          startMs: range.startMs,
          endMs: range.endMs,
          rangeCount: 1,
          firstSequence: range.sequence,
          lastSequence: range.sequence
        });
        continue;
      }
      current.endMs = Math.max(current.endMs, range.endMs);
      current.rangeCount += 1;
      current.lastSequence = Math.max(current.lastSequence, range.sequence);
    }
    return merged;
  }

  function calculateContinuousTranslationWatermark(ranges, options = {}) {
    const merged = mergeTranslationCoverageRanges(ranges, options);
    if (!merged.length) {
      return {
        translationCoverageStartMs: null,
        translationReadyThroughMs: null,
        translationReadyLeadMs: 0,
        nextGapStartMs: null,
        nextGapDurationMs: null,
        coverageRangeCount: 0
      };
    }

    const first = merged[0];
    const next = merged[1] || null;
    return {
      translationCoverageStartMs: first.startMs,
      translationReadyThroughMs: first.endMs,
      translationReadyLeadMs: Math.max(0, first.endMs - first.startMs),
      nextGapStartMs: next ? first.endMs : null,
      nextGapDurationMs: next ? Math.max(0, next.startMs - first.endMs) : null,
      coverageRangeCount: normalizeTranslationCoverageRanges(ranges, options).length
    };
  }

  function calculateTranslationReadyLeadMs(stateOrRanges, options = {}) {
    if (Array.isArray(stateOrRanges)) {
      return calculateContinuousTranslationWatermark(stateOrRanges, options).translationReadyLeadMs;
    }
    return normalizeMediaTimeMs(stateOrRanges?.translationReadyLeadMs) ?? 0;
  }

  function isTranslationReadinessSatisfied(stateOrOptions = {}, options = {}) {
    const required = stateOrOptions.required ?? options.required ?? true;
    if (!required) return true;
    const initialBufferSeconds = normalizePositiveNumber(
      options.initialBufferSeconds ?? stateOrOptions.initialBufferSeconds
    ) ?? 10;
    const requiredLeadMs = initialBufferSeconds * 1000;
    const leadMs = calculateTranslationReadyLeadMs(stateOrOptions, options);
    return leadMs >= requiredLeadMs;
  }

  function isInitialPlaybackGateSatisfied(options = {}) {
    if (!options.mediaReady) return false;
    if (!options.translationReadinessRequired) return true;
    return options.translationReady === true;
  }

  function shouldRequireTranslationReadiness(config = {}) {
    return config.provider === "ollama" &&
      config.syncMode === "buffered" &&
      (config.outputMode === "subtitles" || config.outputMode === "both");
  }

  function resetTranslationReadinessGeneration(state, options = {}) {
    if (!state) return state;
    state.generation = normalizeNonNegativeInteger(options.generation) ?? state.generation;
    state.ranges = [];
    state.seenKeys = new Set();
    state.translationCoverageStartMs = null;
    state.translationReadyThroughMs = null;
    state.translationReadyLeadMs = 0;
    state.translationReady = !state.required;
    state.translationCoverageCount = 0;
    state.waitingStartedAtEpochMs = null;
    state.waitingPausedAtEpochMs = null;
    state.waitingPausedDurationMs = 0;
    state.timedOut = false;
    state.errorCode = "";
    return state;
  }

  function reduceTranslationReadinessState(state, action = {}) {
    if (!state) return state;
    switch (action.type) {
      case "COVERAGE":
        insertTranslationCoverageRange(state, action.range, action);
        return state;
      case "GENERATION_CHANGE":
      case "SEEK_RESET":
        return resetTranslationReadinessGeneration(state, { generation: action.generation });
      case "PAUSE":
        if (state.waitingStartedAtEpochMs !== null && state.waitingPausedAtEpochMs === null) {
          state.waitingPausedAtEpochMs = normalizeEpochMs(action.nowEpochMs) ?? Date.now();
        }
        return state;
      case "RESUME": {
        const now = normalizeEpochMs(action.nowEpochMs) ?? Date.now();
        if (state.waitingPausedAtEpochMs !== null) {
          state.waitingPausedDurationMs += Math.max(0, now - state.waitingPausedAtEpochMs);
          state.waitingPausedAtEpochMs = null;
        }
        return state;
      }
      case "WAITING":
        updateReadinessTimeout(state, action);
        return state;
      case "MEDIA_NOT_READY":
      case "READY":
        state.waitingStartedAtEpochMs = null;
        state.waitingPausedAtEpochMs = null;
        state.waitingPausedDurationMs = 0;
        return state;
      case "STOP":
        return resetTranslationReadinessGeneration(state, { generation: state.generation });
      default:
        return state;
    }
  }

  function updateReadinessWatermark(state, options = {}) {
    const nextInitialBufferSeconds = normalizePositiveNumber(options.initialBufferSeconds);
    if (nextInitialBufferSeconds !== null) state.initialBufferSeconds = nextInitialBufferSeconds;
    const watermark = calculateContinuousTranslationWatermark(state.ranges, {
      bufferedSessionId: state.bufferedSessionId,
      generation: state.generation,
      gapToleranceMs: options.gapToleranceMs
    });
    state.translationCoverageStartMs = watermark.translationCoverageStartMs;
    state.translationReadyThroughMs = watermark.translationReadyThroughMs;
    state.translationReadyLeadMs = watermark.translationReadyLeadMs;
    state.translationCoverageCount = watermark.coverageRangeCount;
    state.translationReady = isTranslationReadinessSatisfied(state, options);
    if (state.translationReady) {
      state.waitingStartedAtEpochMs = null;
      state.waitingPausedAtEpochMs = null;
      state.waitingPausedDurationMs = 0;
      state.timedOut = false;
      state.errorCode = "";
    }
    return watermark;
  }

  function updateReadinessTimeout(state, options = {}) {
    if (!state.required || state.translationReady || state.timedOut) return state;
    if (!options.mediaReady || options.paused || options.seeking || options.rebuffering) return state;
    const now = normalizeEpochMs(options.nowEpochMs) ?? Date.now();
    if (state.waitingStartedAtEpochMs === null) {
      state.waitingStartedAtEpochMs = now;
      state.waitingPausedAtEpochMs = null;
      state.waitingPausedDurationMs = 0;
      return state;
    }
    const timeoutMs = normalizePositiveInteger(options.timeoutMs) ?? TRANSLATION_READINESS_TIMEOUT_MS;
    const elapsedMs = getReadinessWaitElapsedMs(state, now);
    if (elapsedMs >= timeoutMs) {
      state.timedOut = true;
      state.errorCode = "TRANSLATION_READINESS_TIMEOUT";
    }
    return state;
  }

  function getReadinessWaitElapsedMs(state, nowEpochMs = Date.now()) {
    if (!state || state.waitingStartedAtEpochMs === null) return 0;
    const now = normalizeEpochMs(nowEpochMs) ?? Date.now();
    const pausedExtra = state.waitingPausedAtEpochMs === null
      ? 0
      : Math.max(0, now - state.waitingPausedAtEpochMs);
    return Math.max(0, now - state.waitingStartedAtEpochMs - state.waitingPausedDurationMs - pausedExtra);
  }

  function createPublicReadinessSnapshot(state) {
    return {
      translationReadinessRequired: Boolean(state?.required),
      translationCoverageStartMs: finiteOrNull(state?.translationCoverageStartMs),
      translationReadyThroughMs: finiteOrNull(state?.translationReadyThroughMs),
      translationReadyLeadMs: normalizeMediaTimeMs(state?.translationReadyLeadMs) ?? 0,
      translationReady: Boolean(state?.translationReady),
      translationCoverageCount: normalizeNonNegativeInteger(state?.translationCoverageCount) ?? 0
    };
  }

  function sortCoverageRanges(ranges) {
    ranges.sort((left, right) => left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.sequence - right.sequence);
    return ranges;
  }

  function enforceCoverageRangeLimit(state) {
    state.ranges = sortCoverageRanges(state.ranges);
    while (state.ranges.length > state.maxRanges) {
      state.ranges.pop();
    }
    state.seenKeys = new Set(state.ranges.map((range) => range.key));
  }

  function coverageKey(range) {
    return `${range.bufferedSessionId}:${range.generation}:${range.sequence}`;
  }

  function normalizeId(value) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
  }

  function normalizeMediaTimeMs(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function normalizeEpochMs(value) {
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

  function normalizePositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  global.AutoTranslateTranslationReadinessCore = Object.freeze({
    COVERAGE_GAP_TOLERANCE_MS,
    TRANSLATION_READINESS_TIMEOUT_MS,
    MAX_TRANSLATION_COVERAGE_RANGES,
    createTranslationReadinessState,
    normalizeTranslationCoverageRange,
    insertTranslationCoverageRange,
    normalizeTranslationCoverageRanges,
    mergeTranslationCoverageRanges,
    calculateContinuousTranslationWatermark,
    calculateTranslationReadyLeadMs,
    isTranslationReadinessSatisfied,
    isInitialPlaybackGateSatisfied,
    resetTranslationReadinessGeneration,
    shouldRequireTranslationReadiness,
    reduceTranslationReadinessState,
    updateReadinessWatermark,
    updateReadinessTimeout,
    getReadinessWaitElapsedMs,
    createPublicReadinessSnapshot,
    coverageKey
  });
})(globalThis);
