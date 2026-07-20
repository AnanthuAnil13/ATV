import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import {
  LANGUAGES,
  LANGUAGE_CODES,
  LANGUAGE_LABELS,
  OLLAMA_TARGET_LANGUAGE_CODES,
  OPENAI_TARGET_LANGUAGE_CODES
} from "./languages.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8787);
const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
const safetySalt = process.env.SAFETY_ID_SALT || "autotranslate-development-only-salt";
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS || "*");
const ollamaUrl = normalizeHttpUrl(process.env.OLLAMA_URL || "http://127.0.0.1:11434");
const defaultOllamaModel = process.env.OLLAMA_MODEL?.trim() || "";
const localPipelineEnabled = process.env.LOCAL_PIPELINE_ENABLED === "true";
const whisperCommand = process.env.WHISPER_COMMAND?.trim() || "whisper-cli";
const whisperModelPath = process.env.WHISPER_MODEL_PATH?.trim() || "";
const whisperExtraArgs = splitCommandArgs(process.env.WHISPER_EXTRA_ARGS || "");
const ffmpegCommand = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const piperCommand = process.env.PIPER_COMMAND?.trim() || "python";
const piperCommandArgs = splitCommandArgs(process.env.PIPER_COMMAND_ARGS ?? "-m piper");
const piperVoices = parseStringMap(process.env.PIPER_VOICES_JSON || "{}");
const localCommandTimeoutMs = clampInteger(process.env.LOCAL_COMMAND_TIMEOUT_MS, 15_000, 300_000, 90_000);
const rateBuckets = new Map();
const localContexts = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins === "*" || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed by this AutoTranslate backend."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "X-AutoTranslate-Source-Language",
    "X-AutoTranslate-Target-Language",
    "X-AutoTranslate-Output-Mode",
    "X-AutoTranslate-Show-Source",
    "X-AutoTranslate-Ollama-Model",
    "X-AutoTranslate-Session-Id",
    "X-AutoTranslate-Installation-Id"
  ]
}));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "autotranslate-provider-server", version: "0.4.0" });
});

app.get("/languages", (req, res) => {
  res.json({
    languages: LANGUAGES.map((language) => ({
      ...language,
      canTarget: language.openAiTarget || language.ollamaTarget
    }))
  });
});

app.get("/providers", async (req, res) => {
  const ollama = await getOllamaStatus();
  res.json({
    providers: {
      openai: {
        id: "openai",
        label: "OpenAI Realtime",
        available: Boolean(openAiApiKey),
        supportsSubtitles: true,
        supportsDub: true,
        detail: openAiApiKey
          ? "Realtime cloud translation is configured."
          : "Set OPENAI_API_KEY to enable this provider."
      },
      ollama: {
        id: "ollama",
        label: "Ollama local",
        available: ollama.available,
        supportsSubtitles: ollama.available,
        supportsDub: ollama.available && Object.keys(piperVoices).length > 0,
        dubTargets: Object.keys(piperVoices),
        models: ollama.models,
        defaultModel: resolveDefaultOllamaModel(ollama.models),
        chunkMs: 4500,
        detail: ollama.detail
      }
    }
  });
});

app.get("/ollama/models", async (req, res) => {
  try {
    const models = await fetchOllamaModels();
    res.json({ models, defaultModel: resolveDefaultOllamaModel(models) });
  } catch (error) {
    res.status(503).json({ error: friendlyOllamaError(error), models: [] });
  }
});

app.post("/session", async (req, res) => {
  try {
    if (!openAiApiKey) {
      return res.status(503).json({ error: "OPENAI_API_KEY is not configured on the AutoTranslate backend." });
    }

    if (!consumeRateLimit(`openai:${getClientKey(req)}`, 30)) {
      return res.status(429).json({ error: "Too many session requests. Try again later." });
    }

    // Source language is retained as validated user-facing metadata. The
    // OpenAI translation endpoint auto-detects the incoming language.
    const sourceLanguage = sanitizeLanguage(req.body?.sourceLanguage, "ja");
    const targetLanguage = sanitizeOpenAiTargetLanguage(req.body?.targetLanguage, "en");
    if (sourceLanguage === targetLanguage) {
      return res.status(400).json({ error: "Source and translation languages must be different." });
    }

    const showSourceTranscript = req.body?.showSourceTranscript === true;
    const safetyIdentifier = hashSafetyIdentifier(req.body?.installationId);
    const audio = {
      output: {
        language: targetLanguage
      }
    };

    if (showSourceTranscript) {
      audio.input = {
        transcription: {
          model: "gpt-realtime-whisper"
        }
      };
    }

    const openAiResponse = await fetch(
      "https://api.openai.com/v1/realtime/translations/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAiApiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": safetyIdentifier
        },
        body: JSON.stringify({
          session: {
            model: "gpt-realtime-translate",
            audio
          }
        })
      }
    );

    const responseBody = await openAiResponse.json().catch(async () => ({
      error: { message: await openAiResponse.text().catch(() => "Unknown OpenAI error") }
    }));

    if (!openAiResponse.ok) {
      const message = responseBody?.error?.message || "OpenAI could not create a realtime translation session.";
      return res.status(openAiResponse.status).json({ error: message });
    }

    // Return only the short-lived client secret response. The standard API key
    // never leaves this server.
    return res.status(201).json(responseBody);
  } catch (error) {
    return sendRouteError(res, error, "The AutoTranslate backend could not create an OpenAI session.");
  }
});

app.post(
  "/local/chunk",
  express.raw({ type: ["audio/*", "application/octet-stream"], limit: "16mb" }),
  async (req, res) => {
    let tempDir = null;
    try {
      if (!localPipelineEnabled) {
        return res.status(503).json({
          error: "The local pipeline is disabled. Set LOCAL_PIPELINE_ENABLED=true on the backend."
        });
      }
      if (!whisperModelPath) {
        return res.status(503).json({ error: "WHISPER_MODEL_PATH is not configured on the backend." });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length < 128) {
        return res.status(400).json({ error: "The local pipeline did not receive a usable audio chunk." });
      }
      if (!consumeRateLimit(`local:${getClientKey(req)}`, 900)) {
        return res.status(429).json({ error: "Too many local audio-chunk requests." });
      }

      const sourceLanguage = sanitizeLanguage(req.get("X-AutoTranslate-Source-Language"), "ja");
      const targetLanguage = sanitizeOllamaTargetLanguage(req.get("X-AutoTranslate-Target-Language"), "en");
      const outputMode = sanitizeOutputMode(req.get("X-AutoTranslate-Output-Mode"));
      const showSourceTranscript = req.get("X-AutoTranslate-Show-Source") === "true";
      const sessionId = sanitizeSessionId(req.get("X-AutoTranslate-Session-Id"));
      const requestedModel = sanitizeModelName(req.get("X-AutoTranslate-Ollama-Model") || defaultOllamaModel);

      if (sourceLanguage === targetLanguage) {
        return res.status(400).json({ error: "Source and translation languages must be different." });
      }
      if (!requestedModel) {
        return res.status(400).json({ error: "Choose an installed Ollama model before starting local translation." });
      }

      const wantsDub = outputMode === "dub" || outputMode === "both";
      if (wantsDub && !piperVoices[targetLanguage]) {
        return res.status(400).json({
          error: `No Piper voice is configured for ${LANGUAGE_LABELS.get(targetLanguage) || targetLanguage}. Use subtitles-only mode or add that language to PIPER_VOICES_JSON.`
        });
      }

      tempDir = await mkdtemp(path.join(os.tmpdir(), "autotranslate-"));
      const inputPath = path.join(tempDir, `chunk.${extensionForContentType(req.get("content-type"))}`);
      const wavPath = path.join(tempDir, "chunk.wav");
      await writeFile(inputPath, req.body);

      await convertToWhisperWav(inputPath, wavPath);
      const sourceText = await transcribeWithWhisper(wavPath, sourceLanguage, tempDir);
      if (!sourceText) {
        return res.json({ ok: true, empty: true });
      }

      const translatedText = await translateWithOllama({
        model: requestedModel,
        sourceLanguage,
        targetLanguage,
        sourceText,
        sessionId
      });

      if (!translatedText) {
        return res.json({ ok: true, empty: true, sourceText: showSourceTranscript ? sourceText : undefined });
      }

      let audioBase64;
      let audioMime;
      if (wantsDub) {
        const outputPath = path.join(tempDir, "dub.wav");
        await synthesizeWithPiper(translatedText, targetLanguage, outputPath);
        audioBase64 = (await readFile(outputPath)).toString("base64");
        audioMime = "audio/wav";
      }

      updateLocalContext(sessionId, sourceText, translatedText);
      return res.json({
        ok: true,
        sourceText: showSourceTranscript ? sourceText : undefined,
        translatedText,
        audioBase64,
        audioMime,
        model: requestedModel
      });
    } catch (error) {
      return sendRouteError(res, error, "The local Ollama translation pipeline failed.");
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => null);
    }
  }
);

app.use((error, req, res, next) => {
  console.error(error);
  res.status(403).json({ error: error.message || "Request rejected." });
});

app.listen(port, () => {
  console.log(`AutoTranslate provider server listening on http://localhost:${port}`);
  console.log(`OpenAI provider: ${openAiApiKey ? "configured" : "not configured"}`);
  console.log(`Ollama local pipeline: ${localPipelineEnabled ? "enabled" : "disabled"}`);
});

async function getOllamaStatus() {
  if (!localPipelineEnabled) {
    return {
      available: false,
      models: [],
      detail: "Set LOCAL_PIPELINE_ENABLED=true to enable local translation."
    };
  }
  if (!whisperModelPath) {
    return {
      available: false,
      models: [],
      detail: "Set WHISPER_MODEL_PATH so local audio can be transcribed before Ollama translates it."
    };
  }

  try {
    await access(whisperModelPath);
  } catch {
    return {
      available: false,
      models: [],
      detail: "WHISPER_MODEL_PATH does not point to a readable whisper.cpp model."
    };
  }

  try {
    const models = await fetchOllamaModels();
    if (!models.length) {
      return {
        available: false,
        models,
        detail: "Ollama is reachable, but no local models are installed. Run ollama pull <model>."
      };
    }
    return {
      available: true,
      models,
      detail: Object.keys(piperVoices).length
        ? "Local Whisper transcription, Ollama translation, and Piper dubbing are configured."
        : "Local Whisper transcription and Ollama translation are configured. Add Piper voices to enable local dubbing."
    };
  } catch (error) {
    return { available: false, models: [], detail: friendlyOllamaError(error) };
  }
}

async function fetchOllamaModels() {
  const response = await fetch(`${ollamaUrl}/api/tags`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  const body = await response.json();
  return Array.isArray(body.models)
    ? body.models
        .map((model) => ({
          name: model.name || model.model,
          model: model.model || model.name,
          size: model.size,
          parameterSize: model.details?.parameter_size,
          quantization: model.details?.quantization_level
        }))
        .filter((model) => typeof model.name === "string" && model.name)
    : [];
}

async function convertToWhisperWav(inputPath, wavPath) {
  await runCommand(ffmpegCommand, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath
  ]);
}

async function transcribeWithWhisper(wavPath, sourceLanguage, tempDir) {
  const outputPrefix = path.join(tempDir, "transcript");
  const { stdout } = await runCommand(whisperCommand, [
    ...whisperExtraArgs,
    "-m",
    whisperModelPath,
    "-f",
    wavPath,
    "-l",
    sourceLanguage,
    "-nt",
    "-otxt",
    "-of",
    outputPrefix
  ]);

  let text = "";
  try {
    text = await readFile(`${outputPrefix}.txt`, "utf8");
  } catch {
    text = stdout;
  }
  return cleanTranscript(text);
}

async function translateWithOllama({ model, sourceLanguage, targetLanguage, sourceText, sessionId }) {
  const sourceLabel = LANGUAGE_LABELS.get(sourceLanguage) || sourceLanguage;
  const targetLabel = LANGUAGE_LABELS.get(targetLanguage) || targetLanguage;
  const context = localContexts.get(sessionId)?.pairs ?? [];
  const contextText = context.length
    ? `\nRecent context (use only for consistency):\n${context.map((pair) => `SOURCE: ${pair.source}\nTRANSLATION: ${pair.target}`).join("\n")}`
    : "";

  let response;
  try {
    response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(localCommandTimeoutMs),
      body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: "10m",
      format: {
        type: "object",
        properties: {
          translation: { type: "string" }
        },
        required: ["translation"]
      },
      options: {
        temperature: 0.15,
        num_predict: 512
      },
      messages: [
        {
          role: "system",
          content: `You are a professional audiovisual translator. Translate spoken ${sourceLabel} dialogue into natural ${targetLabel}. Return only valid JSON with one key named translation. Preserve meaning, tone, names, numbers, and sentence intent. Do not explain, annotate, censor, summarize, or add quotation marks. If the input is only silence, noise, or non-speech, return an empty translation.${contextText}`
        },
        {
          role: "user",
          content: sourceText
        }
      ]
      })
    });
  } catch (error) {
    throw createHttpError(503, friendlyOllamaError(error));
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(response.status, body.error || `Ollama returned HTTP ${response.status}.`);
  }

  const content = body.message?.content;
  if (typeof content !== "string") {
    throw createHttpError(502, "Ollama did not return a text response.");
  }

  try {
    const parsed = JSON.parse(content);
    return cleanTranslation(parsed.translation);
  } catch {
    return cleanTranslation(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  }
}

async function synthesizeWithPiper(text, targetLanguage, outputPath) {
  const voice = piperVoices[targetLanguage];
  if (!voice) throw createHttpError(400, `No Piper voice is configured for ${targetLanguage}.`);
  await runCommand(piperCommand, [
    ...piperCommandArgs,
    "-m",
    voice,
    "-f",
    outputPath,
    "--",
    text.slice(0, 1800)
  ]);
}

function runCommand(command, args, { stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(createHttpError(504, `${command} timed out after ${localCommandTimeoutMs} ms.`));
    }, localCommandTimeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2_000_000) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(createHttpError(503, `Could not start ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = cleanCommandError(stderr || stdout);
        reject(createHttpError(502, `${command} exited with code ${code}${detail ? `: ${detail}` : "."}`));
      }
    });

    if (stdin !== null) {
      child.stdin.end(stdin);
    }
  });
}

function sanitizeLanguage(value, fallback) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : fallback;
  if (!LANGUAGE_CODES.has(code)) throw createHttpError(400, `Unsupported language code: ${code}`);
  return code;
}

function sanitizeOpenAiTargetLanguage(value, fallback) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : fallback;
  if (!OPENAI_TARGET_LANGUAGE_CODES.has(code)) {
    throw createHttpError(400, `Unsupported OpenAI translation language code: ${code}`);
  }
  return code;
}

function sanitizeOllamaTargetLanguage(value, fallback) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : fallback;
  if (!OLLAMA_TARGET_LANGUAGE_CODES.has(code)) {
    throw createHttpError(400, `Unsupported Ollama translation language code: ${code}`);
  }
  return code;
}

function sanitizeOutputMode(value) {
  return ["subtitles", "dub", "both"].includes(value) ? value : "both";
}

function sanitizeModelName(value) {
  if (typeof value !== "string") return "";
  const model = value.trim();
  if (!model || model.length > 160 || /[\r\n\0]/.test(model)) return "";
  return model;
}

function sanitizeSessionId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (/^[a-zA-Z0-9:_-]{8,200}$/.test(text)) return text;
  return crypto.randomUUID();
}

function resolveDefaultOllamaModel(models) {
  if (defaultOllamaModel && models.some((item) => item.name === defaultOllamaModel || item.model === defaultOllamaModel)) {
    return defaultOllamaModel;
  }
  return models[0]?.name || "";
}

function cleanTranscript(value) {
  return String(value || "")
    .replace(/^\s*\[[0-9:.]+\s*-->\s*[0-9:.]+\]\s*/gm, "")
    .replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC|NOISE)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

function cleanTranslation(value) {
  return String(value || "")
    .replace(/^\s*["']|["']\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

function updateLocalContext(sessionId, source, target) {
  const pairs = [...(localContexts.get(sessionId)?.pairs ?? []), { source, target }].slice(-4);
  localContexts.set(sessionId, { pairs, updatedAt: Date.now() });
  if (localContexts.size > 100) {
    const oldest = [...localContexts.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(0, 20);
    oldest.forEach(([key]) => localContexts.delete(key));
  }
}

function hashSafetyIdentifier(installationId) {
  const stableId = typeof installationId === "string" && installationId.length <= 128
    ? installationId
    : "anonymous-installation";
  return crypto.createHash("sha256").update(`${safetySalt}:${stableId}`).digest("hex");
}

function parseAllowedOrigins(value) {
  if (value.trim() === "*") return "*";
  return new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean));
}

function parseStringMap(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, item]) => /^[a-z]{2,3}$/.test(key) && typeof item === "string" && item.trim())
        .map(([key, item]) => [key, item.trim()])
    );
  } catch {
    console.warn("PIPER_VOICES_JSON is not valid JSON; local dubbing will be unavailable.");
    return {};
  }
}

function splitCommandArgs(value) {
  const args = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(value))) {
    args.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, "$1"));
  }
  return args;
}

function extensionForContentType(contentType = "") {
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("mp4") || contentType.includes("m4a")) return "m4a";
  return "webm";
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid HTTP URL: ${value}`);
  }
}

function getClientKey(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function consumeRateLimit(key, maxRequests) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const existing = rateBuckets.get(key);
  if (!existing || now - existing.startedAt >= windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= maxRequests;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendRouteError(res, error, fallbackMessage) {
  console.error(error);
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const message = statusCode < 500 ? error.message : fallbackMessage;
  return res.status(statusCode).json({ error: message });
}

function cleanCommandError(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function friendlyOllamaError(error) {
  if (error?.name === "TimeoutError") return `Ollama did not respond at ${ollamaUrl}.`;
  if (String(error?.message).includes("fetch failed")) return `Ollama is not reachable at ${ollamaUrl}. Start Ollama and try again.`;
  return `Ollama is unavailable: ${error?.message || "unknown error"}`;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}
