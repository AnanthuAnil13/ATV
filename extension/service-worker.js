import {
  clampInitialBufferSeconds,
  normalizeSyncMode,
  shouldActivateBufferedPlayer,
  validatePlaybackMode
} from "./shared/playback-settings.js";
import "./shared/media-timeline.js";

const timeline = globalThis.AutoTranslateMediaTimeline;

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";
const DEFAULT_SETTINGS = {
  backendUrl: "http://localhost:8787",
  provider: "openai",
  ollamaModel: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  outputMode: "both",
  originalVolume: 0.15,
  dubVolume: 1,
  showSourceTranscript: false,
  syncMode: "live",
  initialBufferSeconds: 10
};

let creatingOffscreenDocument = null;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(([key]) => stored[key] === undefined)
  );
  if (Object.keys(missing).length) {
    await chrome.storage.local.set(missing);
  }

  const { installationId } = await chrome.storage.local.get("installationId");
  if (!installationId) {
    await chrome.storage.local.set({ installationId: crypto.randomUUID() });
  }

  await setSessionState({
    status: "idle",
    tabId: null,
    error: null,
    timedDubSchedulerEnabled: false,
    timedDubScheduler: null
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupClosedTranslationTab(tabId).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "START_TRANSLATION") {
    startTranslation(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch(async (error) => {
        const { translationState } = await chrome.storage.session.get("translationState");
        if (translationState?.status !== "idle") {
          await handleOffscreenStatus({
            status: "error",
            error: error.message,
            tabId: translationState?.tabId ?? null,
            provider: translationState?.provider
          });
        }
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "STOP_TRANSLATION") {
    stopTranslation()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_TRANSLATION_STATE") {
    chrome.storage.session.get(["translationState"]).then(({ translationState }) => {
      sendResponse({ ok: true, state: translationState ?? { status: "idle" } });
    });
    return true;
  }

  if (message.type === "OFFSCREEN_STATUS") {
    handleOffscreenStatus(message.payload).catch(console.error);
    return false;
  }

  if (message.type === "OFFSCREEN_TRANSCRIPT") {
    forwardTranscript(message.payload).catch(console.error);
    return false;
  }

  if (message.type === "OFFSCREEN_BUFFERED_SUBTITLE_SEGMENTS") {
    forwardBufferedSubtitleSegments(message.payload, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: sanitizeError(error.message) || "Buffered subtitle delivery failed." }));
    return true;
  }

  if (message.type === "OFFSCREEN_BUFFERED_TRANSLATION_COVERAGE") {
    forwardBufferedTranslationCoverage(message.payload, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: sanitizeError(error.message) || "Buffered translation coverage delivery failed." }));
    return true;
  }

  if (message.type === "OFFSCREEN_BUFFERED_TIMED_DUB_CLIPS") {
    forwardBufferedTimedDubClips(message.payload, sender).catch(console.error);
    return false;
  }

  if (message.type === "BUFFERED_PLAYER_STATUS") {
    handleBufferedPlayerStatus(message.payload).catch(console.error);
    return false;
  }

  if (message.type === "BUFFERED_TIMED_DUB_STATUS") {
    handleBufferedTimedDubStatus(message.payload, sender).catch(console.error);
    return false;
  }

  // Buffered timeline bridge:
  // offscreen -> service worker -> buffered-player content script -> service worker -> offscreen.
  if (message.type === "OFFSCREEN_TIMELINE_SNAPSHOT_REQUEST") {
    handleTimelineSnapshotRequest(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: sanitizeError(error.message) || "Timeline snapshot unavailable." }));
    return true;
  }

  if (message.type === "BUFFERED_TIMELINE_EVENT") {
    handleBufferedTimelineEvent(message.payload, sender).catch(console.error);
    return false;
  }

  return false;
});

async function startTranslation(payload = {}) {
  const current = await chrome.storage.session.get("translationState");
  if (["starting", "connected", "reconnecting"].includes(current.translationState?.status)) {
    throw new Error("A translation session is already active. Stop it before starting another one.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab was found.");
  if (!tab.url || /^(chrome|edge|brave|about):\/\//.test(tab.url)) {
    throw new Error("This browser page cannot be captured. Open a normal webpage containing a video.");
  }

  const stored = await chrome.storage.local.get({ ...DEFAULT_SETTINGS, installationId: null });
  const settings = {
    ...stored,
    ...payload,
    provider: normalizeProvider(payload.provider ?? stored.provider),
    outputMode: normalizeOutputMode(payload.outputMode ?? stored.outputMode),
    originalVolume: clampVolume(payload.originalVolume ?? stored.originalVolume),
    dubVolume: clampVolume(payload.dubVolume ?? stored.dubVolume),
    syncMode: normalizeSyncMode(payload.syncMode ?? stored.syncMode),
    initialBufferSeconds: clampInitialBufferSeconds(payload.initialBufferSeconds ?? stored.initialBufferSeconds),
    ollamaModel: String(payload.ollamaModel ?? stored.ollamaModel ?? "").trim(),
    tabId: tab.id
  };

  validatePlaybackMode(settings);
  if (settings.sourceLanguage === settings.targetLanguage) {
    throw new Error("Source and translation languages must be different.");
  }
  if (settings.provider === "ollama" && !settings.ollamaModel) {
    throw new Error("Choose an installed Ollama model before starting local translation.");
  }

  const subtitlesEnabled = settings.outputMode !== "dub";
  const dubEnabled = settings.outputMode !== "subtitles";
  const showSourceTranscript = subtitlesEnabled && Boolean(settings.showSourceTranscript);
  const bufferedPlayerEnabled = shouldActivateBufferedPlayer(settings);
  const timedDubSchedulerEnabled = bufferedPlayerEnabled && dubEnabled;
  const bufferedSessionId = bufferedPlayerEnabled ? crypto.randomUUID() : null;

  await setSessionState({
    status: "starting",
    tabId: tab.id,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    provider: settings.provider,
    ollamaModel: settings.provider === "ollama" ? settings.ollamaModel : null,
    outputMode: settings.outputMode,
    syncMode: settings.syncMode,
    initialBufferSeconds: settings.initialBufferSeconds,
    bufferedPlayerEnabled,
    timedDubSchedulerEnabled,
    bufferedSessionId,
    generation: 0,
    bufferedPlayer: bufferedPlayerEnabled ? { status: "idle" } : null,
    subtitlesEnabled,
    dubEnabled,
    showSourceTranscript,
    error: null
  });

  await ensureOffscreenDocument();

  if (subtitlesEnabled) {
    await injectSubtitleOverlay(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      type: "OVERLAY_CONFIG",
      payload: {
        showSourceTranscript,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        provider: settings.provider,
        outputMode: settings.outputMode,
        syncMode: settings.syncMode,
        bufferedSessionId,
        generation: 0
      }
    }).catch(() => null);
  }

  // Calling tabCapture from the service worker allows the stream ID to be
  // consumed by the extension's offscreen document in Chrome 116+.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_START",
    target: "offscreen",
    payload: {
      streamId,
      tabId: tab.id,
      backendUrl: normalizeBackendUrl(settings.backendUrl),
      provider: settings.provider,
      ollamaModel: settings.ollamaModel,
      localSessionId: `${settings.installationId || "install"}:${tab.id}:${Date.now()}`,
      localChunkMs: Number(payload.localChunkMs) || 4500,
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      outputMode: settings.outputMode,
      syncMode: settings.syncMode,
      initialBufferSeconds: settings.initialBufferSeconds,
      bufferedSessionId,
      originalVolume: settings.originalVolume,
      dubVolume: settings.dubVolume,
      showSourceTranscript,
      installationId: settings.installationId
    }
  });

  if (!response?.ok) {
    if (subtitlesEnabled) {
      await chrome.tabs.sendMessage(tab.id, { type: "OVERLAY_STOP" }).catch(() => null);
    }
    throw new Error(response?.error || "The offscreen translation session could not be started.");
  }

  if (bufferedPlayerEnabled) {
    try {
      await injectBufferedPlayer(tab.id, {
        tabId: tab.id,
        provider: settings.provider,
        syncMode: settings.syncMode,
        bufferedSessionId,
        initialBufferSeconds: settings.initialBufferSeconds,
        originalVolume: settings.originalVolume,
        outputMode: settings.outputMode
      });
      if (timedDubSchedulerEnabled) {
        await injectTimedDubScheduler(tab.id, {
          tabId: tab.id,
          provider: settings.provider,
          syncMode: settings.syncMode,
          outputMode: settings.outputMode,
          bufferedSessionId,
          generation: 0,
          dubVolume: settings.dubVolume,
          originalVolume: settings.originalVolume
        });
      }
    } catch (error) {
      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_STOP",
        target: "offscreen",
        payload: { notify: false }
      }).catch(() => null);
      await stopTimedDubScheduler(tab.id).catch(() => null);
      if (subtitlesEnabled) {
        await chrome.tabs.sendMessage(tab.id, { type: "OVERLAY_STOP" }).catch(() => null);
      }
      await stopBufferedPlayer(tab.id).catch(() => null);
      throw error;
    }
  }

  return { tabId: tab.id };
}

async function stopTranslation() {
  const { translationState } = await chrome.storage.session.get("translationState");
  if (translationState?.tabId && translationState?.timedDubSchedulerEnabled) {
    await stopTimedDubScheduler(translationState.tabId).catch(() => null);
  }
  if (translationState?.tabId && translationState?.bufferedPlayerEnabled) {
    await stopBufferedPlayer(translationState.tabId).catch(() => null);
  }
  await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP", target: "offscreen" }).catch(() => null);

  if (translationState?.tabId && translationState?.subtitlesEnabled) {
    await chrome.tabs.sendMessage(translationState.tabId, { type: "OVERLAY_STOP" }).catch(() => null);
  }

  await setSessionState({
    status: "idle",
    tabId: null,
    error: null,
    timedDubSchedulerEnabled: false,
    timedDubScheduler: null
  });
}

async function handleOffscreenStatus(payload = {}) {
  const { translationState } = await chrome.storage.session.get("translationState");
  const tabId = payload.tabId ?? translationState?.tabId ?? null;
  const isIdle = payload.status === "idle";
  if (tabId && translationState?.timedDubSchedulerEnabled && (isIdle || payload.status === "error")) {
    await stopTimedDubScheduler(tabId).catch(() => null);
  }
  if (tabId && translationState?.bufferedPlayerEnabled && (isIdle || payload.status === "error")) {
    await stopBufferedPlayer(tabId).catch(() => null);
  }
  await setSessionState({ ...payload, tabId: isIdle ? null : tabId });

  if (tabId && translationState?.subtitlesEnabled) {
    await chrome.tabs.sendMessage(tabId, isIdle
      ? { type: "OVERLAY_STOP" }
      : { type: "OVERLAY_STATUS", payload }
    ).catch(() => null);
  }
}

async function forwardTranscript(payload = {}) {
  const { translationState } = await chrome.storage.session.get("translationState");
  if (!translationState?.subtitlesEnabled) return;
  if (translationState.provider === "ollama" && translationState.syncMode === "buffered") return;

  const tabId = payload.tabId ?? translationState?.tabId;
  if (!tabId) return;

  await chrome.tabs.sendMessage(tabId, {
    type: "OVERLAY_TRANSCRIPT",
    payload
  }).catch(() => null);
}

async function forwardBufferedSubtitleSegments(payload = {}, sender = {}) {
  if (!isFromOffscreenDocument(sender)) return { ok: false, forwarded: false, error: "Buffered subtitle messages must come from the offscreen document." };
  const { translationState } = await chrome.storage.session.get("translationState");
  if (!isBufferedSubtitleTarget(translationState, payload)) return { ok: true, forwarded: false, stale: true };

  const normalized = normalizeBufferedSubtitlePayload(payload);
  if (!normalized) return { ok: false, forwarded: false, error: "Buffered subtitle segments were malformed." };

  try {
    await chrome.tabs.sendMessage(normalized.tabId, {
      type: "BUFFERED_SUBTITLE_SEGMENTS",
      payload: normalized
    });
  } catch {
    throw new Error("Buffered subtitle overlay is unavailable.");
  }
  return { ok: true, forwarded: true };
}

async function forwardBufferedTranslationCoverage(payload = {}, sender = {}) {
  if (!isFromOffscreenDocument(sender)) return { ok: false, forwarded: false, error: "Buffered translation coverage must come from the offscreen document." };
  const { translationState } = await chrome.storage.session.get("translationState");
  if (!isBufferedTranslationCoverageTarget(translationState, payload)) return { ok: true, forwarded: false, stale: true };

  const normalized = normalizeBufferedTranslationCoveragePayload(payload);
  if (!normalized) return { ok: false, forwarded: false, error: "Buffered translation coverage was malformed." };

  try {
    await chrome.tabs.sendMessage(normalized.tabId, {
      type: "BUFFERED_TRANSLATION_COVERAGE",
      payload: normalized
    });
  } catch {
    throw new Error("Buffered playback controller is unavailable.");
  }
  return { ok: true, forwarded: true };
}

async function forwardBufferedTimedDubClips(payload = {}, sender = {}) {
  if (!isFromOffscreenDocument(sender)) return;
  const { translationState } = await chrome.storage.session.get("translationState");
  if (!isBufferedTimedDubTarget(translationState, payload)) return;

  const normalized = normalizeBufferedTimedDubPayload(payload);
  if (!normalized) return;

  await chrome.tabs.sendMessage(normalized.tabId, {
    type: "BUFFERED_TIMED_DUB_CLIPS",
    payload: normalized
  }).catch(() => null);
}

async function cleanupClosedTranslationTab(tabId) {
  const { translationState } = await chrome.storage.session.get("translationState");
  if (translationState?.tabId !== tabId) return;

  if (translationState?.timedDubSchedulerEnabled) {
    await stopTimedDubScheduler(tabId).catch(() => null);
  }
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_STOP",
    target: "offscreen"
  }).catch(() => null);
  await setSessionState({
    status: "idle",
    tabId: null,
    error: null,
    timedDubSchedulerEnabled: false,
    timedDubScheduler: null
  });
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  if (contexts.length > 0) return;

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK", "WEB_RTC"],
    justification: "Capture active-tab audio, run cloud or local translation, mix original and translated playback, and stream live subtitles."
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function injectSubtitleOverlay(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content/subtitles.css"]
  }).catch(() => null);

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/subtitle-scheduler-core.js", "content/subtitles.js"]
  });
}

async function injectBufferedPlayer(tabId, payload) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content/buffered-player.css"]
  }).catch(() => null);

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "shared/media-timeline.js",
      "content/buffered-player-core.js",
      "content/translation-readiness-core.js",
      "content/subtitle-scheduler-core.js",
      "content/buffered-player.js"
    ]
  });

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "BUFFERED_PLAYER_START",
    payload
  });
  if (!response?.ok) {
    throw new Error(response?.error || "The buffered video player could not be started.");
  }
}

async function injectTimedDubScheduler(tabId, payload) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "content/timed-dub-scheduler-core.js",
      "content/timed-dub-scheduler.js"
    ]
  });

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "TIMED_DUB_SCHEDULER_START",
    payload
  });
  if (!response?.ok) {
    throw new Error(response?.error || "The timed dub scheduler could not be started.");
  }
}

async function stopTimedDubScheduler(tabId) {
  await chrome.tabs.sendMessage(tabId, { type: "TIMED_DUB_SCHEDULER_STOP" }).catch(() => null);
}

async function resetTimedDubScheduler(tabId, payload) {
  await chrome.tabs.sendMessage(tabId, {
    type: "TIMED_DUB_SCHEDULER_RESET",
    payload
  }).catch(() => null);
}

async function stopBufferedPlayer(tabId) {
  await chrome.tabs.sendMessage(tabId, { type: "BUFFERED_PLAYER_STOP" }).catch(() => null);
  await chrome.scripting.removeCSS({
    target: { tabId },
    files: ["content/buffered-player.css"]
  }).catch(() => null);
}

async function handleTimelineSnapshotRequest(payload = {}) {
  const { translationState } = await chrome.storage.session.get("translationState");
  const tabId = payload.tabId ?? translationState?.tabId ?? null;
  const bufferedSessionId = payload.bufferedSessionId ?? translationState?.bufferedSessionId;
  validateBufferedTimelineTarget(translationState, tabId, bufferedSessionId);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "BUFFERED_TIMELINE_SNAPSHOT_REQUEST",
    payload: { bufferedSessionId }
  }).catch(() => null);
  if (!response?.ok) {
    throw new Error(response?.error || "Timeline snapshot unavailable.");
  }

  const snapshot = timeline.normalizeTimelineSnapshot(response.snapshot);
  if (!snapshot) throw new Error("Timeline snapshot unavailable.");
  validateBufferedTimelineTarget(translationState, tabId, snapshot.sessionId);
  return { snapshot };
}

async function handleBufferedTimelineEvent(payload = {}, sender = {}) {
  const { translationState } = await chrome.storage.session.get("translationState");
  const tabId = sender.tab?.id ?? payload.tabId ?? null;
  const snapshot = timeline.normalizeTimelineSnapshot(payload);
  if (!snapshot) return;
  if (!isBufferedTimelineTarget(translationState, tabId, snapshot.sessionId)) return;
  const previousGeneration = Number(translationState.generation ?? 0);

  const statePatch = {
    tabId,
    bufferedSessionId: snapshot.sessionId,
    generation: snapshot.generation,
    sourceTimeMs: snapshot.sourceTimeMs,
    playbackRate: snapshot.playbackRate,
    paused: snapshot.paused,
    seeking: snapshot.seeking,
    ended: snapshot.ended
  };
  if (snapshot.durationMs !== undefined) statePatch.durationMs = snapshot.durationMs;

  await setSessionState(statePatch);
  if (shouldResetTimedDubForTimelineEvent(translationState, snapshot, previousGeneration)) {
    await resetTimedDubScheduler(tabId, {
      bufferedSessionId: snapshot.sessionId,
      generation: snapshot.generation,
      reason: snapshot.eventType || "timeline",
      pipelineEpoch: payload.pipelineEpoch
    });
  }
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_TIMELINE_EVENT",
    target: "offscreen",
    payload: snapshot
  }).catch(() => null);
}

async function handleBufferedPlayerStatus(payload = {}) {
  const { translationState } = await chrome.storage.session.get("translationState");
  const tabId = payload.tabId ?? translationState?.tabId ?? null;
  if (!tabId || translationState?.tabId !== tabId || !translationState?.bufferedPlayerEnabled) return;
  if (payload.bufferedSessionId && payload.bufferedSessionId !== translationState.bufferedSessionId) return;

  const bufferedPlayer = sanitizeBufferedPlayerStatus(payload);
  const previousGeneration = Number(translationState.generation ?? 0);
  if (bufferedPlayer.status === "error") {
    if (translationState.timedDubSchedulerEnabled) {
      await stopTimedDubScheduler(tabId).catch(() => null);
    }
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_STOP",
      target: "offscreen",
      payload: { notify: false }
    }).catch(() => null);
    if (translationState.subtitlesEnabled) {
      await chrome.tabs.sendMessage(tabId, { type: "OVERLAY_STOP" }).catch(() => null);
    }
    await setSessionState({
      status: "error",
      tabId,
      provider: translationState.provider,
      outputMode: translationState.outputMode,
      syncMode: translationState.syncMode,
      bufferedSessionId: translationState.bufferedSessionId,
      generation: bufferedPlayer.generation ?? translationState.generation,
      initialBufferSeconds: translationState.initialBufferSeconds,
      bufferedPlayer,
      error: bufferedPlayer.error || "The buffered video player failed."
    });
    return;
  }

  if (bufferedPlayer.status === "stopped" && translationState.timedDubSchedulerEnabled) {
    await stopTimedDubScheduler(tabId).catch(() => null);
  } else if (
    translationState.timedDubSchedulerEnabled &&
    (bufferedPlayer.status === "rebuffering" || Number(bufferedPlayer.generation ?? previousGeneration) > previousGeneration)
  ) {
    await resetTimedDubScheduler(tabId, {
      bufferedSessionId: translationState.bufferedSessionId,
      generation: bufferedPlayer.generation ?? previousGeneration,
      reason: bufferedPlayer.status,
      pipelineEpoch: payload.pipelineEpoch
    });
  }

  await setSessionState({
    status: translationState.status || "connected",
    tabId,
    generation: bufferedPlayer.generation ?? translationState.generation,
    bufferedPlayer
  });
  if (translationState.subtitlesEnabled && translationState.syncMode === "buffered") {
    await chrome.tabs.sendMessage(tabId, {
      type: "OVERLAY_STATUS",
      payload: {
        status: bufferedPlayer.status,
        provider: translationState.provider,
        syncMode: translationState.syncMode
      }
    }).catch(() => null);
  }
}

async function handleBufferedTimedDubStatus(payload = {}, sender = {}) {
  const { translationState } = await chrome.storage.session.get("translationState");
  const tabId = sender.tab?.id ?? payload.tabId ?? null;
  if (!isBufferedTimedDubStatusTarget(translationState, tabId, payload)) return;
  await setSessionState({
    tabId,
    timedDubScheduler: sanitizeTimedDubSchedulerStatus(payload)
  });
}

function isBufferedSubtitleTarget(translationState, payload = {}) {
  if (!translationState || translationState.status === "idle" || translationState.status === "error") return false;
  if (!translationState.subtitlesEnabled) return false;
  if (translationState.provider !== "ollama" || translationState.syncMode !== "buffered") return false;
  if (!["subtitles", "both"].includes(translationState.outputMode)) return false;
  if (!translationState.bufferedPlayerEnabled) return false;
  if (!payload.tabId || payload.tabId !== translationState.tabId) return false;
  if (!payload.bufferedSessionId || payload.bufferedSessionId !== translationState.bufferedSessionId) return false;
  if (Number(payload.generation) !== Number(translationState.generation ?? 0)) return false;
  return Array.isArray(payload.translatedSegments);
}

function isBufferedTimedDubTarget(translationState, payload = {}) {
  if (!translationState || translationState.status === "idle" || translationState.status === "error") return false;
  if (!translationState.dubEnabled || !translationState.timedDubSchedulerEnabled) return false;
  if (translationState.provider !== "ollama" || translationState.syncMode !== "buffered") return false;
  if (!["dub", "both"].includes(translationState.outputMode)) return false;
  if (!translationState.bufferedPlayerEnabled) return false;
  if (!payload.tabId || payload.tabId !== translationState.tabId) return false;
  if (!payload.bufferedSessionId || payload.bufferedSessionId !== translationState.bufferedSessionId) return false;
  if (Number(payload.generation) !== Number(translationState.generation ?? 0)) return false;
  return Array.isArray(payload.timedDubClips);
}

function isBufferedTranslationCoverageTarget(translationState, payload = {}) {
  if (!translationState || translationState.status === "idle" || translationState.status === "error") return false;
  if (!translationState.subtitlesEnabled) return false;
  if (translationState.provider !== "ollama" || translationState.syncMode !== "buffered") return false;
  if (!["subtitles", "both"].includes(translationState.outputMode)) return false;
  if (!translationState.bufferedPlayerEnabled) return false;
  if (!payload.tabId || payload.tabId !== translationState.tabId) return false;
  if (!payload.bufferedSessionId || payload.bufferedSessionId !== translationState.bufferedSessionId) return false;
  if (Number(payload.generation) !== Number(translationState.generation ?? 0)) return false;
  const playerStatus = translationState.bufferedPlayer?.status;
  if (playerStatus === "stopped" || playerStatus === "error" || playerStatus === "ended") return false;
  return true;
}

function isBufferedTimedDubStatusTarget(translationState, tabId, payload = {}) {
  if (!translationState?.timedDubSchedulerEnabled || translationState.status === "idle") return false;
  if (!tabId || tabId !== translationState.tabId) return false;
  if (!payload.bufferedSessionId || payload.bufferedSessionId !== translationState.bufferedSessionId) return false;
  if (Number(payload.generation) !== Number(translationState.generation ?? 0)) return false;
  return true;
}

function shouldResetTimedDubForTimelineEvent(translationState, snapshot, previousGeneration) {
  if (!translationState?.timedDubSchedulerEnabled) return false;
  if (snapshot.generation > previousGeneration) return true;
  return snapshot.eventType === "seeking" ||
    snapshot.eventType === "seeked" ||
    snapshot.eventType === "timeline-jump" ||
    snapshot.eventType === "timeline-jump-start" ||
    snapshot.eventType === "emptied";
}

function normalizeBufferedSubtitlePayload(payload = {}) {
  const tabId = sanitizeInteger(payload.tabId);
  const generation = sanitizeInteger(payload.generation);
  const sequence = sanitizeInteger(payload.sequence);
  const bufferedSessionId = sanitizeSessionId(payload.bufferedSessionId);
  if (!tabId || !bufferedSessionId || generation === undefined || sequence === undefined) return null;

  const seenIds = new Set();
  const translatedSegments = [];
  for (const raw of payload.translatedSegments || []) {
    const id = sanitizeCueId(raw?.id);
    const startMs = sanitizeNonNegativeFinite(raw?.startMs);
    const endMs = sanitizeNonNegativeFinite(raw?.endMs);
    if (!id || seenIds.has(id) || startMs === undefined || endMs === undefined || endMs <= startMs) return null;
    if (typeof raw.translatedText !== "string") return null;
    seenIds.add(id);

    const segment = {
      id,
      bufferedSessionId,
      generation,
      sequence,
      startMs,
      endMs,
      translatedText: raw.translatedText.replace(/\s+/g, " ").trim().slice(0, 280)
    };
    if (typeof raw.sourceText === "string") {
      segment.sourceText = raw.sourceText.replace(/\s+/g, " ").trim().slice(0, 220);
    }
    translatedSegments.push(segment);
  }

  return {
    tabId,
    bufferedSessionId,
    generation,
    sequence,
    translatedSegments
  };
}

function normalizeBufferedTranslationCoveragePayload(payload = {}) {
  const tabId = sanitizeInteger(payload.tabId);
  const generation = sanitizeInteger(payload.generation);
  const sequence = sanitizeInteger(payload.sequence);
  const bufferedSessionId = sanitizeSessionId(payload.bufferedSessionId);
  const startMs = sanitizeNonNegativeFinite(payload.startMs);
  const endMs = sanitizeNonNegativeFinite(payload.endMs);
  const translatedSegmentCount = sanitizeInteger(payload.translatedSegmentCount);
  if (!tabId || !bufferedSessionId || generation === undefined || sequence === undefined) return null;
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return null;
  if (translatedSegmentCount === undefined) return null;

  return {
    tabId,
    bufferedSessionId,
    generation,
    sequence,
    startMs,
    endMs,
    empty: payload.empty === true,
    translatedSegmentCount
  };
}

function normalizeBufferedTimedDubPayload(payload = {}) {
  const tabId = sanitizeInteger(payload.tabId);
  const generation = sanitizeInteger(payload.generation);
  const sequence = sanitizeInteger(payload.sequence);
  const bufferedSessionId = sanitizeSessionId(payload.bufferedSessionId);
  if (!tabId || !bufferedSessionId || generation === undefined || sequence === undefined) return null;

  const seenIds = new Set();
  const timedDubClips = [];
  for (const raw of payload.timedDubClips || []) {
    const id = sanitizeCueId(raw?.id);
    const clipGeneration = sanitizeInteger(raw?.generation);
    const clipSequence = sanitizeInteger(raw?.sequence);
    const startMs = sanitizeNonNegativeFinite(raw?.startMs);
    const endMs = sanitizeNonNegativeFinite(raw?.endMs);
    const audioDurationMs = sanitizePositiveFinite(raw?.audioDurationMs);
    const targetWindowDurationMs = sanitizePositiveFinite(raw?.targetWindowDurationMs);
    const durationRatio = sanitizePositiveFinite(raw?.durationRatio);
    const audioMime = sanitizeAudioMime(raw?.audioMime);
    const audioBase64 = sanitizeAudioBase64(raw?.audioBase64);
    const speakerId = sanitizePublicIdentifier(raw?.speakerId, 80);
    const voiceId = sanitizePublicIdentifier(raw?.voiceId, 160);
    if (!id || seenIds.has(id)) return null;
    if (clipGeneration !== generation || clipSequence !== sequence) return null;
    if (startMs === undefined || endMs === undefined || endMs <= startMs) return null;
    if (!audioDurationMs || !audioMime || !audioBase64 || !speakerId || !voiceId) return null;
    seenIds.add(id);

    timedDubClips.push({
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
      targetWindowDurationMs: targetWindowDurationMs ?? Math.max(1, endMs - startMs),
      durationRatio: durationRatio ?? audioDurationMs / Math.max(1, endMs - startMs)
    });
  }

  return {
    tabId,
    bufferedSessionId,
    generation,
    sequence,
    timedDubClips
  };
}

function validateBufferedTimelineTarget(translationState, tabId, bufferedSessionId) {
  if (!translationState?.bufferedPlayerEnabled || translationState.syncMode !== "buffered") {
    throw new Error("Buffered timeline is not active.");
  }
  if (!tabId || translationState.tabId !== tabId) {
    throw new Error("Buffered timeline tab mismatch.");
  }
  if (!bufferedSessionId || translationState.bufferedSessionId !== bufferedSessionId) {
    throw new Error("Buffered timeline session mismatch.");
  }
}

function isBufferedTimelineTarget(translationState, tabId, bufferedSessionId) {
  try {
    validateBufferedTimelineTarget(translationState, tabId, bufferedSessionId);
    return true;
  } catch {
    return false;
  }
}

async function setSessionState(patch) {
  const { translationState } = await chrome.storage.session.get("translationState");
  await chrome.storage.session.set({
    translationState: {
      status: "idle",
      tabId: null,
      error: null,
      updatedAt: Date.now(),
      ...(translationState ?? {}),
      ...patch,
      updatedAt: Date.now()
    }
  });
}

function normalizeBackendUrl(value) {
  const url = new URL(value || DEFAULT_SETTINGS.backendUrl);
  return url.origin + url.pathname.replace(/\/$/, "");
}

function normalizeProvider(value) {
  return value === "ollama" ? "ollama" : "openai";
}

function normalizeOutputMode(value) {
  return ["subtitles", "dub", "both"].includes(value) ? value : "both";
}

function clampVolume(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
}

function sanitizeBufferedPlayerStatus(payload = {}) {
  const allowedStatus = new Set(["buffering", "waiting-translation", "rebuffering", "playing", "paused", "ended", "error", "stopped"]);
  const status = allowedStatus.has(payload.status) ? payload.status : "buffering";
  return {
    status,
    error: sanitizeError(payload.error),
    bufferedSessionId: sanitizeSessionId(payload.bufferedSessionId),
    generation: sanitizeInteger(payload.generation),
    bufferedSeconds: sanitizeNumber(payload.bufferedSeconds),
    currentTime: sanitizeNumber(payload.currentTime),
    sourceTime: sanitizeNumber(payload.sourceTime),
    delayedSourceTimeMs: sanitizeNumber(payload.delayedSourceTimeMs),
    translationReadinessRequired: payload.translationReadinessRequired === true,
    translationCoverageStartMs: sanitizeNumber(payload.translationCoverageStartMs),
    translationReadyThroughMs: sanitizeNumber(payload.translationReadyThroughMs),
    translationReadyLeadMs: sanitizeNumber(payload.translationReadyLeadMs),
    translationReady: payload.translationReady === true,
    mediaReady: payload.mediaReady === true,
    waitingForTranslation: payload.waitingForTranslation === true,
    translationCoverageCount: sanitizeInteger(payload.translationCoverageCount),
    pipelineEpoch: sanitizeInteger(payload.pipelineEpoch),
    sequence: Number.isInteger(payload.sequence) ? payload.sequence : undefined,
    updatedAt: Date.now()
  };
}

function sanitizeTimedDubSchedulerStatus(payload = {}) {
  const allowedStatus = new Set([
    "waiting-clock",
    "buffering",
    "rebuffering",
    "playing",
    "paused",
    "audio-blocked",
    "reset",
    "ended",
    "stopped",
    "error"
  ]);
  const status = allowedStatus.has(payload.status) ? payload.status : "waiting-clock";
  return {
    status,
    error: sanitizeError(payload.error),
    generation: sanitizeInteger(payload.generation),
    queueSize: sanitizeInteger(payload.queueSize),
    activeClipCount: sanitizeInteger(payload.activeClipCount),
    counters: sanitizeTimedDubCounters(payload.counters),
    updatedAt: Date.now()
  };
}

function sanitizeTimedDubCounters(counters = {}) {
  const result = {};
  for (const key of ["received", "decoded", "played", "lateStarted", "droppedExpired", "droppedStale", "decodeFailed"]) {
    result[key] = sanitizeInteger(counters?.[key]) ?? 0;
  }
  return result;
}

function isFromOffscreenDocument(sender = {}) {
  return sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
}

function sanitizeError(value) {
  if (typeof value !== "string") return undefined;
  return value.replace(/\s+/g, " ").trim().slice(0, 240) || undefined;
}

function sanitizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function sanitizeNonNegativeFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function sanitizePositiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function sanitizeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function sanitizeSessionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeCueId(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
}

function sanitizePublicIdentifier(value, maxLength) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().slice(0, maxLength);
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "";
}

function sanitizeAudioMime(value) {
  const mime = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"].includes(mime) ? mime : "";
}

function sanitizeAudioBase64(value) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length > 8 * 1024 * 1024 || compact.length % 4 !== 0) return "";
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return "";
  return compact;
}
