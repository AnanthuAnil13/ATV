import test from "node:test";
import assert from "node:assert/strict";
import {
  OLLAMA_SEGMENT_ALIGNMENT_INVALID,
  OLLAMA_SEGMENT_JSON_INVALID,
  OLLAMA_SEGMENT_TRANSLATION_MISSING,
  buildEmptyLocalChunkResponse,
  buildLocalChunkSuccessResponse,
  buildSegmentTranslationOllamaPayload,
  buildSegmentTranslationRequest,
  buildSingleSegmentFallbackResponse,
  buildTranslatedSegmentResponse,
  combineTranslatedSegmentText,
  normalizeTranslatedSegments,
  resolveSegmentTranslationsWithRetry,
  shouldTranslateDub,
  shouldTranslateSubtitleSegments,
  stripSourceTextFromSegments,
  validateSegmentAlignment
} from "../src/translatedSegments.js";

function mappedSegments() {
  return [
    {
      id: "g2-q4-s0",
      startMs: 120_250,
      endMs: 121_900,
      sourceText: "今日はいい天気ですね。"
    },
    {
      id: "g2-q4-s1",
      startMs: 122_050,
      endMs: 124_100,
      sourceText: "散歩に行きましょう。"
    }
  ];
}

function relativeSegments() {
  return [
    {
      id: "g2-q4-s0",
      relativeStartMs: 250,
      relativeEndMs: 1900,
      sourceText: "今日はいい天気ですね。"
    }
  ];
}

function alignedOutput() {
  return {
    segments: [
      { id: "g2-q4-s0", translation: "The weather is nice today." },
      { id: "g2-q4-s1", translation: "Let's go for a walk." }
    ]
  };
}

test("buildSegmentTranslationRequest sends only IDs and source text in order", () => {
  const request = buildSegmentTranslationRequest(mappedSegments());

  assert.deepEqual(request, {
    segments: [
      { id: "g2-q4-s0", sourceText: "今日はいい天気ですね。" },
      { id: "g2-q4-s1", sourceText: "散歩に行きましょう。" }
    ]
  });
});

test("buildSegmentTranslationOllamaPayload uses structured JSON format and no timing fields", () => {
  const request = buildSegmentTranslationRequest(mappedSegments());
  const payload = buildSegmentTranslationOllamaPayload({
    model: "llama3.1",
    sourceLabel: "Japanese",
    targetLabel: "English",
    request,
    contextPairs: [{ source: "前の文", target: "Previous sentence" }]
  });

  assert.equal(payload.model, "llama3.1");
  assert.equal(payload.format.properties.segments.items.properties.id.type, "string");
  assert.equal(payload.format.properties.segments.items.properties.translation.type, "string");
  assert.equal(payload.messages[1].content.includes("startMs"), false);
  assert.equal(payload.messages[1].content.includes("relativeStartMs"), false);
});

test("validates a one-to-one aligned response", () => {
  const normalized = normalizeTranslatedSegments(alignedOutput(), mappedSegments());

  assert.deepEqual(normalized, [
    { id: "g2-q4-s0", index: 0, translatedText: "The weather is nice today." },
    { id: "g2-q4-s1", index: 1, translatedText: "Let's go for a walk." }
  ]);
});

test("restores model output returned in a different order to input order", () => {
  const normalized = normalizeTranslatedSegments({
    segments: [
      { id: "g2-q4-s1", translation: "Let's go for a walk." },
      { id: "g2-q4-s0", translation: "The weather is nice today." }
    ]
  }, mappedSegments());

  assert.deepEqual(normalized.map((segment) => segment.id), ["g2-q4-s0", "g2-q4-s1"]);
});

test("rejects a missing output ID", () => {
  assert.throws(
    () => validateSegmentAlignment(mappedSegments(), [
      { id: "g2-q4-s0", translation: "The weather is nice today." },
      { translation: "Let's go for a walk." }
    ]),
    (error) => error.code === OLLAMA_SEGMENT_TRANSLATION_MISSING
  );
});

test("rejects an unknown output ID", () => {
  assert.throws(
    () => normalizeTranslatedSegments({
      segments: [
        { id: "g2-q4-s0", translation: "The weather is nice today." },
        { id: "g2-q4-s99", translation: "Unknown." }
      ]
    }, mappedSegments()),
    (error) => error.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID
  );
});

test("rejects duplicate output IDs", () => {
  assert.throws(
    () => normalizeTranslatedSegments({
      segments: [
        { id: "g2-q4-s0", translation: "First." },
        { id: "g2-q4-s0", translation: "Duplicate." }
      ]
    }, mappedSegments()),
    (error) => error.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID
  );
});

test("rejects duplicate input IDs defensively", () => {
  assert.throws(
    () => buildSegmentTranslationRequest([
      mappedSegments()[0],
      { ...mappedSegments()[1], id: "g2-q4-s0" }
    ]),
    (error) => error.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID
  );
});

test("rejects output count mismatches", () => {
  assert.throws(
    () => normalizeTranslatedSegments({
      segments: [{ id: "g2-q4-s0", translation: "Only one." }]
    }, mappedSegments()),
    (error) => error.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID
  );
});

test("rejects non-string translations", () => {
  assert.throws(
    () => normalizeTranslatedSegments({
      segments: [
        { id: "g2-q4-s0", translation: "The weather is nice today." },
        { id: "g2-q4-s1", translation: 123 }
      ]
    }, mappedSegments()),
    (error) => error.code === OLLAMA_SEGMENT_TRANSLATION_MISSING
  );
});

test("rejects invalid JSON", () => {
  assert.throws(
    () => normalizeTranslatedSegments("{not-json", mappedSegments()),
    (error) => error.code === OLLAMA_SEGMENT_JSON_INVALID
  );
});

test("handles markdown-fenced JSON responses", () => {
  const normalized = normalizeTranslatedSegments(
    "```json\n{\"segments\":[{\"id\":\"g2-q4-s0\",\"translation\":\"The weather is nice today.\"},{\"id\":\"g2-q4-s1\",\"translation\":\"Let's go for a walk.\"}]}\n```",
    mappedSegments()
  );

  assert.equal(normalized[0].translatedText, "The weather is nice today.");
});

test("single-segment whole-text fallback is safe", () => {
  const [fallback] = buildSingleSegmentFallbackResponse({
    transcriptSegments: relativeSegments(),
    translatedText: "The weather is nice today.",
    showSourceTranscript: false
  });

  assert.deepEqual(fallback, {
    id: "g2-q4-s0",
    relativeStartMs: 250,
    relativeEndMs: 1900,
    translatedText: "The weather is nice today."
  });
});

test("multiple-segment whole-text fallback is rejected", () => {
  assert.throws(
    () => buildSingleSegmentFallbackResponse({
      transcriptSegments: mappedSegments(),
      translatedText: "The weather is nice today. Let's go for a walk.",
      showSourceTranscript: false
    }),
    (error) => error.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID
  );
});

test("empty translation preserves the correct ID", () => {
  const normalized = normalizeTranslatedSegments({
    segments: [
      { id: "g2-q4-s0", translation: "" },
      { id: "g2-q4-s1", translation: "Let's go for a walk." }
    ]
  }, mappedSegments());

  assert.equal(normalized[0].id, "g2-q4-s0");
  assert.equal(normalized[0].translatedText, "");
});

test("translated response copies timing from trusted transcriptSegments", () => {
  const response = buildTranslatedSegmentResponse({
    transcriptSegments: mappedSegments(),
    translatedSegments: normalizeTranslatedSegments(alignedOutput(), mappedSegments()),
    showSourceTranscript: false
  });

  assert.equal(response[0].startMs, 120_250);
  assert.equal(response[0].endMs, 121_900);
});

test("Ollama-provided timing fields are ignored", () => {
  const response = buildTranslatedSegmentResponse({
    transcriptSegments: mappedSegments(),
    translatedSegments: [
      { id: "g2-q4-s0", startMs: 1, endMs: 2, translatedText: "The weather is nice today." },
      { id: "g2-q4-s1", startMs: 3, endMs: 4, translatedText: "Let's go for a walk." }
    ],
    showSourceTranscript: false
  });

  assert.equal(response[0].startMs, 120_250);
  assert.equal(response[0].endMs, 121_900);
});

test("mapped startMs and endMs are preserved", () => {
  const [response] = buildTranslatedSegmentResponse({
    transcriptSegments: mappedSegments().slice(0, 1),
    translatedSegments: [{ id: "g2-q4-s0", translatedText: "The weather is nice today." }],
    showSourceTranscript: false
  });

  assert.equal(response.startMs, 120_250);
  assert.equal(response.endMs, 121_900);
});

test("relativeStartMs and relativeEndMs are preserved", () => {
  const [response] = buildTranslatedSegmentResponse({
    transcriptSegments: relativeSegments(),
    translatedSegments: [{ id: "g2-q4-s0", translatedText: "The weather is nice today." }],
    showSourceTranscript: false
  });

  assert.equal(response.relativeStartMs, 250);
  assert.equal(response.relativeEndMs, 1900);
});

test("sourceText is omitted when showSourceTranscript is false", () => {
  const [response] = buildTranslatedSegmentResponse({
    transcriptSegments: mappedSegments().slice(0, 1),
    translatedSegments: [{ id: "g2-q4-s0", translatedText: "The weather is nice today." }],
    showSourceTranscript: false
  });

  assert.equal("sourceText" in response, false);
});

test("sourceText is included when showSourceTranscript is true", () => {
  const [response] = buildTranslatedSegmentResponse({
    transcriptSegments: mappedSegments().slice(0, 1),
    translatedSegments: [{ id: "g2-q4-s0", translatedText: "The weather is nice today." }],
    showSourceTranscript: true
  });

  assert.equal(response.sourceText, "今日はいい天気ですね。");
});

test("combined translatedText follows canonical order", () => {
  const text = combineTranslatedSegmentText([
    { id: "g2-q4-s0", translatedText: "The weather is nice today." },
    { id: "g2-q4-s1", translatedText: "Let's go for a walk." }
  ]);

  assert.equal(text, "The weather is nice today. Let's go for a walk.");
});

test("empty transcript skips segment translation", async () => {
  let calls = 0;
  const result = await resolveSegmentTranslationsWithRetry({
    transcriptSegments: [],
    requestTranslation: async () => {
      calls += 1;
      return alignedOutput();
    }
  });

  assert.equal(calls, 0);
  assert.deepEqual(result.translatedSegments, []);
});

test("corrective retry is attempted once after alignment failure", async () => {
  const attempts = [];
  const result = await resolveSegmentTranslationsWithRetry({
    transcriptSegments: mappedSegments(),
    requestTranslation: async ({ corrective, expectedIds }) => {
      attempts.push({ corrective, expectedIds });
      return attempts.length === 1
        ? { segments: [{ id: "g2-q4-s0", translation: "Only one." }] }
        : alignedOutput();
    }
  });

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].corrective, false);
  assert.equal(attempts[1].corrective, true);
  assert.deepEqual(attempts[1].expectedIds, ["g2-q4-s0", "g2-q4-s1"]);
  assert.equal(result.retryUsed, true);
});

test("retry is not attempted indefinitely", async () => {
  let calls = 0;
  await assert.rejects(
    resolveSegmentTranslationsWithRetry({
      transcriptSegments: mappedSegments(),
      requestTranslation: async () => {
        calls += 1;
        return { segments: [{ id: "g2-q4-s0", translation: "Only one." }] };
      }
    }),
    (error) => error.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID
  );

  assert.equal(calls, 2);
});

test("invalid JSON does not trigger the alignment retry", async () => {
  let calls = 0;
  await assert.rejects(
    resolveSegmentTranslationsWithRetry({
      transcriptSegments: mappedSegments(),
      requestTranslation: async () => {
        calls += 1;
        return "{not-json";
      }
    }),
    (error) => error.code === OLLAMA_SEGMENT_JSON_INVALID
  );

  assert.equal(calls, 1);
});

test("single-segment retry can fall back to whole-chunk text", async () => {
  let attempts = 0;
  let fallbackCalls = 0;
  const result = await resolveSegmentTranslationsWithRetry({
    transcriptSegments: relativeSegments(),
    requestTranslation: async () => {
      attempts += 1;
      return { segments: [] };
    },
    fallbackTranslation: async () => {
      fallbackCalls += 1;
      return "The weather is nice today.";
    }
  });

  assert.equal(attempts, 2);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.translatedSegments[0].translatedText, "The weather is nice today.");
});

test("multiple-segment retry does not use whole-text fallback", async () => {
  let fallbackCalls = 0;
  await assert.rejects(
    resolveSegmentTranslationsWithRetry({
      transcriptSegments: mappedSegments(),
      requestTranslation: async () => ({ segments: [] }),
      fallbackTranslation: async () => {
        fallbackCalls += 1;
        return "A whole chunk.";
      }
    }),
    (error) => error.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID
  );

  assert.equal(fallbackCalls, 0);
});

test("subtitle-only mode does not plan dub work or return dub audio", () => {
  const response = buildLocalChunkSuccessResponse({
    outputMode: "subtitles",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: stripSourceTextFromSegments(mappedSegments()),
    translatedSegments: [
      { id: "g2-q4-s0", startMs: 120_250, endMs: 121_900, translatedText: "The weather is nice today." }
    ],
    dubTranslation: { translatedText: "dub text", turns: [{ speakerId: "speaker_1", translatedText: "dub text" }] },
    dubClips: [{ audioBase64: "abc" }],
    audioBase64: "abc",
    audioMime: "audio/wav",
    model: "llama3.1"
  });

  assert.equal(shouldTranslateSubtitleSegments("subtitles"), true);
  assert.equal(shouldTranslateDub("subtitles"), false);
  assert.equal(response.audioBase64, undefined);
  assert.deepEqual(response.dubClips, []);
  assert.deepEqual(response.turns, []);
});

test("dub-only mode preserves existing dub translatedText behavior", () => {
  const response = buildLocalChunkSuccessResponse({
    outputMode: "dub",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: stripSourceTextFromSegments(mappedSegments()),
    translatedSegments: [{ id: "g2-q4-s0", translatedText: "subtitle text" }],
    dubTranslation: { translatedText: "dub text", turns: [{ speakerId: "speaker_1", translatedText: "dub text" }] },
    dubClips: [{ audioBase64: "abc" }],
    audioBase64: "abc",
    audioMime: "audio/wav",
    model: "llama3.1"
  });

  assert.equal(shouldTranslateSubtitleSegments("dub"), false);
  assert.equal(shouldTranslateDub("dub"), true);
  assert.equal(response.translatedText, "dub text");
  assert.equal("translatedSegments" in response, false);
  assert.equal(response.audioBase64, "abc");
});

test("both mode returns translatedSegments and dub clips", () => {
  const response = buildLocalChunkSuccessResponse({
    outputMode: "both",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: stripSourceTextFromSegments(mappedSegments()),
    translatedSegments: [
      { id: "g2-q4-s0", startMs: 120_250, endMs: 121_900, translatedText: "subtitle text" }
    ],
    dubTranslation: { translatedText: "dub text", turns: [{ speakerId: "speaker_1", translatedText: "dub text" }] },
    dubClips: [{ audioBase64: "abc" }],
    audioBase64: "abc",
    audioMime: "audio/wav",
    model: "llama3.1"
  });

  assert.equal(response.translatedText, "subtitle text");
  assert.equal(response.translatedSegments.length, 1);
  assert.equal(response.dubClips.length, 1);
});

test("existing generation, sequence, and chunk timing fields remain unchanged", () => {
  const response = buildLocalChunkSuccessResponse({
    outputMode: "subtitles",
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 },
    sourceText: "source",
    showSourceTranscript: false,
    transcriptSegments: [],
    translatedSegments: [],
    model: "llama3.1"
  });

  assert.equal(response.sequence, 4);
  assert.equal(response.generation, 2);
  assert.equal(response.chunkStartMs, 120_000);
  assert.equal(response.chunkEndMs, 124_500);
});

test("empty local chunk response includes empty transcript and translated segment arrays", () => {
  const response = buildEmptyLocalChunkResponse({
    chunkTiming: { sequence: 4, generation: 2, chunkStartMs: 120_000, chunkEndMs: 124_500 }
  });

  assert.equal(response.empty, true);
  assert.deepEqual(response.transcriptSegments, []);
  assert.deepEqual(response.translatedSegments, []);
});
