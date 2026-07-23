# AutoTranslate Video: OpenAI + Ollama

A Chromium Manifest V3 extension that captures the active video tab and produces live translated subtitles, translated speech, or both. The default language pair is **Japanese → English**.

Version **0.4.0** adds a provider switch:

1. **OpenAI Realtime (cloud)** — the existing low-latency WebRTC translation path.
2. **Ollama (local)** — a local, modular pipeline using **whisper.cpp → Ollama → Piper**.

The extension keeps one common UI for both providers and preserves the three output modes:

- **Subtitles + dub**
- **Subtitles only**
- **Dub only**

## Important: what Ollama does in the local pipeline

Ollama is the **translation LLM**. It accepts the transcript from whisper.cpp and returns translated text through its local `/api/chat` endpoint.

Ollama does not currently provide the complete realtime speech-in/speech-out translation stack used by the OpenAI provider. Therefore local audio is handled by separate local tools:

```text
Browser video audio
        │
        ▼
Chrome tabCapture + MediaRecorder
        │  short WebM/Opus chunks
        ▼
Local AutoTranslate backend
        │
        ├── ffmpeg ─────────► 16 kHz mono WAV
        ├── whisper.cpp ────► source transcript
        ├── Ollama ─────────► translated text
        └── Piper (optional) ► translated WAV dub
                    │
                    ▼
Extension subtitle overlay + audio playback
```

This design keeps the provider layer extensible. A future local STT or TTS engine can replace whisper.cpp or Piper without changing the Ollama translation adapter or the extension UI.

## What is included

- `extension/` — Chrome/Edge/Brave Manifest V3 extension
- `server/` — one Node.js backend supporting both providers
- provider selector in the popup
- automatic discovery of installed Ollama models
- provider-specific target-language filtering
- subtitles, dub, and combined modes for both providers
- optional source-language transcript
- independent original-audio and dub-volume controls
- bounded local audio queue to prevent unlimited latency on slower machines
- centralized language registry in `server/src/languages.js`
- no OpenAI API key stored in the extension

## Requirements

### Browser

- Chrome, Microsoft Edge, Brave, or another Chromium browser based on Chrome 116+
- Node.js 20+

### OpenAI provider

- an OpenAI API key with access to Realtime Translation

### Ollama local provider

Required for local subtitles:

- [Ollama](https://ollama.com/) running locally
- at least one installed multilingual instruction model
- [ffmpeg](https://ffmpeg.org/)
- CMake and a C/C++ build toolchain for building whisper.cpp
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with `whisper-cli`
- a multilingual whisper.cpp GGML model, such as `ggml-small.bin`

Required only for local dubbing:

- [Piper](https://github.com/OHF-Voice/piper1-gpl)
- at least one Piper voice for every target language you want to dub
- multiple Piper voices per target language if you want different inferred characters to sound different

## Setup

### 1. Configure the backend

```bash
cd server
cp .env.example .env
```

Then edit `.env`.

### Option A: OpenAI only

```dotenv
OPENAI_API_KEY=<your-openai-api-key>
LOCAL_PIPELINE_ENABLED=false
```

### Option B: Ollama local subtitles

Start Ollama and install a model:

```bash
ollama serve
ollama pull <your-multilingual-model>
```

Build whisper.cpp and download a multilingual model. The official whisper.cpp quick start builds `whisper-cli`; its CLI expects 16-bit WAV input, which the included backend creates with ffmpeg.

For a standard CPU build:

```bash
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
sh ./models/download-ggml-model.sh small
cmake -B build
cmake --build build -j --config Release
./build/bin/whisper-cli -m models/ggml-small.bin -f samples/jfk.wav
```

If you use a different multilingual model, use that model name in the download command and update `WHISPER_MODEL_PATH` below.

Then configure:

```dotenv
OPENAI_API_KEY=
LOCAL_PIPELINE_ENABLED=true
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=<your-installed-ollama-model>

WHISPER_COMMAND=/absolute/path/to/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=/absolute/path/to/whisper.cpp/models/ggml-small.bin
FFMPEG_PATH=ffmpeg

# No Piper voices means local subtitles work, but local dub modes stay disabled.
PIPER_VOICES_JSON={}
```

### Option C: Ollama local subtitles + dub

Install Piper:

```bash
python -m pip install piper-tts
python -m piper.download_voices en_US-lessac-medium
```

Then add the voice to `.env`:

```dotenv
PIPER_COMMAND=python
PIPER_COMMAND_ARGS=-m piper
PIPER_VOICES_JSON={"en":"en_US-lessac-medium"}
```

For character-style voice variety in **Subtitles + dub** mode, configure a voice bank with multiple voices for the target language:

```dotenv
PIPER_VOICE_BANK_JSON={"en":["en_US-lessac-medium","en_US-amy-medium","en_US-ryan-medium"]}
```

The backend asks the selected Ollama model to split each translated chunk into dialogue turns with stable speaker IDs, then assigns each speaker ID to a configured Piper voice for the session. If only `PIPER_VOICES_JSON` is configured, all inferred speakers use that single voice.

For multi-speaker Piper models or custom voice paths, use object entries:

```dotenv
PIPER_VOICE_BANK_JSON={"en":[{"id":"voice_a","model":"/voices/en.onnx","args":["--speaker","0"]},{"id":"voice_b","model":"/voices/en.onnx","args":["--speaker","1"]}]}
```

For multiple output languages:

```dotenv
PIPER_VOICES_JSON={"en":"en_US-lessac-medium","de":"de_DE-thorsten-medium"}
```

The popup enables local dub modes only when the selected target language has a configured Piper voice.

### Option D: Enable both providers

Configure both sections in the same `.env`:

```dotenv
OPENAI_API_KEY=<your-openai-api-key>

LOCAL_PIPELINE_ENABLED=true
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=<your-installed-ollama-model>
WHISPER_COMMAND=/absolute/path/to/whisper-cli
WHISPER_MODEL_PATH=/absolute/path/to/ggml-small.bin
FFMPEG_PATH=ffmpeg
PIPER_COMMAND=python
PIPER_COMMAND_ARGS=-m piper
PIPER_VOICES_JSON={"en":"en_US-lessac-medium"}
# Optional, for speaker-aware local dubbing:
PIPER_VOICE_BANK_JSON={"en":["en_US-lessac-medium","en_US-amy-medium","en_US-ryan-medium"]}
```

Install and start the backend:

```bash
npm install
npm start
```

You should see:

```text
AutoTranslate provider server listening on http://localhost:8787
OpenAI provider: configured
Ollama local pipeline: enabled
```

Check provider discovery:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/providers
curl http://localhost:8787/ollama/models
```

### 2. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project's `extension` folder.

### 3. Translate a video

1. Open a webpage with a Japanese video.
2. Start video playback.
3. Click the AutoTranslate extension icon.
4. Choose **OpenAI Realtime** or **Ollama local**.
5. When using Ollama, choose one of the locally installed models discovered by the backend.
6. Keep **Japanese → English**, or choose another language pair.
7. Choose **Subtitles + dub**, **Subtitles only**, or **Dub only**.
8. Adjust original and translated audio levels.
9. Click the start button.

## Provider comparison

| Capability | OpenAI Realtime | Ollama local |
|---|---|---|
| Translation engine | `gpt-realtime-translate` | user-selected Ollama model |
| Speech-to-text | built into realtime service | local whisper.cpp |
| Subtitles | streaming transcript deltas | translated short chunks |
| Dubbing | remote WebRTC audio track | local Piper voices |
| Audio leaves the computer | Yes, directly to OpenAI | No, when backend and Ollama are local |
| Typical latency | lower | hardware/model dependent and usually higher |
| API key required | Yes | No |
| Target language range | model-defined | depends on selected LLM; dub also requires a Piper voice |

## Local-mode latency and queue behavior

The local provider records approximately 4.5-second audio segments. Each segment is converted, transcribed, translated, and optionally synthesized. This is not word-by-word realtime translation.

To avoid an ever-growing delay on slower hardware, the extension keeps at most two untranslated segments waiting. If local inference cannot keep up with the video, the oldest waiting segment is dropped and newer dialogue is prioritized.

For lower latency:

- use a smaller whisper.cpp model
- use a smaller quantized Ollama model that still translates your language pair well
- use GPU acceleration where supported
- use subtitles-only mode to avoid Piper synthesis time
- keep Ollama's model loaded; the backend sends `keep_alive: "10m"`

## Ollama model discovery

The backend calls Ollama's local:

```text
GET /api/tags
```

and returns the installed models to the extension. The selected model is sent to:

```text
POST /api/chat
```

with `stream: false`, `think: false`, a strict audiovisual-translation system prompt, and a small amount of recent translated context for terminology consistency.

No direct browser-to-Ollama access is required, so you do not need to set `OLLAMA_ORIGINS` for the extension. The Node backend talks to Ollama on `127.0.0.1` by default.

## Local-only Ollama operation

Ollama's local models run on your machine. Ollama also supports cloud features, so for an explicitly local-only Ollama installation you can disable cloud features:

```bash
OLLAMA_NO_CLOUD=1 ollama serve
```

or configure `disable_ollama_cloud` in Ollama's server configuration.

## Add more languages

Edit `server/src/languages.js`:

```js
{ code: "sv", label: "Swedish", openAiTarget: false, ollamaTarget: true }
```

- `openAiTarget` should be true only when the current OpenAI Realtime Translation output supports the language.
- `ollamaTarget` controls whether the language is offered for local text translation. Actual quality depends on the selected Ollama model.
- To enable local dubbing for that language, add a matching voice in `PIPER_VOICES_JSON` or a voice list in `PIPER_VOICE_BANK_JSON`.

Restart the backend. The popup fetches `GET /languages` whenever it opens.

## How OpenAI mode works

The browser sends the captured tab-audio track directly to OpenAI over WebRTC. Translated speech arrives as a remote audio track; translated subtitle deltas arrive over the realtime event data channel. The included backend only creates a short-lived client secret and never receives the tab audio.

## How Ollama mode works

The extension records the captured tab audio into short WebM/Opus segments and posts each segment to the local backend. The backend:

1. converts the segment to 16 kHz mono PCM WAV with ffmpeg
2. transcribes it with whisper.cpp JSON output
3. translates the transcript using the selected Ollama model
4. for Live dub modes, asks Ollama to split the translation into speaker turns
5. for buffered dub modes, assigns a speaker ID to each timed Whisper segment
6. synthesizes requested dub audio with stable Piper voices

Local Whisper responses include structured speech segments. The backend normalizes each segment's chunk-relative Whisper timing and, when buffered chunk metadata is available, maps those segment times onto the source video timeline using the captured chunk start/end media times. For local buffered subtitle-capable modes, Ollama returns one translated subtitle item for each Whisper segment ID, and the extension schedules those cues against the delayed player's source-time clock. Pauses and seeks are generation-aware, and severely late cues are dropped instead of being displayed out of sync.

Buffered startup uses two separate readiness checks. The delayed player waits for the configured initial buffer of captured media and, for local buffered subtitle-capable modes, the same amount of continuous source-video time to be successfully processed through transcription and subtitle translation. Successful empty or silent chunks still advance this translation watermark because they represent processed source time that needs no subtitle. Real processing gaps stop the continuous watermark; the player does not skip past them or claim untranslated time is ready. Runtime automatic rebuffering is not implemented yet, so late cues may still be dropped later if processing falls behind after playback has started.

For local buffered dub-capable modes, the backend prepares one timed dub clip per non-empty translated Whisper segment. Segment timing comes only from backend-normalized source-video timing, each speaker ID receives a stable Piper voice, and each synthesized WAV duration is measured. The extension forwards those clips to a page-level Web Audio scheduler that starts them when the delayed player's `delayedSourceTimeMs` reaches the clip start. Clips that arrive during their source interval begin at a proportional audio offset, expired clips are dropped, and overlong clips are stopped at the end of their source interval.

During active buffered dub speech, the delayed original video audio is ducked: dub-only mode mutes it, and Subtitles + dub mode lowers it. Pause, rebuffering, seeking, and generation changes stop or suspend timed dub playback against the delayed playback clock. Local Live mode and OpenAI mode still use their immediate/streaming subtitle and audio behavior. Audio time stretching, fitted synthesis, and lip synchronization are not implemented.

Piper synthesis uses the installed CLI's stdin input path. The backend invokes the configured command, preserves `PIPER_COMMAND_ARGS` such as `-m piper`, passes the voice with `-m/--model`, writes a WAV with `-f/--output-file`, and sends text through stdin rather than appending the text to the command line. Voices may be configured as explicit `.onnx` model paths or as Piper voice names. Voice names must be resolvable from the server working directory or a configured `PIPER_DATA_DIR`/`PIPER_DATA_DIRS`; Piper also requires the matching `.onnx.json` config file. Missing or unreadable voices are reported as `PIPER_VOICE_NOT_FOUND`.

To verify Piper manually, download or place the voice files in a local voice directory and run:

```bash
printf '%s\n' 'Short test sentence.' | python -m piper --data-dir <voice-dir> -m en_US-lessac-medium -f /tmp/piper-check.wav
```

Local Live dubbing and buffered timed dubbing share this same corrected Piper runtime path.

The backend stores only a small in-memory rolling text context for the active local session. Temporary audio and transcript files are deleted after each request.

## Remote backend deployment

OpenAI mode can use a remote HTTPS backend because video audio still goes directly to OpenAI.

Ollama mode is intended for a backend on the same computer. If you point the extension to a remote backend while using Ollama mode, captured audio is sent to that backend and is no longer local/private.

For any remote deployment:

1. use HTTPS
2. restrict `ALLOWED_ORIGINS`
3. add authentication
4. use persistent distributed rate limiting
5. avoid logging audio, transcripts, translations, or credentials
6. add monitoring and abuse controls

## Limitations

- OpenAI mode has network/model latency and is not frame-perfect or lip-synchronized.
- Ollama mode is chunk-based and normally has noticeably more latency.
- Local translation quality depends strongly on the Ollama model, quantization, prompt following, and source/target languages.
- Local transcription quality depends on the whisper.cpp model and audio clarity.
- Speaker-aware local dubbing is inferred from transcript context. It can keep voices stable for clear dialogue turns, but it is not full visual character recognition or guaranteed speaker diarization.
- Piper voices are language-specific; text translation can support a language even when local dubbing is unavailable.
- Loading Piper from the command line for every chunk is simple and portable but slower than a persistent Piper server. A future version can add a persistent TTS adapter.
- Music, overlapping speakers, fast dialogue, names, and specialized terminology can reduce quality in both providers.
- Browser-internal pages cannot be captured. Some protected/DRM media may provide silence or block capture.
- The overlay can be hidden by native fullscreen directly on a `<video>` element on some sites.
- One extension session translates into one target language at a time.
- Firefox requires a separate media-capture port.

## Security and privacy

### OpenAI provider

- the permanent OpenAI API key remains in the backend
- the extension receives only a short-lived client secret
- tab audio is sent directly from the extension to OpenAI over WebRTC

### Ollama provider

- no API key is required for the default local Ollama server
- audio is sent from the extension to the configured AutoTranslate backend
- when that backend, Ollama, whisper.cpp, ffmpeg, and Piper all run locally, the pipeline stays on the computer
- temporary per-chunk files are removed after processing

## Development checks

```bash
cd server
npm run check
```

Validate the extension manifest:

```bash
python -m json.tool ../extension/manifest.json > /dev/null
```

## Reference documentation

- Ollama API introduction: https://docs.ollama.com/api/introduction
- Ollama chat endpoint: https://docs.ollama.com/api/chat
- Ollama model-list endpoint: https://docs.ollama.com/api/tags
- Ollama FAQ and local-only configuration: https://docs.ollama.com/faq
- whisper.cpp: https://github.com/ggml-org/whisper.cpp
- Piper current project: https://github.com/OHF-Voice/piper1-gpl
- Piper CLI: https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/CLI.md
- OpenAI Realtime Translation: https://developers.openai.com/api/docs/guides/realtime-translation
- OpenAI Realtime WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- Chrome tab capture: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Chrome offscreen documents: https://developer.chrome.com/docs/extensions/reference/api/offscreen

## Project status

Version `0.4.0` is a local-installation MVP. Before extension-store publication, add automated end-to-end browser tests, a privacy policy, accessibility testing, a persistent local STT/TTS service option, signed release packaging, and production backend authentication.
