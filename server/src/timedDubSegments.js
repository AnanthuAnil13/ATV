export const OLLAMA_DUB_SPEAKER_JSON_INVALID = "OLLAMA_DUB_SPEAKER_JSON_INVALID";
export const OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID = "OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID";
export const OLLAMA_DUB_SPEAKER_ID_INVALID = "OLLAMA_DUB_SPEAKER_ID_INVALID";
export const TIMED_DUB_TIMING_UNAVAILABLE = "TIMED_DUB_TIMING_UNAVAILABLE";
export const PIPER_WAV_INVALID = "PIPER_WAV_INVALID";
export const PIPER_WAV_DURATION_INVALID = "PIPER_WAV_DURATION_INVALID";

const MAX_TIMED_DUB_SEGMENTS = 64;
const MAX_SEGMENT_TEXT_CHARS = 1200;
const MAX_TOTAL_TEXT_CHARS = 6000;
const MAX_SPEAKER_ID_CHARS = 48;

export function determineTimedDubMode({ syncMode, outputMode } = {}) {
  return syncMode === "buffered" && (outputMode === "dub" || outputMode === "both");
}

export function buildTimedDubSpeakerRequest(translatedSegments, options = {}) {
  if (!Array.isArray(translatedSegments)) {
    throw createTimedDubError(
      "Timed dub speaker input must be an array.",
      OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
    );
  }

  const maxSegments = options.maxSegments ?? MAX_TIMED_DUB_SEGMENTS;
  if (translatedSegments.length > maxSegments) {
    throw createTimedDubError(
      "Too many timed dub segments for one speaker-assignment request.",
      OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
    );
  }

  const seenIds = new Set();
  let totalChars = 0;
  const segments = translatedSegments.map((segment) => {
    const id = normalizeSegmentId(segment?.id);
    if (!id) {
      throw createTimedDubError(
        "Timed dub segments require stable IDs.",
        OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
      );
    }
    if (seenIds.has(id)) {
      throw createTimedDubError(
        "Timed dub segment IDs must be unique.",
        OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
      );
    }
    seenIds.add(id);

    const sourceText = cleanText(segment?.sourceText).slice(0, MAX_SEGMENT_TEXT_CHARS);
    const translatedText = cleanText(segment?.translatedText).slice(0, MAX_SEGMENT_TEXT_CHARS);
    totalChars += sourceText.length + translatedText.length;
    if (totalChars > (options.maxTotalTextChars ?? MAX_TOTAL_TEXT_CHARS)) {
      throw createTimedDubError(
        "Timed dub segment text is too long for one speaker-assignment request.",
        OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
      );
    }

    return { id, sourceText, translatedText };
  });

  return { segments };
}

export function buildTimedDubSpeakerOllamaPayload({
  model,
  sourceLabel,
  targetLabel,
  request,
  speakerContext = [],
  corrective = false
}) {
  const expectedIds = request.segments.map((segment) => segment.id);
  const speakerContextText = buildSpeakerContextText(speakerContext);
  const correctiveText = corrective
    ? `\nYour previous response was not aligned. Return exactly these IDs in this exact order: ${expectedIds.join(", ")}.`
    : "";

  return {
    model,
    stream: false,
    think: false,
    keep_alive: "10m",
    format: buildTimedDubSpeakerFormatSchema(),
    options: {
      temperature: 0.1,
      num_predict: Math.min(700, 120 + request.segments.length * 40)
    },
    messages: [
      {
        role: "system",
        content: `You assign stable speaker IDs for timed dubbing. The source language is ${sourceLabel}; the translated audio language is ${targetLabel}. Return JSON only with one root key named segments. Return exactly one item for every supplied segment. Preserve each supplied ID exactly. Preserve input order. Assign only a short speakerId for the speaker of that segment, using IDs like speaker_1, speaker_2, or narrator. Reuse known speaker IDs when the current segment likely belongs to the same speaker. Do not translate, rewrite, merge, split, omit, annotate, or explain. Do not provide timing. Do not change translatedText.${speakerContextText}${correctiveText}`
      },
      {
        role: "user",
        content: JSON.stringify({ segments: request.segments })
      }
    ]
  };
}

export function buildTimedDubSpeakerFormatSchema() {
  return {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            speakerId: { type: "string" }
          },
          required: ["id", "speakerId"]
        }
      }
    },
    required: ["segments"]
  };
}

export function parseTimedDubSpeakerResponse(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (!Array.isArray(value.segments)) {
      throw createTimedDubError(
        "Ollama timed-dub speaker JSON must contain a segments array.",
        OLLAMA_DUB_SPEAKER_JSON_INVALID
      );
    }
    return value;
  }

  const parsed = parseJsonObject(String(value || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.segments)) {
    throw createTimedDubError(
      "Ollama did not return valid timed-dub speaker JSON.",
      OLLAMA_DUB_SPEAKER_JSON_INVALID
    );
  }
  return parsed;
}

export function validateTimedDubSpeakerAlignment(inputSegments, outputSegments) {
  const request = buildTimedDubSpeakerRequest(inputSegments);
  if (!Array.isArray(outputSegments)) {
    throw createTimedDubError(
      "Ollama timed-dub speaker output must be an array.",
      OLLAMA_DUB_SPEAKER_JSON_INVALID
    );
  }
  if (outputSegments.length !== request.segments.length) {
    throw createTimedDubError(
      "Ollama timed-dub speaker count did not match the timed segment count.",
      OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
    );
  }

  const expectedIds = new Set(request.segments.map((segment) => segment.id));
  const speakersById = new Map();
  for (const item of outputSegments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw createTimedDubError(
        "Ollama timed-dub speaker items must be objects.",
        OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
      );
    }
    const id = normalizeSegmentId(item.id);
    if (!id) {
      throw createTimedDubError(
        "Ollama timed-dub speaker item is missing a valid ID.",
        OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
      );
    }
    if (!expectedIds.has(id)) {
      throw createTimedDubError(
        "Ollama returned an unknown timed-dub segment ID.",
        OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
      );
    }
    if (speakersById.has(id)) {
      throw createTimedDubError(
        "Ollama returned a duplicate timed-dub segment ID.",
        OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
      );
    }
    const speakerId = normalizeSpeakerId(item.speakerId);
    if (!speakerId) {
      throw createTimedDubError(
        "Ollama returned an invalid timed-dub speaker ID.",
        OLLAMA_DUB_SPEAKER_ID_INVALID
      );
    }
    speakersById.set(id, speakerId);
  }

  for (const segment of request.segments) {
    if (!speakersById.has(segment.id)) {
      throw createTimedDubError(
        "Ollama did not return a speaker ID for every timed-dub segment.",
        OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
      );
    }
  }

  return request.segments.map((segment, index) => ({
    id: segment.id,
    index,
    speakerId: speakersById.get(segment.id)
  }));
}

export function normalizeTimedDubSpeakerAssignments(response, inputSegments) {
  const parsed = parseTimedDubSpeakerResponse(response);
  return validateTimedDubSpeakerAlignment(inputSegments, parsed.segments);
}

export async function resolveTimedDubSpeakersWithRetry({
  translatedSegments,
  requestSpeakerAssignment,
  fallbackSpeakerId = "speaker_1"
}) {
  const request = buildTimedDubSpeakerRequest(translatedSegments);
  if (!request.segments.length) {
    return { request, speakerAssignments: [], retryUsed: false, fallbackUsed: false };
  }

  let lastRecoverableError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await requestSpeakerAssignment({
        attempt,
        corrective: attempt === 1,
        request,
        expectedIds: request.segments.map((segment) => segment.id)
      });
      return {
        request,
        speakerAssignments: normalizeTimedDubSpeakerAssignments(raw, request.segments),
        retryUsed: attempt === 1,
        fallbackUsed: false
      };
    } catch (error) {
      if (!isTimedDubSpeakerRecoverableError(error)) throw error;
      lastRecoverableError = error;
    }
  }

  if (request.segments.length === 1) {
    const speakerId = normalizeSpeakerId(fallbackSpeakerId) || "speaker_1";
    return {
      request,
      speakerAssignments: [{ id: request.segments[0].id, index: 0, speakerId }],
      retryUsed: true,
      fallbackUsed: true
    };
  }

  throw lastRecoverableError || createTimedDubError(
    "Ollama timed-dub speaker assignments could not be aligned to segments.",
    OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
  );
}

export function mergeTimedDubSegments({
  translatedSegments,
  speakerAssignments,
  generation,
  sequence,
  requireMappedTiming = false
}) {
  const request = buildTimedDubSpeakerRequest(translatedSegments);
  const assignments = validateTimedDubSpeakerAlignment(
    request.segments,
    (speakerAssignments || []).map((assignment) => ({
      id: assignment?.id,
      speakerId: assignment?.speakerId
    }))
  );
  const trustedById = new Map((translatedSegments || []).map((segment) => [normalizeSegmentId(segment?.id), segment]));
  const normalizedGeneration = normalizeNonNegativeInteger(generation);
  const normalizedSequence = normalizeNonNegativeInteger(sequence);
  if (normalizedGeneration === null || normalizedSequence === null) {
    throw createTimedDubError(
      "Timed dub generation and sequence are required.",
      OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
    );
  }

  return assignments.map((assignment) => {
    const trusted = trustedById.get(assignment.id);
    const segment = {
      id: assignment.id,
      generation: normalizedGeneration,
      sequence: normalizedSequence,
      speakerId: assignment.speakerId,
      translatedText: cleanText(trusted?.translatedText).slice(0, MAX_SEGMENT_TEXT_CHARS)
    };
    copyTrustedTiming(segment, trusted, requireMappedTiming);
    return segment;
  });
}

export function buildTimedDubSynthesisPlan({ timedDubSegments, sessionId, targetLanguage, assignVoice }) {
  if (!Array.isArray(timedDubSegments)) return [];
  if (typeof assignVoice !== "function") {
    throw createTimedDubError(
      "Timed dub synthesis requires a voice assignment function.",
      OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
    );
  }

  const plan = [];
  for (const segment of timedDubSegments) {
    const translatedText = cleanText(segment?.translatedText);
    if (!translatedText) continue;
    const voice = assignVoice(sessionId, targetLanguage, segment.speakerId);
    plan.push({
      segment: { ...segment, translatedText },
      voice,
      voiceId: safePublicVoiceId(voice)
    });
  }
  return plan;
}

export function buildTimedDubClipResponse({
  segment,
  voice,
  audioBuffer,
  audioMime = "audio/wav",
  audioDurationMs
}) {
  const durationMs = normalizePositiveNumber(audioDurationMs);
  if (durationMs === null) {
    throw createTimedDubError(
      "Piper WAV duration is invalid.",
      PIPER_WAV_DURATION_INVALID
    );
  }
  let normalizedAudioBuffer;
  try {
    normalizedAudioBuffer = Buffer.from(audioBuffer || []);
  } catch {
    normalizedAudioBuffer = Buffer.alloc(0);
  }
  if (!normalizedAudioBuffer.length) {
    throw createTimedDubError(
      "Piper WAV audio data is invalid.",
      PIPER_WAV_INVALID
    );
  }

  const clip = {
    id: normalizeSegmentId(segment?.id),
    generation: normalizeNonNegativeInteger(segment?.generation),
    sequence: normalizeNonNegativeInteger(segment?.sequence),
    speakerId: normalizeSpeakerId(segment?.speakerId),
    voiceId: safePublicVoiceId(voice),
    translatedText: cleanText(segment?.translatedText).slice(0, MAX_SEGMENT_TEXT_CHARS),
    audioBase64: normalizedAudioBuffer.toString("base64"),
    audioMime: cleanAudioMime(audioMime),
    audioDurationMs: Math.round(durationMs)
  };
  copyTrustedTiming(clip, segment, false);
  if (!clip.id || clip.generation === null || clip.sequence === null || !clip.speakerId) {
    throw createTimedDubError(
      "Timed dub clip metadata is invalid.",
      OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID
    );
  }

  const targetWindowDurationMs = calculateTargetWindowDurationMs(clip);
  if (targetWindowDurationMs !== null) {
    clip.targetWindowDurationMs = targetWindowDurationMs;
    clip.durationRatio = roundRatio(clip.audioDurationMs / targetWindowDurationMs);
  }
  return removeNullish(clip);
}

export function parseWavDurationMs(value) {
  const buffer = Buffer.from(value || []);
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw createTimedDubError("Piper output is not a valid RIFF/WAVE file.", PIPER_WAV_INVALID);
  }

  let fmt = null;
  let dataChunkSize = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) {
      throw createTimedDubError("Piper WAV output is truncated.", PIPER_WAV_INVALID);
    }

    if (id === "fmt ") {
      if (size < 16) {
        throw createTimedDubError("Piper WAV fmt chunk is malformed.", PIPER_WAV_INVALID);
      }
      fmt = {
        audioFormat: buffer.readUInt16LE(dataStart),
        channels: buffer.readUInt16LE(dataStart + 2),
        sampleRate: buffer.readUInt32LE(dataStart + 4),
        byteRate: buffer.readUInt32LE(dataStart + 8),
        blockAlign: buffer.readUInt16LE(dataStart + 12),
        bitsPerSample: buffer.readUInt16LE(dataStart + 14)
      };
    } else if (id === "data") {
      dataChunkSize = size;
    }

    offset = dataEnd + (size % 2);
  }

  if (!fmt || dataChunkSize === null) {
    throw createTimedDubError("Piper WAV output is missing fmt or data chunks.", PIPER_WAV_INVALID);
  }
  if (
    fmt.audioFormat !== 1 ||
    fmt.channels <= 0 ||
    fmt.sampleRate <= 0 ||
    fmt.byteRate <= 0 ||
    fmt.blockAlign <= 0 ||
    fmt.bitsPerSample <= 0 ||
    dataChunkSize <= 0
  ) {
    throw createTimedDubError("Piper WAV output has invalid PCM duration metadata.", PIPER_WAV_DURATION_INVALID);
  }

  const durationMs = (dataChunkSize / fmt.byteRate) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw createTimedDubError("Piper WAV duration is invalid.", PIPER_WAV_DURATION_INVALID);
  }
  return Math.round(durationMs);
}

export function normalizeSpeakerId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SPEAKER_ID_CHARS) return "";
  if (!/^[a-zA-Z0-9 _-]+$/.test(trimmed)) return "";
  const normalized = trimmed
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized || normalized.length > MAX_SPEAKER_ID_CHARS || !/^[a-z0-9_]+$/.test(normalized)) return "";
  if (/^\d+$/.test(normalized)) return `speaker_${normalized}`;
  if (/^speaker\d+$/.test(normalized)) return normalized.replace(/^speaker/, "speaker_");
  return normalized;
}

export function safePublicVoiceId(voice) {
  const raw = String(voice?.id || voice?.voiceId || voice?.model || "voice").trim();
  const basename = raw.split(/[\\/]/).pop() || raw;
  const withoutExtension = basename.replace(/\.[a-zA-Z0-9]+$/, "");
  const normalized = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || "voice";
}

export function calculateTargetWindowDurationMs(segment) {
  const startMs = normalizeNonNegativeNumber(segment?.startMs ?? segment?.relativeStartMs);
  const endMs = normalizeNonNegativeNumber(segment?.endMs ?? segment?.relativeEndMs);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return Math.round(endMs - startMs);
}

export function isTimedDubSpeakerRecoverableError(error) {
  return error?.code === OLLAMA_DUB_SPEAKER_JSON_INVALID ||
    error?.code === OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID ||
    error?.code === OLLAMA_DUB_SPEAKER_ID_INVALID;
}

function copyTrustedTiming(target, source, requireMappedTiming) {
  const startMs = normalizeNonNegativeNumber(source?.startMs);
  const endMs = normalizeNonNegativeNumber(source?.endMs);
  if (startMs !== null && endMs !== null && endMs > startMs) {
    target.startMs = startMs;
    target.endMs = endMs;
    return;
  }

  if (requireMappedTiming) {
    throw createTimedDubError(
      "Timed buffered dubbing requires mapped source-video segment timing.",
      TIMED_DUB_TIMING_UNAVAILABLE
    );
  }

  const relativeStartMs = normalizeNonNegativeNumber(source?.relativeStartMs);
  const relativeEndMs = normalizeNonNegativeNumber(source?.relativeEndMs);
  if (relativeStartMs !== null && relativeEndMs !== null && relativeEndMs > relativeStartMs) {
    target.relativeStartMs = relativeStartMs;
    target.relativeEndMs = relativeEndMs;
    return;
  }

  throw createTimedDubError(
    "Timed dub segment timing is unavailable.",
    TIMED_DUB_TIMING_UNAVAILABLE
  );
}

function buildSpeakerContextText(speakerContext) {
  const ids = Array.isArray(speakerContext)
    ? [...new Set(speakerContext.map((item) => normalizeSpeakerId(item?.speakerId ?? item)).filter(Boolean))].slice(-12)
    : [];
  return ids.length
    ? `\nKnown speaker IDs in this session: ${ids.join(", ")}. Reuse them only when the current segment likely belongs to the same speaker.`
    : "";
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

function normalizeSegmentId(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanAudioMime(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^audio\/[a-z0-9.+-]+$/.test(text) ? text : "audio/wav";
}

function roundRatio(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;
}

function removeNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function createTimedDubError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
