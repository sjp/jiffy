// Playback-time formatting. Shared because two places render the same clock:
// the readout draws it, and the scrubber speaks it through `aria-valuetext` —
// a screen reader reading raw milliseconds off a range input is unusable.

/** Format milliseconds as `1.2s` under a minute, else `m:ss`. */
export function formatTime(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
