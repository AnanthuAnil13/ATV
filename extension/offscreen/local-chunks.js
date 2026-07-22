const WEBM_EBML_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3];

export function pickAudioRecorderMimeType(mediaRecorder = globalThis.MediaRecorder) {
  const preferredTypes = [
    "audio/webm;codecs=opus",
    "audio/webm"
  ];

  if (!mediaRecorder || typeof mediaRecorder.isTypeSupported !== "function") return "";
  return preferredTypes.find((type) => mediaRecorder.isTypeSupported(type)) || "";
}

export function createFinalizedAudioBlob(parts, mimeType) {
  const nonEmptyParts = Array.isArray(parts)
    ? parts.filter((part) => part?.size > 0)
    : [];
  return new Blob(nonEmptyParts, mimeType ? { type: mimeType } : undefined);
}

export function createChunkMetadata({
  syncMode = "live",
  sequence,
  generation,
  captureStartEpochMs,
  captureEndEpochMs,
  videoStartMs,
  videoEndMs,
  playbackRate = 1
}) {
  return {
    syncMode,
    sequence: toInteger(sequence, 0),
    generation: toInteger(generation, 0),
    captureStartEpochMs: toFiniteNumber(captureStartEpochMs, 0),
    captureEndEpochMs: toFiniteNumber(captureEndEpochMs, 0),
    videoStartMs: toFiniteNumber(videoStartMs, 0),
    videoEndMs: toFiniteNumber(videoEndMs, 0),
    playbackRate: toFiniteNumber(playbackRate, 1)
  };
}

export async function validateStandaloneAudioBlob(blob) {
  if (!blob?.size) {
    throw new Error("Recorded audio chunk is empty.");
  }

  if (isWebmMimeType(blob.type)) {
    const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (!hasWebmEbmlHeader(header)) {
      const error = new Error("Recorded audio chunk is not a standalone WebM file.");
      error.code = "INVALID_WEBM_HEADER";
      error.headerHex = bytesToHex(header);
      throw error;
    }
  }
}

export async function audioBlobDiagnostics(blob, metadata) {
  const header = blob?.size ? new Uint8Array(await blob.slice(0, 4).arrayBuffer()) : new Uint8Array();
  return {
    sequence: metadata?.sequence,
    generation: metadata?.generation,
    size: blob?.size || 0,
    mimeType: blob?.type || "",
    firstBytesHex: bytesToHex(header),
    captureStartEpochMs: metadata?.captureStartEpochMs,
    captureEndEpochMs: metadata?.captureEndEpochMs,
    videoStartMs: metadata?.videoStartMs,
    videoEndMs: metadata?.videoEndMs
  };
}

export function hasWebmEbmlHeader(bytes) {
  return WEBM_EBML_SIGNATURE.every((value, index) => bytes?.[index] === value);
}

export function isWebmMimeType(mimeType = "") {
  return /\bwebm\b/i.test(String(mimeType));
}

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function toInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
