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
  showSourceTranscript: false
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

  await setSessionState({ status: "idle", tabId: null, error: null });
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
    ollamaModel: String(payload.ollamaModel ?? stored.ollamaModel ?? "").trim(),
    tabId: tab.id
  };

  if (settings.sourceLanguage === settings.targetLanguage) {
    throw new Error("Source and translation languages must be different.");
  }
  if (settings.provider === "ollama" && !settings.ollamaModel) {
    throw new Error("Choose an installed Ollama model before starting local translation.");
  }

  const subtitlesEnabled = settings.outputMode !== "dub";
  const dubEnabled = settings.outputMode !== "subtitles";
  const showSourceTranscript = subtitlesEnabled && Boolean(settings.showSourceTranscript);

  await setSessionState({
    status: "starting",
    tabId: tab.id,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    provider: settings.provider,
    ollamaModel: settings.provider === "ollama" ? settings.ollamaModel : null,
    outputMode: settings.outputMode,
    subtitlesEnabled,
    dubEnabled,
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
        provider: settings.provider
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

  return { tabId: tab.id };
}

async function stopTranslation() {
  const { translationState } = await chrome.storage.session.get("translationState");
  await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP", target: "offscreen" }).catch(() => null);

  if (translationState?.tabId && translationState?.subtitlesEnabled) {
    await chrome.tabs.sendMessage(translationState.tabId, { type: "OVERLAY_STOP" }).catch(() => null);
  }

  await setSessionState({ status: "idle", tabId: null, error: null });
}

async function handleOffscreenStatus(payload = {}) {
  const { translationState } = await chrome.storage.session.get("translationState");
  const tabId = payload.tabId ?? translationState?.tabId ?? null;
  const isIdle = payload.status === "idle";
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

  const tabId = payload.tabId ?? translationState?.tabId;
  if (!tabId) return;

  await chrome.tabs.sendMessage(tabId, {
    type: "OVERLAY_TRANSCRIPT",
    payload
  }).catch(() => null);
}

async function cleanupClosedTranslationTab(tabId) {
  const { translationState } = await chrome.storage.session.get("translationState");
  if (translationState?.tabId !== tabId) return;

  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_STOP",
    target: "offscreen"
  }).catch(() => null);
  await setSessionState({ status: "idle", tabId: null, error: null });
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
    files: ["content/subtitles.js"]
  });
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
