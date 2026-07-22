import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./timed-dub-scheduler-core.js", import.meta.url), "utf8");
const sandbox = {
  globalThis: null,
  atob(value) {
    return Buffer.from(value, "base64").toString("binary");
  },
  Uint8Array
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "timed-dub-scheduler-core.js" });
const core = sandbox.AutoTranslateTimedDubSchedulerCore;

const AUDIO_BASE64 = Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function clip(overrides = {}) {
  return {
    id: "g2-q4-s0",
    bufferedSessionId: "session-1",
    generation: 2,
    sequence: 4,
    startMs: 1000,
    endMs: 2000,
    speakerId: "speaker_1",
    voiceId: "en_us_lessac_medium",
    audioBase64: AUDIO_BASE64,
    audioMime: "audio/wav",
    audioDurationMs: 800,
    targetWindowDurationMs: 1000,
    durationRatio: 0.8,
    ...overrides
  };
}

function queue(overrides = {}) {
  return core.createTimedDubQueue({
    bufferedSessionId: "session-1",
    generation: 2,
    ...overrides
  });
}

function decoded(queueState, rawClip) {
  core.insertTimedDubClips(queueState, [rawClip]);
  const item = queueState.pending.find((candidate) => candidate.id === rawClip.id);
  item.state = "decoding";
  core.markClipDecoded(queueState, item.key, { duration: item.audioDurationMs / 1000 }, item.audioDurationMs);
  return item;
}

test("normalizes a valid timed dub clip", () => {
  const normalized = core.normalizeTimedDubClip(clip());
  assert.equal(normalized.id, "g2-q4-s0");
  assert.equal(normalized.key, "session-1:2:g2-q4-s0");
  assert.equal(normalized.state, "queued");
});

test("rejects an empty timed dub clip ID", () => {
  assert.equal(core.normalizeTimedDubClip(clip({ id: "" })), null);
});

test("rejects invalid start and end times", () => {
  assert.equal(core.normalizeTimedDubClip(clip({ startMs: Number.NaN })), null);
  assert.equal(core.normalizeTimedDubClip(clip({ endMs: Number.POSITIVE_INFINITY })), null);
});

test("rejects end-before-start timed dub clips", () => {
  assert.equal(core.normalizeTimedDubClip(clip({ startMs: 3000, endMs: 2000 })), null);
});

test("rejects invalid audio duration", () => {
  assert.equal(core.normalizeTimedDubClip(clip({ audioDurationMs: 0 })), null);
});

test("rejects invalid audio MIME types", () => {
  assert.equal(core.normalizeTimedDubClip(clip({ audioMime: "text/plain" })), null);
});

test("rejects excessive Base64 payloads", () => {
  assert.equal(core.normalizeTimedDubClip(clip({ audioBase64: "AAAA" }), { maxBase64Chars: 3 }), null);
});

test("orders queued clips deterministically", () => {
  const state = queue();
  core.insertTimedDubClips(state, [
    clip({ id: "later", startMs: 3000, endMs: 4000, sequence: 6 }),
    clip({ id: "first-b", startMs: 1000, endMs: 1800, sequence: 5 }),
    clip({ id: "first-a", startMs: 1000, endMs: 1600, sequence: 4 })
  ]);
  assert.deepEqual(plain(state.pending.map((item) => item.id)), ["first-a", "first-b", "later"]);
});

test("out-of-order backend responses become source-time ordered", () => {
  const state = queue();
  core.insertTimedDubClips(state, [clip({ id: "s6", startMs: 6000, endMs: 7000, sequence: 6 })]);
  core.insertTimedDubClips(state, [clip({ id: "s5", startMs: 5000, endMs: 5900, sequence: 5 })]);
  assert.deepEqual(plain(state.pending.map((item) => item.id)), ["s5", "s6"]);
});

test("duplicate timed dub clips are ignored", () => {
  const state = queue();
  core.insertTimedDubClips(state, [clip()]);
  const stats = core.insertTimedDubClips(state, [clip({ audioDurationMs: 900 })]);
  assert.equal(stats.duplicates, 1);
  assert.equal(state.pending.length, 1);
});

test("the same ID in a new generation is treated as separate", () => {
  const state = queue();
  core.insertTimedDubClips(state, [clip()]);
  core.reduceTimedDubSchedulerState(state, { type: "GENERATION_CHANGE", generation: 3 });
  const stats = core.insertTimedDubClips(state, [clip({ generation: 3 })]);
  assert.equal(stats.inserted, 1);
  assert.equal(state.pending[0].generation, 3);
});

test("old-session clips are rejected", () => {
  const state = queue();
  const stats = core.insertTimedDubClips(state, [clip({ bufferedSessionId: "old-session" })]);
  assert.equal(stats.stale, 1);
  assert.equal(state.pending.length, 0);
});

test("old-generation clips are rejected", () => {
  const state = queue();
  const stats = core.insertTimedDubClips(state, [clip({ generation: 1 })]);
  assert.equal(stats.stale, 1);
});

test("queue capacity is bounded", () => {
  const state = queue({ queueLimit: 2 });
  core.insertTimedDubClips(state, [
    clip({ id: "near", startMs: 1000, endMs: 2000 }),
    clip({ id: "middle", startMs: 3000, endMs: 4000 }),
    clip({ id: "far", startMs: 5000, endMs: 6000 })
  ]);
  assert.deepEqual(plain(state.pending.map((item) => item.id)), ["near", "middle"]);
});

test("completed records are removed before queue limiting", () => {
  const state = queue({ queueLimit: 1 });
  const done = core.normalizeTimedDubClip(clip({ id: "done", state: "completed" }));
  state.pending.push(done);
  core.insertTimedDubClips(state, [clip({ id: "next", startMs: 2000, endMs: 3000 })]);
  assert.deepEqual(plain(state.pending.map((item) => item.id)), ["next"]);
});

test("future clips stay queued", () => {
  const state = queue();
  decoded(state, clip({ startMs: 5000, endMs: 6000 }));
  assert.deepEqual(plain(core.selectDueTimedDubClips(state, 1000)), []);
  assert.equal(state.pending.length, 1);
});

test("due clips are selected for playback", () => {
  const state = queue();
  decoded(state, clip());
  assert.deepEqual(plain(core.selectDueTimedDubClips(state, 1000).map((item) => item.id)), ["g2-q4-s0"]);
});

test("expired clips are dropped", () => {
  const state = queue();
  decoded(state, clip());
  core.discardExpiredTimedDubClips(state, 2000);
  assert.equal(state.pending.length, 0);
  assert.equal(state.counters.droppedExpired, 1);
});

test("clips decoded during their active interval start proportionally", () => {
  const decision = core.buildPlaybackStartDecision(
    { ...clip(), decodedDurationMs: 1000 },
    1250
  );
  assert.equal(decision.action, "play");
  assert.equal(decision.startedLate, true);
});

test("proportional audio offset at 25 percent", () => {
  const decision = core.buildPlaybackStartDecision({ ...clip(), decodedDurationMs: 2000 }, 1250);
  assert.equal(decision.audioOffsetMs, 500);
});

test("proportional audio offset at 50 percent", () => {
  const decision = core.buildPlaybackStartDecision({ ...clip(), decodedDurationMs: 2000 }, 1500);
  assert.equal(decision.audioOffsetMs, 1000);
});

test("proportional audio offset at 75 percent", () => {
  const decision = core.buildPlaybackStartDecision({ ...clip(), decodedDurationMs: 2000 }, 1750);
  assert.equal(decision.audioOffsetMs, 1500);
});

test("offset never exceeds decoded duration", () => {
  const decision = core.buildPlaybackStartDecision({ ...clip(), decodedDurationMs: 1000 }, 1999, {
    minPlayableRemainderMs: 1
  });
  assert.equal(decision.audioOffsetMs <= 1000, true);
});

test("tiny remaining playback is dropped", () => {
  const decision = core.buildPlaybackStartDecision({ ...clip(), decodedDurationMs: 1000 }, 1950);
  assert.equal(decision.action, "drop");
  assert.equal(decision.reason, "tiny-remainder");
});

test("overlong clips are stopped at the source interval end", () => {
  assert.equal(core.shouldStopActiveClip(clip({ endMs: 2000 }), 2075), true);
});

test("short clips may end naturally before the source interval closes", () => {
  assert.equal(core.shouldStopActiveClip(clip({ audioDurationMs: 500, endMs: 2000 }), 1500), false);
});

test("timed dub playback does not fit audio with playbackRate changes", () => {
  assert.equal(core.getTimedDubPlaybackRate(), 1);
});

test("pause status asks the scheduler to suspend audio", () => {
  assert.equal(core.shouldSuspendForClockStatus("paused"), true);
});

test("resume status asks the scheduler to resume audio", () => {
  assert.equal(core.shouldResumeForClockStatus("playing"), true);
});

test("buffering status does not advance audio", () => {
  assert.equal(core.shouldSuspendForClockStatus("buffering"), true);
  assert.equal(core.shouldSuspendForClockStatus("rebuffering"), true);
});

test("generation reset clears active clips and increments the scheduler epoch", () => {
  const state = queue();
  const item = decoded(state, clip());
  core.markClipPlaying(state, item, { delayedSourceTimeMs: 1000 });
  const epoch = state.schedulerEpoch;
  core.reduceTimedDubSchedulerState(state, { type: "GENERATION_CHANGE", generation: 3 });
  assert.equal(state.generation, 3);
  assert.equal(state.active.length, 0);
  assert.equal(state.schedulerEpoch, epoch + 1);
});

test("seek reset invalidates old decode completion", () => {
  const state = queue();
  const epoch = state.schedulerEpoch;
  core.reduceTimedDubSchedulerState(state, { type: "SEEK_RESET", generation: 3 });
  assert.equal(core.isCurrentSchedulerEpoch(epoch, state), false);
});

test("scheduler epoch prevents stale async re-entry", () => {
  const state = queue();
  assert.equal(core.isCurrentSchedulerEpoch(state.schedulerEpoch, state), true);
  core.reduceTimedDubSchedulerState(state, { type: "PIPELINE_RESET", pipelineEpoch: 7 });
  assert.equal(core.isCurrentSchedulerEpoch(0, state), false);
});

test("two overlapping timed dub clips are supported", () => {
  const state = queue();
  decoded(state, clip({ id: "a", startMs: 1000, endMs: 2200 }));
  decoded(state, clip({ id: "b", startMs: 1100, endMs: 2300 }));
  assert.deepEqual(plain(core.selectDueTimedDubClips(state, 1200).map((item) => item.id)), ["a", "b"]);
});

test("more than two overlapping timed dub clips are bounded deterministically", () => {
  const state = queue();
  decoded(state, clip({ id: "c", startMs: 1000, endMs: 2300 }));
  decoded(state, clip({ id: "b", startMs: 1000, endMs: 2200 }));
  decoded(state, clip({ id: "a", startMs: 1000, endMs: 2100 }));
  assert.deepEqual(plain(core.selectDueTimedDubClips(state, 1200).map((item) => item.id)), ["a", "b"]);
});

test("active-count ducking mutes original audio in dub mode", () => {
  assert.equal(core.getDuckedOriginalVolume({ activeClipCount: 1, outputMode: "dub", originalVolume: 0.7 }), 0);
});

test("active-count ducking lowers original audio in both mode", () => {
  assert.equal(core.getDuckedOriginalVolume({ activeClipCount: 1, outputMode: "both", originalVolume: 0.5 }), 0.1);
});

test("original volume is restored after the final clip", () => {
  assert.equal(core.getDuckedOriginalVolume({ activeClipCount: 0, outputMode: "dub", originalVolume: 0.4 }), 0.4);
});

test("cleanup restores original volume policy", () => {
  assert.equal(core.getDuckedOriginalVolume({ activeClipCount: 0, outputMode: "both", originalVolume: 0.25 }), 0.25);
});

test("malformed Base64 affects only one clip", () => {
  const state = queue();
  const stats = core.insertTimedDubClips(state, [
    clip({ id: "bad", audioBase64: "not base64!" }),
    clip({ id: "good" })
  ]);
  assert.equal(stats.rejected, 1);
  assert.deepEqual(plain(state.pending.map((item) => item.id)), ["good"]);
});

test("decode failure affects only one clip", () => {
  const state = queue();
  decoded(state, clip({ id: "good" }));
  core.insertTimedDubClips(state, [clip({ id: "bad" })]);
  const bad = state.pending.find((item) => item.id === "bad");
  bad.state = "decoding";
  core.markClipDecodeFailed(state, bad.key);
  assert.equal(state.pending.find((item) => item.id === "good").state, "ready");
  assert.equal(state.pending.find((item) => item.id === "bad").state, "failed");
});

test("clock session mismatch is rejected", () => {
  const state = queue();
  const result = core.classifyClockSnapshot({
    bufferedSessionId: "old-session",
    generation: 2,
    status: "playing",
    delayedSourceTimeMs: 1000
  }, state);
  assert.equal(result.action, "reject");
});

test("clock generation mismatch triggers reset", () => {
  const state = queue();
  const result = core.classifyClockSnapshot({
    bufferedSessionId: "session-1",
    generation: 3,
    status: "rebuffering",
    delayedSourceTimeMs: null
  }, state);
  assert.equal(result.action, "reset");
});

test("temporary clock unavailability retries", () => {
  assert.equal(core.shouldRetryClockWait(1000, 2000), true);
});

test("persistent clock unavailability stops retrying", () => {
  assert.equal(core.shouldRetryClockWait(1000, 20_001, 15_000), false);
});

test("start and stop can create a fresh scheduler session", () => {
  const state = queue();
  core.insertTimedDubClips(state, [clip()]);
  core.reduceTimedDubSchedulerState(state, {
    type: "RESET_SESSION",
    bufferedSessionId: "session-2",
    generation: 0
  });
  assert.equal(state.bufferedSessionId, "session-2");
  assert.equal(state.generation, 0);
  assert.equal(state.pending.length, 0);
});

test("double stop is safe", () => {
  const state = queue();
  core.insertTimedDubClips(state, [clip()]);
  core.reduceTimedDubSchedulerState(state, { type: "STOP" });
  core.reduceTimedDubSchedulerState(state, { type: "STOP" });
  assert.equal(state.pending.length, 0);
  assert.equal(state.active.length, 0);
});

test("live mode does not activate the timed dub scheduler", () => {
  assert.equal(core.shouldUseTimedDubScheduler({
    provider: "ollama",
    syncMode: "live",
    outputMode: "dub"
  }), false);
});

test("OpenAI mode does not activate the timed dub scheduler", () => {
  assert.equal(core.shouldUseTimedDubScheduler({
    provider: "openai",
    syncMode: "buffered",
    outputMode: "dub"
  }), false);
});

test("subtitle-only mode does not activate the timed dub scheduler", () => {
  assert.equal(core.shouldUseTimedDubScheduler({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "subtitles"
  }), false);
});

test("local buffered dub-capable modes activate the timed dub scheduler", () => {
  assert.equal(core.shouldUseTimedDubScheduler({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "dub"
  }), true);
  assert.equal(core.shouldUseTimedDubScheduler({
    provider: "ollama",
    syncMode: "buffered",
    outputMode: "both"
  }), true);
});

test("live immediate queue behavior remains outside timed scheduling", () => {
  assert.equal(core.shouldUseTimedDubScheduler({
    provider: "ollama",
    syncMode: "live",
    outputMode: "both"
  }), false);
});

test("stop cleanup clears active clips", () => {
  const state = queue();
  const item = decoded(state, clip());
  core.markClipPlaying(state, item, { delayedSourceTimeMs: 1000 });
  core.reduceTimedDubSchedulerState(state, { type: "STOP" });
  assert.equal(state.active.length, 0);
});

test("Base64 decoding returns an ArrayBuffer", () => {
  const buffer = core.decodeBase64ToArrayBuffer(AUDIO_BASE64);
  assert.equal(buffer.byteLength, 6);
});
