import test from "node:test";
import assert from "node:assert/strict";
import {
  OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID,
  OLLAMA_DUB_SPEAKER_ID_INVALID,
  OLLAMA_DUB_SPEAKER_JSON_INVALID,
  PIPER_WAV_DURATION_INVALID,
  PIPER_WAV_INVALID,
  TIMED_DUB_TIMING_UNAVAILABLE,
  buildTimedDubClipResponse,
  buildTimedDubSpeakerOllamaPayload,
  buildTimedDubSpeakerRequest,
  buildTimedDubSynthesisPlan,
  calculateTargetWindowDurationMs,
  determineTimedDubMode,
  mergeTimedDubSegments,
  normalizeSpeakerId,
  normalizeTimedDubSpeakerAssignments,
  parseWavDurationMs,
  resolveTimedDubSpeakersWithRetry,
  safePublicVoiceId,
  validateTimedDubSpeakerAlignment
} from "../src/timedDubSegments.js";
import {
  buildEmptyLocalChunkResponse,
  buildLocalChunkSuccessResponse
} from "../src/translatedSegments.js";

function mappedSegments() {
  return [
    {
      id: "g2-q4-s0",
      startMs: 120_250,
      endMs: 121_900,
      sourceText: "今日はいい天気ですね。",
      translatedText: "The weather is nice today."
    },
    {
      id: "g2-q4-s1",
      startMs: 122_050,
      endMs: 124_100,
      sourceText: "散歩に行きましょう。",
      translatedText: "Let's go for a walk."
    }
  ];
}

function relativeSegments() {
  return [
    {
      id: "g2-q4-s0",
      relativeStartMs: 250,
      relativeEndMs: 1900,
      sourceText: "今日はいい天気ですね。",
      translatedText: "The weather is nice today."
    }
  ];
}

function speakerOutput() {
  return {
    segments: [
      { id: "g2-q4-s0", speakerId: "speaker_1" },
      { id: "g2-q4-s1", speakerId: "speaker_2" }
    ]
  };
}

function mergeSegments(segments = mappedSegments(), assignments = speakerOutput().segments) {
  return mergeTimedDubSegments({
    translatedSegments: segments,
    speakerAssignments: assignments,
    generation: 2,
    sequence: 4
  });
}

function wavBuffer({
  sampleRate = 16_000,
  channels = 1,
  bitsPerSample = 16,
  durationMs = 1000,
  byteRate = null,
  extraChunks = []
} = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const effectiveByteRate = byteRate ?? sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = Math.max(1, Math.round((sampleRate * channels * bytesPerSample * durationMs) / 1000));
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(effectiveByteRate, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);
  const data = Buffer.alloc(dataSize);
  const chunks = [
    ...extraChunks.map(([id, payload]) => makeChunk(id, Buffer.from(payload))),
    makeChunk("fmt ", fmt),
    makeChunk("data", data)
  ];
  const riffSize = 4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return Buffer.concat([
    Buffer.from("RIFF"),
    uint32(riffSize),
    Buffer.from("WAVE"),
    ...chunks
  ]);
}

function makeChunk(id, payload) {
  const pad = payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(id), uint32(payload.length), payload, pad]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function clipFor(segment, overrides = {}) {
  const audio = wavBuffer({ durationMs: overrides.audioDurationMs ?? 1000 });
  return buildTimedDubClipResponse({
    segment,
    voice: overrides.voice ?? { id: "en_US-lessac-medium", model: "/private/en_US-lessac-medium.onnx" },
    audioBuffer: audio,
    audioDurationMs: parseWavDurationMs(audio),
    audioMime: "audio/wav"
  });
}

test("valid speaker assignment alignment", () => {
  const assignments = normalizeTimedDubSpeakerAssignments(speakerOutput(), mappedSegments());

  assert.deepEqual(assignments, [
    { id: "g2-q4-s0", index: 0, speakerId: "speaker_1" },
    { id: "g2-q4-s1", index: 1, speakerId: "speaker_2" }
  ]);
});

test("out-of-order model output is restored to canonical order", () => {
  const assignments = normalizeTimedDubSpeakerAssignments({
    segments: [
      { id: "g2-q4-s1", speakerId: "speaker_2" },
      { id: "g2-q4-s0", speakerId: "speaker_1" }
    ]
  }, mappedSegments());

  assert.deepEqual(assignments.map((item) => item.id), ["g2-q4-s0", "g2-q4-s1"]);
});

test("missing speaker segment ID is rejected", () => {
  assert.throws(
    () => validateTimedDubSpeakerAlignment(mappedSegments(), [
      { id: "g2-q4-s0", speakerId: "speaker_1" },
      { speakerId: "speaker_2" }
    ]),
    (error) => error.code === OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
  );
});

test("unknown speaker segment ID is rejected", () => {
  assert.throws(
    () => normalizeTimedDubSpeakerAssignments({
      segments: [
        { id: "g2-q4-s0", speakerId: "speaker_1" },
        { id: "g2-q4-s99", speakerId: "speaker_2" }
      ]
    }, mappedSegments()),
    (error) => error.code === OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
  );
});

test("duplicate speaker segment ID is rejected", () => {
  assert.throws(
    () => normalizeTimedDubSpeakerAssignments({
      segments: [
        { id: "g2-q4-s0", speakerId: "speaker_1" },
        { id: "g2-q4-s0", speakerId: "speaker_2" }
      ]
    }, mappedSegments()),
    (error) => error.code === OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
  );
});

test("speaker assignment count mismatch is rejected", () => {
  assert.throws(
    () => normalizeTimedDubSpeakerAssignments({
      segments: [{ id: "g2-q4-s0", speakerId: "speaker_1" }]
    }, mappedSegments()),
    (error) => error.code === OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
  );
});

test("invalid JSON is rejected", () => {
  assert.throws(
    () => normalizeTimedDubSpeakerAssignments("{not-json", mappedSegments()),
    (error) => error.code === OLLAMA_DUB_SPEAKER_JSON_INVALID
  );
});

test("invalid speaker ID is rejected", () => {
  assert.throws(
    () => normalizeTimedDubSpeakerAssignments({
      segments: [
        { id: "g2-q4-s0", speakerId: "speaker/1" },
        { id: "g2-q4-s1", speakerId: "speaker_2" }
      ]
    }, mappedSegments()),
    (error) => error.code === OLLAMA_DUB_SPEAKER_ID_INVALID
  );
});

test("speaker ID normalization", () => {
  assert.equal(normalizeSpeakerId("Speaker-1"), "speaker_1");
  assert.equal(normalizeSpeakerId("2"), "speaker_2");
  assert.equal(normalizeSpeakerId("Narrator"), "narrator");
});

test("one-segment fallback assigns speaker_1", async () => {
  let calls = 0;
  const result = await resolveTimedDubSpeakersWithRetry({
    translatedSegments: mappedSegments().slice(0, 1),
    requestSpeakerAssignment: async () => {
      calls += 1;
      return { segments: [] };
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.speakerAssignments[0].speakerId, "speaker_1");
});

test("multi-segment unsafe fallback is rejected by default", async () => {
  await assert.rejects(
    resolveTimedDubSpeakersWithRetry({
      translatedSegments: mappedSegments(),
      requestSpeakerAssignment: async () => ({ segments: [] })
    }),
    (error) => error.code === OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
  );
});

test("corrective retry occurs once", async () => {
  const attempts = [];
  const result = await resolveTimedDubSpeakersWithRetry({
    translatedSegments: mappedSegments(),
    requestSpeakerAssignment: async ({ corrective, expectedIds }) => {
      attempts.push({ corrective, expectedIds });
      return attempts.length === 1 ? { segments: [] } : speakerOutput();
    }
  });

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].corrective, false);
  assert.equal(attempts[1].corrective, true);
  assert.deepEqual(attempts[1].expectedIds, ["g2-q4-s0", "g2-q4-s1"]);
  assert.equal(result.retryUsed, true);
});

test("speaker retry is not attempted indefinitely", async () => {
  let calls = 0;
  await assert.rejects(
    resolveTimedDubSpeakersWithRetry({
      translatedSegments: mappedSegments(),
      requestSpeakerAssignment: async () => {
        calls += 1;
        return "{not-json";
      }
    }),
    (error) => error.code === OLLAMA_DUB_SPEAKER_JSON_INVALID
  );

  assert.equal(calls, 2);
});

test("stable voice assignment input uses speaker ID", () => {
  const calls = [];
  buildTimedDubSynthesisPlan({
    timedDubSegments: mergeSegments(),
    sessionId: "session-a",
    targetLanguage: "en",
    assignVoice: (sessionId, targetLanguage, speakerId) => {
      calls.push({ sessionId, targetLanguage, speakerId });
      return { id: `${speakerId}-voice`, model: "/voices/private.onnx" };
    }
  });

  assert.deepEqual(calls.map((item) => item.speakerId), ["speaker_1", "speaker_2"]);
});

test("safe public voice ID does not expose absolute paths", () => {
  assert.equal(safePublicVoiceId({ model: "/Users/me/models/en_US-lessac-medium.onnx" }), "en_us_lessac_medium");
  assert.equal(safePublicVoiceId({ id: "/private/path/Voice Model.onnx" }), "voice_model");
});

test("timing is copied from trusted translated segment", () => {
  const [segment] = mergeSegments();

  assert.equal(segment.startMs, 120_250);
  assert.equal(segment.endMs, 121_900);
});

test("Ollama-provided timing is ignored", () => {
  const [segment] = mergeSegments(mappedSegments().slice(0, 1), [
    { id: "g2-q4-s0", speakerId: "speaker_1", startMs: 1, endMs: 2 }
  ]);

  assert.equal(segment.startMs, 120_250);
  assert.equal(segment.endMs, 121_900);
});

test("mapped startMs and endMs are preserved", () => {
  const [segment] = mergeSegments(mappedSegments().slice(0, 1), [
    { id: "g2-q4-s0", speakerId: "speaker_1" }
  ]);

  assert.equal(segment.startMs, 120_250);
  assert.equal(segment.endMs, 121_900);
});

test("relative timing field names are preserved", () => {
  const [segment] = mergeSegments(relativeSegments(), [
    { id: "g2-q4-s0", speakerId: "speaker_1" }
  ]);

  assert.equal(segment.relativeStartMs, 250);
  assert.equal(segment.relativeEndMs, 1900);
  assert.equal("startMs" in segment, false);
});

test("buffered timed dub can require mapped source-video timing", () => {
  assert.throws(
    () => mergeTimedDubSegments({
      translatedSegments: relativeSegments(),
      speakerAssignments: [{ id: "g2-q4-s0", speakerId: "speaker_1" }],
      generation: 2,
      sequence: 4,
      requireMappedTiming: true
    }),
    (error) => error.code === TIMED_DUB_TIMING_UNAVAILABLE
  );
});

test("generation and sequence are preserved", () => {
  const [segment] = mergeSegments();

  assert.equal(segment.generation, 2);
  assert.equal(segment.sequence, 4);
});

test("empty translated text skips Piper", () => {
  const plan = buildTimedDubSynthesisPlan({
    timedDubSegments: mergeSegments([
      { ...mappedSegments()[0], translatedText: "" }
    ], [{ id: "g2-q4-s0", speakerId: "speaker_1" }]),
    sessionId: "session-a",
    targetLanguage: "en",
    assignVoice: () => ({ id: "voice-a", model: "/voices/a.onnx" })
  });

  assert.equal(plan.length, 0);
});

test("one WAV is planned per non-empty segment", () => {
  const plan = buildTimedDubSynthesisPlan({
    timedDubSegments: mergeSegments([
      mappedSegments()[0],
      { ...mappedSegments()[1], translatedText: "" },
      { ...mappedSegments()[1], id: "g2-q4-s2", startMs: 124_300, endMs: 125_100, translatedText: "Third line." }
    ], [
      { id: "g2-q4-s0", speakerId: "speaker_1" },
      { id: "g2-q4-s1", speakerId: "speaker_2" },
      { id: "g2-q4-s2", speakerId: "speaker_1" }
    ]),
    sessionId: "session-a",
    targetLanguage: "en",
    assignVoice: () => ({ id: "voice-a", model: "/voices/a.onnx" })
  });

  assert.equal(plan.length, 2);
});

test("timed clips remain in canonical order", () => {
  const segments = mergeSegments(mappedSegments(), [
    { id: "g2-q4-s1", speakerId: "speaker_2" },
    { id: "g2-q4-s0", speakerId: "speaker_1" }
  ]);
  const clips = segments.map((segment) => clipFor(segment));

  assert.deepEqual(clips.map((clip) => clip.id), ["g2-q4-s0", "g2-q4-s1"]);
});

test("RIFF/WAVE validation rejects non-WAV data", () => {
  assert.throws(
    () => parseWavDurationMs(Buffer.from("not wav")),
    (error) => error.code === PIPER_WAV_INVALID
  );
});

test("fmt chunk parsing supports standard PCM WAV", () => {
  assert.equal(parseWavDurationMs(wavBuffer({ durationMs: 500 })), 500);
});

test("data chunk parsing rejects missing data chunk", () => {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(16_000, 4);
  fmt.writeUInt32LE(32_000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const fmtChunk = makeChunk("fmt ", fmt);
  const wav = Buffer.concat([Buffer.from("RIFF"), uint32(4 + fmtChunk.length), Buffer.from("WAVE"), fmtChunk]);

  assert.throws(
    () => parseWavDurationMs(wav),
    (error) => error.code === PIPER_WAV_INVALID
  );
});

test("extra WAV chunks are handled", () => {
  assert.equal(parseWavDurationMs(wavBuffer({
    durationMs: 750,
    extraChunks: [["LIST", Buffer.from("metadata")]]
  })), 750);
});

test("odd-sized WAV chunks and padding are handled", () => {
  assert.equal(parseWavDurationMs(wavBuffer({
    durationMs: 250,
    extraChunks: [["JUNK", Buffer.from([1, 2, 3])]]
  })), 250);
});

test("truncated WAV is rejected", () => {
  const wav = wavBuffer({ durationMs: 500 });

  assert.throws(
    () => parseWavDurationMs(wav.subarray(0, wav.length - 10)),
    (error) => error.code === PIPER_WAV_INVALID
  );
});

test("invalid byte rate is rejected", () => {
  assert.throws(
    () => parseWavDurationMs(wavBuffer({ byteRate: 0 })),
    (error) => error.code === PIPER_WAV_DURATION_INVALID
  );
});

test("PCM WAV duration is calculated correctly", () => {
  assert.equal(parseWavDurationMs(wavBuffer({ sampleRate: 24_000, durationMs: 1250 })), 1250);
});

test("audioDurationMs is finite and positive in clip response", () => {
  const [segment] = mergeSegments();
  const clip = clipFor(segment);

  assert.equal(clip.audioDurationMs, 1000);
  assert.ok(clip.audioDurationMs > 0);
});

test("targetWindowDurationMs is calculated correctly", () => {
  assert.equal(calculateTargetWindowDurationMs(mappedSegments()[0]), 1650);
});

test("durationRatio is calculated correctly", () => {
  const [segment] = mergeSegments();
  const clip = buildTimedDubClipResponse({
    segment,
    voice: { id: "voice-a", model: "/voices/a.onnx" },
    audioBuffer: wavBuffer({ durationMs: 825 }),
    audioDurationMs: 825
  });

  assert.equal(clip.targetWindowDurationMs, 1650);
  assert.equal(clip.durationRatio, 0.5);
});

test("buffered both mode returns translatedSegments and timedDubClips", () => {
  const clips = [clipFor(mergeSegments()[0])];
  const response = buildLocalChunkSuccessResponse({
    outputMode: "both",
    syncMode: "buffered",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: mappedSegments(),
    translatedSegments: mappedSegments(),
    timedDubClips: clips,
    dubClips: [{ audioBase64: "old" }],
    audioBase64: "old",
    audioMime: "audio/wav",
    model: "llama3.1"
  });

  assert.equal(response.translatedSegments.length, 2);
  assert.deepEqual(response.timedDubClips, clips);
  assert.deepEqual(response.dubClips, []);
});

test("buffered dub mode returns timedDubClips", () => {
  const clips = [clipFor(mergeSegments()[0])];
  const response = buildLocalChunkSuccessResponse({
    outputMode: "dub",
    syncMode: "buffered",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: mappedSegments(),
    translatedSegments: mappedSegments(),
    timedDubClips: clips,
    model: "llama3.1"
  });

  assert.equal(response.translatedText, "The weather is nice today. Let's go for a walk.");
  assert.equal("translatedSegments" in response, false);
  assert.deepEqual(response.timedDubClips, clips);
});

test("Live both mode preserves existing dubClips", () => {
  const response = buildLocalChunkSuccessResponse({
    outputMode: "both",
    syncMode: "live",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: mappedSegments(),
    translatedSegments: mappedSegments(),
    dubTranslation: { translatedText: "dub text", turns: [{ speakerId: "speaker_1", translatedText: "dub text" }] },
    dubClips: [{ audioBase64: "abc" }],
    audioBase64: "abc",
    audioMime: "audio/wav",
    model: "llama3.1"
  });

  assert.equal(response.dubClips.length, 1);
  assert.equal(response.audioBase64, "abc");
  assert.equal("timedDubClips" in response, false);
});

test("Live dub mode preserves existing behavior", () => {
  const response = buildLocalChunkSuccessResponse({
    outputMode: "dub",
    syncMode: "live",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: mappedSegments(),
    dubTranslation: { translatedText: "dub text", turns: [{ speakerId: "speaker_1", translatedText: "dub text" }] },
    dubClips: [{ audioBase64: "abc" }],
    audioBase64: "abc",
    audioMime: "audio/wav",
    model: "llama3.1"
  });

  assert.equal(response.translatedText, "dub text");
  assert.equal(response.dubClips.length, 1);
  assert.equal("timedDubClips" in response, false);
});

test("subtitle-only mode does not invoke Piper", () => {
  assert.equal(determineTimedDubMode({ syncMode: "buffered", outputMode: "subtitles" }), false);
});

test("empty speech skips speaker assignment and Piper", async () => {
  let calls = 0;
  const speakers = await resolveTimedDubSpeakersWithRetry({
    translatedSegments: [],
    requestSpeakerAssignment: async () => {
      calls += 1;
      return speakerOutput();
    }
  });
  const response = buildEmptyLocalChunkResponse({
    outputMode: "dub",
    syncMode: "buffered",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 }
  });

  assert.equal(calls, 0);
  assert.deepEqual(speakers.speakerAssignments, []);
  assert.deepEqual(response.timedDubClips, []);
});

test("timed dub clips are not exposed through old immediate dubClips field in buffered mode", () => {
  const response = buildLocalChunkSuccessResponse({
    outputMode: "dub",
    syncMode: "buffered",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: mappedSegments(),
    translatedSegments: mappedSegments(),
    timedDubClips: [clipFor(mergeSegments()[0])],
    dubClips: [{ audioBase64: "old" }],
    audioBase64: "old",
    model: "llama3.1"
  });

  assert.deepEqual(response.dubClips, []);
  assert.equal(response.audioBase64, undefined);
  assert.equal(response.timedDubClips.length, 1);
});

test("existing chunk timing fields remain unchanged", () => {
  const response = buildLocalChunkSuccessResponse({
    outputMode: "dub",
    syncMode: "buffered",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: mappedSegments(),
    translatedSegments: mappedSegments(),
    timedDubClips: [],
    model: "llama3.1"
  });

  assert.equal(response.sequence, 4);
  assert.equal(response.generation, 2);
  assert.equal(response.chunkStartMs, 120_000);
  assert.equal(response.chunkEndMs, 124_500);
});

test("speaker request payload assigns speakers only and does not include timing", () => {
  const request = buildTimedDubSpeakerRequest(mappedSegments());
  const payload = buildTimedDubSpeakerOllamaPayload({
    model: "llama3.1",
    sourceLabel: "Japanese",
    targetLabel: "English",
    request,
    speakerContext: ["speaker_1"]
  });

  assert.equal(payload.format.properties.segments.items.properties.speakerId.type, "string");
  assert.equal(payload.messages[1].content.includes("startMs"), false);
  assert.equal(payload.messages[1].content.includes("translatedText"), true);
  assert.equal(payload.messages[0].content.includes("Do not translate"), true);
});
