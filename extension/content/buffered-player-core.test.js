import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./buffered-player-core.js", import.meta.url), "utf8");
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "buffered-player-core.js" });
const core = sandbox.AutoTranslateBufferedPlayerCore;

function timeRanges(ranges) {
  return {
    length: ranges.length,
    start(index) {
      return ranges[index][0];
    },
    end(index) {
      return ranges[index][1];
    }
  };
}

test("selectPrimaryVideo chooses the largest visible playing video", () => {
  const tinyPreview = {
    id: "preview",
    rect: { width: 80, height: 45 },
    paused: false,
    ended: false,
    readyState: 4
  };
  const smallerPlaying = {
    id: "small-playing",
    rect: { width: 640, height: 360 },
    paused: false,
    ended: false,
    readyState: 4
  };
  const largerPlaying = {
    id: "large-playing",
    rect: { width: 1280, height: 720 },
    paused: false,
    ended: false,
    readyState: 4
  };
  const hugePaused = {
    id: "huge-paused",
    rect: { width: 1920, height: 1080 },
    paused: true,
    ended: false,
    readyState: 4
  };

  assert.equal(
    core.selectPrimaryVideo([tinyPreview, smallerPlaying, largerPlaying, hugePaused]),
    largerPlaying
  );
});

test("pickBufferedRecorderMimeType chooses the first type supported by MediaRecorder and MediaSource", () => {
  const fakeRecorder = {
    isTypeSupported(type) {
      return type === "video/webm;codecs=vp8,opus" || type === "video/webm";
    }
  };
  const fakeMediaSource = {
    isTypeSupported(type) {
      return type === "video/webm;codecs=vp8,opus";
    }
  };

  assert.equal(
    core.pickBufferedRecorderMimeType(fakeRecorder, fakeMediaSource),
    "video/webm;codecs=vp8,opus"
  );
});

test("isInitialBufferReady uses playable buffered media ahead of currentTime", () => {
  assert.equal(
    core.isInitialBufferReady({
      buffered: timeRanges([[0, 9.9]]),
      currentTime: 0,
      initialBufferSeconds: 10
    }),
    false
  );
  assert.equal(
    core.isInitialBufferReady({
      buffered: timeRanges([[0, 13.1]]),
      currentTime: 3,
      initialBufferSeconds: 10
    }),
    true
  );
});

test("createSegmentQueue preserves append order", () => {
  const queue = core.createSegmentQueue(0);
  const first = { sequence: 0, blob: new Blob(["first"]) };
  const second = { sequence: 1, blob: new Blob(["second"]) };

  queue.enqueue(first);
  queue.enqueue(second);

  assert.equal(queue.size, 2);
  assert.equal(queue.shift(), first);
  assert.equal(queue.shift(), second);
});

test("createSegmentQueue rejects out-of-order segments", () => {
  const queue = core.createSegmentQueue(0);

  assert.throws(
    () => queue.enqueue({ sequence: 1, blob: new Blob(["late"]) }),
    /Out-of-order media segment/
  );
  assert.equal(queue.size, 0);
  assert.equal(queue.expectedSequence, 0);
});

test("reducePlayerLifecycle supports idempotent cleanup transitions", () => {
  let phase = "idle";
  phase = core.reducePlayerLifecycle(phase, "START");
  phase = core.reducePlayerLifecycle(phase, "READY");
  assert.equal(phase, "playing");

  phase = core.reducePlayerLifecycle(phase, "STOP");
  assert.equal(phase, "stopped");
  assert.equal(core.reducePlayerLifecycle(phase, "STOP"), "stopped");
});
