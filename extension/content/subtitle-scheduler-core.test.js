import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./subtitle-scheduler-core.js", import.meta.url), "utf8");
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "subtitle-scheduler-core.js" });
const core = sandbox.AutoTranslateSubtitleSchedulerCore;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function cue(overrides = {}) {
  return {
    id: "g2-q4-s0",
    bufferedSessionId: "session-1",
    generation: 2,
    sequence: 4,
    startMs: 1000,
    endMs: 2000,
    translatedText: "Hello.",
    sourceText: "こんにちは。",
    ...overrides
  };
}

function state(overrides = {}) {
  return core.createSubtitleCueQueue({
    bufferedSessionId: "session-1",
    generation: 2,
    ...overrides
  });
}

test("normalizes a valid subtitle cue", () => {
  assert.deepEqual(plain(core.normalizeSubtitleCue(cue(), { showSourceTranscript: true })), cue());
});

test("rejects invalid cue IDs", () => {
  assert.equal(core.normalizeSubtitleCue(cue({ id: "" })), null);
});

test("rejects invalid cue start and end times", () => {
  assert.equal(core.normalizeSubtitleCue(cue({ startMs: Number.NaN })), null);
  assert.equal(core.normalizeSubtitleCue(cue({ endMs: Number.POSITIVE_INFINITY })), null);
});

test("rejects end-before-start cues", () => {
  assert.equal(core.normalizeSubtitleCue(cue({ startMs: 3000, endMs: 2000 })), null);
});

test("inserts cues in stable chronological order", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [
    cue({ id: "later", startMs: 3000, endMs: 4000, sequence: 6 }),
    cue({ id: "first-b", startMs: 1000, endMs: 1800, sequence: 5 }),
    cue({ id: "first-a", startMs: 1000, endMs: 1600, sequence: 4 })
  ]);

  assert.deepEqual(plain(queue.pending.map((item) => item.id)), ["first-a", "first-b", "later"]);
});

test("out-of-order backend responses become time ordered", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue({ id: "s6", startMs: 6000, endMs: 7000, sequence: 6 })]);
  core.insertSubtitleCues(queue, [cue({ id: "s5", startMs: 5000, endMs: 5900, sequence: 5 })]);

  assert.deepEqual(plain(queue.pending.map((item) => item.id)), ["s5", "s6"]);
});

test("duplicate cue IDs are ignored within one generation", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()]);
  const stats = core.insertSubtitleCues(queue, [cue({ translatedText: "Duplicate." })]);

  assert.equal(stats.duplicates, 1);
  assert.equal(queue.pending.length, 1);
});

test("the same cue ID in a newer generation is separate after generation reset", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()]);
  core.reduceSubtitleSchedulerState(queue, { type: "GENERATION_CHANGE", generation: 3 });
  const stats = core.insertSubtitleCues(queue, [cue({ generation: 3 })]);

  assert.equal(stats.inserted, 1);
  assert.equal(queue.pending[0].generation, 3);
});

test("old-generation cues are removed", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue(), cue({ id: "new", generation: 3 })], { generation: 2 });
  core.removeStaleGenerationCues(queue, 3);

  assert.deepEqual(plain(queue.pending), []);
  assert.deepEqual(plain(queue.active), []);
});

test("old-session cues are rejected", () => {
  const queue = state();
  const stats = core.insertSubtitleCues(queue, [cue({ bufferedSessionId: "old-session" })]);

  assert.equal(stats.rejected, 1);
  assert.equal(queue.pending.length, 0);
});

test("a future cue remains queued", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue({ startMs: 5000, endMs: 6000 })]);
  const active = core.selectActiveCues(queue, 1000);

  assert.deepEqual(plain(active), []);
  assert.equal(queue.pending.length, 1);
});

test("a current cue becomes active", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()]);

  assert.deepEqual(plain(core.selectActiveCues(queue, 1500).map((item) => item.id)), ["g2-q4-s0"]);
});

test("an expired cue is removed", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()]);
  core.selectActiveCues(queue, 2300);

  assert.equal(queue.pending.length, 0);
  assert.equal(queue.active.length, 0);
});

test("late expired cue is dropped on insert", () => {
  const queue = state();
  const stats = core.insertSubtitleCues(queue, [cue({ startMs: 0, endMs: 1000 })], { delayedSourceTimeMs: 1400 });

  assert.equal(stats.late, 1);
  assert.equal(queue.droppedLateCueCount, 1);
});

test("cue arriving during its active interval displays immediately", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()], { delayedSourceTimeMs: 1500 });

  assert.deepEqual(plain(core.selectActiveCues(queue, 1500).map((item) => item.id)), ["g2-q4-s0"]);
});

test("pause does not expire a cue by wall-clock time", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()]);
  const before = core.selectActiveCues(queue, 1500);
  const after = core.selectActiveCues(queue, 1500);

  assert.equal(before[0].id, "g2-q4-s0");
  assert.equal(after[0].id, "g2-q4-s0");
});

test("resume continues from media time", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()]);

  assert.deepEqual(plain(core.selectActiveCues(queue, 1500).map((item) => item.id)), ["g2-q4-s0"]);
  assert.deepEqual(plain(core.selectActiveCues(queue, 2100)), []);
});

test("seek generation reset clears active and pending cues", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue(), cue({ id: "future", startMs: 5000, endMs: 6000 })]);
  core.selectActiveCues(queue, 1500);
  core.reduceSubtitleSchedulerState(queue, { type: "SEEK_RESET", generation: 3 });

  assert.equal(queue.generation, 3);
  assert.deepEqual(plain(queue.pending), []);
  assert.deepEqual(plain(queue.active), []);
});

test("two overlapping cues render in chronological order", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [
    cue({ id: "b", startMs: 1200, endMs: 2400, translatedText: "Second." }),
    cue({ id: "a", startMs: 1000, endMs: 2200, translatedText: "First." })
  ]);
  const active = core.selectActiveCues(queue, 1500);

  assert.deepEqual(plain(active.map((item) => item.id)), ["a", "b"]);
  assert.equal(core.renderCueLines(active).targetText, "First.\nSecond.");
});

test("more than two overlapping cues are bounded deterministically", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [
    cue({ id: "c", startMs: 1000, endMs: 2200 }),
    cue({ id: "b", startMs: 1000, endMs: 2100 }),
    cue({ id: "a", startMs: 1000, endMs: 2000 })
  ]);

  assert.deepEqual(plain(core.selectActiveCues(queue, 1500).map((item) => item.id)), ["a", "b"]);
});

test("queue capacity is bounded while preserving imminent cues", () => {
  const queue = state({ queueLimit: 2 });
  core.insertSubtitleCues(queue, [
    cue({ id: "near", startMs: 1000, endMs: 2000 }),
    cue({ id: "middle", startMs: 3000, endMs: 4000 }),
    cue({ id: "far", startMs: 5000, endMs: 6000 })
  ]);

  assert.deepEqual(plain(queue.pending.map((item) => item.id)), ["near", "middle"]);
});

test("source text is omitted when disabled", () => {
  const normalized = core.normalizeSubtitleCue(cue(), { showSourceTranscript: false });

  assert.equal("sourceText" in normalized, false);
});

test("source text is paired when enabled", () => {
  const normalized = core.normalizeSubtitleCue(cue(), { showSourceTranscript: true });

  assert.equal(normalized.sourceText, "こんにちは。");
});

test("interpolates delayed media time to source time at 1x", () => {
  const sourceMs = core.calculateDelayedSourceTime(1500, [{
    generation: 2,
    delayedMediaStartMs: 1000,
    delayedMediaEndMs: 2000,
    sourceStartMs: 10_000,
    sourceEndMs: 11_000
  }]);

  assert.equal(sourceMs, 10_500);
});

test("interpolates mapping representing 0.5x source progression", () => {
  const sourceMs = core.calculateDelayedSourceTime(1500, [{
    generation: 2,
    delayedMediaStartMs: 1000,
    delayedMediaEndMs: 2000,
    sourceStartMs: 10_000,
    sourceEndMs: 10_500
  }]);

  assert.equal(sourceMs, 10_250);
});

test("interpolates mapping representing 1.5x source progression", () => {
  const sourceMs = core.calculateDelayedSourceTime(1500, [{
    generation: 2,
    delayedMediaStartMs: 1000,
    delayedMediaEndMs: 2000,
    sourceStartMs: 10_000,
    sourceEndMs: 11_500
  }]);

  assert.equal(sourceMs, 10_750);
});

test("interpolates mapping representing 2x source progression", () => {
  const sourceMs = core.calculateDelayedSourceTime(1500, [{
    generation: 2,
    delayedMediaStartMs: 1000,
    delayedMediaEndMs: 2000,
    sourceStartMs: 10_000,
    sourceEndMs: 12_000
  }]);

  assert.equal(sourceMs, 11_000);
});

test("invalid mapping ranges are rejected", () => {
  assert.equal(core.normalizeClockRange({
    generation: 2,
    delayedMediaStartMs: 2000,
    delayedMediaEndMs: 1000,
    sourceStartMs: 10_000,
    sourceEndMs: 11_000
  }), null);
});

test("old pipelineEpoch mappings are ignored", () => {
  const sourceMs = core.calculateDelayedSourceTime(1500, [{
    generation: 2,
    pipelineEpoch: 1,
    delayedMediaStartMs: 1000,
    delayedMediaEndMs: 2000,
    sourceStartMs: 10_000,
    sourceEndMs: 11_000
  }], { pipelineEpoch: 2 });

  assert.equal(sourceMs, null);
});

test("live mode bypasses the buffered scheduler", () => {
  assert.equal(core.shouldUseBufferedSubtitleScheduler({
    provider: "ollama",
    syncMode: "live",
    outputMode: "subtitles"
  }), false);
});

test("buffered local subtitle-capable modes use the buffered scheduler", () => {
  assert.equal(core.shouldUseBufferedSubtitleScheduler({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "subtitles"
  }), true);
  assert.equal(core.shouldUseBufferedSubtitleScheduler({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "both"
  }), true);
});

test("OpenAI transcript behavior remains outside buffered cue normalization", () => {
  assert.equal(core.shouldUseBufferedSubtitleScheduler({
    provider: "openai",
    syncMode: "buffered",
    outputMode: "subtitles"
  }), false);
});

test("dub-only mode does not schedule subtitles when no cues are inserted", () => {
  assert.equal(core.shouldUseBufferedSubtitleScheduler({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "dub"
  }), false);
});

test("cleanup state transition clears scheduler queues", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()]);
  core.reduceSubtitleSchedulerState(queue, { type: "STOP" });

  assert.equal(queue.pending.length, 0);
  assert.equal(queue.active.length, 0);
});

test("stop and start create a fresh scheduler session", () => {
  const queue = state();
  core.insertSubtitleCues(queue, [cue()]);
  core.reduceSubtitleSchedulerState(queue, {
    type: "RESET_SESSION",
    bufferedSessionId: "session-2",
    generation: 0
  });

  assert.equal(queue.bufferedSessionId, "session-2");
  assert.equal(queue.generation, 0);
  assert.equal(queue.seenKeys.size, 0);
});
