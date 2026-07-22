import test from "node:test";
import assert from "node:assert/strict";
import {
  createChunkMetadata,
  createFinalizedAudioBlob,
  hasWebmEbmlHeader,
  pickAudioRecorderMimeType,
  validateStandaloneAudioBlob
} from "./local-chunks.js";

test("pickAudioRecorderMimeType chooses the first supported preferred type", () => {
  const fakeRecorder = {
    isTypeSupported(type) {
      return type === "audio/webm";
    }
  };

  assert.equal(pickAudioRecorderMimeType(fakeRecorder), "audio/webm");
});

test("pickAudioRecorderMimeType falls back to browser default when preferred types are unsupported", () => {
  const fakeRecorder = {
    isTypeSupported() {
      return false;
    }
  };

  assert.equal(pickAudioRecorderMimeType(fakeRecorder), "");
});

test("createFinalizedAudioBlob combines non-empty dataavailable pieces", async () => {
  const empty = new Blob([]);
  const first = new Blob([new Uint8Array([0x1a, 0x45])]);
  const second = new Blob([new Uint8Array([0xdf, 0xa3])]);
  const blob = createFinalizedAudioBlob([empty, first, second], "audio/webm");

  assert.equal(blob.size, 4);
  assert.equal(blob.type, "audio/webm");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x1a, 0x45, 0xdf, 0xa3]);
});

test("validateStandaloneAudioBlob accepts a standalone WebM EBML header", async () => {
  const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])], { type: "audio/webm" });
  await assert.doesNotReject(() => validateStandaloneAudioBlob(blob));
  assert.equal(hasWebmEbmlHeader(new Uint8Array(await blob.slice(0, 4).arrayBuffer())), true);
});

test("validateStandaloneAudioBlob rejects invalid WebM before upload", async () => {
  const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: "audio/webm" });
  await assert.rejects(
    () => validateStandaloneAudioBlob(blob),
    /not a standalone WebM/
  );
});

test("createChunkMetadata preserves sequence and generation", () => {
  const metadata = createChunkMetadata({
    syncMode: "live",
    sequence: 4,
    generation: 3,
    captureStartEpochMs: 1000,
    captureEndEpochMs: 4000,
    videoStartMs: 10,
    videoEndMs: 3010,
    playbackRate: 1
  });

  assert.equal(metadata.sequence, 4);
  assert.equal(metadata.generation, 3);
  assert.equal(metadata.captureEndEpochMs, 4000);
});

test("recording can continue while previous HTTP work is pending", async () => {
  const events = [];
  const pendingUpload = new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
    events.push("upload-finished");
  });
  events.push("next-recording-started");
  await pendingUpload;

  assert.deepEqual(events, ["next-recording-started", "upload-finished"]);
});
