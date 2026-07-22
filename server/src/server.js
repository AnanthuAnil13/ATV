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
  validateUploadedAudioBody,
  sanitizeChunkMetadataHeader
} from "./mediaValidation.js";
import {
  LANGUAGES,
  LANGUAGE_CODES,
  LANGUAGE_LABELS,
  OLLAMA_TARGET_LANGUAGE_CODES,
  OPENAI_TARGET_LANGUAGE_CODES
} from "./languages.js";
import {
  WHISPER_JSON_INVALID,
  WHISPER_JSON_SCHEMA_UNSUPPORTED,
  buildChunkTimingResponseFields,
  buildTranscriptionFromWhisperJson,
  buildTranscriptSegmentResponse
} from "./whisperSegments.js";
import {
  OLLAMA_SEGMENT_ALIGNMENT_INVALID,
  OLLAMA_SEGMENT_JSON_INVALID,
  OLLAMA_SEGMENT_TRANSLATION_MISSING,
  buildEmptyLocalChunkResponse,
  buildLocalChunkSuccessResponse,
  buildSegmentTranslationOllamaPayload,
  buildTranslatedSegmentResponse,
  resolveSegmentTranslationsWithRetry,
  shouldTranslateDub,
  shouldTranslateSubtitleSegments,
  stripSourceTextFromSegments
} from "./translatedSegments.js";
import {
  OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID,
  OLLAMA_DUB_SPEAKER_ID_INVALID,
  OLLAMA_DUB_SPEAKER_JSON_INVALID,
  PIPER_WAV_DURATION_INVALID,
  PIPER_WAV_INVALID,
  TIMED_DUB_TIMING_UNAVAILABLE,
  buildTimedDubClipResponse,
  buildTimedDubSpeakerOllamaPayload,
  buildTimedDubSynthesisPlan,
  determineTimedDubMode,
  mergeTimedDubSegments,
  parseWavDurationMs,
  resolveTimedDubSpeakersWithRetry
} from "./timedDubSegments.js";

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
const piperVoiceBanks = parsePiperVoiceBanks(process.env.PIPER_VOICE_BANK_JSON || "", piperVoices);
const localCommandTimeoutMs = clampInteger(process.env.LOCAL_COMMAND_TIMEOUT_MS, 15_000, 300_000, 90_000);
const maxDubTurnsPerChunk = clampInteger(process.env.LOCAL_DUB_MAX_TURNS_PER_CHUNK, 1, 12, 6);
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
    "X-AutoTranslate-Installation-Id",
    "X-AutoTranslate-Chunk-Metadata"
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
        supportsDub: ollama.available && hasPiperVoiceBanks(),
        dubTargets: getPiperDubTargets(),
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

app.post("/local/session/end", (req, res) => {
  const sessionId = sanitizeOptionalSessionId(req.body?.sessionId);
  if (sessionId) localContexts.delete(sessionId);
  res.json({ ok: true });
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
      validateUploadedAudioBody(req.body, req.get("content-type"));
      if (!consumeRateLimit(`local:${getClientKey(req)}`, 900)) {
        return res.status(429).json({ error: "Too many local audio-chunk requests." });
      }

      const chunkMetadata = sanitizeChunkMetadataHeader(req.get("X-AutoTranslate-Chunk-Metadata"));
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

      const wantsSubtitles = shouldTranslateSubtitleSegments(outputMode);
      const wantsDub = shouldTranslateDub(outputMode);
      const wantsTimedDub = determineTimedDubMode({
        syncMode: chunkMetadata.syncMode,
        outputMode
      });
      const wantsSegmentTranslation = wantsSubtitles || wantsTimedDub;
      if (wantsDub && !getPiperVoiceBank(targetLanguage).length) {
        return res.status(400).json({
          error: `No Piper voice is configured for ${LANGUAGE_LABELS.get(targetLanguage) || targetLanguage}. Use subtitles-only mode or add that language to PIPER_VOICES_JSON or PIPER_VOICE_BANK_JSON.`
        });
      }

      tempDir = await mkdtemp(path.join(os.tmpdir(), "autotranslate-"));
      const inputPath = path.join(tempDir, `chunk.${extensionForContentType(req.get("content-type"))}`);
      const wavPath = path.join(tempDir, "chunk.wav");
      await writeFile(inputPath, req.body);

      await convertToWhisperWav(inputPath, wavPath);
      const transcription = await transcribeWithWhisper(wavPath, sourceLanguage, tempDir);
      const sourceText = transcription.text;
      const transcriptSegmentsWithSource = buildTranscriptSegmentResponse({
        segments: transcription.segments,
        metadata: chunkMetadata,
        showSourceTranscript: true
      });
      const transcriptSegments = showSourceTranscript
        ? transcriptSegmentsWithSource
        : stripSourceTextFromSegments(transcriptSegmentsWithSource);
      const chunkTiming = buildChunkTimingResponseFields(chunkMetadata);
      if (!sourceText) {
        return res.json(buildEmptyLocalChunkResponse({
          chunkTiming,
          outputMode,
          syncMode: chunkMetadata.syncMode
        }));
      }

      let translatedSegments = [];
      let translatedSegmentsWithSourceForDub = [];
      if (wantsSegmentTranslation) {
        const segmentTranslation = await translateSegmentsWithOllama({
          model: requestedModel,
          sourceLanguage,
          targetLanguage,
          transcriptSegments: transcriptSegmentsWithSource,
          sourceText,
          sessionId
        });
        translatedSegmentsWithSourceForDub = buildTranslatedSegmentResponse({
          transcriptSegments: transcriptSegmentsWithSource,
          translatedSegments: segmentTranslation.translatedSegments,
          showSourceTranscript: true
        });
        translatedSegments = showSourceTranscript
          ? translatedSegmentsWithSourceForDub
          : stripSourceTextFromSegments(translatedSegmentsWithSourceForDub);
      }

      const dubTranslation = wantsDub && !wantsTimedDub
        ? await translateDialogueWithOllama({
            model: requestedModel,
            sourceLanguage,
            targetLanguage,
            sourceText,
            sessionId
          })
        : {
            translatedText: "",
            turns: []
          };

      if (!wantsSubtitles && !wantsTimedDub && !dubTranslation.translatedText) {
        return res.json({
          ok: true,
          empty: true,
          ...chunkTiming,
          sourceText: showSourceTranscript ? sourceText : undefined,
          transcriptSegments
        });
      }

      let audioBase64;
      let audioMime;
      const dubClips = [];
      const timedDubClips = [];
      if (wantsTimedDub) {
        const hasTranslatedDubSpeech = translatedSegmentsWithSourceForDub
          .some((segment) => String(segment.translatedText || "").trim());
        if (hasTranslatedDubSpeech) {
          const speakerAssignment = await assignTimedDubSpeakersWithOllama({
            model: requestedModel,
            sourceLanguage,
            targetLanguage,
            translatedSegments: translatedSegmentsWithSourceForDub,
            sessionId
          });
          const timedDubSegments = mergeTimedDubSegments({
            translatedSegments: translatedSegmentsWithSourceForDub,
            speakerAssignments: speakerAssignment.speakerAssignments,
            generation: chunkMetadata.generation,
            sequence: chunkMetadata.sequence,
            requireMappedTiming: true
          });
          const synthesisPlan = buildTimedDubSynthesisPlan({
            timedDubSegments,
            sessionId,
            targetLanguage,
            assignVoice: assignPiperVoice
          });

          for (const [index, item] of synthesisPlan.entries()) {
            const outputPath = path.join(tempDir, `timed-dub-${index}.wav`);
            await synthesizeWithPiper(item.segment.translatedText, targetLanguage, outputPath, item.voice);
            const audioBuffer = await readFile(outputPath);
            const audioDurationMs = parseWavDurationMs(audioBuffer);
            timedDubClips.push(buildTimedDubClipResponse({
              segment: item.segment,
              voice: item.voice,
              audioBuffer,
              audioMime: "audio/wav",
              audioDurationMs
            }));
          }
        }
      } else if (wantsDub && dubTranslation.translatedText) {
        const turns = dubTranslation.turns.length
          ? dubTranslation.turns
          : [{ speakerId: "speaker_1", sourceText, translatedText: dubTranslation.translatedText }];

        for (const [index, turn] of turns.entries()) {
          const outputPath = path.join(tempDir, `dub-${index}.wav`);
          const voice = assignPiperVoice(sessionId, targetLanguage, turn.speakerId);
          await synthesizeWithPiper(turn.translatedText, targetLanguage, outputPath, voice);
          dubClips.push({
            speakerId: turn.speakerId,
            translatedText: turn.translatedText,
            audioBase64: (await readFile(outputPath)).toString("base64"),
            audioMime: "audio/wav"
          });
        }

        audioBase64 = dubClips[0]?.audioBase64;
        audioMime = dubClips[0]?.audioMime;
      }

      const response = buildLocalChunkSuccessResponse({
        outputMode,
        chunkTiming,
        sourceText,
        showSourceTranscript,
        transcriptSegments,
        translatedSegments,
        dubTranslation,
        dubClips,
        timedDubClips,
        audioBase64,
        audioMime,
        syncMode: chunkMetadata.syncMode,
        model: requestedModel
      });
      if (response.translatedText) {
        const contextTurns = wantsTimedDub
          ? timedDubClips.map((clip) => ({ speakerId: clip.speakerId }))
          : dubTranslation.turns;
        updateLocalContext(sessionId, sourceText, response.translatedText, contextTurns);
      }
      return res.json(response);
    } catch (error) {
      return sendRouteError(res, normalizeLocalPipelineError(error), "The local Ollama translation pipeline failed.");
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
      detail: hasPiperVoiceBanks()
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
  try {
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
  } catch {
    throw createHttpError(
      502,
      "ffmpeg could not decode the uploaded audio chunk. The recording may not be a complete media file.",
      "FFMPEG_DECODE_FAILED",
      true
    );
  }
}

async function transcribeWithWhisper(wavPath, sourceLanguage, tempDir) {
  const outputPrefix = path.join(tempDir, "transcript");
  await runCommand(whisperCommand, [
    ...whisperExtraArgs,
    "-m",
    whisperModelPath,
    "-f",
    wavPath,
    "-l",
    sourceLanguage,
    "-oj",
    "-of",
    outputPrefix
  ]);

  let jsonText = "";
  try {
    jsonText = await readFile(`${outputPrefix}.json`, "utf8");
  } catch {
    throw createHttpError(
      502,
      "whisper.cpp did not produce the expected JSON transcript.",
      "WHISPER_JSON_OUTPUT_MISSING",
      true
    );
  }

  try {
    return buildTranscriptionFromWhisperJson(jsonText);
  } catch (error) {
    if (error.code === WHISPER_JSON_INVALID) {
      throw createHttpError(
        502,
        "whisper.cpp produced invalid JSON transcript output.",
        WHISPER_JSON_INVALID,
        true
      );
    }
    if (error.code === WHISPER_JSON_SCHEMA_UNSUPPORTED) {
      throw createHttpError(
        502,
        "whisper.cpp JSON transcript schema is unsupported.",
        WHISPER_JSON_SCHEMA_UNSUPPORTED,
        true
      );
    }
    throw error;
  }
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
    const parsed = parseJsonObjectFromText(content);
    if (!parsed) throw new Error("No JSON object found.");
    return cleanTranslation(parsed.translation);
  } catch {
    return cleanTranslation(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  }
}

async function translateSegmentsWithOllama({ model, sourceLanguage, targetLanguage, transcriptSegments, sourceText, sessionId }) {
  const sourceLabel = LANGUAGE_LABELS.get(sourceLanguage) || sourceLanguage;
  const targetLabel = LANGUAGE_LABELS.get(targetLanguage) || targetLanguage;
  const contextPairs = localContexts.get(sessionId)?.pairs ?? [];

  try {
    return await resolveSegmentTranslationsWithRetry({
      transcriptSegments,
      requestTranslation: async ({ request, corrective }) => {
        const payload = buildSegmentTranslationOllamaPayload({
          model,
          sourceLabel,
          targetLabel,
          request,
          contextPairs,
          corrective
        });
        return fetchOllamaChatContent(payload, "Ollama did not return a text response for segment translation.");
      },
      fallbackTranslation: async () => translateWithOllama({
        model,
        sourceLanguage,
        targetLanguage,
        sourceText,
        sessionId
      })
    });
  } catch (error) {
    if (error.code === OLLAMA_SEGMENT_JSON_INVALID) {
      throw createHttpError(
        502,
        "Ollama did not return valid JSON for segment translation.",
        OLLAMA_SEGMENT_JSON_INVALID,
        true
      );
    }
    if (
      error.code === OLLAMA_SEGMENT_ALIGNMENT_INVALID ||
      error.code === OLLAMA_SEGMENT_TRANSLATION_MISSING
    ) {
      throw createHttpError(
        502,
        "Ollama segment translations could not be aligned with transcript segments.",
        error.code,
        true
      );
    }
    throw error;
  }
}

async function assignTimedDubSpeakersWithOllama({ model, sourceLanguage, targetLanguage, translatedSegments, sessionId }) {
  const sourceLabel = LANGUAGE_LABELS.get(sourceLanguage) || sourceLanguage;
  const targetLabel = LANGUAGE_LABELS.get(targetLanguage) || targetLanguage;
  const context = localContexts.get(sessionId) ?? {};
  const speakerContext = getKnownSpeakerIds(context, targetLanguage);

  try {
    return await resolveTimedDubSpeakersWithRetry({
      translatedSegments,
      requestSpeakerAssignment: async ({ request, corrective }) => {
        const payload = buildTimedDubSpeakerOllamaPayload({
          model,
          sourceLabel,
          targetLabel,
          request,
          speakerContext,
          corrective
        });
        return fetchOllamaChatContent(payload, "Ollama did not return a text response for timed dub speaker assignment.");
      }
    });
  } catch (error) {
    if (error.code === OLLAMA_DUB_SPEAKER_JSON_INVALID) {
      throw createHttpError(
        502,
        "Ollama did not return valid JSON for timed dub speaker assignment.",
        OLLAMA_DUB_SPEAKER_JSON_INVALID,
        true
      );
    }
    if (
      error.code === OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID ||
      error.code === OLLAMA_DUB_SPEAKER_ID_INVALID
    ) {
      throw createHttpError(
        502,
        "Ollama timed dub speaker assignments could not be aligned with transcript segments.",
        error.code,
        true
      );
    }
    throw error;
  }
}

async function fetchOllamaChatContent(payload, emptyMessage = "Ollama did not return a text response.") {
  let response;
  try {
    response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(localCommandTimeoutMs),
      body: JSON.stringify(payload)
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
    throw createHttpError(502, emptyMessage);
  }
  return content;
}

async function translateDialogueWithOllama({ model, sourceLanguage, targetLanguage, sourceText, sessionId }) {
  const sourceLabel = LANGUAGE_LABELS.get(sourceLanguage) || sourceLanguage;
  const targetLabel = LANGUAGE_LABELS.get(targetLanguage) || targetLanguage;
  const context = localContexts.get(sessionId) ?? {};
  const recentPairs = context.pairs ?? [];
  const contextText = recentPairs.length
    ? `\nRecent context (use only for continuity):\n${recentPairs.map((pair) => `SOURCE: ${pair.source}\nTRANSLATION: ${pair.target}`).join("\n")}`
    : "";
  const knownSpeakers = getKnownSpeakerIds(context, targetLanguage);
  const speakerText = knownSpeakers.length
    ? `\nKnown speaker IDs in this session: ${knownSpeakers.join(", ")}. Reuse them when the current dialogue likely belongs to the same character.`
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
            turns: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  speakerId: { type: "string" },
                  source: { type: "string" },
                  translation: { type: "string" }
                },
                required: ["speakerId", "translation"]
              }
            },
            translation: { type: "string" }
          },
          required: ["turns"]
        },
        options: {
          temperature: 0.2,
          num_predict: 900
        },
        messages: [
          {
            role: "system",
            content: `You are a professional audiovisual dubbing translator. Translate spoken ${sourceLabel} dialogue into natural ${targetLabel} and split it into character dialogue turns for dubbing. Return only valid JSON with a turns array. Each turn must have speakerId, source, and translation. Use stable IDs like speaker_1 and speaker_2. Create a new speaker ID only when the transcript strongly suggests a different character or speaker turn; otherwise reuse the current or known speaker. Preserve meaning, tone, names, numbers, and intent. Keep each translation speakable and concise. Do not explain, annotate, censor, summarize, or add quotation marks. If the input is silence, noise, music, or non-speech, return an empty turns array.${speakerText}${contextText}`
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

  const parsed = parseJsonObjectFromText(content);
  const turns = normalizeDialogueTurns(parsed?.turns, sourceText);
  const translatedText = cleanTranslation(
    parsed?.translation || turns.map((turn) => turn.translatedText).join(" ") || (parsed ? "" : content)
  );

  return {
    translatedText,
    turns: turns.length
      ? turns
      : translatedText
        ? [{ speakerId: "speaker_1", sourceText, translatedText }]
        : []
  };
}

async function synthesizeWithPiper(text, targetLanguage, outputPath, assignedVoice = null) {
  const voice = assignedVoice || getPiperVoiceBank(targetLanguage)[0];
  if (!voice) throw createHttpError(400, `No Piper voice is configured for ${targetLanguage}.`);
  await runCommand(piperCommand, [
    ...piperCommandArgs,
    "-m",
    voice.model,
    ...voice.args,
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

function sanitizeOptionalSessionId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9:_-]{8,200}$/.test(text) ? text : "";
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

function normalizeDialogueTurns(value, sourceFallback) {
  if (!Array.isArray(value)) return [];

  const turns = [];
  for (const [index, item] of value.slice(0, maxDubTurnsPerChunk).entries()) {
    const translatedText = cleanTranslation(item?.translation ?? item?.translatedText ?? item?.text ?? "");
    if (!translatedText) continue;

    const sourceText = cleanTranscript(item?.source ?? item?.sourceText ?? "");
    turns.push({
      speakerId: normalizeSpeakerId(item?.speakerId ?? item?.speaker ?? item?.character, index + 1),
      sourceText: sourceText || (turns.length === 0 ? sourceFallback : ""),
      translatedText
    });
  }

  return turns;
}

function normalizeSpeakerId(value, fallbackIndex) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

  if (!normalized) return `speaker_${fallbackIndex}`;
  if (/^\d+$/.test(normalized)) return `speaker_${normalized}`;
  if (/^speaker\d+$/.test(normalized)) return normalized.replace(/^speaker/, "speaker_");
  return normalized.startsWith("speaker_") ? normalized : `speaker_${normalized}`;
}

function parseJsonObjectFromText(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(text);
  } catch {}

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function updateLocalContext(sessionId, source, target, turns = []) {
  const context = getOrCreateLocalContext(sessionId);
  context.pairs = [...(context.pairs ?? []), { source, target }].slice(-4);
  context.recentSpeakers = [
    ...(context.recentSpeakers ?? []),
    ...turns.map((turn) => turn.speakerId).filter(Boolean)
  ].slice(-12);
  context.updatedAt = Date.now();
  localContexts.set(sessionId, context);
  pruneLocalContexts();
}

function getOrCreateLocalContext(sessionId) {
  const existing = localContexts.get(sessionId);
  if (existing) {
    existing.pairs ??= [];
    existing.speakerVoices ??= {};
    existing.voiceCursorByLanguage ??= {};
    existing.recentSpeakers ??= [];
    return existing;
  }

  const context = {
    pairs: [],
    speakerVoices: {},
    voiceCursorByLanguage: {},
    recentSpeakers: [],
    updatedAt: Date.now()
  };
  localContexts.set(sessionId, context);
  return context;
}

function pruneLocalContexts() {
  if (localContexts.size > 100) {
    const oldest = [...localContexts.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(0, 20);
    oldest.forEach(([key]) => localContexts.delete(key));
  }
}

function getKnownSpeakerIds(context, targetLanguage) {
  const assigned = Object.keys(context.speakerVoices ?? {})
    .filter((key) => key.startsWith(`${targetLanguage}:`))
    .map((key) => key.slice(targetLanguage.length + 1));
  return [...new Set([...(context.recentSpeakers ?? []), ...assigned])].slice(-12);
}

function assignPiperVoice(sessionId, targetLanguage, speakerId) {
  const bank = getPiperVoiceBank(targetLanguage);
  if (!bank.length) throw createHttpError(400, `No Piper voice is configured for ${targetLanguage}.`);

  const context = getOrCreateLocalContext(sessionId);
  const normalizedSpeakerId = normalizeSpeakerId(speakerId, 1);
  const speakerKey = `${targetLanguage}:${normalizedSpeakerId}`;
  const existingVoiceId = context.speakerVoices[speakerKey];
  const existingVoice = bank.find((voice) => voice.id === existingVoiceId);
  if (existingVoice) return existingVoice;

  const cursor = context.voiceCursorByLanguage[targetLanguage] ?? 0;
  const voice = bank[cursor % bank.length];
  context.voiceCursorByLanguage[targetLanguage] = cursor + 1;
  context.speakerVoices[speakerKey] = voice.id;
  context.updatedAt = Date.now();
  localContexts.set(sessionId, context);
  pruneLocalContexts();
  return voice;
}

function hasPiperVoiceBanks() {
  return getPiperDubTargets().length > 0;
}

function getPiperDubTargets() {
  return Object.entries(piperVoiceBanks)
    .filter(([, voices]) => Array.isArray(voices) && voices.length > 0)
    .map(([language]) => language);
}

function getPiperVoiceBank(targetLanguage) {
  return Array.isArray(piperVoiceBanks[targetLanguage]) ? piperVoiceBanks[targetLanguage] : [];
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

function parsePiperVoiceBanks(value, fallbackVoices) {
  const banks = {};
  for (const [language, voice] of Object.entries(fallbackVoices)) {
    const normalized = normalizePiperVoice(voice, 0);
    if (normalized) banks[language] = [normalized];
  }

  if (!value.trim()) return banks;

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return banks;

    for (const [language, entry] of Object.entries(parsed)) {
      if (!/^[a-z]{2,3}$/.test(language)) continue;
      const list = Array.isArray(entry) ? entry : [entry];
      const voices = dedupePiperVoices(
        list
          .map((item, index) => normalizePiperVoice(item, index))
          .filter(Boolean)
      );
      if (voices.length) banks[language] = voices;
    }
  } catch {
    console.warn("PIPER_VOICE_BANK_JSON is not valid JSON; falling back to PIPER_VOICES_JSON.");
  }

  return banks;
}

function normalizePiperVoice(value, index) {
  if (typeof value === "string") {
    const model = value.trim();
    return model
      ? { id: createPiperVoiceId(model, index), model, args: [] }
      : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = String(value.model ?? value.voice ?? value.path ?? "").trim();
  if (!model) return null;

  const args = Array.isArray(value.args)
    ? value.args.map((arg) => String(arg)).filter((arg) => arg && !/[\r\n\0]/.test(arg))
    : splitCommandArgs(String(value.args ?? ""));

  return {
    id: createPiperVoiceId(value.id || model, index),
    model,
    args
  };
}

function dedupePiperVoices(voices) {
  const counts = new Map();
  return voices.map((voice) => {
    const count = counts.get(voice.id) ?? 0;
    counts.set(voice.id, count + 1);
    return count === 0 ? voice : { ...voice, id: `${voice.id}_${count + 1}` };
  });
}

function createPiperVoiceId(value, index) {
  const basename = path.basename(String(value || ""), path.extname(String(value || "")));
  const normalized = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return normalized || `voice_${index + 1}`;
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

function createHttpError(statusCode, message, code, expose = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = expose;
  return error;
}

function normalizeLocalPipelineError(error) {
  if (error?.statusCode) return error;
  if (
    error?.code === OLLAMA_DUB_SPEAKER_JSON_INVALID ||
    error?.code === OLLAMA_DUB_SPEAKER_ALIGNMENT_INVALID ||
    error?.code === OLLAMA_DUB_SPEAKER_ID_INVALID
  ) {
    return createHttpError(
      502,
      "Ollama timed dub speaker assignments could not be used.",
      error.code,
      true
    );
  }
  if (error?.code === PIPER_WAV_INVALID || error?.code === PIPER_WAV_DURATION_INVALID) {
    return createHttpError(
      502,
      "Piper produced invalid WAV audio for a timed dub segment.",
      error.code,
      true
    );
  }
  if (error?.code === TIMED_DUB_TIMING_UNAVAILABLE) {
    return createHttpError(
      422,
      "Timed buffered dubbing requires mapped source-video segment timing.",
      TIMED_DUB_TIMING_UNAVAILABLE,
      true
    );
  }
  return error;
}

function sendRouteError(res, error, fallbackMessage) {
  console.error(error);
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const message = statusCode < 500 || error.expose ? error.message : fallbackMessage;
  return res.status(statusCode).json({ error: message, code: error.code });
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
