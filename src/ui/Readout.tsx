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
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// The elapsed time and frame index grow in digit count as playback advances
// (e.g. `9.9s` → `10.0s`). Reserving the widest each will ever get — in `ch`,
// which is exact because `.readout` uses tabular-nums — keeps the readout a
// constant width so the buttons to its right never shift.

/** Max character length of the elapsed-time string over `[0, duration]`. */
function maxTimeChars(durationMs: number): number {
  // Elapsed is never longer than the duration string within the same format…
  let max = formatTime(durationMs).length;
  // …but formatTime flips `X.Xs` → `m:ss` at 60s, and the sub-minute peak
  // `59.9s` (5 chars) can be wider than a short `m:ss` duration (e.g. `1:50`).
  if (durationMs >= 60000) max = Math.max(max, 5);
  return max;
}

export function Readout({ index, frameCount, time, duration }: ReadoutProps) {
  return (
    <span class="readout">
      <span class="num" style={{ minWidth: `${String(frameCount).length}ch` }}>
        {index + 1}
      </span>{" "}
      / {frameCount}
      {duration > 0 && (
        <span class="time">
          {" · "}
          <span class="num" style={{ minWidth: `${maxTimeChars(duration)}ch` }}>
            {formatTime(time)}
          </span>{" "}
          / {formatTime(duration)}
        </span>
      )}
    </span>
  );
}
