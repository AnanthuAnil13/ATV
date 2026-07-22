# Buffered Player Manual Browser Checklist

Use Chrome 116 or newer with the unpacked extension loaded.

1. Start the local backend and play a normal webpage video with audio.
2. In the popup, choose Ollama, choose a local model, set Playback mode to Buffered, and set Initial buffer to 10 seconds.
3. Start translation and confirm the source video is visually replaced by the buffered player overlay.
4. Confirm the delayed copy does not start immediately; it starts only after the overlay reports the configured buffer duration.
5. Confirm no live source audio is heard before delayed playback starts.
6. Confirm the delayed video continues while the original source video is running ahead.
7. Pause the source video and confirm delayed playback pauses without removing the buffered player.
8. Resume the source video and confirm delayed playback resumes after buffered media is available.
9. Seek the source video and confirm buffered playback stops with a restart-required message.
10. Stop translation and confirm the delayed video, overlay, and injected styles are removed and the original page video/audio are restored.
11. Repeat with Playback mode set to Live and confirm the buffered-player files are not injected and existing live behavior is unchanged.
12. Choose OpenAI with Playback mode set to Buffered and confirm the popup shows the local-only validation instead of starting buffered playback.
