import test from "node:test";
import assert from "node:assert/strict";
import "../shared/media-timeline.js";
import {
  advanceLocalGeneration,
  removeQueuedChunksFromOldGenerations,
  shouldDiscardRecordedChunk,
  shouldIgnoreBackendResult
} from "./local-timeline-state.js";

const timeline = globalThis.AutoTranslateMediaTimeline;

function snapshot(overrides = {}) {
  return timeline.normalizeTimelineSnapshot({
    sessionId: "session-a",
    generation: 0,
    sourceTimeMs: 1000,
    observedAtEpochMs: 1000,
    playbackRate: 1,
    ...overrides
  });
}

test("sequence resets to zero for a new generation", () => {
  const local = {
    generation: 0,
    sequence: 7,
    queue: [],
    audioQueue: []
  };

  assert.equal(advanceLocalGeneration(local, 1), true);
  assert.equal(local.generation, 1);
  assert.equal(local.sequence, 0);
});

test("old-generation queued chunks are removed", () => {
  const queue = [
    { metadata: { generation: 0, sequence: 3 } },
    { metadata: { generation: 1, sequence: 0 } }
  ];

  assert.deepEqual(removeQueuedChunksFromOldGenerations(queue, 1), [queue[1]]);
});

test("a chunk spanning two generations is discarded", () => {
  const reason = shouldDiscardRecordedChunk({
    startSnapshot: snapshot({ generation: 0, sourceTimeMs: 1000 }),
    endSnapshot: snapshot({ generation: 1, sourceTimeMs: 2000 }),
    captureStartEpochMs: 1000,
    captureEndEpochMs: 3000,
    timeline
  });

  assert.equal(reason, "cross-generation");
});

test("old-generation backend results are ignored", () => {
  const local = { generation: 2 };
  const oldItem = { metadata: { generation: 1 } };
  const currentItem = { metadata: { generation: 2 } };

  assert.equal(shouldIgnoreBackendResult(local, oldItem, {}), true);
  assert.equal(shouldIgnoreBackendResult(local, currentItem, { generation: 1 }), true);
  assert.equal(shouldIgnoreBackendResult(local, currentItem, { generation: 2 }), false);
});

test("a chunk does not span materially different playback rates", () => {
  const reason = shouldDiscardRecordedChunk({
    startSnapshot: snapshot({ playbackRate: 1, sourceTimeMs: 1000 }),
    endSnapshot: snapshot({ playbackRate: 1.5, sourceTimeMs: 2000 }),
    captureStartEpochMs: 1000,
    captureEndEpochMs: 3000,
    timeline
  });

  assert.equal(reason, "playback-rate-changed");
});
