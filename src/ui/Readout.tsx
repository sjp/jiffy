// Frame/time readout (PRD §8).

export interface ReadoutProps {
  index: number;
  frameCount: number;
}

export function Readout({ index, frameCount }: ReadoutProps) {
  return (
    <span class="readout">
      {index + 1}/{frameCount}
    </span>
  );
}
