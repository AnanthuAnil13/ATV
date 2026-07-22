import test from "node:test";
import assert from "node:assert/strict";
import {
  WHISPER_JSON_INVALID,
  WHISPER_JSON_SCHEMA_UNSUPPORTED,
  buildChunkTimingResponseFields,
  buildTranscriptSegmentResponse,
  buildTranscriptionFromWhisperJson,
  buildWhisperSegmentId,
  mapWhisperSegmentsToVideoTimeline,
  normalizeWhisperSegments,
  parseWhisperJson,
  parseWhisperTimestamp
} from "../src/whisperSegments.js";

function fixture(transcription, extra = {}) {
  return {
    result: { language: "en" },
    transcription,
    ...extra
  };
}

function segment({ from = 0, to = 1000, text = "Hello", timestamps } = {}) {
  return {
    offsets: { from, to },
    timestamps: timestamps ?? { from: "00:00:00,000", to: "00:00:01,000" },
    text
  };
}

function metadata(overrides = {}) {
  return {
    syncMode: "buffered",
    generation: 2,
    sequence: 4,
    captureStartEpochMs: 1_000,
    captureEndEpochMs: 5_500,
    videoStartMs: 120_000,
    videoEndMs: 124_500,
    playbackRate: 1,
    ...overrides
  };
}

test("normalizes numeric Whisper offsets as milliseconds", () => {
  const [normalized] = normalizeWhisperSegments(fixture([
    segment({ from: 250, to: 1750, text: "Hello there." })
  ]));

  assert.deepEqual(normalized, {
    index: 0,
    text: "Hello there.",
    relativeStartMs: 250,
    relativeEndMs: 1750
  });
});

test("falls back to Whisper timestamp strings when numeric offsets are absent", () => {
  const [normalized] = normalizeWhisperSegments(fixture([
    {
      timestamps: { from: "00:00:02,500", to: "00:00:03,750" },
      text: "Timestamped speech."
    }
  ]));

  assert.equal(normalized.relativeStartMs, 2500);
  assert.equal(normalized.relativeEndMs, 3750);
});

test("does not treat string offsets with unknown units as milliseconds", () => {
  const [normalized] = normalizeWhisperSegments(fixture([
    {
      offsets: { from: "250", to: "1750" },
      timestamps: { from: "00:00:03,000", to: "00:00:04,000" },
      text: "Use timestamp fallback."
    }
  ]));

  assert.equal(normalized.relativeStartMs, 3000);
  assert.equal(normalized.relativeEndMs, 4000);
});

test("parses Whisper timestamp strings", () => {
  assert.equal(parseWhisperTimestamp("00:00:00,000"), 0);
  assert.equal(parseWhisperTimestamp("00:01:02,500"), 62_500);
  assert.equal(parseWhisperTimestamp("01:02:03,250"), 3_723_250);
});

test("handles an empty Whisper transcription array", () => {
  const transcription = buildTranscriptionFromWhisperJson(fixture([]));

  assert.equal(transcription.text, "");
  assert.equal(transcription.durationMs, 0);
  assert.deepEqual(transcription.segments, []);
});

test("filters empty and known non-speech segments", () => {
  const normalized = normalizeWhisperSegments(fixture([
    segment({ text: "   " }),
    segment({ text: "[BLANK_AUDIO]" }),
    segment({ text: "[SILENCE]" }),
    segment({ text: "[MUSIC]" }),
    segment({ text: "[NOISE]" }),
    segment({ text: "Speech remains." })
  ]));

  assert.deepEqual(normalized.map((item) => item.text), ["Speech remains."]);
});

test("preserves Unicode transcript text", () => {
  const transcription = buildTranscriptionFromWhisperJson(fixture([
    segment({ from: 0, to: 1000, text: "こんにちは、世界。" }),
    segment({ from: 1100, to: 2000, text: "Café déjà vu." })
  ]));

  assert.equal(transcription.text, "こんにちは、世界。 Café déjà vu.");
});

test("rejects invalid JSON", () => {
  assert.throws(
    () => parseWhisperJson("{not-json"),
    (error) => error.code === WHISPER_JSON_INVALID
  );
});

test("rejects unsupported Whisper JSON schema", () => {
  assert.throws(
    () => normalizeWhisperSegments({ result: { language: "en" }, segments: [] }),
    (error) => error.code === WHISPER_JSON_SCHEMA_UNSUPPORTED
  );
});

test("skips malformed individual segments without failing the whole transcript", () => {
  const normalized = normalizeWhisperSegments(fixture([
    null,
    { offsets: { from: Number.NaN, to: 100 }, text: "bad" },
    { timestamps: { from: "bad", to: "00:00:01,000" }, text: "bad" },
    segment({ from: 100, to: 600, text: "good" })
  ]));

  assert.deepEqual(normalized.map((item) => item.text), ["good"]);
});

test("sorts segments by start time with stable ordering for equal starts", () => {
  const normalized = normalizeWhisperSegments(fixture([
    segment({ from: 500, to: 1000, text: "third" }),
    segment({ from: 100, to: 400, text: "first" }),
    segment({ from: 100, to: 500, text: "second" })
  ]));

  assert.deepEqual(normalized.map((item) => item.text), ["first", "second", "third"]);
  assert.deepEqual(normalized.map((item) => item.index), [0, 1, 2]);
});

test("rejects segments whose end is not after start", () => {
  const normalized = normalizeWhisperSegments(fixture([
    segment({ from: 500, to: 500, text: "equal" }),
    segment({ from: 800, to: 700, text: "backward" }),
    segment({ from: 900, to: 1200, text: "valid" })
  ]));

  assert.deepEqual(normalized.map((item) => item.text), ["valid"]);
});

test("reconstructs whole sourceText from normalized segments", () => {
  const transcription = buildTranscriptionFromWhisperJson(fixture([
    segment({ from: 1000, to: 1200, text: "world" }),
    segment({ from: 0, to: 800, text: "Hello" })
  ]));

  assert.equal(transcription.text, "Hello world");
});

test("builds deterministic segment IDs from generation, sequence, and segment index", () => {
  assert.equal(buildWhisperSegmentId(metadata({ generation: 7, sequence: 11 }), 3), "g7-q11-s3");
});

test("maps segment times at 1x using the video-span to capture-span ratio", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 250, to: 1750 })
  ]));
  const [mapped] = mapWhisperSegmentsToVideoTimeline(segments, metadata());

  assert.equal(mapped.startMs, 120_250);
  assert.equal(mapped.endMs, 121_750);
});

test("maps segment times at 2x using the actual video span", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 1000, to: 3000 })
  ]));
  const [mapped] = mapWhisperSegmentsToVideoTimeline(segments, metadata({
    captureStartEpochMs: 10_000,
    captureEndEpochMs: 14_500,
    videoStartMs: 50_000,
    videoEndMs: 59_000,
    playbackRate: 2
  }));

  assert.equal(mapped.startMs, 52_000);
  assert.equal(mapped.endMs, 56_000);
});

test("maps segment times at 0.5x using the actual video span", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 1000, to: 3000 })
  ]));
  const [mapped] = mapWhisperSegmentsToVideoTimeline(segments, metadata({
    captureStartEpochMs: 10_000,
    captureEndEpochMs: 14_500,
    videoStartMs: 50_000,
    videoEndMs: 52_250,
    playbackRate: 0.5
  }));

  assert.equal(mapped.startMs, 50_500);
  assert.equal(mapped.endMs, 51_500);
});

test("prefers measured video-span ratio over playbackRate", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 500, to: 900 })
  ]));
  const [mapped] = mapWhisperSegmentsToVideoTimeline(segments, metadata({
    captureStartEpochMs: 0,
    captureEndEpochMs: 1000,
    videoStartMs: 10_000,
    videoEndMs: 13_000,
    playbackRate: 1
  }));

  assert.equal(mapped.startMs, 11_500);
  assert.equal(mapped.endMs, 12_700);
});

test("falls back to playbackRate when capture duration is invalid", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 1000, to: 2000 })
  ]));
  const [mapped] = mapWhisperSegmentsToVideoTimeline(segments, metadata({
    captureStartEpochMs: 1000,
    captureEndEpochMs: 1000,
    videoStartMs: 10_000,
    videoEndMs: 20_000,
    playbackRate: 2
  }));

  assert.equal(mapped.startMs, 12_000);
  assert.equal(mapped.endMs, 14_000);
});

test("clamps mapped segments to chunk video bounds", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 4000, to: 6000 })
  ]));
  const [mapped] = mapWhisperSegmentsToVideoTimeline(segments, metadata());

  assert.equal(mapped.startMs, 124_000);
  assert.equal(mapped.endMs, 124_500);
});

test("does not emit NaN or Infinity in mapped output", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 1000, to: 2000 }),
    { offsets: { from: Number.POSITIVE_INFINITY, to: 2500 }, text: "bad" },
    { offsets: { from: 3000, to: Number.NaN }, text: "bad" }
  ]));
  const mapped = mapWhisperSegmentsToVideoTimeline(segments, metadata());

  assert.equal(mapped.length, 1);
  assert.ok(Number.isFinite(mapped[0].startMs));
  assert.ok(Number.isFinite(mapped[0].endMs));
});

test("omits sourceText from segment responses when source transcripts are hidden", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 250, to: 1750, text: "Hidden source." })
  ]));
  const [response] = buildTranscriptSegmentResponse({
    segments,
    metadata: metadata(),
    showSourceTranscript: false
  });

  assert.deepEqual(Object.keys(response).sort(), ["endMs", "id", "startMs"]);
});

test("includes sourceText in segment responses when source transcripts are shown", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 250, to: 1750, text: "Visible source." })
  ]));
  const [response] = buildTranscriptSegmentResponse({
    segments,
    metadata: metadata(),
    showSourceTranscript: true
  });

  assert.equal(response.sourceText, "Visible source.");
});

test("uses relative timing fields when source-video metadata is unavailable", () => {
  const segments = normalizeWhisperSegments(fixture([
    segment({ from: 250, to: 1750, text: "Live fallback." })
  ]));
  const [response] = buildTranscriptSegmentResponse({
    segments,
    metadata: null,
    showSourceTranscript: false
  });

  assert.equal(response.relativeStartMs, 250);
  assert.equal(response.relativeEndMs, 1750);
  assert.equal("startMs" in response, false);
  assert.equal("endMs" in response, false);
});

test("empty normalized transcript produces no segment response", () => {
  const transcription = buildTranscriptionFromWhisperJson(fixture([
    segment({ text: "[NOISE]" })
  ]));

  assert.equal(transcription.text, "");
  assert.deepEqual(buildTranscriptSegmentResponse({
    segments: transcription.segments,
    metadata: metadata(),
    showSourceTranscript: true
  }), []);
});

test("keeps existing chunk-level timing response fields available", () => {
  assert.deepEqual(buildChunkTimingResponseFields(metadata({
    generation: 9,
    sequence: 12,
    videoStartMs: 3000,
    videoEndMs: 7000
  })), {
    sequence: 12,
    generation: 9,
    chunkStartMs: 3000,
    chunkEndMs: 7000
  });
});
