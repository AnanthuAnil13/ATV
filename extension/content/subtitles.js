(() => {
  if (window.__autoTranslateOverlayInstalled) return;
  window.__autoTranslateOverlayInstalled = true;

  const schedulerCore = window.AutoTranslateSubtitleSchedulerCore;

  const state = {
    mode: "live",
    source: "",
    target: "",
    sourceLastElapsedMs: null,
    targetLastElapsedMs: null,
    sourceClearTimer: null,
    targetClearTimer: null,
    showSourceTranscript: false,
    visible: true,
    bufferedSessionId: "",
    generation: 0,
    scheduler: null,
    latestClock: null,
    clockUnsubscribe: null,
    schedulerFrame: null,
    schedulerTimer: null,
    schedulerError: "",
    clockWaitStartedAt: null
  };

  const root = document.createElement("section");
  root.id = "autotranslate-overlay";
  root.setAttribute("aria-live", "polite");
  root.innerHTML = `
    <div class="autotranslate-shell">
      <div class="autotranslate-toolbar">
        <span class="autotranslate-brand">AutoTranslate</span>
        <span class="autotranslate-status" data-status="starting">Starting</span>
        <button class="autotranslate-hide" type="button" aria-label="Hide subtitles">×</button>
      </div>
      <div class="autotranslate-source" aria-label="Source transcript"></div>
      <div class="autotranslate-target" aria-label="Translated subtitles"></div>
      <div class="autotranslate-disclosure">AI-generated live translation</div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const sourceEl = root.querySelector(".autotranslate-source");
  const targetEl = root.querySelector(".autotranslate-target");
  const statusEl = root.querySelector(".autotranslate-status");
  const hideButton = root.querySelector(".autotranslate-hide");
  const disclosureEl = root.querySelector(".autotranslate-disclosure");

  hideButton.addEventListener("click", () => {
    state.visible = false;
    root.hidden = true;
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "OVERLAY_CONFIG") {
      configureOverlay(message.payload || {});
    }

    if (message?.type === "OVERLAY_TRANSCRIPT") {
      if (!state.visible || state.mode === "buffered") return;
      const payload = message.payload || {};
      if (payload.kind === "source" && !state.showSourceTranscript) return;
      root.hidden = false;
      appendCue(payload.kind, payload.delta, payload.elapsedMs, payload.replace === true);
    }

    if (message?.type === "BUFFERED_SUBTITLE_SEGMENTS") {
      handleBufferedSubtitleSegments(message.payload || {});
    }

    if (message?.type === "OVERLAY_STATUS") {
      const { status = "idle", error } = message.payload || {};
      statusEl.dataset.status = status;
      statusEl.textContent = labelForStatus(status);
      if (state.mode === "buffered" && ["buffering", "waiting-translation", "rebuffering"].includes(status)) {
        clearRenderedCues();
        if (state.scheduler) state.scheduler.active = [];
      }
      if (error) {
        state.target = error;
        targetEl.textContent = error;
      }
    }

    if (message?.type === "OVERLAY_STOP") {
      cleanupScheduler();
      clearTimers();
      document.removeEventListener("fullscreenchange", placeOverlay);
      root.remove();
      window.__autoTranslateOverlayInstalled = false;
    }
  });

  document.addEventListener("fullscreenchange", placeOverlay);

  function configureOverlay(payload) {
    cleanupScheduler();
    resetCues();
    statusEl.dataset.status = "starting";
    statusEl.textContent = "Starting";
    state.showSourceTranscript = Boolean(payload.showSourceTranscript);
    state.mode = schedulerCore?.shouldUseBufferedSubtitleScheduler(payload) ? "buffered" : "live";
    state.bufferedSessionId = typeof payload.bufferedSessionId === "string" ? payload.bufferedSessionId : "";
    state.generation = Number.isInteger(Number(payload.generation)) ? Number(payload.generation) : 0;
    state.latestClock = null;
    state.clockWaitStartedAt = null;
    root.dataset.showSource = String(state.showSourceTranscript);
    root.dataset.syncMode = state.mode;
    const provider = payload.provider === "ollama" ? "Local Ollama" : "OpenAI";
    disclosureEl.textContent = state.mode === "buffered"
      ? `AI-generated buffered translation · ${provider}`
      : `AI-generated live translation · ${provider}`;
    state.visible = true;
    root.hidden = false;

    if (state.mode === "buffered") {
      startBufferedScheduler();
    }
  }

  function startBufferedScheduler() {
    if (!schedulerCore || !state.bufferedSessionId) {
      setSchedulerError("Buffered subtitle scheduler could not start.");
      return;
    }
    state.scheduler = schedulerCore.createSubtitleCueQueue({
      bufferedSessionId: state.bufferedSessionId,
      generation: state.generation
    });
    state.clockWaitStartedAt = Date.now();
    statusEl.dataset.status = "buffering";
    statusEl.textContent = "Waiting";
    ensureClockSubscription();
  }

  function ensureClockSubscription() {
    if (state.mode !== "buffered" || state.clockUnsubscribe) return;
    const clock = window.AutoTranslateBufferedPlaybackClock;
    if (clock && typeof clock.subscribe === "function") {
      clearTimeout(state.schedulerTimer);
      state.schedulerTimer = null;
      state.clockUnsubscribe = clock.subscribe((snapshot) => {
        handleClockSnapshot(snapshot);
      });
      return;
    }
    if (state.clockWaitStartedAt && Date.now() - state.clockWaitStartedAt > 15_000) {
      setSchedulerError("Buffered playback clock is unavailable.");
      return;
    }

    state.schedulerFrame = requestAnimationFrame(() => {
      state.schedulerFrame = null;
      const nextClock = window.AutoTranslateBufferedPlaybackClock;
      if (nextClock && typeof nextClock.subscribe === "function") {
        ensureClockSubscription();
        return;
      }
      if (nextClock && typeof nextClock.getSnapshot === "function") {
        handleClockSnapshot(nextClock.getSnapshot());
      }
      if (state.mode === "buffered" && !state.clockUnsubscribe) {
        state.schedulerTimer = setTimeout(ensureClockSubscription, 250);
      }
    });
  }

  function handleBufferedSubtitleSegments(payload) {
    if (!state.visible || state.mode !== "buffered" || !state.scheduler || !schedulerCore) return;
    if (payload.bufferedSessionId !== state.bufferedSessionId) return;
    const generation = Number(payload.generation);
    if (!Number.isInteger(generation) || generation !== state.generation) return;
    const sequence = Number.isInteger(Number(payload.sequence)) ? Number(payload.sequence) : 0;
    const cues = Array.isArray(payload.translatedSegments) ? payload.translatedSegments : [];
    const stats = schedulerCore.insertSubtitleCues(state.scheduler, cues, {
      bufferedSessionId: state.bufferedSessionId,
      generation,
      sequence,
      showSourceTranscript: state.showSourceTranscript,
      delayedSourceTimeMs: state.latestClock?.delayedSourceTimeMs
    });
    if (stats.rejected > 0) {
      console.debug("[AutoTranslate subtitles] rejected buffered cue payload", {
        generation,
        sequence,
        rejected: stats.rejected
      });
    }
    renderFromClock();
  }

  function handleClockSnapshot(snapshot = {}) {
    if (state.mode !== "buffered" || !state.scheduler) return;
    if (snapshot.status === "stopped") {
      clearRenderedCues();
      return;
    }
    if (snapshot.bufferedSessionId && snapshot.bufferedSessionId !== state.bufferedSessionId) {
      setSchedulerError("Buffered subtitle clock session mismatch.");
      return;
    }

    const generation = Number(snapshot.generation);
    if (Number.isInteger(generation) && generation > state.generation) {
      state.generation = generation;
      schedulerCore.reduceSubtitleSchedulerState(state.scheduler, {
        type: "GENERATION_CHANGE",
        generation
      });
      clearRenderedCues();
    } else if (Number.isInteger(generation) && generation < state.generation) {
      return;
    }

    state.latestClock = snapshot;
    if (["rebuffering", "buffering", "waiting-translation"].includes(snapshot.status) && snapshot.delayedSourceTimeMs === null) {
      clearRenderedCues();
      return;
    }
    renderFromClock();
  }

  function renderFromClock() {
    if (!state.scheduler || !schedulerCore) return;
    const delayedSourceTimeMs = Number(state.latestClock?.delayedSourceTimeMs);
    if (!Number.isFinite(delayedSourceTimeMs) || delayedSourceTimeMs < 0) return;
    const active = schedulerCore.selectActiveCues(state.scheduler, delayedSourceTimeMs);
    const rendered = schedulerCore.renderCueLines(active, {
      showSourceTranscript: state.showSourceTranscript
    });
    state.target = rendered.targetText;
    state.source = rendered.sourceText;
    targetEl.textContent = rendered.targetText;
    sourceEl.textContent = rendered.sourceText;
    root.hidden = !state.visible;
  }

  function appendCue(kind, delta = "", elapsedMs, replace = false) {
    if (kind !== "source" && kind !== "target") return;
    if (typeof delta !== "string" || !delta) return;

    const textKey = kind;
    const elapsedKey = `${kind}LastElapsedMs`;
    const element = kind === "source" ? sourceEl : targetEl;
    const limit = kind === "source" ? 170 : 240;
    const clearDelay = kind === "source" ? 3800 : 4600;
    const lastElapsed = state[elapsedKey];
    const numericElapsed = Number(elapsedMs);

    if (
      state[textKey] &&
      Number.isFinite(numericElapsed) &&
      Number.isFinite(lastElapsed) &&
      numericElapsed - lastElapsed > 1200
    ) {
      state[textKey] = "";
    }

    state[textKey] = replace ? trimToCue(delta, limit) : trimToCue(`${state[textKey]}${delta}`, limit);
    state[elapsedKey] = Number.isFinite(numericElapsed) ? numericElapsed : lastElapsed;
    element.textContent = state[textKey];

    const timerKey = `${kind}ClearTimer`;
    clearTimeout(state[timerKey]);
    state[timerKey] = setTimeout(() => {
      state[textKey] = "";
      element.textContent = "";
    }, clearDelay);
  }

  function trimToCue(text, limit) {
    if (text.length <= limit) return text;
    const clipped = text.slice(-limit);
    const firstSpace = clipped.search(/\s/);
    return firstSpace >= 0 && firstSpace < 28 ? clipped.slice(firstSpace + 1) : clipped;
  }

  function resetCues() {
    clearTimers();
    clearRenderedCues();
    state.sourceLastElapsedMs = null;
    state.targetLastElapsedMs = null;
  }

  function clearRenderedCues() {
    state.source = "";
    state.target = "";
    sourceEl.textContent = "";
    targetEl.textContent = "";
  }

  function cleanupScheduler() {
    if (typeof state.clockUnsubscribe === "function") {
      try { state.clockUnsubscribe(); } catch {}
    }
    state.clockUnsubscribe = null;
    if (state.schedulerFrame !== null) cancelAnimationFrame(state.schedulerFrame);
    clearTimeout(state.schedulerTimer);
    state.schedulerFrame = null;
    state.schedulerTimer = null;
    state.scheduler = null;
    state.latestClock = null;
    state.schedulerError = "";
    state.clockWaitStartedAt = null;
  }

  function clearTimers() {
    clearTimeout(state.sourceClearTimer);
    clearTimeout(state.targetClearTimer);
    state.sourceClearTimer = null;
    state.targetClearTimer = null;
  }

  function setSchedulerError(message) {
    state.schedulerError = message;
    statusEl.dataset.status = "error";
    statusEl.textContent = "Error";
    targetEl.textContent = message;
  }

  function placeOverlay() {
    const fullscreenHost = document.fullscreenElement;
    if (fullscreenHost && fullscreenHost.tagName !== "VIDEO") {
      fullscreenHost.appendChild(root);
    } else {
      document.documentElement.appendChild(root);
    }
  }

  function labelForStatus(status) {
    if (state.mode === "buffered") {
      return {
        starting: "Starting",
        connected: "Buffered",
        buffering: "Buffering",
        "waiting-translation": "Translating",
        rebuffering: "Rebuffering",
        playing: "Buffered",
        paused: "Paused",
        ended: "Ended",
        error: "Error",
        idle: "Stopped"
      }[status] || status;
    }
    return {
      starting: "Starting",
      connected: "Live",
      reconnecting: "Reconnecting",
      error: "Error",
      idle: "Stopped"
    }[status] || status;
  }
})();
