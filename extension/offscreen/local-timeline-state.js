export function advanceLocalGeneration(local, nextGeneration) {
  if (!local || !Number.isInteger(nextGeneration) || nextGeneration < 0 || nextGeneration <= local.generation) {
    return false;
  }

  local.generation = nextGeneration;
  local.sequence = 0;
  local.queue = removeQueuedChunksFromOldGenerations(local.queue, nextGeneration);
  local.audioQueue = removeQueuedClipsFromOldGenerations(local.audioQueue, nextGeneration);
  return true;
}

export function removeQueuedChunksFromOldGenerations(queue, generation) {
  return Array.isArray(queue)
    ? queue.filter((item) => item?.metadata?.generation === generation)
    : [];
}

export function removeQueuedClipsFromOldGenerations(queue, generation) {
  return Array.isArray(queue)
    ? queue.filter((item) => item?.generation === generation)
    : [];
}

export function shouldIgnoreBackendResult(local, item, result = {}) {
  if (!local || !item?.metadata) return true;
  if (item.metadata.generation !== local.generation) return true;
  if (result.generation !== undefined && Number(result.generation) !== item.metadata.generation) return true;
  return false;
}

export function shouldDiscardRecordedChunk({
  startSnapshot,
  endSnapshot,
  captureStartEpochMs,
  captureEndEpochMs,
  timeline,
  allowShort = false
}) {
  if (!startSnapshot || !endSnapshot) return "missing-timeline-snapshot";
  if (timeline.recordingCrossedGenerationBoundary(startSnapshot, endSnapshot)) {
    return "cross-generation";
  }
  if (timeline.recordingCrossedPlaybackRateChange(startSnapshot, endSnapshot)) {
    return "playback-rate-changed";
  }
  if (!allowShort && !timeline.hasMeaningfulChunkDuration(
    startSnapshot,
    endSnapshot,
    captureStartEpochMs,
    captureEndEpochMs
  )) {
    return "too-short";
  }
  return "";
}
