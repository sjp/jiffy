// Frame/time readout. Pure presentational: props in, text out — no
// engine access of its own (<Controls> passes the snapshot fields down).

export interface ReadoutProps {
  /** 0-based current frame index. */
  index: number;
  frameCount: number;
  /** Current time in ms. */
  time: number;
  /** Total duration in ms. */
  duration: number;
}

/** Format milliseconds as `1.2s` under a minute, else `m:ss`. */
function formatTime(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function Readout({ index, frameCount, time, duration }: ReadoutProps) {
  return (
    <span class="readout">
      {index + 1} / {frameCount}
      {duration > 0 && (
        <span class="time">
          {' · '}
          {formatTime(time)} / {formatTime(duration)}
        </span>
      )}
    </span>
  );
}
