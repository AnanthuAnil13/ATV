/**
 * Shared language registry.
 *
 * `openAiTarget` reflects the target-language set exposed by the current
 * OpenAI Realtime Translation model. `ollamaTarget` is intentionally broader:
 * local translation quality depends on the Ollama model the user selects.
 */
export const LANGUAGES = Object.freeze([
  { code: "ja", label: "Japanese", openAiTarget: true, ollamaTarget: true },
  { code: "en", label: "English", openAiTarget: true, ollamaTarget: true },
  { code: "es", label: "Spanish", openAiTarget: true, ollamaTarget: true },
  { code: "pt", label: "Portuguese", openAiTarget: true, ollamaTarget: true },
  { code: "fr", label: "French", openAiTarget: true, ollamaTarget: true },
  { code: "ru", label: "Russian", openAiTarget: true, ollamaTarget: true },
  { code: "zh", label: "Chinese", openAiTarget: true, ollamaTarget: true },
  { code: "de", label: "German", openAiTarget: true, ollamaTarget: true },
  { code: "ko", label: "Korean", openAiTarget: true, ollamaTarget: true },
  { code: "hi", label: "Hindi", openAiTarget: true, ollamaTarget: true },
  { code: "id", label: "Indonesian", openAiTarget: true, ollamaTarget: true },
  { code: "vi", label: "Vietnamese", openAiTarget: true, ollamaTarget: true },
  { code: "it", label: "Italian", openAiTarget: true, ollamaTarget: true },
  { code: "nl", label: "Dutch", openAiTarget: false, ollamaTarget: true }
]);

export const LANGUAGE_CODES = new Set(LANGUAGES.map(({ code }) => code));
export const OPENAI_TARGET_LANGUAGE_CODES = new Set(
  LANGUAGES.filter(({ openAiTarget }) => openAiTarget).map(({ code }) => code)
);
export const OLLAMA_TARGET_LANGUAGE_CODES = new Set(
  LANGUAGES.filter(({ ollamaTarget }) => ollamaTarget).map(({ code }) => code)
);

export const LANGUAGE_LABELS = new Map(LANGUAGES.map(({ code, label }) => [code, label]));
