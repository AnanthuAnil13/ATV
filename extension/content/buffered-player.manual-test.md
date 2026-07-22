# Buffered Player Manual Browser Checklist

Use Chrome 116 or newer with the unpacked extension loaded.

1. Start the local backend and play a normal webpage video with audio.
2. In the popup, choose Ollama, choose a local model, set Playback mode to Buffered, and set Initial buffer to 10 seconds.
3. Start translation and confirm the source video is visually replaced by the buffered player overlay.
4. Confirm the delayed copy does not start immediately; it starts only after the overlay reports the configured buffer duration.
5. Confirm no live source audio is heard before delayed playback starts.
6. Confirm the delayed video continues while the original source video is running ahead.
7. Seek forward while the initial buffer overlay is still visible and confirm the player enters rebuffering instead of stopping translation.
8. Seek backward while the initial buffer overlay is still visible and confirm the delayed buffer is rebuilt from the new source time.
9. After delayed playback is running, seek forward and confirm the overlay reappears, buffers again, and resumes delayed playback.
10. Perform repeated rapid seeks and confirm only the latest generation resumes playback and old subtitles/dubs do not appear.
11. Pause the source video for at least 10 seconds and confirm delayed playback pauses and no endless local transcription chunks are generated.
12. Resume the source video and confirm a new chunk starts and delayed playback resumes after buffered media is available.
13. Test playback at 0.5x, 1.5x, and 2x and confirm the delayed video rate follows the source rate.
14. Seek immediately after changing playback rate and confirm rebuffering uses the new rate.
15. Stop translation during seek recovery and confirm the delayed video, overlay, and injected styles are removed and the original page video/audio are restored.
16. Start a new translation session after stopping and confirm stale timeline events from the old session do not affect it.
17. Repeat with Playback mode set to Live and confirm the buffered-player files are not injected and existing live behavior is unchanged.
18. Choose OpenAI with Playback mode set to Buffered and confirm the popup shows the local-only validation instead of starting buffered playback.
