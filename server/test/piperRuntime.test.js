import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PIPER_CLI_ARGUMENT_INVALID,
  PIPER_OUTPUT_EMPTY,
  PIPER_OUTPUT_MISSING,
  PIPER_RUNTIME_UNAVAILABLE,
  PIPER_SYNTHESIS_FAILED,
  PIPER_SYNTHESIS_TIMEOUT,
  PIPER_VOICE_NOT_FOUND,
  buildPiperInvocation,
  buildSafePiperError,
  checkPiperRuntime,
  normalizePiperInputText,
  resolvePiperVoiceModel,
  sanitizePublicVoiceId,
  synthesizePiperToFile
} from "../src/piperRuntime.js";
import {
  PIPER_WAV_INVALID,
  buildTimedDubClipResponse
} from "../src/timedDubSegments.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autotranslate-piper-test-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeVoice(dir, name = "en_US-lessac-medium") {
  const model = path.join(dir, `${name}.onnx`);
  await writeFile(model, "model");
  await writeFile(`${model}.json`, "{}");
  return model;
}

function voice(overrides = {}) {
  return {
    id: "en_US-lessac-medium",
    model: "en_US-lessac-medium",
    args: [],
    ...overrides
  };
}

function wavBuffer({ sampleRate = 16_000, durationMs = 500 } = {}) {
  const byteRate = sampleRate * 2;
  const dataSize = Math.round(byteRate * durationMs / 1000);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const data = Buffer.alloc(dataSize);
  const chunks = [chunk("fmt ", fmt), chunk("data", data)];
  return Buffer.concat([Buffer.from("RIFF"), uint32(4 + chunks.reduce((sum, item) => sum + item.length, 0)), Buffer.from("WAVE"), ...chunks]);
}

function chunk(id, payload) {
  return Buffer.concat([Buffer.from(id), uint32(payload.length), payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

async function invocationFixture(dir, overrides = {}) {
  await writeVoice(dir);
  return buildPiperInvocation({
    command: "python",
    commandArgs: ["-m", "piper"],
    voice: voice(overrides.voice),
    outputPath: path.join(dir, "out.wav"),
    text: overrides.text ?? "Hello world.",
    dataDirs: [dir],
    cwd: dir
  });
}

test("Piper command uses configured executable", async () => withTempDir(async (dir) => {
  const invocation = await invocationFixture(dir, { text: "Hello." });

  assert.equal(invocation.command, "python");
}));

test("PIPER_COMMAND_ARGS=-m piper is preserved", async () => withTempDir(async (dir) => {
  const invocation = await invocationFixture(dir);

  assert.deepEqual(invocation.args.slice(0, 2), ["-m", "piper"]);
}));

test("model option is included once for the Piper CLI model", async () => withTempDir(async (dir) => {
  const invocation = await invocationFixture(dir);
  const modelIndex = invocation.args.findIndex((item, index) => index >= 2 && item === "-m");

  assert.notEqual(modelIndex, -1);
  assert.equal(invocation.args.filter((item, index) => index >= 2 && item === "-m").length, 1);
}));

test("output-file option is included once", async () => withTempDir(async (dir) => {
  const invocation = await invocationFixture(dir);

  assert.equal(invocation.args.filter((item) => item === "-f").length, 1);
  assert.equal(invocation.args.at(-2), "-f");
}));

test("text is passed through stdin when required", async () => withTempDir(async (dir) => {
  const invocation = await invocationFixture(dir);

  assert.equal(invocation.usesStdin, true);
  assert.equal(invocation.stdin, "Hello world.\n");
}));

test("text is not appended as an unsafe positional argument", async () => withTempDir(async (dir) => {
  const invocation = await invocationFixture(dir, { text: "Sensitive sentence." });

  assert.equal(invocation.args.includes("Sensitive sentence."), false);
}));

test("Unicode input is preserved", () => {
  assert.equal(normalizePiperInputText("こんにちは、世界。"), "こんにちは、世界。\n");
});

test("empty input is rejected before spawning", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  let calls = 0;
  await assert.rejects(
    synthesizePiperToFile({
      command: "python",
      commandArgs: ["-m", "piper"],
      voice: voice(),
      outputPath: path.join(dir, "out.wav"),
      text: "   ",
      dataDirs: [dir],
      cwd: dir,
      runCommand: async () => { calls += 1; }
    }),
    (error) => error.code === PIPER_SYNTHESIS_FAILED
  );
  assert.equal(calls, 0);
}));

test("defensive input-length limit is applied", () => {
  const text = normalizePiperInputText("abcdef", { limit: 3 });

  assert.equal(text, "abc\n");
});

test("voice-specific args are preserved", async () => withTempDir(async (dir) => {
  const invocation = await invocationFixture(dir, {
    voice: { args: ["--length-scale", "1.05", "--speaker", "2"] }
  });

  assert.ok(invocation.args.includes("--length-scale"));
  assert.ok(invocation.args.includes("--speaker"));
}));

test("voice name configuration is accepted when supported by data dir", async () => withTempDir(async (dir) => {
  const model = await writeVoice(dir);
  const resolved = await resolvePiperVoiceModel(voice(), { dataDirs: [dir], cwd: dir });

  assert.equal(resolved.modelPath, model);
}));

test("explicit .onnx path is accepted", async () => withTempDir(async (dir) => {
  const model = await writeVoice(dir, "voice-a");
  const resolved = await resolvePiperVoiceModel(voice({ model }), { cwd: dir });

  assert.equal(resolved.modelArgument, model);
}));

test("missing explicit model file is rejected", async () => withTempDir(async (dir) => {
  await assert.rejects(
    resolvePiperVoiceModel(voice({ model: path.join(dir, "missing.onnx") }), { cwd: dir }),
    (error) => error.code === PIPER_VOICE_NOT_FOUND
  );
}));

test("missing required .onnx.json is rejected", async () => withTempDir(async (dir) => {
  const model = path.join(dir, "voice-a.onnx");
  await writeFile(model, "model");

  await assert.rejects(
    resolvePiperVoiceModel(voice({ model }), { cwd: dir }),
    (error) => error.code === PIPER_VOICE_NOT_FOUND
  );
}));

test("safe public voice ID does not expose an absolute path", () => {
  assert.equal(sanitizePublicVoiceId({ model: "/private/path/en_US-lessac-medium.onnx" }), "en_us_lessac_medium");
});

test("spawn failure maps to a Piper runtime error", () => {
  const error = new Error("Could not start python");
  error.spawnErrorCode = "ENOENT";
  const safe = buildSafePiperError(error, { command: "python" });

  assert.equal(safe.code, PIPER_RUNTIME_UNAVAILABLE);
});

test("non-zero exit maps to synthesis error", () => {
  const error = new Error("python exited with code 1");
  error.exitCode = 1;
  const safe = buildSafePiperError(error, { command: "python" });

  assert.equal(safe.code, PIPER_SYNTHESIS_FAILED);
});

test("CLI-argument failure is identified from stderr", () => {
  const error = new Error("python exited with code 2");
  error.stderr = "usage: piper\\nunrecognized arguments: --bad";
  const safe = buildSafePiperError(error, { command: "python" });

  assert.equal(safe.code, PIPER_CLI_ARGUMENT_INVALID);
});

test("timeout remains handled", () => {
  const error = new Error("timed out");
  error.timedOut = true;
  const safe = buildSafePiperError(error, { command: "python" });

  assert.equal(safe.code, PIPER_SYNTHESIS_TIMEOUT);
});

test("stdin EPIPE does not leak through safe errors", () => {
  const error = new Error("python exited with code 1");
  error.exitCode = 1;
  error.stdinErrorCode = "EPIPE";
  const safe = buildSafePiperError(error, { command: "python" });

  assert.equal(safe.code, PIPER_SYNTHESIS_FAILED);
});

test("process settlement occurs only once through synthesis runner", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  let calls = 0;
  await assert.rejects(
    synthesizePiperToFile({
      command: "python",
      commandArgs: ["-m", "piper"],
      voice: voice(),
      outputPath: path.join(dir, "out.wav"),
      text: "Hello.",
      dataDirs: [dir],
      cwd: dir,
      runCommand: async () => {
        calls += 1;
        const error = new Error("python exited with code 1");
        error.exitCode = 1;
        throw error;
      }
    }),
    (error) => error.code === PIPER_SYNTHESIS_FAILED
  );
  assert.equal(calls, 1);
}));

test("missing output WAV is rejected", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  await assert.rejects(
    synthesizePiperToFile({
      command: "python",
      commandArgs: ["-m", "piper"],
      voice: voice(),
      outputPath: path.join(dir, "missing.wav"),
      text: "Hello.",
      dataDirs: [dir],
      cwd: dir,
      runCommand: async () => {}
    }),
    (error) => error.code === PIPER_OUTPUT_MISSING
  );
}));

test("empty output WAV is rejected", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  const outputPath = path.join(dir, "empty.wav");
  await assert.rejects(
    synthesizePiperToFile({
      command: "python",
      commandArgs: ["-m", "piper"],
      voice: voice(),
      outputPath,
      text: "Hello.",
      dataDirs: [dir],
      cwd: dir,
      runCommand: async () => writeFile(outputPath, Buffer.alloc(0))
    }),
    (error) => error.code === PIPER_OUTPUT_EMPTY
  );
}));

test("invalid WAV is rejected", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  const outputPath = path.join(dir, "invalid.wav");
  await assert.rejects(
    synthesizePiperToFile({
      command: "python",
      commandArgs: ["-m", "piper"],
      voice: voice(),
      outputPath,
      text: "Hello.",
      dataDirs: [dir],
      cwd: dir,
      runCommand: async () => writeFile(outputPath, "not wav")
    }),
    (error) => error.code === PIPER_WAV_INVALID
  );
}));

test("valid WAV with positive duration succeeds", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  const outputPath = path.join(dir, "valid.wav");
  const result = await synthesizePiperToFile({
    command: "python",
    commandArgs: ["-m", "piper"],
    voice: voice(),
    outputPath,
    text: "Hello.",
    dataDirs: [dir],
    cwd: dir,
    runCommand: async () => writeFile(outputPath, wavBuffer({ durationMs: 750 }))
  });

  assert.equal(result.audioDurationMs, 750);
  assert.ok(result.audioBuffer.length > 0);
}));

test("Live dub uses corrected synthesis helper", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  const outputPath = path.join(dir, "live.wav");
  const result = await synthesizePiperToFile({
    command: "python",
    commandArgs: ["-m", "piper"],
    voice: voice(),
    outputPath,
    text: "Live line.",
    dataDirs: [dir],
    cwd: dir,
    runCommand: async (command, args, options) => {
      assert.equal(options.stdin, "Live line.\n");
      await writeFile(outputPath, wavBuffer());
    }
  });

  assert.equal(result.usesStdin, true);
}));

test("Buffered timed dub uses corrected synthesis helper", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  const outputPath = path.join(dir, "timed.wav");
  const result = await synthesizePiperToFile({
    command: "python",
    commandArgs: ["-m", "piper"],
    voice: voice(),
    outputPath,
    text: "Timed line.",
    dataDirs: [dir],
    cwd: dir,
    runCommand: async () => writeFile(outputPath, wavBuffer({ durationMs: 900 }))
  });

  assert.equal(result.audioDurationMs, 900);
}));

test("existing timed clip response fields remain unchanged", () => {
  const clip = buildTimedDubClipResponse({
    segment: {
      id: "g2-q4-s0",
      generation: 2,
      sequence: 4,
      startMs: 120_250,
      endMs: 121_900,
      speakerId: "speaker_1",
      translatedText: "Timed line."
    },
    voice: voice({ id: "en_US-lessac-medium" }),
    audioBuffer: wavBuffer(),
    audioDurationMs: 500
  });

  assert.equal(clip.id, "g2-q4-s0");
  assert.equal(clip.startMs, 120_250);
  assert.equal(clip.audioDurationMs, 500);
});

test("safe error objects do not include transcript or translation text", () => {
  const error = new Error("python exited with code 1: secret translated sentence");
  error.stderr = "Unable to find voice: /Users/me/secret-model";
  const safe = buildSafePiperError(error, { command: "python", voiceId: "/Users/me/voice.onnx", usesStdin: true });

  assert.equal(safe.message.includes("secret translated sentence"), false);
  assert.equal(safe.stderr.includes("/Users/me"), false);
});

test("lightweight availability check does not synthesize audio", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  const calls = [];
  const result = await checkPiperRuntime({
    command: "python",
    commandArgs: ["-m", "piper"],
    voicesByLanguage: { en: [voice()] },
    dataDirs: [dir],
    cwd: dir,
    runCommand: async (command, args) => calls.push({ command, args })
  });

  assert.equal(result.runtimeAvailable, true);
  assert.equal(result.voiceResolvable, true);
  assert.equal(result.synthesisTested, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes("-f"), false);
}));

test("runtime-check results are cached for a bounded period", async () => withTempDir(async (dir) => {
  await writeVoice(dir);
  const cache = {};
  let calls = 0;
  const options = {
    command: "python",
    commandArgs: ["-m", "piper"],
    voicesByLanguage: { en: [voice()] },
    dataDirs: [dir],
    cwd: dir,
    runCommand: async () => { calls += 1; },
    cache,
    now: 1000,
    ttlMs: 5000
  };

  await checkPiperRuntime(options);
  await checkPiperRuntime({ ...options, now: 2000 });

  assert.equal(calls, 1);
  assert.equal(cache.expiresAt, 6000);
}));
