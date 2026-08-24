// Seek scrubber — a native <input type="range"> driven by TIME, not frame index.
// Driving by time gives smooth seeking across uneven GIF delays;
// `engine.seekToTime` snaps to the correct frame internally, while frame-stepping
// stays exact via the buttons. Pure/presentational: props + callbacks only.

export interface ScrubberProps {
  /** Current playback time in ms (the engine's continuous clock). */
  time: number;
  /** Total duration in ms. */
  duration: number;
  /** Seek to an absolute time (ms). */
  onSeek: (time: number) => void;
  /** Drag started — caller pauses the engine so its loop doesn't fight input. */
  onScrubStart?: () => void;
  /** Drag ended — caller resumes if it was playing. */
  onScrubEnd?: () => void;
}

export function Scrubber({ time, duration, onSeek, onScrubStart, onScrubEnd }: ScrubberProps) {
  return (
    <input
      class="scrubber"
      type="range"
      min={0}
      max={duration}
      step="any"
      value={time}
      aria-label="Seek"
      onPointerDown={onScrubStart}
      onInput={(e) => onSeek(e.currentTarget.valueAsNumber)}
      onPointerUp={onScrubEnd}
      onPointerCancel={onScrubEnd}
    />
  );
}
