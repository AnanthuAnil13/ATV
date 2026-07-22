import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parseWavDurationMs } from "./timedDubSegments.js";

export const PIPER_RUNTIME_UNAVAILABLE = "PIPER_RUNTIME_UNAVAILABLE";
export const PIPER_CLI_ARGUMENT_INVALID = "PIPER_CLI_ARGUMENT_INVALID";
export const PIPER_VOICE_NOT_FOUND = "PIPER_VOICE_NOT_FOUND";
export const PIPER_SYNTHESIS_FAILED = "PIPER_SYNTHESIS_FAILED";
export const PIPER_SYNTHESIS_TIMEOUT = "PIPER_SYNTHESIS_TIMEOUT";
export const PIPER_OUTPUT_MISSING = "PIPER_OUTPUT_MISSING";
export const PIPER_OUTPUT_EMPTY = "PIPER_OUTPUT_EMPTY";

const DEFAULT_TEXT_LIMIT = 1800;
const DEFAULT_RUNTIME_CACHE_MS = 60_000;
const MODEL_FLAGS = new Set(["-m", "--model"]);
const OUTPUT_FLAGS = new Set(["-f", "--output-file", "--output_file"]);
const INPUT_FLAGS = new Set(["-i", "--input-file", "--input_file"]);
const DATA_DIR_FLAGS = new Set(["--data-dir", "--data_dir"]);

export function normalizePiperInputText(value, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_TEXT_LIMIT;
  const text = String(value || "").replace(/\r\n/g, "\n").trim().slice(0, limit);
  if (!text) {
    throw createPiperError("Piper synthesis requires non-empty input text.", PIPER_SYNTHESIS_FAILED);
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

export async function resolvePiperVoiceModel(voice, options = {}) {
  const model = String(voice?.model || voice?.voice || voice?.path || "").trim();
  if (!model) {
    throw createPiperError("No Piper voice model is configured.", PIPER_VOICE_NOT_FOUND);
  }

  const dataDirs = collectPiperDataDirs({
    commandArgs: options.commandArgs,
    voiceArgs: voice?.args,
    dataDirs: options.dataDirs,
    cwd: options.cwd
  });

  if (isExplicitModelPath(model)) {
    await validatePiperVoiceFiles(model, options);
    return {
      modelArgument: model,
      modelPath: model,
      voiceName: null,
      dataDirs
    };
  }

  for (const dataDir of dataDirs) {
    const candidate = path.join(dataDir, `${model}.onnx`);
    if (await isReadable(candidate)) {
      await validatePiperVoiceFiles(candidate, options);
      return {
        modelArgument: candidate,
        modelPath: candidate,
        voiceName: model,
        dataDirs
      };
    }
  }

  throw createPiperError("The configured Piper voice could not be found.", PIPER_VOICE_NOT_FOUND);
}

export async function validatePiperVoiceFiles(modelPath, options = {}) {
  const requireConfig = options.requireConfig !== false;
  if (!await isReadable(modelPath)) {
    throw createPiperError("The configured Piper voice model could not be read.", PIPER_VOICE_NOT_FOUND);
  }
  if (requireConfig && !await isReadable(`${modelPath}.json`)) {
    throw createPiperError("The configured Piper voice config could not be read.", PIPER_VOICE_NOT_FOUND);
  }
  return true;
}

export async function buildPiperInvocation({
  command,
  commandArgs = [],
  voice,
  outputPath,
  text,
  cwd,
  dataDirs = []
}) {
  const normalizedText = normalizePiperInputText(text);
  const voiceArgs = Array.isArray(voice?.args) ? voice.args.map(String) : [];
  validateVoiceArgs(voiceArgs);
  const resolvedVoice = await resolvePiperVoiceModel(voice, {
    commandArgs,
    voiceArgs,
    cwd,
    dataDirs
  });

  return {
    command: String(command || "python"),
    args: [
      ...commandArgs.map(String),
      "-m",
      resolvedVoice.modelArgument,
      ...voiceArgs,
      "-f",
      outputPath
    ],
    stdin: normalizedText,
    usesStdin: true,
    safeVoiceId: sanitizePublicVoiceId(voice),
    resolvedVoice
  };
}

export async function synthesizePiperToFile({
  command,
  commandArgs = [],
  voice,
  outputPath,
  text,
  cwd,
  dataDirs = [],
  runCommand
}) {
  if (typeof runCommand !== "function") {
    throw createPiperError("Piper synthesis requires a command runner.", PIPER_RUNTIME_UNAVAILABLE);
  }
  const invocation = await buildPiperInvocation({
    command,
    commandArgs,
    voice,
    outputPath,
    text,
    cwd,
    dataDirs
  });

  try {
    await runCommand(invocation.command, invocation.args, {
      stdin: invocation.stdin
    });
  } catch (error) {
    throw buildSafePiperError(error, {
      command: invocation.command,
      voiceId: invocation.safeVoiceId,
      usesStdin: invocation.usesStdin
    });
  }

  const output = await validatePiperOutputFile(outputPath);
  return {
    ...invocation,
    audioBuffer: output.audioBuffer,
    audioDurationMs: output.audioDurationMs,
    outputBytes: output.audioBuffer.length
  };
}

export async function validatePiperOutputFile(outputPath) {
  let audioBuffer;
  try {
    audioBuffer = await readFile(outputPath);
  } catch {
    throw createPiperError("Piper did not create the expected WAV output.", PIPER_OUTPUT_MISSING);
  }
  if (!audioBuffer.length) {
    throw createPiperError("Piper created an empty WAV output.", PIPER_OUTPUT_EMPTY);
  }
  const audioDurationMs = parseWavDurationMs(audioBuffer);
  return { audioBuffer, audioDurationMs };
}

export function buildSafePiperError(error, context = {}) {
  const stderr = sanitizeProcessText(error?.stderr || error?.message || "");
  const code = classifyPiperFailure(error, stderr);
  const safe = createPiperError(messageForPiperCode(code), code);
  safe.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : undefined;
  safe.stderr = stderr;
  safe.command = path.basename(String(context.command || "piper"));
  safe.voiceId = sanitizePublicVoiceId({ id: context.voiceId });
  safe.usesStdin = context.usesStdin === true;
  return safe;
}

export async function checkPiperRuntime({
  command,
  commandArgs = [],
  voicesByLanguage = {},
  cwd,
  dataDirs = [],
  runCommand,
  cache,
  now = Date.now(),
  ttlMs = DEFAULT_RUNTIME_CACHE_MS
}) {
  if (cache?.expiresAt > now && cache.result) return cache.result;

  const voiceEntries = Object.entries(voicesByLanguage || {})
    .flatMap(([language, voices]) => (Array.isArray(voices) ? voices : [])
      .map((voice) => ({ language, voice })));
  const result = {
    voiceConfigured: voiceEntries.length > 0,
    runtimeAvailable: false,
    voiceResolvable: false,
    synthesisTested: false,
    checkedAt: now,
    detail: ""
  };

  if (typeof runCommand === "function") {
    try {
      await runCommand(command, [...commandArgs, "--help"]);
      result.runtimeAvailable = true;
    } catch (error) {
      const safe = buildSafePiperError(error, { command });
      result.detail = safe.message;
    }
  }

  for (const { voice } of voiceEntries) {
    try {
      await resolvePiperVoiceModel(voice, {
        commandArgs,
        voiceArgs: voice.args,
        cwd,
        dataDirs
      });
      result.voiceResolvable = true;
      break;
    } catch {}
  }

  if (!result.voiceConfigured) {
    result.detail = "No Piper voice is configured.";
  } else if (!result.runtimeAvailable) {
    result.detail ||= "Piper runtime is not available.";
  } else if (!result.voiceResolvable) {
    result.detail = "Piper is installed, but the configured voice model could not be found.";
  } else {
    result.detail = "Piper runtime and configured voice files are available. Real synthesis is checked only during explicit tests or requests.";
  }

  if (cache) {
    cache.expiresAt = now + ttlMs;
    cache.result = result;
  }
  return result;
}

export function collectPiperDataDirs({ commandArgs = [], voiceArgs = [], dataDirs = [], cwd = process.cwd() } = {}) {
  const dirs = [
    ...extractDataDirs(commandArgs),
    ...extractDataDirs(voiceArgs),
    ...toArray(dataDirs),
    cwd
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return [...new Set(dirs)];
}

export function sanitizePublicVoiceId(voice) {
  const raw = String(voice?.id || voice?.voiceId || voice?.model || voice?.voice || voice?.path || "voice").trim();
  const basename = raw.split(/[\\/]/).pop() || raw;
  const withoutExtension = basename.replace(/\.[a-zA-Z0-9]+$/, "");
  const normalized = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || "voice";
}

function classifyPiperFailure(error, stderr) {
  if (error?.timedOut || /timed out|timeout/i.test(stderr)) return PIPER_SYNTHESIS_TIMEOUT;
  if (error?.spawnErrorCode || /could not start|enoent|no such file/i.test(stderr)) return PIPER_RUNTIME_UNAVAILABLE;
  if (/unrecognized arguments|invalid choice|usage:/i.test(stderr)) return PIPER_CLI_ARGUMENT_INVALID;
  if (/unable to find voice|voice model|voice config|not found/i.test(stderr)) return PIPER_VOICE_NOT_FOUND;
  return PIPER_SYNTHESIS_FAILED;
}

function messageForPiperCode(code) {
  return {
    [PIPER_RUNTIME_UNAVAILABLE]: "Piper executable or module is not available.",
    [PIPER_CLI_ARGUMENT_INVALID]: "Piper rejected the configured command arguments.",
    [PIPER_VOICE_NOT_FOUND]: "The configured Piper voice model could not be found.",
    [PIPER_SYNTHESIS_TIMEOUT]: "Piper synthesis timed out.",
    [PIPER_OUTPUT_MISSING]: "Piper did not create the expected WAV output.",
    [PIPER_OUTPUT_EMPTY]: "Piper created an empty WAV output.",
    [PIPER_SYNTHESIS_FAILED]: "Piper synthesis failed."
  }[code] || "Piper synthesis failed.";
}

function validateVoiceArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const flag = String(arg).split("=")[0];
    if (MODEL_FLAGS.has(flag) || OUTPUT_FLAGS.has(flag) || INPUT_FLAGS.has(flag)) {
      throw createPiperError("Voice-specific Piper args cannot override model, input, or output flags.", PIPER_CLI_ARGUMENT_INVALID);
    }
  }
}

function extractDataDirs(args = []) {
  const dirs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");
    const [flag, inlineValue] = arg.split("=", 2);
    if (DATA_DIR_FLAGS.has(flag)) {
      const value = inlineValue ?? args[index + 1];
      if (value) dirs.push(value);
      if (inlineValue === undefined) index += 1;
    }
  }
  return dirs;
}

function isExplicitModelPath(value) {
  return value.endsWith(".onnx") || value.includes("/") || value.includes("\\\\");
}

async function isReadable(filePath) {
  return access(filePath).then(() => true, () => false);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeProcessText(value) {
  return String(value || "")
    .replace(/\/Users\/[^\s'")]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function createPiperError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
