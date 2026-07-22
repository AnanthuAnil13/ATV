import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_AUDIO_CHUNK_CODE,
  INVALID_WEBM_HEADER_CODE,
  hasWebmEbmlHeader,
  sanitizeChunkMetadataHeader,
  validateUploadedAudioBody
} from "../src/mediaValidation.js";

const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);

test("hasWebmEbmlHeader accepts a valid EBML signature", () => {
  assert.equal(hasWebmEbmlHeader(EBML), true);
});

test("hasWebmEbmlHeader rejects an invalid EBML signature", () => {
  assert.equal(hasWebmEbmlHeader(Buffer.from([0, 1, 2, 3])), false);
});

test("validateUploadedAudioBody rejects an empty body", () => {
  assert.throws(
    () => validateUploadedAudioBody(Buffer.alloc(0), "audio/webm"),
    (error) => error.statusCode === 400 && error.code === EMPTY_AUDIO_CHUNK_CODE
  );
});

test("validateUploadedAudioBody rejects a body shorter than four bytes", () => {
  assert.throws(
    () => validateUploadedAudioBody(Buffer.from([0x1a, 0x45, 0xdf]), "audio/webm"),
    (error) => error.statusCode === 400 && error.code === INVALID_WEBM_HEADER_CODE
  );
});

test("validateUploadedAudioBody rejects WebM content with an invalid signature", () => {
  assert.throws(
    () => validateUploadedAudioBody(Buffer.from([0, 1, 2, 3, 4]), "audio/webm;codecs=opus"),
    (error) => error.statusCode === 400 && error.code === INVALID_WEBM_HEADER_CODE
  );
});

test("validateUploadedAudioBody accepts WebM content with a valid signature", () => {
  assert.doesNotThrow(() => validateUploadedAudioBody(EBML, "audio/webm"));
});

test("validateUploadedAudioBody does not apply WebM validation to non-WebM content", () => {
  assert.doesNotThrow(() => validateUploadedAudioBody(Buffer.from([0, 1, 2, 3, 4]), "audio/ogg"));
});

test("invalid WebM is rejected before ffmpeg would be invoked", () => {
  assert.throws(
    () => {
      validateUploadedAudioBody(Buffer.from([0, 1, 2, 3, 4]), "audio/webm");
      throw new Error("ffmpeg invoked");
    },
    (error) => error.code === INVALID_WEBM_HEADER_CODE
  );
});

test("sanitizeChunkMetadataHeader preserves sequence and generation metadata", () => {
  const metadata = sanitizeChunkMetadataHeader(JSON.stringify({
    syncMode: "live",
    sequence: 7,
    generation: 2,
    captureStartEpochMs: 1000,
    captureEndEpochMs: 5500,
    videoStartMs: 120,
    videoEndMs: 4620,
    playbackRate: 1
  }));

  assert.equal(metadata.sequence, 7);
  assert.equal(metadata.generation, 2);
  assert.equal(metadata.videoEndMs, 4620);
});
