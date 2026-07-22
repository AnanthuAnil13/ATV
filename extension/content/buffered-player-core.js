(function installBufferedPlayerCore(global) {
  if (global.AutoTranslateBufferedPlayerCore) return;

  const MIN_INITIAL_BUFFER_SECONDS = 5;
  const MAX_INITIAL_BUFFER_SECONDS = 30;
  const DEFAULT_INITIAL_BUFFER_SECONDS = 10;
  const MIN_VIDEO_WIDTH = 120;
  const MIN_VIDEO_HEIGHT = 80;
  const MIN_VIDEO_AREA = MIN_VIDEO_WIDTH * MIN_VIDEO_HEIGHT;

  const RECORDER_MIME_CANDIDATES = Object.freeze([
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ]);

  function clampInitialBufferSeconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_INITIAL_BUFFER_SECONDS;
    return Math.min(MAX_INITIAL_BUFFER_SECONDS, Math.max(MIN_INITIAL_BUFFER_SECONDS, number));
  }

  function shouldActivateBufferedPlayer(config) {
    return config?.provider === "ollama" && config?.syncMode === "buffered";
  }

  function selectPrimaryVideo(candidates) {
    const ranked = Array.from(candidates || [])
      .map((candidate, index) => ({ candidate, index, details: describeCandidate(candidate) }))
      .filter((item) => item.details.usable)
      .sort(compareVideoCandidates);
    return ranked[0]?.candidate || null;
  }

  function describeCandidate(candidate) {
    const rect = candidate?.rect || candidate?.boundingClientRect || {};
    const width = toFiniteNumber(rect.width ?? candidate?.width, 0);
    const height = toFiniteNumber(rect.height ?? candidate?.height, 0);
    const area = width * height;
    const readyState = toFiniteNumber(candidate?.readyState, 0);
    const paused = candidate?.paused !== false;
    const ended = candidate?.ended === true;
    const visible = candidate?.visible !== false &&
      candidate?.hidden !== true &&
      candidate?.display !== "none" &&
      candidate?.visibility !== "hidden" &&
      candidate?.opacity !== 0;
    const connected = candidate?.isConnected !== false;
    const playing = candidate?.playing === true || (!paused && !ended && readyState >= 2);
    const usable = connected && visible && !ended && width > 0 && height > 0 &&
      width >= MIN_VIDEO_WIDTH && height >= MIN_VIDEO_HEIGHT && area >= MIN_VIDEO_AREA;

    return {
      width,
      height,
      area,
      readyState,
      paused,
      ended,
      visible,
      connected,
      playing,
      usable
    };
  }

  function compareVideoCandidates(left, right) {
    if (left.details.playing !== right.details.playing) {
      return left.details.playing ? -1 : 1;
    }
    if (left.details.area !== right.details.area) {
      return right.details.area - left.details.area;
    }
    return left.index - right.index;
  }

  function pickBufferedRecorderMimeType(
    mediaRecorder = global.MediaRecorder,
    mediaSource = global.MediaSource
  ) {
    if (!mediaRecorder || typeof mediaRecorder.isTypeSupported !== "function") return "";
    const mediaSourceSupport = mediaSource?.isTypeSupported;
    if (typeof mediaSourceSupport !== "function") return "";

    return RECORDER_MIME_CANDIDATES.find((mimeType) => {
      return mediaRecorder.isTypeSupported(mimeType) && mediaSourceSupport.call(mediaSource, mimeType);
    }) || "";
  }

  function getPlayableBufferedAhead(buffered, currentTime, tolerance = 0.25) {
    const time = toFiniteNumber(currentTime, 0);
    const rangeCount = Math.max(0, toInteger(buffered?.length, 0));
    for (let index = 0; index < rangeCount; index += 1) {
      const start = toFiniteNumber(buffered.start(index), 0);
      const end = toFiniteNumber(buffered.end(index), 0);
      if (time >= start - tolerance && time <= end + tolerance) {
        return Math.max(0, end - Math.max(time, start));
      }
    }
    return 0;
  }

  function isInitialBufferReady({ buffered, currentTime = 0, initialBufferSeconds } = {}) {
    return getPlayableBufferedAhead(buffered, currentTime) >= clampInitialBufferSeconds(initialBufferSeconds);
  }

  function createSegmentQueue(startSequence = 0) {
    let expectedSequence = toInteger(startSequence, 0);
    const items = [];

    return {
      enqueue(segment) {
        const sequence = toInteger(segment?.sequence, NaN);
        if (sequence !== expectedSequence) {
          const error = new Error(`Out-of-order media segment received. Expected ${expectedSequence}, got ${segment?.sequence}.`);
          error.code = "OUT_OF_ORDER_SEGMENT";
          throw error;
        }
        items.push(segment);
        expectedSequence += 1;
        return items.length;
      },
      peek() {
        return items[0] || null;
      },
      shift() {
        return items.shift() || null;
      },
      clear() {
        items.length = 0;
      },
      get size() {
        return items.length;
      },
      get expectedSequence() {
        return expectedSequence;
      }
    };
  }

  function reducePlayerLifecycle(phase, action) {
    const current = typeof phase === "string" ? phase : "idle";
    if (action === "START") return "buffering";
    if (action === "READY") return "playing";
    if (action === "PAUSE") return current === "ended" || current === "stopped" ? current : "paused";
    if (action === "RESUME") return current === "paused" ? "buffering" : current;
    if (action === "END") return "ended";
    if (action === "ERROR") return "error";
    if (action === "STOP") return "stopped";
    return current;
  }

  function toInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) ? number : fallback;
  }

  function toFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  global.AutoTranslateBufferedPlayerCore = Object.freeze({
    MIN_INITIAL_BUFFER_SECONDS,
    MAX_INITIAL_BUFFER_SECONDS,
    DEFAULT_INITIAL_BUFFER_SECONDS,
    RECORDER_MIME_CANDIDATES,
    clampInitialBufferSeconds,
    shouldActivateBufferedPlayer,
    selectPrimaryVideo,
    describeCandidate,
    pickBufferedRecorderMimeType,
    getPlayableBufferedAhead,
    isInitialBufferReady,
    createSegmentQueue,
    reducePlayerLifecycle
  });
})(globalThis);
