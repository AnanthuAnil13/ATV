export const WHISPER_JSON_INVALID = "WHISPER_JSON_INVALID";
export const WHISPER_JSON_SCHEMA_UNSUPPORTED = "WHISPER_JSON_SCHEMA_UNSUPPORTED";

const NON_SPEECH_MARKER_PATTERN = /^\s*\[(?:BLANK_AUDIO|SILENCE|MUSIC|NOISE)\]\s*$/iu;
const MAX_TRANSCRIPT_TEXT_LENGTH = 4000;

export function parseWhisperJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    const error = new Error("whisper.cpp produced invalid JSON transcript output.");
    error.code = WHISPER_JSON_INVALID;
    throw error;
  }
}

export function normalizeWhisperSegments(whisperJson) {
  const parsed = parseWhisperJson(whisperJson);
  if (!parsed || !Array.isArray(parsed.transcription)) {
    const error = new Error("whisper.cpp JSON transcript schema is unsupported.");
    error.code = WHISPER_JSON_SCHEMA_UNSUPPORTED;
    throw error;
  }

  return parsed.transcription
    .map((segment, originalIndex) => normalizeWhisperSegment(segment, originalIndex))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.relativeStartMs !== right.relativeStartMs) {
        return left.relativeStartMs - right.relativeStartMs;
      }
      return left.originalIndex - right.originalIndex;
    })
    .map((segment, index) => ({
      index,
      text: segment.text,
      relativeStartMs: segment.relativeStartMs,
      relativeEndMs: segment.relativeEndMs
    }));
}

export function buildTranscriptionFromWhisperJson(whisperJson) {
  const parsed = parseWhisperJson(whisperJson);
  const segments = normalizeWhisperSegments(parsed);
  return {
    text: segments.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_TRANSCRIPT_TEXT_LENGTH),
    language: typeof parsed?.result?.language === "string" ? parsed.result.language : undefined,
    durationMs: segments.length ? Math.max(...segments.map((segment) => segment.relativeEndMs)) : 0,
    segments
  };
}

export function parseWhisperTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  const totalMs =
    Number(hours) * 60 * 60 * 1000 +
    Number(minutes) * 60 * 1000 +
    Number(seconds) * 1000 +
    Number(milliseconds);
  return Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : null;
}

export function mapWhisperSegmentsToVideoTimeline(segments, metadata) {
  if (!Array.isArray(segments)) return [];
  const mapping = createTimelineMapping(metadata);
  if (!mapping) return [];

  return segments
    .map((segment) => mapSegmentToVideoTimeline(segment, metadata, mapping))
    .filter(Boolean);
}

export function buildTranscriptSegmentResponse({ segments, metadata, showSourceTranscript }) {
  const canMap = canMapSegmentsToVideoTimeline(metadata);
  const mapped = mapWhisperSegmentsToVideoTimeline(segments, metadata);
  if (canMap) {
    return mapped.map((segment) => {
      const response = {
        id: buildWhisperSegmentId(metadata, segment.index),
        startMs: segment.startMs,
        endMs: segment.endMs
      };
      if (showSourceTranscript) response.sourceText = segment.text;
      return response;
    });
  }

  if (!Array.isArray(segments)) return [];
  return segments.map((segment) => {
    const response = {
      id: buildWhisperSegmentId(metadata, segment.index),
      relativeStartMs: segment.relativeStartMs,
      relativeEndMs: segment.relativeEndMs
    };
    if (showSourceTranscript) response.sourceText = segment.text;
    return response;
  });
}

export function buildChunkTimingResponseFields(metadata) {
  return {
    sequence: metadata?.sequence,
    generation: metadata?.generation,
    chunkStartMs: metadata?.videoStartMs,
    chunkEndMs: metadata?.videoEndMs
  };
}

export function buildWhisperSegmentId(metadata, segmentIndex) {
  const generation = isValidInteger(metadata?.generation) ? metadata.generation : 0;
  const sequence = isValidInteger(metadata?.sequence) ? metadata.sequence : 0;
  const index = isValidInteger(segmentIndex) ? segmentIndex : 0;
  return `g${generation}-q${sequence}-s${index}`;
}

export function canMapSegmentsToVideoTimeline(metadata) {
  return Boolean(createTimelineMapping(metadata));
}

function normalizeWhisperSegment(segment, originalIndex) {
  if (!segment || typeof segment !== "object") return null;
  const text = cleanWhisperSegmentText(segment.text);
  if (!text) return null;

  const offsets = extractSegmentOffsets(segment);
  if (!offsets) return null;
  if (offsets.relativeEndMs <= offsets.relativeStartMs) return null;

  return {
    originalIndex,
    text,
    relativeStartMs: offsets.relativeStartMs,
    relativeEndMs: offsets.relativeEndMs
  };
}

function extractSegmentOffsets(segment) {
  const numeric = parseNumericOffsets(segment.offsets);
  if (numeric) return numeric;

  const timestampStart = parseWhisperTimestamp(segment.timestamps?.from);
  const timestampEnd = parseWhisperTimestamp(segment.timestamps?.to);
  if (timestampStart === null || timestampEnd === null) return null;
  return {
    relativeStartMs: timestampStart,
    relativeEndMs: timestampEnd
  };
}

function parseNumericOffsets(offsets) {
  if (!offsets || typeof offsets !== "object") return null;
  if (typeof offsets.from !== "number" || typeof offsets.to !== "number") return null;
  const from = offsets.from;
  const to = offsets.to;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) return null;
  return {
    relativeStartMs: from,
    relativeEndMs: to
  };
}

function cleanWhisperSegmentText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || NON_SPEECH_MARKER_PATTERN.test(text)) return "";
  return text;
}

function createTimelineMapping(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const videoStartMs = finiteNonNegative(metadata.videoStartMs);
  const videoEndMs = finiteNonNegative(metadata.videoEndMs);
  if (videoStartMs === null || videoEndMs === null || videoEndMs < videoStartMs) return null;

  const captureStartEpochMs = finiteNonNegative(metadata.captureStartEpochMs);
  const captureEndEpochMs = finiteNonNegative(metadata.captureEndEpochMs);
  const captureDurationMs = captureStartEpochMs !== null && captureEndEpochMs !== null
    ? captureEndEpochMs - captureStartEpochMs
    : 0;
  const videoDurationMs = videoEndMs - videoStartMs;
  const playbackRate = finitePositive(metadata.playbackRate);
  const timeScale = captureDurationMs > 0 && videoDurationMs >= 0
    ? videoDurationMs / captureDurationMs
    : playbackRate ?? 1;

  if (!Number.isFinite(timeScale) || timeScale <= 0) return null;
  return { videoStartMs, videoEndMs, timeScale };
}

function mapSegmentToVideoTimeline(segment, metadata, mapping) {
  const startMs = clamp(
    mapping.videoStartMs + segment.relativeStartMs * mapping.timeScale,
    mapping.videoStartMs,
    mapping.videoEndMs
  );
  const endMs = clamp(
    mapping.videoStartMs + segment.relativeEndMs * mapping.timeScale,
    mapping.videoStartMs,
    mapping.videoEndMs
  );
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return null;
  return {
    id: buildWhisperSegmentId(metadata, segment.index),
    index: segment.index,
    text: segment.text,
    startMs,
    endMs
  };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isValidInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
