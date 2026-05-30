// <Controls> — subscribes to the engine and renders the control bar.
// Issue 07 stands up the mount + engine binding with a minimal bar (state-driven
// icon + readout). The interactive play/pause + frame-step buttons land in issue
// 08, the scrubber in 09, and the full readout in 10.
import type { Engine } from '../engine/types';
import { useEngineState } from './useEngineState';
import { PauseIcon, PlayIcon } from './icons';

/** Props for the top-level controls component. */
export interface ControlsProps {
  engine: Engine;
}

/** Top-level controls bar. Only this component talks to the engine. */
export function Controls({ engine }: ControlsProps) {
  const { playing, index, frameCount } = useEngineState(engine);
  return (
    <div class="bar">
      <span class="icon">{playing ? <PauseIcon /> : <PlayIcon />}</span>
      <span class="readout">
        {index + 1} / {frameCount}
      </span>
    </div>
  );
}
