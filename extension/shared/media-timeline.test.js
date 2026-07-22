import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./media-timeline.js", import.meta.url), "utf8");
const sandbox = { globalThis: null, Date };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "media-timeline.js" });
const timeline = sandbox.AutoTranslateMediaTimeline;

function video(overrides = {}) {
  return {
    currentTime: 12.345,
    playbackRate: 1.5,
    paused: false,
    seeking: false,
    ended: false,
    duration: 120,
    ...overrides
  };
}

test("timeline snapshot normalization uses actual source video time", () => {
  const snapshot = timeline.createTimelineSnapshotFromVideo(video(), {
    sessionId: "session-a",
    generation: 2,
    eventType: "playing",
    observedAtEpochMs: 1000
  });

  assert.equal(snapshot.sessionId, "session-a");
  assert.equal(snapshot.generation, 2);
  assert.equal(snapshot.sourceTimeMs, 12345);
  assert.equal(snapshot.playbackRate, 1.5);
  assert.equal(snapshot.durationMs, 120000);
  assert.equal(snapshot.observedAtEpochMs, 1000);
});

test("invalid NaN and Infinity timeline values are rejected or normalized safely", () => {
  assert.equal(timeline.normalizeTimelineSnapshot({
    sessionId: "session-a",
    generation: 0,
    sourceTimeMs: Number.NaN,
    observedAtEpochMs: 1000,
    playbackRate: 1
  }), null);

  const snapshot = timeline.normalizeTimelineSnapshot({
    sessionId: "session-a",
    generation: 0,
    sourceTimeMs: 0,
    observedAtEpochMs: Number.POSITIVE_INFINITY,
    playbackRate: Number.POSITIVE_INFINITY,
    durationMs: Number.NaN
  }, { now: 2000 });

  assert.equal(snapshot.observedAtEpochMs, 2000);
  assert.equal(snapshot.playbackRate, 1);
  assert.equal("durationMs" in snapshot, false);
});

test("one seek cycle increments generation exactly once", () => {
  let state = { generation: 0 };
  state = timeline.applySeekCycleEvent(state, { eventType: "seeking", observedAtEpochMs: 1000 });
  assert.equal(state.generation, 0);
  state = timeline.applySeekCycleEvent(state, { eventType: "seeked", observedAtEpochMs: 1200 });
  assert.equal(state.generation, 1);
  assert.equal(state.changed, true);
  state = timeline.applySeekCycleEvent(state, { eventType: "seeked", observedAtEpochMs: 1300 });
  assert.equal(state.generation, 1);
  assert.equal(state.changed, false);
});

test("duplicate seeking and jump notifications do not increment twice", () => {
  let state = { generation: 3 };
  state = timeline.applySeekCycleEvent(state, { eventType: "seeking", observedAtEpochMs: 1000 });
  state = timeline.applySeekCycleEvent(state, { eventType: "seeking", observedAtEpochMs: 1010 });
  state = timeline.applySeekCycleEvent(state, { eventType: "timeline-jump", observedAtEpochMs: 1020 });
  assert.equal(state.generation, 3);
  state = timeline.applySeekCycleEvent(state, { eventType: "seeked", observedAtEpochMs: 1300 });
  assert.equal(state.generation, 4);
  state = timeline.applySeekCycleEvent(state, { eventType: "timeline-jump", observedAtEpochMs: 1350 });
  assert.equal(state.generation, 4);
});

test("pause and rate change do not increment generation", () => {
  let state = { generation: 1 };
  state = timeline.applySeekCycleEvent(state, { eventType: "pause", observedAtEpochMs: 1000 });
  assert.equal(state.generation, 1);
  state = timeline.applySeekCycleEvent(state, { eventType: "ratechange", observedAtEpochMs: 2000 });
  assert.equal(state.generation, 1);
});

test("playback rates 0.5, 1, 1.5, and 2 are preserved", () => {
  for (const playbackRate of [0.5, 1, 1.5, 2]) {
    const snapshot = timeline.createTimelineSnapshotFromVideo(video({ playbackRate }), {
      sessionId: "session-a",
      generation: 0
    });
    assert.equal(snapshot.playbackRate, playbackRate);
  }
});

test("chunk generation and playback-rate boundaries are detected", () => {
  const start = timeline.normalizeTimelineSnapshot({
    sessionId: "session-a",
    generation: 0,
    sourceTimeMs: 1000,
    observedAtEpochMs: 1000,
    playbackRate: 1
  });
  const nextGeneration = { ...start, generation: 1, sourceTimeMs: 2000 };
  const newRate = { ...start, sourceTimeMs: 2000, playbackRate: 1.5 };

  assert.equal(timeline.recordingCrossedGenerationBoundary(start, nextGeneration), true);
  assert.equal(timeline.recordingCrossedPlaybackRateChange(start, newRate), true);
});

test("jump detection accounts for playback rate", () => {
  const previous = timeline.normalizeTimelineSnapshot({
    sessionId: "session-a",
    generation: 0,
    sourceTimeMs: 10000,
    observedAtEpochMs: 1000,
    playbackRate: 2
  });
  const ordinary2x = { ...previous, sourceTimeMs: 12000, observedAtEpochMs: 2000 };
  const jumped = { ...previous, sourceTimeMs: 18000, observedAtEpochMs: 2000 };

  assert.equal(timeline.detectTimelineJump(previous, ordinary2x, { toleranceMs: 500 }).jumped, false);
  assert.equal(timeline.detectTimelineJump(previous, jumped, { toleranceMs: 500 }).jumped, true);
});

test("pipeline epoch helper invalidates old asynchronous SourceBuffer work", () => {
  assert.equal(timeline.isCurrentPipelineEpoch(2, 2), true);
  assert.equal(timeline.isCurrentPipelineEpoch(1, 2), false);
});

test("session-ID mismatch is rejected by timeline comparison helpers", () => {
  const a = { sessionId: "a", generation: 0 };
  const b = { sessionId: "b", generation: 0 };
  assert.equal(timeline.sameTimelineSession(a, b), false);
  assert.equal(timeline.sameTimelineGeneration(a, b), false);
  assert.equal(timeline.isStaleTimelineSnapshot(a, b), true);
});
