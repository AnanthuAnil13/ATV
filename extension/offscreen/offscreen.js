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
import "../shared/media-timeline.js";
import {
  advanceLocalGeneration,
  shouldDiscardRecordedChunk,
  shouldIgnoreBackendResult
} from "./local-timeline-state.js";

const timeline = globalThis.AutoTranslateMediaTimeline;

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

  if (message.type === "OFFSCREEN_TIMELINE_EVENT") {
    handleOffscreenTimelineEvent(message.payload).catch(console.error);
    sendResponse({ ok: true });
    return false;
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
    activeRecording: null,
    segmentTimer: null,
    timelineRetryTimer: null,
    queue: [],
    processing: false,
    startedAt: performance.now(),
    generation: 0,
    sequence: 0,
    bufferedTimelineEnabled: shouldActivateBufferedPlayer(currentSession.config),
    bufferedSessionId: currentSession.config.bufferedSessionId || "",
    paused: false,
    seeking: false,
    ended: false,
    startingRecording: false,
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
  if (shouldUseBufferedTimeline(currentSession)) {
    startNextBufferedLocalRecording(currentSession).catch((error) => {
      if (isTimelineTemporarilyUnavailable(error)) {
        scheduleTimelineRecordingRetry(currentSession);
      } else {
        failLocalSession(currentSession, error);
      }
    });
    return;
  }
  startNextLiveLocalRecording(currentSession);
}

function startNextLiveLocalRecording(currentSession) {
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

async function startNextBufferedLocalRecording(currentSession) {
  const local = currentSession.local;
  if (session !== currentSession || !local || !local.bufferedTimelineEnabled) return;
  if (local.startingRecording || local.recorder) return;
  if (local.paused || local.seeking || local.ended) return;
  if (currentSession.sourceTrack.readyState !== "live") return;

  local.startingRecording = true;
  let startSnapshot;
  try {
    startSnapshot = await requestBufferedTimelineSnapshot(currentSession, "chunk-start");
  } finally {
    local.startingRecording = false;
  }
  if (session !== currentSession || !currentSession.local) return;
  if (startSnapshot.paused || startSnapshot.seeking || startSnapshot.ended) {
    local.paused = startSnapshot.paused;
    local.seeking = startSnapshot.seeking;
    local.ended = startSnapshot.ended;
    return;
  }
  applyBufferedTimelineSnapshot(currentSession, startSnapshot);

  const chunks = [];
  const captureStartEpochMs = Date.now();
  const sequence = local.sequence++;
  const generation = local.generation;
  const recorderOptions = {
    audioBitsPerSecond: 96_000
  };
  if (local.mimeType) {
    recorderOptions.mimeType = local.mimeType;
  }

  const recorder = new MediaRecorder(currentSession.sourceStream, recorderOptions);
  const activeRecording = {
    recorder,
    chunks,
    startSnapshot,
    captureStartEpochMs,
    sequence,
    generation,
    discardReason: ""
  };
  local.recorder = recorder;
  local.activeRecording = activeRecording;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) chunks.push(event.data);
  });

  recorder.addEventListener("error", (event) => {
    failLocalSession(currentSession, event.error || new Error("Local audio recording failed."));
  });

  recorder.addEventListener("stop", () => {
    finishBufferedLocalRecording(currentSession, activeRecording, recorder)
      .catch((error) => failLocalSession(currentSession, error));
  }, { once: true });

  recorder.start();
  local.segmentTimer = setTimeout(() => {
    if (session === currentSession && recorder.state === "recording") recorder.stop();
  }, local.chunkMs);
}

async function finishBufferedLocalRecording(currentSession, activeRecording, recorder) {
  if (session !== currentSession || !currentSession.local) return;
  const local = currentSession.local;
  clearTimeout(local.segmentTimer);
  if (local.activeRecording === activeRecording) local.activeRecording = null;
  if (local.recorder === recorder) local.recorder = null;

  const captureEndEpochMs = Date.now();
  const shouldRestart = !local.paused && !local.seeking && !local.ended;
  let endSnapshot = null;
  if (!activeRecording.discardReason) {
    try {
      endSnapshot = await requestBufferedTimelineSnapshot(currentSession, "chunk-end");
      applyBufferedTimelineSnapshot(currentSession, endSnapshot);
    } catch (error) {
      activeRecording.discardReason = "timeline-snapshot-unavailable";
    }
  }

  const discardReason = activeRecording.discardReason || shouldDiscardRecordedChunk({
    startSnapshot: activeRecording.startSnapshot,
    endSnapshot,
    captureStartEpochMs: activeRecording.captureStartEpochMs,
    captureEndEpochMs,
    timeline
  });

  if (shouldRestart) startNextLocalRecording(currentSession);
  if (discardReason) {
    logLocalChunkDiagnostic("recorded_audio_chunk_discarded", {
      reason: discardReason,
      generation: activeRecording.generation,
      sequence: activeRecording.sequence,
      bufferedSessionIdPrefix: local.bufferedSessionId.slice(0, 8)
    });
    return;
  }

  const blob = createFinalizedAudioBlob(activeRecording.chunks, recorder.mimeType || local.mimeType);
  const metadata = createChunkMetadata({
    syncMode: "buffered",
    sequence: activeRecording.sequence,
    generation: activeRecording.generation,
    captureStartEpochMs: activeRecording.captureStartEpochMs,
    captureEndEpochMs,
    videoStartMs: activeRecording.startSnapshot.sourceTimeMs,
    videoEndMs: endSnapshot.sourceTimeMs,
    playbackRate: activeRecording.startSnapshot.playbackRate
  });

  validateAndEnqueueLocalChunk(currentSession, blob, metadata)
    .catch((error) => failLocalSession(currentSession, error));
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

async function handleOffscreenTimelineEvent(payload = {}) {
  const currentSession = session;
  if (!currentSession?.local?.bufferedTimelineEnabled) return;
  const snapshot = timeline.normalizeTimelineSnapshot(payload);
  if (!snapshot || snapshot.sessionId !== currentSession.local.bufferedSessionId) return;
  applyBufferedTimelineSnapshot(currentSession, snapshot);
}

function applyBufferedTimelineSnapshot(currentSession, snapshot) {
  const local = currentSession.local;
  if (!local?.bufferedTimelineEnabled || snapshot.sessionId !== local.bufferedSessionId) return;

  const generationChanged = advanceLocalGeneration(local, snapshot.generation);
  local.paused = snapshot.paused;
  local.seeking = snapshot.seeking;
  local.ended = snapshot.ended;

  if (generationChanged) {
    stopCurrentLocalDub(currentSession);
    stopActiveBufferedRecording(currentSession, "generation-changed");
  }

  if (snapshot.eventType === "seeking" || snapshot.eventType === "timeline-jump-start") {
    local.seeking = true;
    stopActiveBufferedRecording(currentSession, "seeking");
  } else if (snapshot.eventType === "pause") {
    stopActiveBufferedRecording(currentSession, "");
  } else if (snapshot.eventType === "ratechange") {
    stopActiveBufferedRecording(currentSession, "playback-rate-changed");
  }

  if (!local.paused && !local.seeking && !local.ended && !local.recorder && !local.activeRecording) {
    startNextLocalRecording(currentSession);
  }
}

function stopActiveBufferedRecording(currentSession, discardReason) {
  const local = currentSession.local;
  const active = local?.activeRecording;
  const recorder = local?.recorder;
  if (!active || !recorder) return;
  if (discardReason) active.discardReason = discardReason;
  clearTimeout(local.segmentTimer);
  try {
    if (recorder.state === "recording" || recorder.state === "paused") recorder.stop();
  } catch {}
}

function stopCurrentLocalDub(currentSession) {
  const local = currentSession.local;
  if (!local) return;
  local.audioQueue = [];
  try {
    if (local.currentAudio) {
      local.currentAudio.pause();
      local.currentAudio.removeAttribute("src");
      local.currentAudio.remove();
    }
  } catch {}
  local.currentAudio = null;
  local.audioPlaying = false;
}

async function requestBufferedTimelineSnapshot(currentSession, eventType) {
  const local = currentSession.local;
  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_TIMELINE_SNAPSHOT_REQUEST",
    payload: {
      tabId: currentSession.config.tabId,
      bufferedSessionId: local.bufferedSessionId,
      eventType
    }
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Timeline snapshot unavailable.");
  }
  const snapshot = timeline.normalizeTimelineSnapshot(response.snapshot);
  if (!snapshot) throw new Error("Timeline snapshot unavailable.");
  if (snapshot.sessionId !== local.bufferedSessionId) {
    throw new Error("Buffered session ID mismatch.");
  }
  if (timeline.isStaleTimelineSnapshot(snapshot, {
    sessionId: local.bufferedSessionId,
    generation: local.generation
  })) {
    throw new Error("Stale timeline snapshot.");
  }
  return snapshot;
}

function scheduleTimelineRecordingRetry(currentSession) {
  const local = currentSession.local;
  if (!local || local.timelineRetryTimer || session !== currentSession) return;
  local.timelineRetryTimer = setTimeout(() => {
    if (currentSession.local) currentSession.local.timelineRetryTimer = null;
    startNextLocalRecording(currentSession);
  }, 250);
}

function isTimelineTemporarilyUnavailable(error) {
  return /timeline snapshot unavailable|stale timeline snapshot|receiving end does not exist|could not establish connection/i.test(error?.message || "");
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
      let result;
      try {
        result = await requestLocalTranslation(currentSession.config, item);
      } catch (error) {
        if (item.metadata.generation !== local.generation) continue;
        throw error;
      }
      assertCurrentSession(currentSession);
      if (shouldIgnoreBackendResult(local, item, result)) continue;
      if (result.empty) continue;

      const elapsedMs = item.metadata.syncMode === "buffered"
        ? item.metadata.videoEndMs
        : Math.round(performance.now() - local.startedAt);
      if (shouldUseBufferedSubtitleSegments(currentSession.config)) {
        const translatedSegments = normalizeBufferedSubtitleSegments(result, item, currentSession);
        if (translatedSegments.length) {
          notifyBufferedSubtitleSegments({
            tabId: currentSession.config.tabId,
            bufferedSessionId: local.bufferedSessionId,
            generation: item.metadata.generation,
            sequence: item.metadata.sequence,
            translatedSegments
          });
        }
      } else {
        if (result.sourceText) {
          notifyTranscript({
            tabId: currentSession.config.tabId,
            kind: "source",
            delta: result.sourceText,
            generation: item.metadata.generation,
            elapsedMs,
            replace: true
          });
        }
        if (result.translatedText) {
          notifyTranscript({
            tabId: currentSession.config.tabId,
            kind: "target",
            delta: result.translatedText,
            generation: item.metadata.generation,
            elapsedMs,
            replace: true
          });
        }
      }
      if (isDubEnabled(currentSession.config.outputMode)) {
        if (shouldUseBufferedTimedDubClips(currentSession.config)) {
          notePreparedTimedDubClips(result, item);
          continue;
        }

        const dubClips = Array.isArray(result.dubClips) ? result.dubClips : [];
        if (dubClips.length) {
          for (const clip of dubClips) {
            if (clip?.audioBase64) {
              enqueueLocalDub(currentSession, {
                generation: item.metadata.generation,
                audioBase64: clip.audioBase64,
                mimeType: clip.audioMime || "audio/wav",
                speakerId: clip.speakerId,
                translatedText: clip.translatedText
              });
            }
          }
        } else if (result.audioBase64) {
          enqueueLocalDub(currentSession, {
            generation: item.metadata.generation,
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
  if (clip.generation !== undefined && clip.generation !== local.generation) return;
  if (local.audioQueue.length >= local.maxAudioQueue) local.audioQueue.shift();
  local.audioQueue.push(clip);
  playNextLocalDub(currentSession);
}

function playNextLocalDub(currentSession) {
  const local = currentSession.local;
  if (!local || local.audioPlaying || session !== currentSession) return;
  const next = local.audioQueue.shift();
  if (!next) return;
  if (next.generation !== undefined && next.generation !== local.generation) {
    playNextLocalDub(currentSession);
    return;
  }

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
  try { clearTimeout(oldSession.local?.timelineRetryTimer); } catch {}
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
  await endLocalBackendSession(oldSession.config).catch(() => null);

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

async function endLocalBackendSession(config) {
  if (config?.provider !== "ollama" || !config.backendUrl || !config.localSessionId) return;
  await fetch(`${config.backendUrl}/local/session/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: config.localSessionId }),
    keepalive: true
  }).catch(() => null);
}

function notifyTranscript(payload) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_TRANSCRIPT",
    payload
  }).catch(() => null);
}

function notifyBufferedSubtitleSegments(payload) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_BUFFERED_SUBTITLE_SEGMENTS",
    payload
  }).catch(() => null);
}

function shouldUseBufferedSubtitleSegments(config) {
  return config?.provider === "ollama" &&
    config?.syncMode === "buffered" &&
    (config?.outputMode === "subtitles" || config?.outputMode === "both");
}

function shouldUseBufferedTimedDubClips(config) {
  return config?.provider === "ollama" &&
    config?.syncMode === "buffered" &&
    (config?.outputMode === "dub" || config?.outputMode === "both");
}

function notePreparedTimedDubClips(result, item) {
  const clips = Array.isArray(result?.timedDubClips) ? result.timedDubClips : [];
  if (!clips.length) return;
  console.debug("[AutoTranslate offscreen] timed dub clips prepared", {
    generation: item.metadata.generation,
    sequence: item.metadata.sequence,
    clipCount: clips.length,
    firstStartMs: finiteDebugNumber(clips[0]?.startMs),
    lastEndMs: finiteDebugNumber(clips.at(-1)?.endMs)
  });
}

function normalizeBufferedSubtitleSegments(result, item, currentSession) {
  const local = currentSession.local;
  if (!Array.isArray(result?.translatedSegments)) {
    throw new Error("The local backend did not return timed translated subtitle segments.");
  }
  if (Array.isArray(result.transcriptSegments) && result.translatedSegments.length !== result.transcriptSegments.length) {
    throw new Error("The local backend returned mismatched subtitle segment counts.");
  }
  if (!result.translatedSegments.length && result.translatedText) {
    throw new Error("The local backend returned translated text without timed subtitle segments.");
  }
  if (Number(result.generation) !== item.metadata.generation || Number(result.sequence) !== item.metadata.sequence) {
    throw new Error("The local backend returned subtitle segments for the wrong chunk.");
  }

  const seenIds = new Set();
  return result.translatedSegments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const startMs = Number(segment?.startMs);
    const endMs = Number(segment?.endMs);
    const translatedText = segment?.translatedText;
    if (!id) throw new Error("The local backend returned a subtitle segment without an ID.");
    if (seenIds.has(id)) throw new Error("The local backend returned duplicate subtitle segment IDs.");
    seenIds.add(id);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
      throw new Error("The local backend returned invalid subtitle segment timing.");
    }
    if (typeof translatedText !== "string") {
      throw new Error("The local backend returned invalid subtitle segment text.");
    }

    const normalized = {
      id,
      bufferedSessionId: local.bufferedSessionId,
      generation: item.metadata.generation,
      sequence: item.metadata.sequence,
      startMs,
      endMs,
      translatedText
    };
    if (currentSession.config.showSourceTranscript && typeof segment.sourceText === "string") {
      normalized.sourceText = segment.sourceText;
    }
    return normalized;
  });
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
  if (shouldActivateBufferedPlayer(config) && !config.bufferedSessionId) {
    throw new Error("Missing buffered playback session ID.");
  }
}

function isDubEnabled(outputMode) {
  return outputMode === "dub" || outputMode === "both";
}

function finiteDebugNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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

function shouldUseBufferedTimeline(currentSession) {
  return currentSession.config.provider === "ollama" &&
    currentSession.local?.bufferedTimelineEnabled === true;
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
