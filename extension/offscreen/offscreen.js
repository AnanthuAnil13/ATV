import {
  audioBlobDiagnostics,
  createChunkMetadata,
  createFinalizedAudioBlob,
  pickAudioRecorderMimeType,
  validateStandaloneAudioBlob
} from "./local-chunks.js";
import {
  clampInitialBufferSeconds,
  normalizeSyncMode,
  shouldActivateBufferedPlayer,
  validatePlaybackMode
} from "../shared/playback-settings.js";

let session = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "OFFSCREEN_START") {
    startSession(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        await stopSession({ notify: false });
        if (error.name !== "AbortError") {
          notifyStatus("error", {
            error: error.message,
            tabId: message.payload?.tabId,
            provider: message.payload?.provider,
            syncMode: message.payload?.syncMode
          });
        }
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "OFFSCREEN_STOP") {
    stopSession({ notify: message.payload?.notify !== false })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function startSession(config) {
  await stopSession({ notify: false });
  validateConfig(config);

  const currentSession = {
    config,
    hasConnected: false,
    sourceStream: null,
    sourceTrack: null,
    audioContext: null,
    sourceNode: null,
    originalGain: null,
    remoteAudio: null,
    peerConnection: null,
    events: null,
    local: null
  };
  session = currentSession;
  notifyStatus("starting", {
    tabId: config.tabId,
    outputMode: config.outputMode,
    provider: config.provider,
    syncMode: config.syncMode
  });

  currentSession.sourceStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: config.streamId
      }
    },
    video: false
  });
  assertCurrentSession(currentSession);

  currentSession.sourceTrack = currentSession.sourceStream.getAudioTracks()[0];
  if (!currentSession.sourceTrack) {
    throw new Error("The captured tab did not provide an audio track.");
  }
  currentSession.sourceTrack.onended = () => {
    if (session !== currentSession) return;
    stopSession({ notify: true }).catch(console.error);
  };

  // tabCapture removes the tab's audio from its normal output path. Route the
  // captured track back through a gain node so it can be preserved, ducked, or
  // muted independently of translated speech.
  currentSession.audioContext = new AudioContext();
  await currentSession.audioContext.resume();
  assertCurrentSession(currentSession);

  currentSession.sourceNode = currentSession.audioContext.createMediaStreamSource(currentSession.sourceStream);
  currentSession.originalGain = currentSession.audioContext.createGain();
  currentSession.originalGain.gain.value = shouldMuteLiveOriginal(config) ? 0 : clampVolume(config.originalVolume);
  currentSession.sourceNode.connect(currentSession.originalGain).connect(currentSession.audioContext.destination);

  if (config.provider === "ollama") {
    await startOllamaLocalSession(currentSession);
  } else {
    await startOpenAiSession(currentSession);
  }
}

async function startOpenAiSession(currentSession) {
  const { config } = currentSession;
  const clientSecret = await requestClientSecret(config);
  assertCurrentSession(currentSession);

  currentSession.peerConnection = new RTCPeerConnection();
  currentSession.peerConnection.addTrack(currentSession.sourceTrack, currentSession.sourceStream);

  currentSession.peerConnection.ontrack = ({ track, streams }) => {
    if (session !== currentSession) return;

    if (!isDubEnabled(config.outputMode)) {
      track.enabled = false;
      return;
    }

    attachTranslatedAudio(currentSession, track, streams?.[0]);
  };

  currentSession.peerConnection.onconnectionstatechange = () => {
    if (session !== currentSession) return;
    const state = currentSession.peerConnection.connectionState;
    if (state === "connected") {
      currentSession.hasConnected = true;
      notifyStatus("connected", {
        tabId: config.tabId,
        outputMode: config.outputMode,
        provider: config.provider,
        syncMode: config.syncMode
      });
    } else if (state === "disconnected") {
      notifyStatus("reconnecting", {
        tabId: config.tabId,
        outputMode: config.outputMode,
        provider: config.provider,
        syncMode: config.syncMode
      });
    } else if (state === "connecting") {
      notifyStatus(currentSession.hasConnected ? "reconnecting" : "starting", {
        tabId: config.tabId,
        outputMode: config.outputMode,
        provider: config.provider,
        syncMode: config.syncMode
      });
    } else if (state === "failed") {
      notifyStatus("error", {
        tabId: config.tabId,
        outputMode: config.outputMode,
        provider: config.provider,
        syncMode: config.syncMode,
        error: "The OpenAI realtime translation connection failed."
      });
    }
  };

  currentSession.events = currentSession.peerConnection.createDataChannel("oai-events");
  currentSession.events.onmessage = ({ data }) => handleRealtimeEvent(data, config);
  currentSession.events.onerror = () => {
    if (session !== currentSession) return;
    notifyStatus("error", {
      tabId: config.tabId,
      outputMode: config.outputMode,
      provider: config.provider,
      syncMode: config.syncMode,
      error: "The OpenAI realtime translation event channel failed."
    });
  };

  const offer = await currentSession.peerConnection.createOffer();
  await currentSession.peerConnection.setLocalDescription(offer);
  assertCurrentSession(currentSession);

  const sdpResponse = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    },
    body: offer.sdp
  });
  assertCurrentSession(currentSession);

  if (!sdpResponse.ok) {
    throw new Error(`OpenAI WebRTC connection failed (${sdpResponse.status}): ${await sdpResponse.text()}`);
  }

  const answerSdp = await sdpResponse.text();
  assertCurrentSession(currentSession);
  await currentSession.peerConnection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp
  });
  assertCurrentSession(currentSession);
}

async function startOllamaLocalSession(currentSession) {
  const mimeType = pickAudioRecorderMimeType();

  currentSession.local = {
    mimeType,
    chunkMs: clampInteger(currentSession.config.localChunkMs, 2500, 12000, 4500),
    recorder: null,
    segmentTimer: null,
    queue: [],
    processing: false,
    startedAt: performance.now(),
    generation: 0,
    sequence: 0,
    currentAudio: null,
    audioQueue: [],
    maxAudioQueue: 8,
    audioPlaying: false
  };

  notifyStatus("connected", {
    tabId: currentSession.config.tabId,
    outputMode: currentSession.config.outputMode,
    provider: currentSession.config.provider,
    syncMode: currentSession.config.syncMode,
    model: currentSession.config.ollamaModel
  });
  startNextLocalRecording(currentSession);
}

function startNextLocalRecording(currentSession) {
  if (session !== currentSession || !currentSession.local) return;
  if (currentSession.sourceTrack.readyState !== "live") return;

  const chunks = [];
  const captureStartEpochMs = Date.now();
  const videoStartMs = Math.max(0, performance.now() - currentSession.local.startedAt);
  const sequence = currentSession.local.sequence++;
  const generation = currentSession.local.generation;
  const recorderOptions = {
    audioBitsPerSecond: 96_000
  };
  if (currentSession.local.mimeType) {
    recorderOptions.mimeType = currentSession.local.mimeType;
  }

  const recorder = new MediaRecorder(currentSession.sourceStream, recorderOptions);
  currentSession.local.recorder = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) chunks.push(event.data);
  });

  recorder.addEventListener("error", (event) => {
    failLocalSession(currentSession, event.error || new Error("Local audio recording failed."));
  });

  recorder.addEventListener("stop", () => {
    if (session !== currentSession || !currentSession.local) return;
    const captureEndEpochMs = Date.now();
    const videoEndMs = Math.max(videoStartMs, performance.now() - currentSession.local.startedAt);
    const blob = createFinalizedAudioBlob(chunks, recorder.mimeType || currentSession.local.mimeType);
    const metadata = createChunkMetadata({
      syncMode: currentSession.config.syncMode || "live",
      sequence,
      generation,
      captureStartEpochMs,
      captureEndEpochMs,
      videoStartMs,
      videoEndMs,
      playbackRate: 1
    });

    // Start capturing the next segment before doing any model work. A small
    // stop/start boundary remains, but model latency does not pause capture.
    startNextLocalRecording(currentSession);

    validateAndEnqueueLocalChunk(currentSession, blob, metadata)
      .catch((error) => failLocalSession(currentSession, error));
  }, { once: true });

  recorder.start();
  currentSession.local.segmentTimer = setTimeout(() => {
    if (session === currentSession && recorder.state === "recording") recorder.stop();
  }, currentSession.local.chunkMs);
}

async function validateAndEnqueueLocalChunk(currentSession, blob, metadata) {
  if (!blob.size) return;
  try {
    await validateStandaloneAudioBlob(blob);
    logLocalChunkDiagnostic("recorded_audio_chunk_ready", await audioBlobDiagnostics(blob, metadata));
    enqueueLocalChunk(currentSession, { blob, metadata });
  } catch (error) {
    logLocalChunkDiagnostic("recorded_audio_chunk_rejected", {
      ...(await audioBlobDiagnostics(blob, metadata)),
      code: error.code || "INVALID_AUDIO_CHUNK"
    });
    throw error;
  }
}

function enqueueLocalChunk(currentSession, item) {
  const local = currentSession.local;
  if (!local || session !== currentSession) return;
  if (item.metadata.generation !== local.generation) return;

  // Avoid unbounded latency on slower machines. Keep the newest two waiting
  // segments; if inference falls behind, stale untranslated audio is dropped.
  if (local.queue.length >= 2) local.queue.shift();
  local.queue.push(item);
  processLocalQueue(currentSession).catch((error) => failLocalSession(currentSession, error));
}

async function processLocalQueue(currentSession) {
  const local = currentSession.local;
  if (!local || local.processing || session !== currentSession) return;
  local.processing = true;

  try {
    while (session === currentSession && local.queue.length) {
      const item = local.queue.shift();
      if (item.metadata.generation !== local.generation) continue;
      const result = await requestLocalTranslation(currentSession.config, item);
      assertCurrentSession(currentSession);
      if (result.generation !== undefined && result.generation !== item.metadata.generation) continue;
      if (result.empty) continue;

      const elapsedMs = Math.round(performance.now() - local.startedAt);
      if (result.sourceText) {
        notifyTranscript({
          tabId: currentSession.config.tabId,
          kind: "source",
          delta: result.sourceText,
          elapsedMs,
          replace: true
        });
      }
      if (result.translatedText) {
        notifyTranscript({
          tabId: currentSession.config.tabId,
          kind: "target",
          delta: result.translatedText,
          elapsedMs,
          replace: true
        });
      }
      if (isDubEnabled(currentSession.config.outputMode)) {
        const dubClips = Array.isArray(result.dubClips) ? result.dubClips : [];
        if (dubClips.length) {
          for (const clip of dubClips) {
            if (clip?.audioBase64) {
              enqueueLocalDub(currentSession, {
                audioBase64: clip.audioBase64,
                mimeType: clip.audioMime || "audio/wav",
                speakerId: clip.speakerId,
                translatedText: clip.translatedText
              });
            }
          }
        } else if (result.audioBase64) {
          enqueueLocalDub(currentSession, {
            audioBase64: result.audioBase64,
            mimeType: result.audioMime || "audio/wav",
            speakerId: "speaker_1",
            translatedText: result.translatedText
          });
        }
      }
    }
  } finally {
    if (currentSession.local) currentSession.local.processing = false;
  }
}

async function requestLocalTranslation(config, item) {
  const { blob, metadata } = item;
  let response;
  try {
    response = await fetch(`${config.backendUrl}/local/chunk`, {
      method: "POST",
      signal: createRequestTimeoutSignal(150_000),
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
        "X-AutoTranslate-Source-Language": config.sourceLanguage,
        "X-AutoTranslate-Target-Language": config.targetLanguage,
        "X-AutoTranslate-Output-Mode": config.outputMode,
        "X-AutoTranslate-Show-Source": String(config.showSourceTranscript),
        "X-AutoTranslate-Ollama-Model": config.ollamaModel,
        "X-AutoTranslate-Session-Id": config.localSessionId,
        "X-AutoTranslate-Installation-Id": config.installationId || "anonymous",
        "X-AutoTranslate-Chunk-Metadata": JSON.stringify(metadata)
      },
      body: blob
    });
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      throw new Error("The local translation backend request timed out.");
    }
    throw new Error("Could not reach the local translation backend. Check that it is running and reachable.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createLocalBackendError(response.status, data);
  }
  return data;
}

function enqueueLocalDub(currentSession, clip) {
  const local = currentSession.local;
  if (!local || session !== currentSession) return;
  if (local.audioQueue.length >= local.maxAudioQueue) local.audioQueue.shift();
  local.audioQueue.push(clip);
  playNextLocalDub(currentSession);
}

function playNextLocalDub(currentSession) {
  const local = currentSession.local;
  if (!local || local.audioPlaying || session !== currentSession) return;
  const next = local.audioQueue.shift();
  if (!next) return;

  local.audioPlaying = true;
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.hidden = true;
  audio.volume = clampVolume(currentSession.config.dubVolume);
  audio.src = `data:${next.mimeType || "audio/wav"};base64,${next.audioBase64}`;
  document.body.appendChild(audio);
  local.currentAudio = audio;

  const cleanup = () => {
    audio.pause();
    audio.removeAttribute("src");
    audio.remove();
    if (currentSession.local) {
      currentSession.local.currentAudio = null;
      currentSession.local.audioPlaying = false;
      playNextLocalDub(currentSession);
    }
  };
  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", () => {
    cleanup();
    failLocalSession(currentSession, new Error("The local translated audio could not be played."));
  }, { once: true });
  audio.play().catch((error) => {
    cleanup();
    failLocalSession(currentSession, error);
  });
}

function failLocalSession(currentSession, error) {
  if (session !== currentSession) return;
  notifyStatus("error", {
    tabId: currentSession.config.tabId,
    outputMode: currentSession.config.outputMode,
    provider: currentSession.config.provider,
    syncMode: currentSession.config.syncMode,
    error: error?.message || "The local translation pipeline failed."
  });
  stopSession({ notify: false }).catch(console.error);
}

function attachTranslatedAudio(currentSession, track, suppliedStream) {
  track.enabled = true;
  const translatedStream = suppliedStream || new MediaStream([track]);
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.hidden = true;
  audio.volume = clampVolume(currentSession.config.dubVolume);
  audio.srcObject = translatedStream;
  document.body.appendChild(audio);
  currentSession.remoteAudio = audio;

  audio.play().catch((error) => {
    if (session !== currentSession || error.name === "AbortError") return;
    notifyStatus("error", {
      tabId: currentSession.config.tabId,
      outputMode: currentSession.config.outputMode,
      provider: currentSession.config.provider,
      syncMode: currentSession.config.syncMode,
      error: "The translated audio track was received but could not be played."
    });
  });
}

async function requestClientSecret(config) {
  const response = await fetch(`${config.backendUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      showSourceTranscript: config.showSourceTranscript,
      installationId: config.installationId
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `The AutoTranslate backend returned ${response.status}.`);
  }

  if (!data.value || typeof data.value !== "string") {
    throw new Error("The backend did not return a valid short-lived OpenAI client secret.");
  }

  return data.value;
}

function handleRealtimeEvent(rawData, config) {
  let event;
  try {
    event = JSON.parse(rawData);
  } catch {
    return;
  }

  if (event.type === "session.output_transcript.delta" && event.delta) {
    notifyTranscript({
      tabId: config.tabId,
      kind: "target",
      delta: event.delta,
      elapsedMs: event.elapsed_ms
    });
  }

  if (event.type === "session.input_transcript.delta" && event.delta) {
    notifyTranscript({
      tabId: config.tabId,
      kind: "source",
      delta: event.delta,
      elapsedMs: event.elapsed_ms
    });
  }

  if (event.type === "error") {
    const message = event.error?.message || "The OpenAI realtime translation service returned an error.";
    notifyStatus("error", {
      tabId: config.tabId,
      outputMode: config.outputMode,
      provider: config.provider,
      syncMode: config.syncMode,
      error: message
    });
  }
}

async function stopSession({ notify }) {
  if (!session) {
    if (notify) notifyStatus("idle", {});
    return;
  }

  const oldSession = session;
  session = null;

  try { clearTimeout(oldSession.local?.segmentTimer); } catch {}
  try {
    if (oldSession.local?.recorder && oldSession.local.recorder.state !== "inactive") {
      oldSession.local.recorder.stop();
    }
  } catch {}
  try {
    if (oldSession.local?.currentAudio) {
      oldSession.local.currentAudio.pause();
      oldSession.local.currentAudio.remove();
    }
  } catch {}
  try { oldSession.events?.close(); } catch {}
  try { oldSession.peerConnection?.close(); } catch {}
  try { oldSession.sourceStream?.getTracks().forEach((track) => track.stop()); } catch {}
  try {
    if (oldSession.remoteAudio) {
      oldSession.remoteAudio.pause();
      oldSession.remoteAudio.srcObject = null;
      oldSession.remoteAudio.remove();
    }
  } catch {}
  try { await oldSession.audioContext?.close(); } catch {}

  if (notify) {
    notifyStatus("idle", {
      tabId: oldSession.config?.tabId ?? null,
      provider: oldSession.config?.provider
    });
  }
}

function notifyStatus(status, extra) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_STATUS",
    payload: { status, ...extra }
  }).catch(() => null);
}

function notifyTranscript(payload) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_TRANSCRIPT",
    payload
  }).catch(() => null);
}

function assertCurrentSession(expectedSession) {
  if (session !== expectedSession) {
    throw new DOMException("Translation start was cancelled.", "AbortError");
  }
}

function validateConfig(config) {
  if (!config?.streamId) throw new Error("Missing tab audio stream ID.");
  if (!config?.backendUrl) throw new Error("Missing AutoTranslate backend URL.");
  if (!config?.targetLanguage) throw new Error("Missing translation language.");
  if (!config?.tabId) throw new Error("Missing active tab ID.");
  if (!["openai", "ollama"].includes(config?.provider)) {
    throw new Error("Invalid translation provider.");
  }
  if (config.provider === "ollama" && !config.ollamaModel) {
    throw new Error("Choose an Ollama model before starting local translation.");
  }
  if (!["subtitles", "dub", "both"].includes(config?.outputMode)) {
    throw new Error("Invalid translation output mode.");
  }
  config.syncMode = normalizeSyncMode(config.syncMode);
  config.initialBufferSeconds = clampInitialBufferSeconds(config.initialBufferSeconds);
  validatePlaybackMode(config);
}

function isDubEnabled(outputMode) {
  return outputMode === "dub" || outputMode === "both";
}

function clampVolume(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function shouldMuteLiveOriginal(config) {
  return shouldActivateBufferedPlayer(config);
}

function createRequestTimeoutSignal(timeoutMs) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

function createLocalBackendError(status, data = {}) {
  const backendMessage = typeof data.error === "string" && data.error.trim()
    ? data.error.trim()
    : `The local translation backend returned HTTP ${status}.`;
  const prefix = status === 400
    ? "The recorded audio chunk was rejected"
    : status === 502
      ? "The local backend could not decode the recorded audio"
      : "The local translation backend failed";
  const error = new Error(`${prefix}: ${backendMessage}`);
  error.status = status;
  error.code = data.code;
  return error;
}

function logLocalChunkDiagnostic(event, payload) {
  console.debug("[AutoTranslate local audio]", event, payload);
}
