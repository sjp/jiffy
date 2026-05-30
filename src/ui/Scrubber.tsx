// Seek scrubber — driven by time for smooth seeking across uneven GIF delays
// (PRD §8). Full behaviour (pause-on-drag, resume) lands in issue 09.

export interface ScrubberProps {
  time: number;
  duration: number;
  onSeek: (t: number) => void;
  onScrubStart?: () => void;
}

export function Scrubber({ time, duration, onSeek, onScrubStart }: ScrubberProps) {
  return (
    <input
      type="range"
      min={0}
      max={duration}
      step="any"
      value={time}
      onPointerDown={onScrubStart}
      onInput={(e) => onSeek(e.currentTarget.valueAsNumber)}
    />
  );
}
