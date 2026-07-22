import {
  clampInitialBufferSeconds,
  normalizeSyncMode,
  validatePlaybackMode
} from "../shared/playback-settings.js";

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

const FALLBACK_LANGUAGES = [
  { code: "ja", label: "Japanese", openAiTarget: true, ollamaTarget: true },
  { code: "en", label: "English", openAiTarget: true, ollamaTarget: true },
  { code: "es", label: "Spanish", openAiTarget: true, ollamaTarget: true },
  { code: "pt", label: "Portuguese", openAiTarget: true, ollamaTarget: true },
  { code: "fr", label: "French", openAiTarget: true, ollamaTarget: true },
  { code: "ru", label: "Russian", openAiTarget: true, ollamaTarget: true },
  { code: "zh", label: "Chinese", openAiTarget: true, ollamaTarget: true },
  { code: "de", label: "German", openAiTarget: true, ollamaTarget: true },
  { code: "ko", label: "Korean", openAiTarget: true, ollamaTarget: true },
  { code: "hi", label: "Hindi", openAiTarget: true, ollamaTarget: true },
  { code: "id", label: "Indonesian", openAiTarget: true, ollamaTarget: true },
  { code: "vi", label: "Vietnamese", openAiTarget: true, ollamaTarget: true },
  { code: "it", label: "Italian", openAiTarget: true, ollamaTarget: true },
  { code: "nl", label: "Dutch", openAiTarget: false, ollamaTarget: true }
];

const FALLBACK_PROVIDERS = {
  openai: {
    available: true,
    supportsSubtitles: true,
    supportsDub: true,
    detail: "OpenAI availability will be checked when you start."
  },
  ollama: {
    available: false,
    supportsSubtitles: false,
    supportsDub: false,
    dubTargets: [],
    models: [],
    defaultModel: "",
    chunkMs: 4500,
    detail: "Start the backend to discover your local Ollama models."
  }
};

const els = {
  provider: document.querySelector("#provider"),
  ollamaModelRow: document.querySelector("#ollamaModelRow"),
  ollamaModel: document.querySelector("#ollamaModel"),
  ollamaModelHelp: document.querySelector("#ollamaModelHelp"),
  providerStatus: document.querySelector("#providerStatus"),
  sourceLanguage: document.querySelector("#sourceLanguage"),
  sourceLanguageHelp: document.querySelector("#sourceLanguageHelp"),
  targetLanguage: document.querySelector("#targetLanguage"),
  outputMode: document.querySelector("#outputMode"),
  syncMode: document.querySelector("#syncMode"),
  playbackModeHelp: document.querySelector("#playbackModeHelp"),
  initialBufferRow: document.querySelector("#initialBufferRow"),
  initialBufferSeconds: document.querySelector("#initialBufferSeconds"),
  originalVolume: document.querySelector("#originalVolume"),
  originalVolumeValue: document.querySelector("#originalVolumeValue"),
  dubVolume: document.querySelector("#dubVolume"),
  dubVolumeValue: document.querySelector("#dubVolumeValue"),
  showSourceTranscript: document.querySelector("#showSourceTranscript"),
  sourceTranscriptRow: document.querySelector("#sourceTranscriptRow"),
  modeNote: document.querySelector("#modeNote"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  statusBadge: document.querySelector("#statusBadge"),
  message: document.querySelector("#message"),
  privacyLabel: document.querySelector("#privacyLabel"),
  openOptions: document.querySelector("#openOptions")
};

let languages = FALLBACK_LANGUAGES;
let providers = FALLBACK_PROVIDERS;

init().catch((error) => showMessage(error.message, true));

async function init() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const metadata = await loadBackendMetadata(settings.backendUrl);
  languages = metadata.languages;
  providers = metadata.providers;

  populateSourceLanguages(settings.sourceLanguage);
  els.provider.value = normalizeProvider(settings.provider);
  populateOllamaModels(settings.ollamaModel);
  refreshTargetLanguages(settings.targetLanguage);

  els.outputMode.value = normalizeOutputMode(settings.outputMode);
  els.syncMode.value = normalizeSyncMode(settings.syncMode);
  els.initialBufferSeconds.value = clampInitialBufferSeconds(settings.initialBufferSeconds);
  els.originalVolume.value = Math.round(clampVolume(settings.originalVolume) * 100);
  els.dubVolume.value = Math.round(clampVolume(settings.dubVolume) * 100);
  els.showSourceTranscript.checked = settings.showSourceTranscript;
  syncVolumeLabels();
  updateProviderUi(false);
  updateModeUi(false);
  updatePlaybackUi(false);

  els.startButton.addEventListener("click", startTranslation);
  els.stopButton.addEventListener("click", stopTranslation);
  els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

  els.provider.addEventListener("change", async () => {
    const previousTarget = els.targetLanguage.value;
    refreshTargetLanguages(previousTarget);
    populateOllamaModels(els.ollamaModel.value);
    updateProviderUi(false);
    updateModeUi(false);
    updatePlaybackUi(false);
    await persistControls();
  });
  els.ollamaModel.addEventListener("change", persistControls);
  els.outputMode.addEventListener("change", async () => {
    applyModePreset(els.outputMode.value);
    updateModeUi(false);
    await persistControls();
  });
  els.syncMode.addEventListener("change", async () => {
    updatePlaybackUi(false);
    await persistControls();
  });
  els.initialBufferSeconds.addEventListener("change", async () => {
    els.initialBufferSeconds.value = clampInitialBufferSeconds(els.initialBufferSeconds.value);
    await persistControls();
  });
  els.showSourceTranscript.addEventListener("change", persistControls);
  els.sourceLanguage.addEventListener("change", persistControls);
  els.targetLanguage.addEventListener("change", async () => {
    updateProviderUi(false);
    updateModeUi(false);
    updatePlaybackUi(false);
    await persistControls();
  });
  els.originalVolume.addEventListener("input", syncVolumeLabels);
  els.dubVolume.addEventListener("input", syncVolumeLabels);
  els.originalVolume.addEventListener("change", persistControls);
  els.dubVolume.addEventListener("change", persistControls);

  const stateResponse = await chrome.runtime.sendMessage({ type: "GET_TRANSLATION_STATE" });
  renderState(stateResponse?.state ?? { status: "idle" });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "session" && changes.translationState?.newValue) {
      renderState(changes.translationState.newValue);
    }
  });
}

async function loadBackendMetadata(backendUrl) {
  const baseUrl = backendUrl.replace(/\/$/, "");
  try {
    const [languageResponse, providerResponse] = await Promise.all([
      fetch(`${baseUrl}/languages`),
      fetch(`${baseUrl}/providers`)
    ]);
    if (!languageResponse.ok || !providerResponse.ok) throw new Error("Backend metadata unavailable");
    const languageData = await languageResponse.json();
    const providerData = await providerResponse.json();
    return {
      languages: Array.isArray(languageData.languages) && languageData.languages.length
        ? languageData.languages
        : FALLBACK_LANGUAGES,
      providers: providerData.providers || FALLBACK_PROVIDERS
    };
  } catch {
    showMessage("Backend not reached yet. Using built-in defaults; local model discovery is unavailable.");
    return { languages: FALLBACK_LANGUAGES, providers: FALLBACK_PROVIDERS };
  }
}

function populateSourceLanguages(preferred) {
  els.sourceLanguage.replaceChildren();
  for (const language of languages) {
    els.sourceLanguage.add(new Option(language.label, language.code));
  }
  els.sourceLanguage.value = preferred;
  if (!els.sourceLanguage.value) els.sourceLanguage.value = "ja";
}

function refreshTargetLanguages(preferred) {
  const provider = normalizeProvider(els.provider.value);
  els.targetLanguage.replaceChildren();
  for (const language of languages) {
    if (canTarget(language, provider)) {
      els.targetLanguage.add(new Option(language.label, language.code));
    }
  }
  els.targetLanguage.value = preferred;
  if (!els.targetLanguage.value) els.targetLanguage.value = "en";
  if (!els.targetLanguage.value && els.targetLanguage.options.length) {
    els.targetLanguage.selectedIndex = 0;
  }
}

function populateOllamaModels(preferred) {
  const modelList = providers.ollama?.models || [];
  els.ollamaModel.replaceChildren();
  if (!modelList.length) {
    const empty = new Option("No local models found", "");
    empty.disabled = true;
    empty.selected = true;
    els.ollamaModel.add(empty);
    return;
  }

  for (const model of modelList) {
    const name = model.name || model.model;
    const details = [model.parameterSize, model.quantization].filter(Boolean).join(" · ");
    els.ollamaModel.add(new Option(details ? `${name} (${details})` : name, name));
  }
  const desired = preferred || providers.ollama?.defaultModel;
  els.ollamaModel.value = desired;
  if (!els.ollamaModel.value) els.ollamaModel.selectedIndex = 0;
}

async function startTranslation() {
  try {
    if (els.sourceLanguage.value === els.targetLanguage.value) {
      throw new Error("Choose different video and translation languages.");
    }
    if (els.provider.value === "ollama" && !els.ollamaModel.value) {
      throw new Error("No Ollama model is available. Start Ollama, pull a model, and reopen the popup.");
    }
    if (!providerSupportsSelectedMode()) {
      throw new Error("The selected provider is not configured for this output mode and target language.");
    }
    validatePlaybackMode({
      provider: els.provider.value,
      syncMode: els.syncMode.value
    });

    els.initialBufferSeconds.value = clampInitialBufferSeconds(els.initialBufferSeconds.value);
    await persistControls();
    showMessage(els.provider.value === "ollama"
      ? "Starting the local Whisper → Ollama pipeline…"
      : "Opening an OpenAI realtime translation session…");
    els.startButton.disabled = true;

    const response = await chrome.runtime.sendMessage({
      type: "START_TRANSLATION",
      payload: {
        provider: els.provider.value,
        ollamaModel: els.ollamaModel.value,
        localChunkMs: providers.ollama?.chunkMs || 4500,
        sourceLanguage: els.sourceLanguage.value,
        targetLanguage: els.targetLanguage.value,
        outputMode: els.outputMode.value,
        syncMode: els.syncMode.value,
        initialBufferSeconds: Number(els.initialBufferSeconds.value),
        originalVolume: Number(els.originalVolume.value) / 100,
        dubVolume: Number(els.dubVolume.value) / 100,
        showSourceTranscript: els.showSourceTranscript.checked
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not start translation.");
    }
  } catch (error) {
    showMessage(error.message || "Could not start translation.", true);
    els.startButton.disabled = false;
  }
}

async function stopTranslation() {
  try {
    els.stopButton.disabled = true;
    const response = await chrome.runtime.sendMessage({ type: "STOP_TRANSLATION" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not stop translation.");
    }
  } catch (error) {
    showMessage(error.message || "Could not stop translation.", true);
    els.stopButton.disabled = false;
  }
}

async function persistControls() {
  await chrome.storage.local.set({
    provider: els.provider.value,
    ollamaModel: els.ollamaModel.value,
    sourceLanguage: els.sourceLanguage.value,
    targetLanguage: els.targetLanguage.value,
    outputMode: els.outputMode.value,
    syncMode: els.syncMode.value,
    initialBufferSeconds: clampInitialBufferSeconds(els.initialBufferSeconds.value),
    originalVolume: Number(els.originalVolume.value) / 100,
    dubVolume: Number(els.dubVolume.value) / 100,
    showSourceTranscript: els.showSourceTranscript.checked
  });
}

function renderState(state) {
  const status = state.status || "idle";
  els.statusBadge.dataset.status = status;
  els.statusBadge.textContent = {
    idle: "Idle",
    starting: "Starting",
    connected: "Live",
    reconnecting: "Reconnecting",
    error: "Error"
  }[status] || status;

  const active = ["starting", "connected", "reconnecting"].includes(status);
  updateProviderUi(active);
  updateModeUi(active);
  updatePlaybackUi(active);
  if (status === "connected" && state.syncMode === "buffered") {
    els.statusBadge.textContent = "Buffered";
  }
  els.startButton.disabled = active || !providerSupportsSelectedMode() || !playbackModeSupported();
  els.stopButton.disabled = !active && status !== "error";
  els.sourceLanguage.disabled = active;
  els.targetLanguage.disabled = active;
  els.provider.disabled = active;
  els.ollamaModel.disabled = active || els.provider.value !== "ollama" || !els.ollamaModel.value;
  els.outputMode.disabled = active;
  els.syncMode.disabled = active;
  els.initialBufferSeconds.disabled = active || normalizeSyncMode(els.syncMode.value) !== "buffered";
  els.originalVolume.disabled = active;

  const provider = state.provider || els.provider.value;
  if (status === "connected") {
    const providerName = provider === "ollama" ? "Ollama local" : "OpenAI Realtime";
    if (state.syncMode === "buffered") {
      showBufferedPlayerMessage(state);
    } else {
      showMessage(`${modeLabel(state.outputMode || els.outputMode.value)} is live through ${providerName}. Keep this video tab open.`);
    }
  } else if (status === "reconnecting") {
    showMessage("The realtime connection is reconnecting…");
  } else if (status === "error") {
    showMessage(state.error || "The translation session failed.", true);
  } else if (status === "idle") {
    showMessage("Open a Japanese video, press play, choose an engine, playback mode, and output mode, then start.");
  }
}

function updateProviderUi(active) {
  const provider = normalizeProvider(els.provider.value);
  const capability = providers[provider] || FALLBACK_PROVIDERS[provider];
  const isOllama = provider === "ollama";
  els.ollamaModelRow.hidden = !isOllama;
  els.ollamaModel.disabled = active || !isOllama || !els.ollamaModel.value;
  els.sourceLanguageHelp.textContent = isOllama
    ? "Used by local whisper.cpp transcription."
    : "Expected language; OpenAI translation input is auto-detected.";
  els.privacyLabel.textContent = isOllama
    ? "Local AI translation through your backend"
    : "AI-generated cloud translation";

  const available = capability?.available !== false;
  els.providerStatus.classList.toggle("error", !available);
  els.providerStatus.textContent = capability?.detail || "Provider status unavailable.";
  updateModeAvailability();
}

function updateModeAvailability() {
  const provider = normalizeProvider(els.provider.value);
  const capability = providers[provider] || FALLBACK_PROVIDERS[provider];
  const target = els.targetLanguage.value;
  const localDubTargets = new Set(capability?.dubTargets || []);
  const canDub = provider === "openai"
    ? capability?.supportsDub !== false
    : capability?.supportsDub === true && localDubTargets.has(target);

  for (const option of els.outputMode.options) {
    option.disabled = (option.value === "dub" || option.value === "both") && !canDub;
  }
  if (els.outputMode.selectedOptions[0]?.disabled) {
    els.outputMode.value = "subtitles";
    applyModePreset("subtitles");
  }
}

function updateModeUi(active) {
  const mode = normalizeOutputMode(els.outputMode.value);
  const subtitlesEnabled = mode !== "dub";
  const dubEnabled = mode !== "subtitles";
  const isLocal = els.provider.value === "ollama";

  els.dubVolume.disabled = active || !dubEnabled;
  els.showSourceTranscript.disabled = active || !subtitlesEnabled;
  els.sourceTranscriptRow.dataset.disabled = String(!subtitlesEnabled);

  const copy = {
    both: {
      strong: "Subtitles and translated speech are both on.",
      detail: isLocal
        ? "Audio is processed in short local chunks using Whisper, Ollama, and Piper."
        : "The original track is mixed quietly underneath the realtime English dub."
    },
    subtitles: {
      strong: "Original audio stays on.",
      detail: isLocal
        ? "Short audio chunks are transcribed locally and translated by your selected Ollama model."
        : "Translated captions appear on the page; no AI voice is played."
    },
    dub: {
      strong: "Translated speech is on.",
      detail: isLocal
        ? "Piper speaks each translated chunk; this has more latency than OpenAI Realtime."
        : "The original track is muted by default, but you can mix it back in."
    }
  }[mode];

  els.modeNote.innerHTML = `<strong>${copy.strong}</strong><span>${copy.detail}</span>`;
  els.startButton.textContent = {
    both: "Start subtitles + dub",
    subtitles: "Start subtitles",
    dub: "Start dub"
  }[mode];
}

function updatePlaybackUi(active) {
  const syncMode = normalizeSyncMode(els.syncMode.value);
  const isBuffered = syncMode === "buffered";
  const supported = playbackModeSupported();

  els.initialBufferRow.hidden = !isBuffered;
  els.initialBufferSeconds.disabled = active || !isBuffered;
  if (isBuffered && document.activeElement !== els.initialBufferSeconds) {
    els.initialBufferSeconds.value = clampInitialBufferSeconds(els.initialBufferSeconds.value);
  }

  els.playbackModeHelp.classList.toggle("error", !supported);
  els.playbackModeHelp.textContent = !supported
    ? "Buffered playback is currently only available with Ollama local mode."
    : isBuffered
      ? "The source video runs ahead while a delayed visible copy buffers."
      : "Live leaves the page video timing unchanged.";
  if (!active) {
    els.startButton.disabled = !providerSupportsSelectedMode() || !supported;
  }
}

function providerSupportsSelectedMode() {
  const provider = normalizeProvider(els.provider.value);
  const capability = providers[provider] || FALLBACK_PROVIDERS[provider];
  if (capability?.available === false) return false;
  if (provider === "ollama" && !els.ollamaModel.value) return false;
  const mode = normalizeOutputMode(els.outputMode.value);
  if (mode === "subtitles") return capability?.supportsSubtitles !== false;
  if (provider === "openai") return capability?.supportsDub !== false;
  return capability?.supportsDub === true && (capability.dubTargets || []).includes(els.targetLanguage.value);
}

function playbackModeSupported() {
  try {
    validatePlaybackMode({
      provider: normalizeProvider(els.provider.value),
      syncMode: normalizeSyncMode(els.syncMode.value)
    });
    return true;
  } catch {
    return false;
  }
}

function applyModePreset(mode) {
  const presets = {
    both: { original: 15, dub: 100 },
    subtitles: { original: 100, dub: 100 },
    dub: { original: 0, dub: 100 }
  };
  const preset = presets[normalizeOutputMode(mode)];
  els.originalVolume.value = preset.original;
  els.dubVolume.value = preset.dub;
  syncVolumeLabels();
}

function syncVolumeLabels() {
  els.originalVolumeValue.textContent = `${els.originalVolume.value}%`;
  els.dubVolumeValue.textContent = `${els.dubVolume.value}%`;
}

function canTarget(language, provider) {
  if (provider === "ollama") return language.ollamaTarget !== false;
  return language.openAiTarget === true || (language.openAiTarget === undefined && language.canTarget === true);
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

function modeLabel(mode) {
  return {
    both: "Subtitles + dub",
    subtitles: "Subtitles",
    dub: "Dub"
  }[normalizeOutputMode(mode)];
}

function showBufferedPlayerMessage(state) {
  const player = state.bufferedPlayer || {};
  const target = clampInitialBufferSeconds(state.initialBufferSeconds ?? els.initialBufferSeconds.value);
  const buffered = Number.isFinite(player.bufferedSeconds)
    ? ` (${Math.min(player.bufferedSeconds, target).toFixed(1)} / ${target}s)`
    : "";

  if (player.status === "playing") {
    showMessage("Delayed buffered video playback is running through Ollama local. Subtitle and dub timing are not synchronized yet.");
  } else if (player.status === "paused") {
    showMessage("The source video is paused; delayed buffered playback is paused too.");
  } else if (player.status === "ended") {
    showMessage("The delayed buffered video reached the end of the captured source media.");
  } else {
    showMessage(`Buffering delayed video playback${buffered}. Keep the source video playing.`);
  }
}

function showMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle("error", isError);
}
