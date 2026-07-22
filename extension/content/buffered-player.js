(function installBufferedPlayer() {
  if (window.__autoTranslateBufferedPlayerInstalled) return;
  window.__autoTranslateBufferedPlayerInstalled = true;

  const core = window.AutoTranslateBufferedPlayerCore;
  const SEGMENT_TIMESLICE_MS = 1000;
  const QUOTA_RETAIN_SECONDS = 5;
  const ROUTINE_RETAIN_SECONDS = 30;
  const SEEK_JUMP_TOLERANCE_SECONDS = 2.5;

  let controller = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "BUFFERED_PLAYER_START") {
      startBufferedPlayer(message.payload || {})
        .then((status) => sendResponse({ ok: true, status }))
        .catch((error) => sendResponse({ ok: false, error: sanitizeMediaError(error) }));
      return true;
    }

    if (message?.type === "BUFFERED_PLAYER_STOP") {
      stopBufferedPlayer()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: sanitizeMediaError(error) }));
      return true;
    }

    if (message?.type === "BUFFERED_PLAYER_STATUS_REQUEST") {
      sendResponse({ ok: true, status: controller?.publicStatus() || { status: "stopped" } });
      return false;
    }

    return false;
  });

  async function startBufferedPlayer(config) {
    await stopBufferedPlayer();
    if (!core) {
      throw new Error("The buffered player helper module was not loaded.");
    }
    if (!core.shouldActivateBufferedPlayer(config)) {
      throw new Error("Buffered playback is only available for local Ollama buffered mode.");
    }

    const nextController = createController(config);
    controller = nextController;
    try {
      await nextController.start();
      return nextController.publicStatus();
    } catch (error) {
      if (controller === nextController) controller = null;
      await nextController.stop({ removeRoot: true, report: false });
      throw error;
    }
  }

  async function stopBufferedPlayer() {
    if (!controller) return;
    const oldController = controller;
    controller = null;
    await oldController.stop({ removeRoot: true, report: true });
  }

  function createController(rawConfig) {
    const state = {
      config: {
        ...rawConfig,
        initialBufferSeconds: core.clampInitialBufferSeconds(rawConfig.initialBufferSeconds),
        originalVolume: clampVolume(rawConfig.originalVolume)
      },
      phase: "idle",
      stopped: false,
      sourceVideo: null,
      sourceOriginalStyle: null,
      root: null,
      delayedVideo: null,
      statusTitle: null,
      statusDetail: null,
      captureStream: null,
      mediaSource: null,
      mediaSourceUrl: null,
      sourceBuffer: null,
      recorder: null,
      recorderEnded: false,
      recorderMimeType: "",
      segmentQueue: core.createSegmentQueue(0),
      nextSegmentSequence: 0,
      lastAppendedSequence: -1,
      appending: false,
      delayedPlaybackStarted: false,
      sourcePaused: false,
      sourceEnded: false,
      listeners: [],
      resizeObserver: null,
      placementFrame: null,
      healthTimer: null,
      lastSourceTime: null,
      lastSourceTimeStamp: null,
      lastReportedStatus: "",
      lastReportedAt: 0,
      bufferedSeconds: 0
    };

    return {
      start,
      stop,
      publicStatus
    };

    async function start() {
      state.phase = core.reducePlayerLifecycle(state.phase, "START");
      state.sourceVideo = findPrimaryVideoElement();
      if (!state.sourceVideo) {
        throw new Error("No active video element was found for buffered playback.");
      }

      buildDelayedPlayer();
      hideSourceVideo();
      installPlacementObservers();
      installSourceEventListeners();

      state.captureStream = captureSourceMedia(state.sourceVideo);
      validateCapturedStream(state.sourceVideo, state.captureStream);
      state.recorderMimeType = pickRecorderMimeType();
      setupMediaSource(state.recorderMimeType);
      setupRecorder(state.recorderMimeType);
      reportStatus("buffering");
      updateBufferingOverlay();
    }

    async function stop({ removeRoot = true, report = true } = {}) {
      if (state.stopped) {
        if (removeRoot) {
          try { state.root?.remove(); } catch {}
          state.root = null;
        }
        if (report) reportStatus("stopped");
        return;
      }
      state.stopped = true;
      state.phase = core.reducePlayerLifecycle(state.phase, "STOP");
      clearTimeout(state.healthTimer);
      cancelAnimationFrame(state.placementFrame);
      state.placementFrame = null;

      for (const { target, type, listener, options } of state.listeners.splice(0)) {
        try { target.removeEventListener(type, listener, options); } catch {}
      }
      try { state.resizeObserver?.disconnect(); } catch {}
      state.resizeObserver = null;

      try {
        if (state.recorder && state.recorder.state !== "inactive") {
          state.recorder.stop();
        }
      } catch {}
      state.recorder = null;

      try {
        state.captureStream?.getTracks().forEach((track) => track.stop());
      } catch {}
      state.captureStream = null;

      try {
        if (state.sourceBuffer && state.mediaSource?.readyState === "open") {
          if (state.sourceBuffer.updating) state.sourceBuffer.abort();
        }
      } catch {}
      state.sourceBuffer = null;

      try {
        if (state.delayedVideo) {
          state.delayedVideo.pause();
          state.delayedVideo.removeAttribute("src");
          state.delayedVideo.srcObject = null;
          state.delayedVideo.load();
        }
      } catch {}
      state.delayedVideo = null;

      if (state.mediaSourceUrl) {
        try { URL.revokeObjectURL(state.mediaSourceUrl); } catch {}
        state.mediaSourceUrl = null;
      }
      state.mediaSource = null;
      state.segmentQueue.clear();

      restoreSourceVideo();
      if (removeRoot) {
        try { state.root?.remove(); } catch {}
        state.root = null;
      }

      if (report) reportStatus("stopped");
    }

    function publicStatus() {
      return {
        status: state.phase,
        tabId: state.config.tabId,
        bufferedSeconds: state.bufferedSeconds,
        currentTime: state.delayedVideo?.currentTime,
        sourceTime: state.sourceVideo?.currentTime,
        sequence: state.lastAppendedSequence
      };
    }

    function buildDelayedPlayer() {
      const root = document.createElement("section");
      root.id = "autotranslate-buffered-player";
      root.dataset.playerStatus = "buffering";
      root.setAttribute("aria-live", "polite");

      const delayedVideo = document.createElement("video");
      delayedVideo.className = "autotranslate-buffered-video";
      delayedVideo.autoplay = false;
      delayedVideo.controls = false;
      delayedVideo.playsInline = true;
      delayedVideo.volume = state.config.originalVolume;
      delayedVideo.muted = false;
      delayedVideo.preload = "auto";
      delayedVideo.playbackRate = state.sourceVideo.playbackRate || 1;

      const status = document.createElement("div");
      status.className = "autotranslate-buffered-status";
      status.innerHTML = `
        <div class="autotranslate-buffered-panel">
          <div class="autotranslate-buffered-title"></div>
          <div class="autotranslate-buffered-detail"></div>
        </div>
      `;

      root.append(delayedVideo, status);
      document.documentElement.appendChild(root);

      state.root = root;
      state.delayedVideo = delayedVideo;
      state.statusTitle = status.querySelector(".autotranslate-buffered-title");
      state.statusDetail = status.querySelector(".autotranslate-buffered-detail");

      addListener(delayedVideo, "error", () => {
        fail(new Error("The delayed video playback element failed."));
      });
      addListener(delayedVideo, "waiting", () => {
        if (state.phase === "playing") {
          state.phase = "buffering";
          reportStatus("buffering");
          updateBufferingOverlay();
        }
      });
      addListener(delayedVideo, "playing", () => {
        if (state.phase !== "playing") {
          state.phase = "playing";
          reportStatus("playing");
        }
        updateBufferingOverlay();
      });
      addListener(delayedVideo, "timeupdate", () => {
        updateBufferedReadiness();
        evictOldBufferedMedia(ROUTINE_RETAIN_SECONDS);
      });
      addListener(delayedVideo, "ended", () => {
        state.phase = core.reducePlayerLifecycle(state.phase, "END");
        reportStatus("ended");
        updateBufferingOverlay("Buffered playback ended", "The delayed copy consumed the remaining captured media.");
      });

      placePlayer();
    }

    function setupMediaSource(mimeType) {
      if (typeof MediaSource === "undefined") {
        throw new Error("MediaSource is not available in this browser for buffered playback.");
      }

      state.mediaSource = new MediaSource();
      state.mediaSourceUrl = URL.createObjectURL(state.mediaSource);
      state.delayedVideo.src = state.mediaSourceUrl;

      addListener(state.mediaSource, "sourceopen", () => {
        if (state.stopped || state.sourceBuffer) return;
        try {
          state.sourceBuffer = state.mediaSource.addSourceBuffer(mimeType);
          try { state.sourceBuffer.mode = "sequence"; } catch {}
          addListener(state.sourceBuffer, "updateend", onSourceBufferUpdateEnd);
          addListener(state.sourceBuffer, "error", () => {
            fail(new Error("SourceBuffer append failed during buffered playback."));
          });
          addListener(state.sourceBuffer, "abort", () => {
            if (!state.stopped) fail(new Error("SourceBuffer append was aborted during buffered playback."));
          });
          drainAppendQueue();
        } catch (error) {
          fail(new Error(`MediaSource could not create a SourceBuffer for ${mimeType}.`));
        }
      });

      addListener(state.mediaSource, "sourceended", () => {
        if (!state.stopped) console.debug("[AutoTranslate buffered player] MediaSource ended");
      });
    }

    function setupRecorder(mimeType) {
      if (typeof MediaRecorder === "undefined") {
        throw new Error("MediaRecorder is not available in this browser for buffered playback.");
      }

      try {
        state.recorder = new MediaRecorder(state.captureStream, {
          mimeType,
          videoBitsPerSecond: 2_500_000,
          audioBitsPerSecond: 128_000
        });
      } catch (error) {
        throw new Error("The delayed video recorder could not be created.");
      }

      addListener(state.recorder, "dataavailable", (event) => {
        if (state.stopped || !event.data?.size) return;
        const sequence = state.nextSegmentSequence++;
        const segment = { sequence, blob: event.data, size: event.data.size };
        try {
          state.segmentQueue.enqueue(segment);
          console.debug("[AutoTranslate buffered player] segment", {
            sequence,
            size: event.data.size,
            mimeType: event.data.type || state.recorderMimeType
          });
          drainAppendQueue();
        } catch (error) {
          fail(error);
        }
      });

      addListener(state.recorder, "error", (event) => {
        fail(event.error || new Error("The delayed video recorder failed."));
      });

      addListener(state.recorder, "stop", () => {
        state.recorderEnded = true;
        maybeEndMediaSource();
      });

      try {
        state.recorder.start(SEGMENT_TIMESLICE_MS);
      } catch (error) {
        throw new Error("The delayed video recorder could not be started.");
      }

      console.debug("[AutoTranslate buffered player] recorder started", { mimeType });
    }

    function drainAppendQueue() {
      if (state.stopped || state.appending || !state.sourceBuffer || state.sourceBuffer.updating) return;
      const segment = state.segmentQueue.peek();
      if (!segment) {
        maybeEndMediaSource();
        return;
      }

      state.appending = true;
      segment.blob.arrayBuffer()
        .then((buffer) => {
          if (state.stopped || !state.sourceBuffer) return;
          try {
            state.sourceBuffer.appendBuffer(buffer);
            state.segmentQueue.shift();
            state.lastAppendedSequence = segment.sequence;
          } catch (error) {
            state.appending = false;
            if (isQuotaExceeded(error) && evictOldBufferedMedia(QUOTA_RETAIN_SECONDS)) return;
            fail(new Error("SourceBuffer append failed during buffered playback."));
          }
        })
        .catch((error) => {
          state.appending = false;
          fail(new Error("The buffered media segment could not be read for appending."));
        });
    }

    function onSourceBufferUpdateEnd() {
      state.appending = false;
      updateBufferedReadiness();
      if (!evictOldBufferedMedia(ROUTINE_RETAIN_SECONDS)) {
        maybeEndMediaSource();
        drainAppendQueue();
      }
    }

    function updateBufferedReadiness() {
      if (!state.delayedVideo) return;
      state.bufferedSeconds = core.getPlayableBufferedAhead(
        state.delayedVideo.buffered,
        state.delayedVideo.currentTime
      );
      updateBufferingOverlay();

      console.debug("[AutoTranslate buffered player] buffer", {
        bufferedSeconds: state.bufferedSeconds,
        delayedTime: state.delayedVideo.currentTime,
        sourceTime: state.sourceVideo?.currentTime,
        phase: state.phase
      });

      if (state.sourcePaused) {
        reportStatus("paused");
        return;
      }

      const ready = core.isInitialBufferReady({
        buffered: state.delayedVideo.buffered,
        currentTime: state.delayedVideo.currentTime,
        initialBufferSeconds: state.config.initialBufferSeconds
      });
      if (!state.delayedPlaybackStarted && (ready || (state.sourceEnded && state.bufferedSeconds > 0))) {
        playDelayedVideo();
      } else if (!state.delayedPlaybackStarted) {
        reportStatus("buffering");
      }
    }

    function playDelayedVideo() {
      if (state.stopped || state.sourcePaused || !state.delayedVideo) return;
      state.delayedPlaybackStarted = true;
      state.delayedVideo.playbackRate = state.sourceVideo?.playbackRate || 1;
      state.delayedVideo.play()
        .then(() => {
          if (state.stopped) return;
          state.phase = core.reducePlayerLifecycle(state.phase, "READY");
          state.root.dataset.playerStatus = "playing";
          reportStatus("playing");
        })
        .catch((error) => {
          state.delayedPlaybackStarted = false;
          fail(new Error("Delayed video playback failed. The browser may require interaction with the page before audio can autoplay."));
        });
    }

    function installSourceEventListeners() {
      const source = state.sourceVideo;

      addListener(source, "pause", () => {
        if (state.stopped || source.ended || source.seeking) return;
        state.sourcePaused = true;
        state.phase = core.reducePlayerLifecycle(state.phase, "PAUSE");
        try {
          if (state.recorder?.state === "recording") state.recorder.pause();
        } catch {}
        try { state.delayedVideo?.pause(); } catch {}
        reportStatus("paused");
        updateBufferingOverlay("Source video paused", "Resume the source video to continue delayed playback.");
      });

      addListener(source, "play", handleSourceResume);
      addListener(source, "playing", handleSourceResume);

      addListener(source, "ended", () => {
        if (state.stopped) return;
        state.sourceEnded = true;
        try {
          if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
        } catch {}
        updateBufferedReadiness();
      });

      addListener(source, "seeking", () => {
        if (!state.stopped) {
          fail(new Error("The source video was seeked. Restart translation to use buffered playback after a seek."), {
            title: "Restart required after seek"
          });
        }
      });

      addListener(source, "ratechange", () => {
        if (state.delayedVideo) state.delayedVideo.playbackRate = source.playbackRate || 1;
      });

      addListener(source, "timeupdate", () => {
        detectSourceSeekByJump();
      });

      state.healthTimer = setInterval(() => {
        if (!state.sourceVideo?.isConnected) {
          fail(new Error("The page replaced the video element; restart buffered playback."));
        } else {
          schedulePlacement();
        }
      }, 1000);
    }

    function handleSourceResume() {
      if (state.stopped || state.sourceVideo.seeking) return;
      state.sourcePaused = false;
      state.phase = core.reducePlayerLifecycle(state.phase, "RESUME");
      try {
        if (state.recorder?.state === "paused") state.recorder.resume();
      } catch {}

      if (state.delayedPlaybackStarted && state.bufferedSeconds > 0.75) {
        state.delayedVideo.play()
          .then(() => {
            state.phase = "playing";
            state.root.dataset.playerStatus = "playing";
            reportStatus("playing");
          })
          .catch(() => fail(new Error("Delayed video playback failed after the source video resumed.")));
      } else {
        updateBufferedReadiness();
      }
    }

    function detectSourceSeekByJump() {
      const source = state.sourceVideo;
      const now = performance.now();
      const currentTime = source.currentTime;
      if (state.lastSourceTime === null) {
        state.lastSourceTime = currentTime;
        state.lastSourceTimeStamp = now;
        return;
      }

      const elapsedSeconds = Math.max(0, (now - state.lastSourceTimeStamp) / 1000);
      const expectedDelta = elapsedSeconds * (source.playbackRate || 1);
      const actualDelta = currentTime - state.lastSourceTime;
      state.lastSourceTime = currentTime;
      state.lastSourceTimeStamp = now;

      if (!source.paused && Math.abs(actualDelta - expectedDelta) > SEEK_JUMP_TOLERANCE_SECONDS) {
        fail(new Error("The source video timeline jumped. Restart translation to use buffered playback after a seek."), {
          title: "Restart required after seek"
        });
      }
    }

    function installPlacementObservers() {
      state.resizeObserver = new ResizeObserver(schedulePlacement);
      state.resizeObserver.observe(state.sourceVideo);
      addListener(window, "resize", schedulePlacement);
      addListener(window, "scroll", schedulePlacement, true);
      addListener(document, "fullscreenchange", () => {
        ensureFullscreenParent();
        schedulePlacement();
      });
      schedulePlacement();
    }

    function schedulePlacement() {
      if (state.placementFrame) return;
      state.placementFrame = requestAnimationFrame(() => {
        state.placementFrame = null;
        placePlayer();
      });
    }

    function placePlayer() {
      if (!state.root || !state.sourceVideo?.isConnected) return;
      ensureFullscreenParent();
      const rect = state.sourceVideo.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        state.root.hidden = true;
        return;
      }

      state.root.hidden = false;
      state.root.style.left = `${rect.left}px`;
      state.root.style.top = `${rect.top}px`;
      state.root.style.width = `${rect.width}px`;
      state.root.style.height = `${rect.height}px`;

      const objectFit = getComputedStyle(state.sourceVideo).objectFit;
      state.delayedVideo.style.objectFit = objectFit && objectFit !== "initial" ? objectFit : "contain";
    }

    function ensureFullscreenParent() {
      if (!state.root) return;
      const fullscreenElement = document.fullscreenElement;
      const parent = fullscreenElement && fullscreenElement.tagName !== "VIDEO"
        ? fullscreenElement
        : document.documentElement;
      if (state.root.parentNode !== parent) parent.appendChild(state.root);
    }

    function hideSourceVideo() {
      const source = state.sourceVideo;
      state.sourceOriginalStyle = {
        opacity: source.style.opacity
      };
      source.style.opacity = "0";
    }

    function restoreSourceVideo() {
      if (!state.sourceVideo || !state.sourceOriginalStyle) return;
      try {
        state.sourceVideo.style.opacity = state.sourceOriginalStyle.opacity;
      } catch {}
      state.sourceOriginalStyle = null;
    }

    function updateBufferingOverlay(title, detail) {
      if (!state.root || !state.statusTitle || !state.statusDetail) return;
      const target = state.config.initialBufferSeconds;
      const buffered = Math.min(state.bufferedSeconds || 0, target);
      state.root.dataset.playerStatus = state.phase === "error"
        ? "error"
        : state.phase === "playing"
          ? "playing"
          : "buffering";
      state.statusTitle.textContent = title || "Buffering delayed playback";
      state.statusDetail.textContent = detail || `Captured ${buffered.toFixed(1)} of ${target}s before playback starts.`;
    }

    function reportStatus(status, extra = {}) {
      const now = Date.now();
      const repeated = status === state.lastReportedStatus && now - state.lastReportedAt < 500;
      if (repeated && status !== "error") return;
      state.lastReportedStatus = status;
      state.lastReportedAt = now;
      chrome.runtime.sendMessage({
        type: "BUFFERED_PLAYER_STATUS",
        payload: {
          status,
          tabId: state.config.tabId,
          bufferedSeconds: state.bufferedSeconds,
          currentTime: state.delayedVideo?.currentTime,
          sourceTime: state.sourceVideo?.currentTime,
          sequence: state.lastAppendedSequence,
          ...extra
        }
      }).catch(() => null);
    }

    function fail(error, options = {}) {
      if (state.phase === "error" || state.phase === "stopped") return;
      const message = sanitizeMediaError(error);
      state.phase = core.reducePlayerLifecycle(state.phase, "ERROR");
      updateBufferingOverlay(options.title || "Buffered playback stopped", message);
      reportStatus("error", { error: message });
      stop({ removeRoot: false, report: false }).catch(console.error);
    }

    function maybeEndMediaSource() {
      if (
        !state.recorderEnded ||
        state.segmentQueue.size ||
        state.appending ||
        !state.mediaSource ||
        !state.sourceBuffer ||
        state.sourceBuffer.updating ||
        state.mediaSource.readyState !== "open"
      ) {
        return;
      }
      try {
        state.mediaSource.endOfStream();
      } catch {}
    }

    function evictOldBufferedMedia(retainSeconds) {
      if (!state.sourceBuffer || state.sourceBuffer.updating || !state.delayedVideo) return false;
      const safeEnd = state.delayedVideo.currentTime - retainSeconds;
      if (safeEnd <= 0) return false;

      const buffered = state.sourceBuffer.buffered;
      for (let index = 0; index < buffered.length; index += 1) {
        const start = buffered.start(index);
        const end = Math.min(buffered.end(index), safeEnd);
        if (end > start + 0.5) {
          try {
            state.sourceBuffer.remove(start, end);
            return true;
          } catch (error) {
            if (isQuotaExceeded(error)) continue;
            fail(new Error("SourceBuffer cleanup failed during buffered playback."));
            return true;
          }
        }
      }
      return false;
    }

    function addListener(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      state.listeners.push({ target, type, listener, options });
    }
  }

  function findPrimaryVideoElement() {
    const candidates = Array.from(document.querySelectorAll("video")).map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        element,
        rect,
        paused: element.paused,
        ended: element.ended,
        readyState: element.readyState,
        isConnected: element.isConnected,
        hidden: element.hidden,
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
        playing: !element.paused && !element.ended && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      };
    });
    return core.selectPrimaryVideo(candidates)?.element || null;
  }

  function captureSourceMedia(video) {
    const capture = video.captureStream || video.mozCaptureStream;
    if (typeof capture !== "function") {
      throw new Error("This browser does not support HTMLVideoElement.captureStream() for buffered playback.");
    }
    return capture.call(video);
  }

  function validateCapturedStream(video, stream) {
    if (!stream?.getVideoTracks?.().length) {
      throw new Error("The selected video did not provide a video track for buffered playback.");
    }
    if (sourceHasKnownAudio(video) && !stream.getAudioTracks().length) {
      throw new Error("The selected video did not provide an audio track for buffered playback.");
    }
  }

  function sourceHasKnownAudio(video) {
    return Boolean(
      video.audioTracks?.length ||
      video.mozHasAudio ||
      video.webkitAudioDecodedByteCount > 0
    );
  }

  function pickRecorderMimeType() {
    const mimeType = core.pickBufferedRecorderMimeType(MediaRecorder, MediaSource);
    if (!mimeType) {
      throw new Error("No MediaRecorder MIME type is supported by both MediaRecorder and MediaSource for buffered playback.");
    }
    return mimeType;
  }

  function isQuotaExceeded(error) {
    return error?.name === "QuotaExceededError";
  }

  function clampVolume(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
  }

  function sanitizeMediaError(error) {
    const message = error?.message || String(error || "Buffered playback failed.");
    return message.replace(/\s+/g, " ").trim().slice(0, 300);
  }
})();
