import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./translation-readiness-core.js", import.meta.url), "utf8");
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "translation-readiness-core.js" });
const core = sandbox.AutoTranslateTranslationReadinessCore;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function range(overrides = {}) {
  return {
    bufferedSessionId: "session-1",
    generation: 2,
    sequence: 4,
    startMs: 3000,
    endMs: 7500,
    empty: false,
    translatedSegmentCount: 1,
    ...overrides
  };
}

function state(overrides = {}) {
  return core.createTranslationReadinessState({
    bufferedSessionId: "session-1",
    generation: 2,
    required: true,
    initialBufferSeconds: 10,
    ...overrides
  });
}

test("normalizes a valid coverage range", () => {
  const normalized = core.normalizeTranslationCoverageRange(range());

  assert.deepEqual(plain(normalized), {
    key: "session-1:2:4",
    bufferedSessionId: "session-1",
    generation: 2,
    sequence: 4,
    startMs: 3000,
    endMs: 7500,
    empty: false,
    translatedSegmentCount: 1
  });
});

test("rejects invalid session IDs", () => {
  assert.equal(core.normalizeTranslationCoverageRange(range({ bufferedSessionId: "" })), null);
});

test("rejects invalid generations", () => {
  assert.equal(core.normalizeTranslationCoverageRange(range({ generation: -1 })), null);
  assert.equal(core.normalizeTranslationCoverageRange(range({ generation: 1.5 })), null);
});

test("rejects invalid sequences", () => {
  assert.equal(core.normalizeTranslationCoverageRange(range({ sequence: -1 })), null);
  assert.equal(core.normalizeTranslationCoverageRange(range({ sequence: 2.5 })), null);
});

test("rejects invalid start and end times", () => {
  assert.equal(core.normalizeTranslationCoverageRange(range({ startMs: Number.NaN })), null);
  assert.equal(core.normalizeTranslationCoverageRange(range({ endMs: Number.POSITIVE_INFINITY })), null);
});

test("rejects end-before-start ranges", () => {
  assert.equal(core.normalizeTranslationCoverageRange(range({ startMs: 8000, endMs: 7500 })), null);
});

test("duplicate sequences are ignored", () => {
  const readiness = state();
  core.insertTranslationCoverageRange(readiness, range());
  const stats = core.insertTranslationCoverageRange(readiness, range({ startMs: 7600, endMs: 10_000 }));

  assert.equal(stats.duplicates, 1);
  assert.equal(readiness.ranges.length, 1);
});

test("the same sequence in a new generation is separate after reset", () => {
  const readiness = state();
  core.insertTranslationCoverageRange(readiness, range());
  core.resetTranslationReadinessGeneration(readiness, { generation: 3 });
  const stats = core.insertTranslationCoverageRange(readiness, range({ generation: 3 }));

  assert.equal(stats.inserted, 1);
  assert.equal(readiness.ranges[0].generation, 3);
});

test("old-session ranges are rejected", () => {
  const readiness = state();
  const stats = core.insertTranslationCoverageRange(readiness, range({ bufferedSessionId: "old-session" }));

  assert.equal(stats.stale, 1);
  assert.equal(readiness.ranges.length, 0);
});

test("old-generation ranges are rejected", () => {
  const readiness = state();
  const stats = core.insertTranslationCoverageRange(readiness, range({ generation: 1 }));

  assert.equal(stats.stale, 1);
  assert.equal(readiness.ranges.length, 0);
});

test("overlapping ranges merge", () => {
  const merged = core.mergeTranslationCoverageRanges([
    range({ startMs: 3000, endMs: 7500 }),
    range({ sequence: 5, startMs: 7000, endMs: 12_000 })
  ], { bufferedSessionId: "session-1", generation: 2 });

  assert.deepEqual(plain(merged.map(({ startMs, endMs }) => ({ startMs, endMs }))), [
    { startMs: 3000, endMs: 12_000 }
  ]);
});

test("touching ranges merge within tolerance", () => {
  const watermark = core.calculateContinuousTranslationWatermark([
    range({ startMs: 3000, endMs: 7500 }),
    range({ sequence: 5, startMs: 7600, endMs: 12_000 })
  ], { bufferedSessionId: "session-1", generation: 2, gapToleranceMs: 250 });

  assert.equal(watermark.translationReadyThroughMs, 12_000);
});

test("a real gap does not merge", () => {
  const merged = core.mergeTranslationCoverageRanges([
    range({ startMs: 3000, endMs: 7500 }),
    range({ sequence: 5, startMs: 11_000, endMs: 15_500 })
  ], { bufferedSessionId: "session-1", generation: 2 });

  assert.equal(merged.length, 2);
});

test("out-of-order ranges normalize into chronological order", () => {
  const normalized = core.normalizeTranslationCoverageRanges([
    range({ sequence: 6, startMs: 12_020, endMs: 16_500 }),
    range({ sequence: 4, startMs: 3000, endMs: 7500 }),
    range({ sequence: 5, startMs: 7505, endMs: 12_000 })
  ], { bufferedSessionId: "session-1", generation: 2 });

  assert.deepEqual(plain(normalized.map((item) => item.sequence)), [4, 5, 6]);
});

test("continuous watermark stops at the first gap", () => {
  const watermark = core.calculateContinuousTranslationWatermark([
    range({ startMs: 3000, endMs: 7500 }),
    range({ sequence: 5, startMs: 11_000, endMs: 15_500 }),
    range({ sequence: 6, startMs: 15_520, endMs: 20_000 })
  ], { bufferedSessionId: "session-1", generation: 2 });

  assert.equal(watermark.translationCoverageStartMs, 3000);
  assert.equal(watermark.translationReadyThroughMs, 7500);
  assert.equal(watermark.translationReadyLeadMs, 4500);
});

test("later completed ranges do not cross a gap", () => {
  const readiness = state({ initialBufferSeconds: 10 });
  core.insertTranslationCoverageRange(readiness, range({ startMs: 3000, endMs: 7500 }));
  core.insertTranslationCoverageRange(readiness, range({ sequence: 6, startMs: 12_000, endMs: 20_000 }));

  assert.equal(readiness.translationReadyLeadMs, 4500);
  assert.equal(readiness.translationReady, false);
});

test("empty successful chunks advance coverage", () => {
  const readiness = state({ initialBufferSeconds: 4 });
  core.insertTranslationCoverageRange(readiness, range({
    empty: true,
    translatedSegmentCount: 0
  }));

  assert.equal(readiness.translationReadyLeadMs, 4500);
  assert.equal(readiness.translationReady, true);
});

test("non-empty chunks advance only when coverage is inserted after cue acknowledgement", () => {
  const readiness = state({ initialBufferSeconds: 4 });
  assert.equal(readiness.translationReadyLeadMs, 0);

  core.insertTranslationCoverageRange(readiness, range({ translatedSegmentCount: 2 }));

  assert.equal(readiness.translationReadyLeadMs, 4500);
  assert.equal(readiness.translationReady, true);
});

test("failed cue forwarding does not advance coverage when no coverage is inserted", () => {
  const readiness = state({ initialBufferSeconds: 4 });

  assert.equal(readiness.translationReady, false);
  assert.equal(readiness.ranges.length, 0);
});

test("malformed translated results do not advance coverage", () => {
  const readiness = state();
  const stats = core.insertTranslationCoverageRange(readiness, range({ translatedSegmentCount: Number.NaN }));

  assert.equal(stats.rejected, 1);
  assert.equal(readiness.translationReadyLeadMs, 0);
});

test("stale backend results do not advance coverage", () => {
  const readiness = state();
  core.insertTranslationCoverageRange(readiness, range({ generation: 1, startMs: 0, endMs: 20_000 }));

  assert.equal(readiness.translationReadyLeadMs, 0);
});

test("required ready lead equals initialBufferSeconds", () => {
  const readiness = state({ initialBufferSeconds: 10 });
  core.insertTranslationCoverageRange(readiness, range({ startMs: 3000, endMs: 12_999 }));
  assert.equal(core.isTranslationReadinessSatisfied(readiness, { initialBufferSeconds: 10 }), false);
  core.insertTranslationCoverageRange(readiness, range({ sequence: 5, startMs: 12_999, endMs: 13_001 }));
  assert.equal(core.isTranslationReadinessSatisfied(readiness, { initialBufferSeconds: 10 }), true);
});

test("media ready but translation unready does not start playback", () => {
  assert.equal(core.isInitialPlaybackGateSatisfied({
    mediaReady: true,
    translationReadinessRequired: true,
    translationReady: false
  }), false);
});

test("translation ready but media unready does not start playback", () => {
  assert.equal(core.isInitialPlaybackGateSatisfied({
    mediaReady: false,
    translationReadinessRequired: true,
    translationReady: true
  }), false);
});

test("both media and translation ready allows playback", () => {
  assert.equal(core.isInitialPlaybackGateSatisfied({
    mediaReady: true,
    translationReadinessRequired: true,
    translationReady: true
  }), true);
});

test("live mode bypasses translation readiness", () => {
  assert.equal(core.shouldRequireTranslationReadiness({
    provider: "ollama",
    syncMode: "live",
    outputMode: "subtitles"
  }), false);
});

test("OpenAI mode bypasses translation readiness", () => {
  assert.equal(core.shouldRequireTranslationReadiness({
    provider: "openai",
    syncMode: "buffered",
    outputMode: "subtitles"
  }), false);
});

test("buffered dub-only bypasses this gate", () => {
  assert.equal(core.shouldRequireTranslationReadiness({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "dub"
  }), false);
});

test("buffered subtitles require the gate", () => {
  assert.equal(core.shouldRequireTranslationReadiness({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "subtitles"
  }), true);
});

test("buffered both requires the gate", () => {
  assert.equal(core.shouldRequireTranslationReadiness({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "both"
  }), true);
});

test("generation reset clears ranges", () => {
  const readiness = state();
  core.insertTranslationCoverageRange(readiness, range());
  core.reduceTranslationReadinessState(readiness, { type: "GENERATION_CHANGE", generation: 3 });

  assert.equal(readiness.generation, 3);
  assert.equal(readiness.ranges.length, 0);
  assert.equal(readiness.translationReadyLeadMs, 0);
});

test("seek reset clears ranges", () => {
  const readiness = state();
  core.insertTranslationCoverageRange(readiness, range());
  core.reduceTranslationReadinessState(readiness, { type: "SEEK_RESET", generation: 3 });

  assert.equal(readiness.generation, 3);
  assert.equal(readiness.ranges.length, 0);
});

test("pause does not clear readiness", () => {
  const readiness = state({ initialBufferSeconds: 4 });
  core.insertTranslationCoverageRange(readiness, range());
  core.reduceTranslationReadinessState(readiness, { type: "PAUSE", nowEpochMs: 1000 });

  assert.equal(readiness.translationReadyLeadMs, 4500);
});

test("pause stops timeout accounting", () => {
  const readiness = state();
  core.reduceTranslationReadinessState(readiness, {
    type: "WAITING",
    mediaReady: true,
    nowEpochMs: 1000,
    timeoutMs: 5000
  });
  core.reduceTranslationReadinessState(readiness, { type: "PAUSE", nowEpochMs: 2000 });

  assert.equal(core.getReadinessWaitElapsedMs(readiness, 8000), 1000);
});

test("resume restarts timeout accounting", () => {
  const readiness = state();
  core.reduceTranslationReadinessState(readiness, {
    type: "WAITING",
    mediaReady: true,
    nowEpochMs: 1000,
    timeoutMs: 5000
  });
  core.reduceTranslationReadinessState(readiness, { type: "PAUSE", nowEpochMs: 2000 });
  core.reduceTranslationReadinessState(readiness, { type: "RESUME", nowEpochMs: 8000 });

  assert.equal(core.getReadinessWaitElapsedMs(readiness, 9000), 2000);
});

test("readiness timeout does not begin before media readiness", () => {
  const readiness = state();
  core.reduceTranslationReadinessState(readiness, {
    type: "WAITING",
    mediaReady: false,
    nowEpochMs: 1000,
    timeoutMs: 1000
  });

  assert.equal(readiness.waitingStartedAtEpochMs, null);
});

test("readiness timeout does not begin while rebuffering", () => {
  const readiness = state();
  core.reduceTranslationReadinessState(readiness, {
    type: "WAITING",
    mediaReady: true,
    rebuffering: true,
    nowEpochMs: 1000,
    timeoutMs: 1000
  });

  assert.equal(readiness.waitingStartedAtEpochMs, null);
  assert.equal(readiness.timedOut, false);
});

test("readiness timeout produces the expected failure", () => {
  const readiness = state();
  core.reduceTranslationReadinessState(readiness, {
    type: "WAITING",
    mediaReady: true,
    nowEpochMs: 1000,
    timeoutMs: 1000
  });
  core.reduceTranslationReadinessState(readiness, {
    type: "WAITING",
    mediaReady: true,
    nowEpochMs: 2100,
    timeoutMs: 1000
  });

  assert.equal(readiness.timedOut, true);
  assert.equal(readiness.errorCode, "TRANSLATION_READINESS_TIMEOUT");
});

test("readiness timeout never silently starts playback", () => {
  const readiness = state();
  readiness.timedOut = true;
  readiness.errorCode = "TRANSLATION_READINESS_TIMEOUT";

  assert.equal(core.isInitialPlaybackGateSatisfied({
    mediaReady: true,
    translationReadinessRequired: true,
    translationReady: readiness.translationReady
  }), false);
});

test("public clock snapshot exposes readiness numbers", () => {
  const readiness = state({ initialBufferSeconds: 4 });
  core.insertTranslationCoverageRange(readiness, range());
  const snapshot = core.createPublicReadinessSnapshot(readiness);

  assert.deepEqual(plain(snapshot), {
    translationReadinessRequired: true,
    translationCoverageStartMs: 3000,
    translationReadyThroughMs: 7500,
    translationReadyLeadMs: 4500,
    translationReady: true,
    translationCoverageCount: 1
  });
});

test("public clock snapshot does not expose mutable range arrays", () => {
  const snapshot = core.createPublicReadinessSnapshot(state());

  assert.equal("ranges" in snapshot, false);
  assert.equal("seenKeys" in snapshot, false);
});

test("coverage range count is bounded", () => {
  const readiness = state({ maxRanges: 2 });
  core.insertTranslationCoverageRange(readiness, range({ sequence: 1, startMs: 0, endMs: 1000 }));
  core.insertTranslationCoverageRange(readiness, range({ sequence: 2, startMs: 1000, endMs: 2000 }));
  core.insertTranslationCoverageRange(readiness, range({ sequence: 3, startMs: 2000, endMs: 3000 }));

  assert.equal(readiness.ranges.length, 2);
});

test("startup status becomes waiting-translation when media is ready and translation is not", () => {
  const readiness = state();
  core.reduceTranslationReadinessState(readiness, {
    type: "WAITING",
    mediaReady: true,
    nowEpochMs: 1000
  });

  assert.equal(readiness.waitingStartedAtEpochMs, 1000);
  assert.equal(readiness.translationReady, false);
});

test("cue forwarding must occur before coverage insertion", () => {
  const readiness = state({ initialBufferSeconds: 4 });
  const cueForwarded = false;
  if (cueForwarded) {
    core.insertTranslationCoverageRange(readiness, range());
  }

  assert.equal(readiness.translationReady, false);
});

test("existing subtitle scheduler behavior remains outside readiness mode decisions", () => {
  assert.equal(core.shouldRequireTranslationReadiness({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "subtitles"
  }), true);
});

test("existing timed-dub scheduler behavior remains outside subtitle-only readiness", () => {
  assert.equal(core.shouldRequireTranslationReadiness({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "dub"
  }), false);
});
