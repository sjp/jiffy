// Control bar — the only component that talks to the engine; children are pure
// presentational components (PRD §8). Wired up fully in issue 09.
import type { Engine } from '../engine/types';
import { Readout } from './Readout';
import { Scrubber } from './Scrubber';
import { pauseIcon, playIcon } from './icons';

export interface ControlsProps {
  engine: Engine;
}

export function Controls({ engine }: ControlsProps) {
  const { playing, index, frameCount, currentTime, duration } = engine.state;
  return (
    <div class="bar">
      <button
        class="toggle"
        type="button"
        onClick={() => engine.toggle()}
        dangerouslySetInnerHTML={{ __html: playing ? pauseIcon : playIcon }}
      />
      <Scrubber
        time={currentTime}
        duration={duration}
        onSeek={(t) => engine.seekToTime(t)}
        onScrubStart={() => engine.pause()}
      />
      <Readout index={index} frameCount={frameCount} />
    </div>
  );
}
