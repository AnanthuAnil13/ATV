(() => {
  if (window.__autoTranslateOverlayInstalled) return;
  window.__autoTranslateOverlayInstalled = true;

  const state = {
    source: "",
    target: "",
    sourceLastElapsedMs: null,
    targetLastElapsedMs: null,
    sourceClearTimer: null,
    targetClearTimer: null,
    showSourceTranscript: false,
    visible: true
  };

  const root = document.createElement("section");
  root.id = "autotranslate-overlay";
  root.setAttribute("aria-live", "polite");
  root.innerHTML = `
    <div class="autotranslate-shell">
      <div class="autotranslate-toolbar">
        <span class="autotranslate-brand">AutoTranslate</span>
        <span class="autotranslate-status" data-status="starting">Starting</span>
        <button class="autotranslate-hide" type="button" aria-label="Hide subtitles">×</button>
      </div>
      <div class="autotranslate-source" aria-label="Source transcript"></div>
      <div class="autotranslate-target" aria-label="Translated subtitles"></div>
      <div class="autotranslate-disclosure">AI-generated live translation</div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const sourceEl = root.querySelector(".autotranslate-source");
  const targetEl = root.querySelector(".autotranslate-target");
  const statusEl = root.querySelector(".autotranslate-status");
  const hideButton = root.querySelector(".autotranslate-hide");

  hideButton.addEventListener("click", () => {
    state.visible = false;
    root.hidden = true;
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "OVERLAY_CONFIG") {
      resetCues();
      statusEl.dataset.status = "starting";
      statusEl.textContent = "Starting";
      state.showSourceTranscript = Boolean(message.payload?.showSourceTranscript);
      root.dataset.showSource = String(state.showSourceTranscript);
      const provider = message.payload?.provider === "ollama" ? "Local Ollama" : "OpenAI";
      root.querySelector(".autotranslate-disclosure").textContent = `AI-generated live translation · ${provider}`;
      state.visible = true;
      root.hidden = false;
    }

    if (message?.type === "OVERLAY_TRANSCRIPT") {
      if (!state.visible) return;
      const payload = message.payload || {};
      if (payload.kind === "source" && !state.showSourceTranscript) return;
      root.hidden = false;
      appendCue(payload.kind, payload.delta, payload.elapsedMs, payload.replace === true);
    }

    if (message?.type === "OVERLAY_STATUS") {
      const { status = "idle", error } = message.payload || {};
      statusEl.dataset.status = status;
      statusEl.textContent = labelForStatus(status);
      if (error) {
        state.target = error;
        targetEl.textContent = error;
      }
    }

    if (message?.type === "OVERLAY_STOP") {
      clearTimers();
      document.removeEventListener("fullscreenchange", placeOverlay);
      root.remove();
      window.__autoTranslateOverlayInstalled = false;
    }
  });

  document.addEventListener("fullscreenchange", placeOverlay);

  function appendCue(kind, delta = "", elapsedMs, replace = false) {
    if (kind !== "source" && kind !== "target") return;
    if (typeof delta !== "string" || !delta) return;

    const textKey = kind;
    const elapsedKey = `${kind}LastElapsedMs`;
    const element = kind === "source" ? sourceEl : targetEl;
    const limit = kind === "source" ? 170 : 240;
    const clearDelay = kind === "source" ? 3800 : 4600;
    const lastElapsed = state[elapsedKey];
    const numericElapsed = Number(elapsedMs);

    if (
      state[textKey] &&
      Number.isFinite(numericElapsed) &&
      Number.isFinite(lastElapsed) &&
      numericElapsed - lastElapsed > 1200
    ) {
      state[textKey] = "";
    }

    state[textKey] = replace ? trimToCue(delta, limit) : trimToCue(`${state[textKey]}${delta}`, limit);
    state[elapsedKey] = Number.isFinite(numericElapsed) ? numericElapsed : lastElapsed;
    element.textContent = state[textKey];

    const timerKey = `${kind}ClearTimer`;
    clearTimeout(state[timerKey]);
    state[timerKey] = setTimeout(() => {
      state[textKey] = "";
      element.textContent = "";
    }, clearDelay);
  }

  function trimToCue(text, limit) {
    if (text.length <= limit) return text;
    const clipped = text.slice(-limit);
    const firstSpace = clipped.search(/\s/);
    return firstSpace >= 0 && firstSpace < 28 ? clipped.slice(firstSpace + 1) : clipped;
  }

  function resetCues() {
    clearTimers();
    state.source = "";
    state.target = "";
    state.sourceLastElapsedMs = null;
    state.targetLastElapsedMs = null;
    sourceEl.textContent = "";
    targetEl.textContent = "";
  }

  function clearTimers() {
    clearTimeout(state.sourceClearTimer);
    clearTimeout(state.targetClearTimer);
    state.sourceClearTimer = null;
    state.targetClearTimer = null;
  }

  function placeOverlay() {
    const fullscreenHost = document.fullscreenElement;
    if (fullscreenHost && fullscreenHost.tagName !== "VIDEO") {
      fullscreenHost.appendChild(root);
    } else {
      document.documentElement.appendChild(root);
    }
  }

  function labelForStatus(status) {
    return {
      starting: "Starting",
      connected: "Live",
      reconnecting: "Reconnecting",
      error: "Error",
      idle: "Stopped"
    }[status] || status;
  }
})();
