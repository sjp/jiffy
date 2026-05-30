// <Controls> — the control bar and the ONLY component that talks to the engine
// (PRD §8). It subscribes via useEngineState and dispatches engine commands;
// children (Scrubber/Readout, issues 09/10) are pure props+callbacks.
//
// Issue 08 builds the play/pause toggle + prev/next frame-step buttons. The
// scrubber and readout slot into the same bar in issues 09 and 10.
import type { Engine } from '../engine/types';
import { useEngineState } from './useEngineState';
import { PauseIcon, PlayIcon, StepBackIcon, StepForwardIcon } from './icons';

/** Props for the top-level controls component. */
export interface ControlsProps {
  engine: Engine;
}

/** Top-level controls bar. */
export function Controls({ engine }: ControlsProps) {
  const { playing, index, frameCount } = useEngineState(engine);

  // With a single frame there's nothing to play or step through. At the ends we
  // let the engine clamp rather than disabling the buttons, so they don't
  // flicker disabled on every loop during playback (issue 04 already clamps).
  const steppable = frameCount > 1;

  return (
    <div class="bar">
      <button
        type="button"
        class="icon"
        aria-label="Previous frame"
        disabled={!steppable}
        onClick={() => engine.step(-1)}
      >
        <StepBackIcon />
      </button>

      <button
        type="button"
        class="icon"
        aria-label={playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
        disabled={!steppable}
        onClick={() => engine.toggle()}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <button
        type="button"
        class="icon"
        aria-label="Next frame"
        disabled={!steppable}
        onClick={() => engine.step(1)}
      >
        <StepForwardIcon />
      </button>

      <span class="readout">
        {index + 1} / {frameCount}
      </span>
    </div>
  );
}
