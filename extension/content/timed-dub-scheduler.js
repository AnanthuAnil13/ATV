(() => {
  if (window.__autoTranslateTimedDubSchedulerInstalled) return;
  window.__autoTranslateTimedDubSchedulerInstalled = true;

  const core = window.AutoTranslateTimedDubSchedulerCore;

  const state = {
    active: false,
    config: null,
    queue: null,
    audioContext: null,
    masterGain: null,
    clockUnsubscribe: null,
    clockWaitStartedAt: null,
    clockWaitFrame: null,
    clockWaitTimer: null,
    fallbackTickTimer: null,
    latestClock: null,
    schedulerEpoch: 0,
    fatalErrorReported: false,
    audioSuspended: true,
    resumeFailureCount: 0,
    lastDuckedActiveCount: 0
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "TIMED_DUB_SCHEDULER_START") {
      startScheduler(message.payload || {})
        .then((status) => sendResponse({ ok: true, status }))
        .catch((error) => sendResponse({ ok: false, error: sanitizeError(error) }));
      return true;
    }

    if (message?.type === "TIMED_DUB_SCHEDULER_RESET" || message?.type === "BUFFERED_TIMED_DUB_RESET") {
      resetScheduler(message.payload || {});
      sendResponse?.({ ok: true });
      return false;
    }

    if (message?.type === "TIMED_DUB_SCHEDULER_STOP" || message?.type === "BUFFERED_TIMED_DUB_STOP") {
      stopScheduler()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: sanitizeError(error) }));
      return true;
    }

    if (message?.type === "BUFFERED_TIMED_DUB_CLIPS") {
      handleTimedDubClips(message.payload || {});
      sendResponse?.({ ok: true });
      return false;
    }

    return false;
  });

  async function startScheduler(config) {
    await stopScheduler({ report: false });
    if (!core) throw new Error("Timed dub scheduler helper module was not loaded.");
    if (!core.shouldUseTimedDubScheduler(config)) {
      throw new Error("Timed dub playback is only available for local buffered dub mode.");
    }
    if (!config.bufferedSessionId) throw new Error("Missing buffered playback session ID for timed dub playback.");

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextConstructor !== "function") {
      throw new Error("Web Audio is unavailable for timed dub playback.");
    }

    state.active = true;
    state.config = {
      tabId: config.tabId,
      bufferedSessionId: String(config.bufferedSessionId),
      generation: normalizeInteger(config.generation) ?? 0,
      outputMode: config.outputMode,
      dubVolume: clampVolume(config.dubVolume),
      originalVolume: clampVolume(config.originalVolume)
    };
    state.queue = core.createTimedDubQueue({
      bufferedSessionId: state.config.bufferedSessionId,
      generation: state.config.generation,
      queueLimit: core.DEFAULT_QUEUE_LIMIT,
      maxActiveClips: core.DEFAULT_MAX_ACTIVE_TIMED_DUBS
    });
    state.schedulerEpoch = state.queue.schedulerEpoch;
    state.audioContext = new AudioContextConstructor();
    state.masterGain = state.audioContext.createGain();
    state.masterGain.gain.value = state.config.dubVolume;
    state.masterGain.connect(state.audioContext.destination);
    state.audioSuspended = state.audioContext.state !== "running";
    state.clockWaitStartedAt = Date.now();
    state.latestClock = null;
    state.fatalErrorReported = false;
    state.resumeFailureCount = 0;
    state.lastDuckedActiveCount = 0;

    notifyStatus("waiting-clock");
    ensureClockSubscription();
    return publicStatus("waiting-clock");
  }

  async function stopScheduler({ report = true } = {}) {
    stopClockWait();
    stopFallbackTick();
    unsubscribeClock();
    stopAllActiveClips("stop");
    resetBufferedAudioControl();

    if (state.queue) {
      core?.reduceTimedDubSchedulerState(state.queue, { type: "STOP" });
    }
    if (report) notifyStatus("stopped");
    state.schedulerEpoch += 1;
    state.queue = null;
    state.latestClock = null;
    state.config = null;
    state.active = false;
    state.lastDuckedActiveCount = 0;

    try { state.masterGain?.disconnect(); } catch {}
    state.masterGain = null;
    try {
      if (state.audioContext && state.audioContext.state !== "closed") {
        await state.audioContext.close();
      }
    } catch {}
    state.audioContext = null;
    state.audioSuspended = true;
  }

  function resetScheduler(payload = {}) {
    if (!state.active || !state.queue || !state.config) return;
    if (payload.bufferedSessionId && payload.bufferedSessionId !== state.config.bufferedSessionId) return;
    const nextGeneration = normalizeInteger(payload.generation);
    if (nextGeneration !== null && nextGeneration < state.config.generation) return;

    stopAllActiveClips(payload.reason || "reset");
    core.reduceTimedDubSchedulerState(state.queue, {
      type: "SEEK_RESET",
      generation: nextGeneration ?? state.config.generation,
      pipelineEpoch: normalizeInteger(payload.pipelineEpoch)
    });
    state.schedulerEpoch = state.queue.schedulerEpoch;
    state.config.generation = state.queue.generation;
    state.latestClock = null;
    state.lastDuckedActiveCount = 0;
    resetBufferedAudioControl();
    notifyStatus("reset", { reason: sanitizeReason(payload.reason), generation: state.config.generation });
  }

  function ensureClockSubscription() {
    if (!state.active || state.clockUnsubscribe) return;
    const clock = window.AutoTranslateBufferedPlaybackClock;
    if (clock && typeof clock.subscribe === "function") {
      stopClockWait();
      state.clockUnsubscribe = clock.subscribe((snapshot) => handleClockSnapshot(snapshot));
      if (typeof clock.getSnapshot === "function") handleClockSnapshot(clock.getSnapshot());
      startFallbackTick();
      return;
    }

    if (!core.shouldRetryClockWait(state.clockWaitStartedAt, Date.now())) {
      reportFatalError("Buffered playback clock is unavailable for timed dub playback.");
      return;
    }

    if (state.clockWaitFrame === null) {
      state.clockWaitFrame = requestAnimationFrame(() => {
        state.clockWaitFrame = null;
        ensureClockSubscription();
      });
    }
    if (state.clockWaitTimer === null) {
      state.clockWaitTimer = setTimeout(() => {
        state.clockWaitTimer = null;
        ensureClockSubscription();
      }, core.CLOCK_RETRY_INTERVAL_MS);
    }
  }

  function handleClockSnapshot(rawSnapshot = {}) {
    if (!state.active || !state.queue || !state.config) return;
    const classified = core.classifyClockSnapshot(rawSnapshot, state.queue);
    if (classified.action === "reject") {
      reportFatalError("Timed dub playback clock session mismatch.");
      return;
    }
    if (classified.action === "ignore") return;

    const snapshot = classified.snapshot;
    if (classified.action === "reset") {
      resetScheduler({
        bufferedSessionId: state.config.bufferedSessionId,
        generation: snapshot.generation,
        pipelineEpoch: snapshot.pipelineEpoch,
        reason: classified.reason
      });
      state.queue.pipelineEpoch = snapshot.pipelineEpoch;
    } else if (state.queue.pipelineEpoch === null && snapshot.pipelineEpoch !== null) {
      state.queue.pipelineEpoch = snapshot.pipelineEpoch;
    }

    state.latestClock = snapshot;

    if (snapshot.status === "stopped" || snapshot.status === "ended" || snapshot.status === "error") {
      stopAllActiveClips(snapshot.status);
      updateDucking();
      if (snapshot.status === "ended") notifyStatus("ended");
      return;
    }

    if (core.shouldSuspendForClockStatus(snapshot.status)) {
      setAudioSuspended(true);
      notifyStatus(snapshot.status);
    } else if (core.shouldResumeForClockStatus(snapshot.status)) {
      setAudioSuspended(false);
    }

    processDueClips(snapshot);
    decodePendingClips();
  }

  function handleTimedDubClips(payload = {}) {
    if (!state.active || !state.queue || !state.config) return;
    if (payload.bufferedSessionId !== state.config.bufferedSessionId) return;
    const generation = normalizeInteger(payload.generation);
    if (generation === null || generation < state.config.generation) return;
    if (generation > state.config.generation) {
      resetScheduler({
        bufferedSessionId: state.config.bufferedSessionId,
        generation,
        reason: "generation-change"
      });
    }
    if (generation !== state.config.generation) return;

    const clips = Array.isArray(payload.timedDubClips) ? payload.timedDubClips : [];
    const stats = core.insertTimedDubClips(state.queue, clips, {
      bufferedSessionId: state.config.bufferedSessionId,
      generation,
      sequence: normalizeInteger(payload.sequence) ?? 0,
      delayedSourceTimeMs: state.latestClock?.delayedSourceTimeMs
    });
    if (stats.rejected || stats.late || stats.stale) {
      console.debug("[AutoTranslate timed dub] clip payload filtered", {
        generation,
        sequence: normalizeInteger(payload.sequence),
        rejected: stats.rejected,
        late: stats.late,
        stale: stats.stale
      });
    }
    decodePendingClips();
    if (state.latestClock) processDueClips(state.latestClock);
  }

  function decodePendingClips() {
    if (!state.active || !state.queue || !state.audioContext) return;
    const epoch = state.queue.schedulerEpoch;
    const queued = state.queue.pending.filter((clip) => clip.state === "queued");
    for (const clip of queued) {
      clip.state = "decoding";
      const clipKey = clip.key;
      let arrayBuffer;
      try {
        arrayBuffer = core.decodeBase64ToArrayBuffer(clip.audioBase64, {
          maxBase64Chars: core.MAX_AUDIO_BASE64_CHARS,
          maxDecodedBytes: core.MAX_DECODED_AUDIO_BYTES
        });
      } catch (error) {
        core.markClipDecodeFailed(state.queue, clipKey);
        continue;
      }

      state.audioContext.decodeAudioData(arrayBuffer.slice(0))
        .then((audioBuffer) => {
          if (!state.active || !state.queue || state.queue.schedulerEpoch !== epoch) return;
          const decodedDurationMs = Number(audioBuffer?.duration) * 1000;
          core.markClipDecoded(state.queue, clipKey, audioBuffer, decodedDurationMs);
          if (state.latestClock) processDueClips(state.latestClock);
        })
        .catch(() => {
          if (!state.active || !state.queue || state.queue.schedulerEpoch !== epoch) return;
          core.markClipDecodeFailed(state.queue, clipKey);
        });
    }
  }

  function processDueClips(snapshot) {
    if (!state.active || !state.queue || !state.audioContext || !snapshot) return;
    const delayedSourceTimeMs = snapshot.delayedSourceTimeMs;
    if (!Number.isFinite(delayedSourceTimeMs) || delayedSourceTimeMs < 0) return;

    core.discardExpiredTimedDubClips(state.queue, delayedSourceTimeMs);
    for (const activeClip of state.queue.active.slice()) {
      if (core.shouldStopActiveClip(activeClip, delayedSourceTimeMs)) {
        stopClip(activeClip, "source-window-ended");
      }
    }

    if (snapshot.status !== "playing") {
      updateDucking();
      return;
    }

    const due = core.selectDueTimedDubClips(state.queue, delayedSourceTimeMs);
    for (const clip of due) {
      startClip(clip, delayedSourceTimeMs);
    }
    updateDucking();
  }

  function startClip(clip, delayedSourceTimeMs) {
    if (!state.active || !state.audioContext || !state.masterGain || !clip?.audioBuffer) return;
    const decision = core.buildPlaybackStartDecision(clip, delayedSourceTimeMs, {
      decodedDurationMs: clip.audioBuffer.duration * 1000
    });
    if (decision.action === "wait") return;
    if (decision.action === "drop") {
      core.markClipTerminal(state.queue, clip, "dropped");
      state.queue.counters.droppedExpired += 1;
      return;
    }

    let source;
    try {
      source = state.audioContext.createBufferSource();
      source.buffer = clip.audioBuffer;
      source.playbackRate.value = core.getTimedDubPlaybackRate();
      source.connect(state.masterGain);
      source.onended = () => {
        if (!state.queue) return;
        try { source.disconnect(); } catch {}
        core.markClipTerminal(state.queue, clip.key, "completed");
        updateDucking();
      };
      const offsetSeconds = Math.max(0, decision.audioOffsetMs / 1000);
      source.start(0, offsetSeconds);
      core.markClipPlaying(state.queue, clip, {
        audioSource: source,
        audioOffsetMs: decision.audioOffsetMs,
        delayedSourceTimeMs,
        startedLate: decision.startedLate
      });
    } catch {
      try { source?.disconnect(); } catch {}
      core.markClipTerminal(state.queue, clip, "failed");
    }
  }

  function stopAllActiveClips(reason) {
    if (!state.queue) return;
    for (const clip of state.queue.active.slice()) {
      stopClip(clip, reason || "stop");
    }
  }

  function stopClip(clip, reason) {
    if (!clip) return;
    try { clip.audioSource?.stop(); } catch {}
    try { clip.audioSource?.disconnect(); } catch {}
    core.markClipTerminal(state.queue, clip.key, reason === "source-window-ended" ? "completed" : "dropped");
  }

  function setAudioSuspended(shouldSuspend) {
    if (!state.audioContext || state.audioContext.state === "closed") return;
    if (shouldSuspend) {
      if (state.audioContext.state === "running") {
        state.audioSuspended = true;
        state.audioContext.suspend().catch(() => {});
      }
      return;
    }

    if (state.audioContext.state !== "running") {
      state.audioContext.resume()
        .then(() => {
          state.audioSuspended = false;
          state.resumeFailureCount = 0;
          notifyStatus("playing");
        })
        .catch(() => {
          state.resumeFailureCount += 1;
          if (state.resumeFailureCount >= 3) {
            reportFatalError("Timed dub audio playback was blocked by the browser.");
          } else {
            notifyStatus("audio-blocked");
          }
        });
    } else {
      state.audioSuspended = false;
      state.resumeFailureCount = 0;
      notifyStatus("playing");
    }
  }

  function updateDucking() {
    if (!state.config || !state.queue) return;
    const activeClipCount = state.queue.active.filter((clip) => clip.state === "playing").length;
    if (activeClipCount === state.lastDuckedActiveCount) return;
    state.lastDuckedActiveCount = activeClipCount;
    const control = window.AutoTranslateBufferedPlaybackAudioControl;
    if (!control || typeof control.setTimedDubActivity !== "function") return;
    try {
      control.setTimedDubActivity({
        bufferedSessionId: state.config.bufferedSessionId,
        generation: state.config.generation,
        activeClipCount
      });
    } catch {}
  }

  function resetBufferedAudioControl() {
    const control = window.AutoTranslateBufferedPlaybackAudioControl;
    if (!state.config || !control || typeof control.resetTimedDubActivity !== "function") return;
    try {
      control.resetTimedDubActivity({
        bufferedSessionId: state.config.bufferedSessionId,
        generation: state.config.generation
      });
    } catch {}
  }

  function startFallbackTick() {
    stopFallbackTick();
    state.fallbackTickTimer = setInterval(() => {
      if (!state.active) return;
      const clock = window.AutoTranslateBufferedPlaybackClock;
      if (clock && typeof clock.getSnapshot === "function") {
        handleClockSnapshot(clock.getSnapshot());
      }
    }, 250);
  }

  function stopFallbackTick() {
    clearInterval(state.fallbackTickTimer);
    state.fallbackTickTimer = null;
  }

  function stopClockWait() {
    if (state.clockWaitFrame !== null) cancelAnimationFrame(state.clockWaitFrame);
    clearTimeout(state.clockWaitTimer);
    state.clockWaitFrame = null;
    state.clockWaitTimer = null;
  }

  function unsubscribeClock() {
    if (typeof state.clockUnsubscribe === "function") {
      try { state.clockUnsubscribe(); } catch {}
    }
    state.clockUnsubscribe = null;
  }

  function notifyStatus(status, extra = {}) {
    if (!state.config) return;
    chrome.runtime.sendMessage({
      type: "BUFFERED_TIMED_DUB_STATUS",
      payload: {
        tabId: state.config.tabId,
        bufferedSessionId: state.config.bufferedSessionId,
        generation: state.config.generation,
        status,
        queueSize: state.queue?.pending.length ?? 0,
        activeClipCount: state.queue?.active.length ?? 0,
        counters: sanitizeCounters(state.queue?.counters),
        ...extra
      }
    }).catch(() => null);
  }

  function reportFatalError(message) {
    if (state.fatalErrorReported) return;
    state.fatalErrorReported = true;
    notifyStatus("error", { error: sanitizeError(message) });
  }

  function publicStatus(status) {
    return {
      status,
      bufferedSessionId: state.config?.bufferedSessionId,
      generation: state.config?.generation,
      queueSize: state.queue?.pending.length ?? 0,
      activeClipCount: state.queue?.active.length ?? 0
    };
  }

  function sanitizeCounters(counters = {}) {
    const result = {};
    for (const key of ["received", "decoded", "played", "lateStarted", "droppedExpired", "droppedStale", "decodeFailed"]) {
      const number = Number(counters[key]);
      result[key] = Number.isFinite(number) && number >= 0 ? number : 0;
    }
    return result;
  }

  function sanitizeError(error) {
    const message = error?.message || String(error || "Timed dub playback failed.");
    return message.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function sanitizeReason(value) {
    return typeof value === "string" ? value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) : undefined;
  }

  function normalizeInteger(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function clampVolume(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
  }
})();
