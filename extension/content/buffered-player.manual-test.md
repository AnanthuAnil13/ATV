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
13. Confirm translated subtitles appear at the delayed video position, not immediately when the backend response arrives.
14. Repeat with source transcript disabled and confirm no source text is displayed in buffered subtitles.
15. Repeat with source transcript enabled and confirm each source line appears with its matching translated cue.
16. Pause while a cue is visible and confirm it remains visible without expiring by wall-clock time.
17. Resume after a long pause and confirm subtitles continue from the same delayed media position.
18. Seek forward and confirm old-generation cues disappear and new cues wait for the rebuilt delayed clock.
19. Seek backward and confirm old-generation cues do not reappear.
20. Perform repeated rapid seeks and confirm only the latest generation displays subtitles.
21. Test playback at 0.5x and confirm subtitles follow the delayed visible content.
22. Test playback at 1.5x and confirm subtitles follow the delayed visible content.
23. Test playback at 2x and confirm subtitles follow the delayed visible content.
24. Seek immediately after changing playback rate and confirm rebuffering uses the new generation.
25. Use a case where the backend result arrives before a cue start and confirm it remains queued until its start time.
26. Use a case where the backend result arrives during a cue interval and confirm it displays immediately for the remaining interval.
27. Use a case where the backend result arrives after a cue end and confirm the cue is dropped instead of shown late.
28. Test overlapping speech segments and confirm at most two translated cues are displayed in chronological order.
29. Rebuffer while a cue is active and confirm the visible subtitle is cleared or held only when the delayed source time still matches it.
30. Stop translation while cues are queued and confirm the delayed video, overlay, and injected styles are removed and the original page video/audio are restored.
31. Start a new buffered session after stopping and confirm stale timeline events and cues from the old session do not affect it.
32. Repeat with Playback mode set to Live and confirm the buffered scheduler is not used and existing live behavior is unchanged.
33. Choose OpenAI with Playback mode set to Buffered and confirm the popup shows the local-only validation instead of starting buffered playback.
34. Run an OpenAI regression check and confirm streaming subtitles still appear immediately.
35. Enter fullscreen and confirm the delayed player and subtitle overlay remain positioned correctly.
