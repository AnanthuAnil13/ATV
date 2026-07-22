import test from "node:test";
import assert from "node:assert/strict";
import {
  clampInitialBufferSeconds,
  normalizeSyncMode,
  shouldActivateBufferedPlayer,
  validatePlaybackMode
} from "./playback-settings.js";

test("clampInitialBufferSeconds clamps to the supported 5 to 30 second range", () => {
  assert.equal(clampInitialBufferSeconds(4), 5);
  assert.equal(clampInitialBufferSeconds(5), 5);
  assert.equal(clampInitialBufferSeconds(12.5), 12.5);
  assert.equal(clampInitialBufferSeconds(31), 30);
  assert.equal(clampInitialBufferSeconds("not a number"), 10);
});

test("normalizeSyncMode defaults unknown values to live", () => {
  assert.equal(normalizeSyncMode("buffered"), "buffered");
  assert.equal(normalizeSyncMode("live"), "live");
  assert.equal(normalizeSyncMode("other"), "live");
});

test("Live mode does not activate the buffered player", () => {
  assert.equal(shouldActivateBufferedPlayer({ provider: "ollama", syncMode: "live" }), false);
  assert.equal(shouldActivateBufferedPlayer({ provider: "openai", syncMode: "buffered" }), false);
  assert.equal(shouldActivateBufferedPlayer({ provider: "ollama", syncMode: "buffered" }), true);
});

test("OpenAI buffered mode is rejected with a clear validation error", () => {
  assert.throws(
    () => validatePlaybackMode({ provider: "openai", syncMode: "buffered" }),
    /only available with Ollama local mode/
  );
});
