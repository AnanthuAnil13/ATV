export const OLLAMA_SEGMENT_JSON_INVALID = "OLLAMA_SEGMENT_JSON_INVALID";
export const OLLAMA_SEGMENT_ALIGNMENT_INVALID = "OLLAMA_SEGMENT_ALIGNMENT_INVALID";
export const OLLAMA_SEGMENT_TRANSLATION_MISSING = "OLLAMA_SEGMENT_TRANSLATION_MISSING";

const MAX_SEGMENT_COUNT = 64;
const MAX_SEGMENT_SOURCE_CHARS = 4000;
const MAX_SEGMENT_TRANSLATION_CHARS = 1200;
const MAX_COMBINED_TRANSLATION_CHARS = 4000;

export function shouldTranslateSubtitleSegments(outputMode) {
  return outputMode === "subtitles" || outputMode === "both";
}

export function shouldTranslateDub(outputMode) {
  return outputMode === "dub" || outputMode === "both";
}

export function stripSourceTextFromSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.map(({ sourceText, ...segment }) => segment);
}

export function buildSegmentTranslationRequest(transcriptSegments, options = {}) {
  if (!Array.isArray(transcriptSegments)) {
    throw createSegmentError(
      "Segment translation input must be an array.",
      OLLAMA_SEGMENT_ALIGNMENT_INVALID
    );
  }

  const maxSegments = options.maxSegments ?? MAX_SEGMENT_COUNT;
  const maxSourceChars = options.maxSourceChars ?? MAX_SEGMENT_SOURCE_CHARS;
  if (transcriptSegments.length > maxSegments) {
    throw createSegmentError(
      "Too many transcript segments for one translation request.",
      OLLAMA_SEGMENT_ALIGNMENT_INVALID
    );
  }

  const seenIds = new Set();
  let totalSourceChars = 0;
  const segments = transcriptSegments.map((segment) => {
    if (!segment || typeof segment !== "object" || typeof segment.id !== "string" || !segment.id.trim()) {
      throw createSegmentError(
        "Transcript segment IDs are required for aligned translation.",
        OLLAMA_SEGMENT_ALIGNMENT_INVALID
      );
    }

    const id = segment.id.trim();
    if (seenIds.has(id)) {
      throw createSegmentError(
        "Transcript segment IDs must be unique.",
        OLLAMA_SEGMENT_ALIGNMENT_INVALID
      );
    }
    seenIds.add(id);

    const sourceText = cleanText(segment.sourceText);
    totalSourceChars += sourceText.length;
    if (totalSourceChars > maxSourceChars) {
      throw createSegmentError(
        "Transcript segment text is too long for one translation request.",
        OLLAMA_SEGMENT_ALIGNMENT_INVALID
      );
    }

    return { id, sourceText };
  });

  return { segments };
}

export function buildSegmentTranslationOllamaPayload({
  model,
  sourceLabel,
  targetLabel,
  request,
  contextPairs = [],
  corrective = false
}) {
  const expectedIds = request.segments.map((segment) => segment.id);
  const contextText = buildContextText(contextPairs);
  const correctiveText = corrective
    ? `\nYour previous response was not aligned. Return exactly these IDs in this exact order: ${expectedIds.join(", ")}.`
    : "";

  return {
    model,
    stream: false,
    think: false,
    keep_alive: "10m",
    format: buildSegmentTranslationFormatSchema(),
    options: {
      temperature: 0.1,
      num_predict: Math.min(1600, 160 + request.segments.length * 120)
    },
    messages: [
      {
        role: "system",
        content: `You are a professional audiovisual subtitle translator. Translate spoken ${sourceLabel} dialogue into natural ${targetLabel}. Return JSON only with one root key named segments. Return exactly one item for every supplied segment. Preserve each supplied ID exactly. Preserve input order. Translate only the text belonging to that segment. Do not merge neighboring segments. Do not split one segment into multiple objects. Do not omit IDs. Do not create new IDs. Do not repeat source text unless explicitly required. Preserve meaning, tone, names, numbers, and sentence intent. Return an empty translation only when that individual segment contains no translatable speech. Do not explain or annotate. Recent context is for terminology consistency only and must not change the one-input-to-one-output alignment.${contextText}${correctiveText}`
      },
      {
        role: "user",
        content: JSON.stringify({ segments: request.segments })
      }
    ]
  };
}

export function buildSegmentTranslationFormatSchema() {
  return {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            translation: { type: "string" }
          },
          required: ["id", "translation"]
        }
      }
    },
    required: ["segments"]
  };
}

export function parseSegmentTranslationResponse(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (!Array.isArray(value.segments)) {
      throw createSegmentError(
        "Ollama segment translation JSON must contain a segments array.",
        OLLAMA_SEGMENT_JSON_INVALID
      );
    }
    return value;
  }

  const text = String(value || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.segments)) {
    throw createSegmentError(
      "Ollama did not return valid segment translation JSON.",
      OLLAMA_SEGMENT_JSON_INVALID
    );
  }
  return parsed;
}

export function normalizeTranslatedSegments(response, inputSegments) {
  const parsed = parseSegmentTranslationResponse(response);
  return validateSegmentAlignment(inputSegments, parsed.segments);
}

export function validateSegmentAlignment(inputSegments, outputSegments) {
  const request = buildSegmentTranslationRequest(inputSegments);
  if (!Array.isArray(outputSegments)) {
    throw createSegmentError(
      "Ollama segment translation output must be an array.",
      OLLAMA_SEGMENT_JSON_INVALID
    );
  }
  if (outputSegments.length !== request.segments.length) {
    throw createSegmentError(
      "Ollama segment translation count did not match the transcript segment count.",
      OLLAMA_SEGMENT_ALIGNMENT_INVALID
    );
  }

  const expectedIds = new Set(request.segments.map((segment) => segment.id));
  const translationsById = new Map();
  for (const item of outputSegments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw createSegmentError(
        "Ollama segment translation items must be objects.",
        OLLAMA_SEGMENT_ALIGNMENT_INVALID
      );
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      throw createSegmentError(
        "Ollama segment translation item is missing a valid ID.",
        OLLAMA_SEGMENT_TRANSLATION_MISSING
      );
    }
    const id = item.id.trim();
    if (!expectedIds.has(id)) {
      throw createSegmentError(
        "Ollama returned an unknown segment ID.",
        OLLAMA_SEGMENT_ALIGNMENT_INVALID
      );
    }
    if (translationsById.has(id)) {
      throw createSegmentError(
        "Ollama returned a duplicate segment ID.",
        OLLAMA_SEGMENT_ALIGNMENT_INVALID
      );
    }
    if (typeof item.translation !== "string") {
      throw createSegmentError(
        "Ollama segment translation item is missing translated text.",
        OLLAMA_SEGMENT_TRANSLATION_MISSING
      );
    }
    translationsById.set(id, cleanTranslationText(item.translation));
  }

  for (const segment of request.segments) {
    if (!translationsById.has(segment.id)) {
      throw createSegmentError(
        "Ollama did not return a translation for every transcript segment.",
        OLLAMA_SEGMENT_TRANSLATION_MISSING
      );
    }
  }

  return request.segments.map((segment, index) => ({
    id: segment.id,
    index,
    translatedText: translationsById.get(segment.id)
  }));
}

export async function resolveSegmentTranslationsWithRetry({
  transcriptSegments,
  requestTranslation,
  fallbackTranslation = null
}) {
  const request = buildSegmentTranslationRequest(transcriptSegments);
  if (!request.segments.length) {
    return { request, translatedSegments: [], retryUsed: false, fallbackUsed: false };
  }

  let lastAlignmentError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await requestTranslation({
      attempt,
      corrective: attempt === 1,
      request,
      expectedIds: request.segments.map((segment) => segment.id)
    });
    const parsed = parseSegmentTranslationResponse(raw);
    try {
      return {
        request,
        translatedSegments: validateSegmentAlignment(request.segments, parsed.segments),
        retryUsed: attempt === 1,
        fallbackUsed: false
      };
    } catch (error) {
      if (!isSegmentAlignmentError(error)) throw error;
      lastAlignmentError = error;
    }
  }

  if (request.segments.length === 1 && typeof fallbackTranslation === "function") {
    const translatedText = await fallbackTranslation(request.segments[0]);
    return {
      request,
      translatedSegments: [{
        id: request.segments[0].id,
        index: 0,
        translatedText: cleanTranslationText(translatedText)
      }],
      retryUsed: true,
      fallbackUsed: true
    };
  }

  throw lastAlignmentError || createSegmentError(
    "Ollama segment translation could not be aligned to transcript segments.",
    OLLAMA_SEGMENT_ALIGNMENT_INVALID
  );
}

export function buildTranslatedSegmentResponse({ transcriptSegments, translatedSegments, showSourceTranscript }) {
  const trustedSegments = normalizeTrustedTranscriptSegments(transcriptSegments);
  const translatedById = new Map();
  for (const item of translatedSegments || []) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
    translatedById.set(item.id, cleanTranslationText(item.translatedText ?? item.translation));
  }

  return trustedSegments.map((segment) => {
    if (!translatedById.has(segment.id)) {
      throw createSegmentError(
        "A transcript segment is missing its aligned translation.",
        OLLAMA_SEGMENT_TRANSLATION_MISSING
      );
    }

    const response = { id: segment.id };
    copyTrustedTiming(response, segment);
    if (showSourceTranscript) response.sourceText = segment.sourceText;
    response.translatedText = translatedById.get(segment.id);
    return response;
  });
}

export function buildSingleSegmentFallbackResponse({ transcriptSegments, translatedText, showSourceTranscript }) {
  const trustedSegments = normalizeTrustedTranscriptSegments(transcriptSegments);
  if (trustedSegments.length !== 1) {
    throw createSegmentError(
      "Whole-chunk fallback is only safe for a single transcript segment.",
      OLLAMA_SEGMENT_ALIGNMENT_INVALID
    );
  }
  return buildTranslatedSegmentResponse({
    transcriptSegments: trustedSegments,
    translatedSegments: [{
      id: trustedSegments[0].id,
      translatedText
    }],
    showSourceTranscript
  });
}

export function combineTranslatedSegmentText(translatedSegments) {
  if (!Array.isArray(translatedSegments)) return "";
  return translatedSegments
    .map((segment) => cleanTranslationText(segment?.translatedText))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_COMBINED_TRANSLATION_CHARS);
}

export function buildEmptyLocalChunkResponse({ chunkTiming }) {
  return {
    ok: true,
    empty: true,
    ...chunkTiming,
    transcriptSegments: [],
    translatedSegments: []
  };
}

export function buildLocalChunkSuccessResponse({
  outputMode,
  chunkTiming,
  sourceText,
  showSourceTranscript,
  transcriptSegments,
  translatedSegments = [],
  dubTranslation = { translatedText: "", turns: [] },
  dubClips = [],
  audioBase64,
  audioMime,
  model
}) {
  const wantsSubtitles = shouldTranslateSubtitleSegments(outputMode);
  const wantsDub = shouldTranslateDub(outputMode);
  const translatedText = wantsSubtitles
    ? combineTranslatedSegmentText(translatedSegments)
    : cleanTranslationText(dubTranslation?.translatedText);

  return removeUndefined({
    ok: true,
    ...chunkTiming,
    sourceText: showSourceTranscript ? sourceText : undefined,
    translatedText,
    transcriptSegments,
    translatedSegments: wantsSubtitles ? translatedSegments : undefined,
    turns: wantsDub ? dubTranslation?.turns ?? [] : [],
    dubClips: wantsDub ? dubClips : [],
    audioBase64: wantsDub ? audioBase64 : undefined,
    audioMime: wantsDub ? audioMime : undefined,
    model
  });
}

export function isSegmentAlignmentError(error) {
  return error?.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID ||
    error?.code === OLLAMA_SEGMENT_TRANSLATION_MISSING;
}

function normalizeTrustedTranscriptSegments(transcriptSegments) {
  const request = buildSegmentTranslationRequest(transcriptSegments);
  const trustedById = new Map();
  for (const segment of transcriptSegments) {
    trustedById.set(segment.id, segment);
  }

  return request.segments.map((segment) => ({
    ...trustedById.get(segment.id),
    id: segment.id,
    sourceText: segment.sourceText
  }));
}

function copyTrustedTiming(target, source) {
  if (isFiniteNonNegative(source.startMs) && isFiniteNonNegative(source.endMs)) {
    target.startMs = source.startMs;
    target.endMs = source.endMs;
    return;
  }
  if (isFiniteNonNegative(source.relativeStartMs) && isFiniteNonNegative(source.relativeEndMs)) {
    target.relativeStartMs = source.relativeStartMs;
    target.relativeEndMs = source.relativeEndMs;
  }
}

function buildContextText(contextPairs) {
  const pairs = Array.isArray(contextPairs) ? contextPairs.slice(-4) : [];
  if (!pairs.length) return "";
  return `\nRecent context for terminology only:\n${pairs
    .map((pair) => `SOURCE: ${cleanText(pair.source)}\nTRANSLATION: ${cleanTranslationText(pair.target)}`)
    .join("\n")}`;
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanTranslationText(value) {
  return cleanText(value)
    .replace(/^\s*["']|["']\s*$/g, "")
    .slice(0, MAX_SEGMENT_TRANSLATION_CHARS);
}

function createSegmentError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
