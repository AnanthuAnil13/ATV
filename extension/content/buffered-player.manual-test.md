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
30. Use buffered Dub only at 1x and confirm timed Piper clips play from the delayed video's displayed source position, not immediately when the backend response arrives.
31. Use buffered Subtitles + dub at 1x and confirm subtitles and timed dub clips follow the same delayed source-time intervals.
32. Confirm delayed original audio is muted while a dub-only timed clip is active and restored when the clip ends.
33. Confirm delayed original audio is reduced, not fully muted, while a Subtitles + dub timed clip is active and restored when the clip ends.
34. Pause while a timed dub clip is active and confirm translated audio pauses with delayed playback.
35. Resume after a long pause and confirm translated audio resumes from the same decoded-audio position.
36. Seek forward during an active timed dub clip and confirm old audio stops and does not resume after rebuffering.
37. Seek backward during queued timed dub clips and confirm old-generation clips are discarded.
38. Perform repeated rapid seeks and confirm late decode completions from earlier generations do not play.
39. Test timed dub at 0.5x and confirm clip start decisions follow the delayed visible content.
40. Test timed dub at 1.5x and confirm clip start decisions follow the delayed visible content.
41. Test timed dub at 2x and confirm clip start decisions follow the delayed visible content.
42. Use a case where a timed dub clip is available before its start and confirm it waits.
43. Use a case where a timed dub clip arrives during its interval and confirm playback starts at a proportional audio offset.
44. Use a case where a timed dub clip arrives after its interval and confirm it is dropped.
45. Use a clip longer than its source interval and confirm runtime playback stops at the interval end without time stretching.
46. Use a clip shorter than its source interval and confirm it finishes naturally.
47. Test overlapping timed dub clips and confirm at most two play at once.
48. Stop translation with active timed audio and confirm all translated audio stops and delayed original audio volume is restored.
49. Start another buffered session and confirm stale timed dub clips from the old session do not play.
50. Switch back to Live mode and confirm the timed dub scheduler is not injected and Live dubbing remains immediate.
51. Run an OpenAI audio regression check and confirm the realtime translated audio path remains unchanged.
52. Enter fullscreen and confirm delayed video, subtitles, and timed dub behavior remain tied to the same buffered playback session.
53. Test an autoplay-blocked page state and confirm one clear timed dub playback error is reported instead of repeated per-clip errors.
