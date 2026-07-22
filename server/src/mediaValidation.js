export const INVALID_WEBM_HEADER_CODE = "INVALID_WEBM_HEADER";
export const EMPTY_AUDIO_CHUNK_CODE = "EMPTY_AUDIO_CHUNK";
export const INVALID_CHUNK_METADATA_CODE = "INVALID_CHUNK_METADATA";

const WEBM_EBML_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3];

export function validateUploadedAudioBody(body, contentType = "") {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw createValidationError(
      "The local pipeline did not receive a usable audio chunk.",
      EMPTY_AUDIO_CHUNK_CODE
    );
  }

  if (body.length < WEBM_EBML_SIGNATURE.length) {
    throw createValidationError(
      "The uploaded audio is too short to be a standalone WebM file.",
      INVALID_WEBM_HEADER_CODE
    );
  }

  if (isWebmContentType(contentType) && !hasWebmEbmlHeader(body)) {
    throw createValidationError(
      "The uploaded audio is not a standalone WebM file.",
      INVALID_WEBM_HEADER_CODE
    );
  }
}

export function isWebmContentType(contentType = "") {
  return /\bwebm\b/i.test(String(contentType));
}

export function hasWebmEbmlHeader(bytes) {
  if (!bytes || bytes.length < WEBM_EBML_SIGNATURE.length) return false;
  return WEBM_EBML_SIGNATURE.every((value, index) => bytes[index] === value);
}

export function sanitizeChunkMetadataHeader(value) {
  if (!value) return null;

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw createValidationError("Malformed chunk metadata.", INVALID_CHUNK_METADATA_CODE);
  }

  const metadata = {
    syncMode: parsed.syncMode === "buffered" ? "buffered" : "live",
    sequence: sanitizeInteger(parsed.sequence, 0, 1_000_000_000, "sequence"),
    generation: sanitizeInteger(parsed.generation, 0, 1_000_000, "generation"),
    captureStartEpochMs: sanitizeNumber(parsed.captureStartEpochMs, 0, 10_000_000_000_000, "captureStartEpochMs"),
    captureEndEpochMs: sanitizeNumber(parsed.captureEndEpochMs, 0, 10_000_000_000_000, "captureEndEpochMs"),
    videoStartMs: sanitizeNumber(parsed.videoStartMs, 0, 24 * 60 * 60 * 1000, "videoStartMs"),
    videoEndMs: sanitizeNumber(parsed.videoEndMs, 0, 24 * 60 * 60 * 1000, "videoEndMs"),
    playbackRate: sanitizeNumber(parsed.playbackRate, 0.25, 4, "playbackRate")
  };

  if (metadata.captureEndEpochMs < metadata.captureStartEpochMs) {
    throw createValidationError("Chunk capture end is before start.", INVALID_CHUNK_METADATA_CODE);
  }
  if (metadata.videoEndMs < metadata.videoStartMs) {
    throw createValidationError("Chunk media end is before start.", INVALID_CHUNK_METADATA_CODE);
  }

  return metadata;
}

function createValidationError(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function sanitizeInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw createValidationError(`Invalid ${name}.`, INVALID_CHUNK_METADATA_CODE);
  }
  return number;
}

function sanitizeNumber(value, min, max, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw createValidationError(`Invalid ${name}.`, INVALID_CHUNK_METADATA_CODE);
  }
  return number;
}
