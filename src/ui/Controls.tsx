// <Controls> — the control bar and the ONLY component that talks to the engine
// (PRD §8). It subscribes via useEngineState and dispatches engine commands;
// children (Scrubber, and Readout in issue 10) are pure props+callbacks.
//
// Issue 08 added the play/pause + frame-step buttons; issue 09 adds the scrubber
// (time-driven seek with pause-while-dragging). The full readout lands in 10.
import { useRef } from 'preact/hooks';
import type { Engine } from '../engine/types';
import { useEngineState } from './useEngineState';
import { PauseIcon, PlayIcon, StepBackIcon, StepForwardIcon } from './icons';
import { Scrubber } from './Scrubber';
import { Readout } from './Readout';
import { handleControlKey } from './keymap';

/** Props for the top-level controls component. */
export interface ControlsProps {
  engine: Engine;
}

/** Top-level controls bar. */
export function Controls({ engine }: ControlsProps) {
  const { playing, index, frameCount, currentTime, duration } = useEngineState(engine);

  // With a single frame there's nothing to play or step through. At the ends we
  // let the engine clamp rather than disabling the buttons, so they don't
  // flicker disabled on every loop during playback (issue 04 already clamps).
  const steppable = frameCount > 1;

  // Remember whether playback was running when a scrub began, to resume on release.
  const wasPlaying = useRef(false);

  return (
    // Focus-scoped keyboard shortcuts (issue 12): the bar is focusable so
    // Space/arrows only drive *this* GIF when its controls have focus — no
    // document-level capture, so two GIFs never react to one keypress and page
    // text inputs keep their keys.
    <div
      class="bar"
      tabIndex={0}
      onKeyDown={(event) => {
        if (handleControlKey(event.key, engine)) event.preventDefault();
      }}
    >
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

      <Scrubber
        time={currentTime}
        duration={duration}
        onSeek={(t) => engine.seekToTime(t)}
        onScrubStart={() => {
          // Read live state (avoids stale closure) and pause while dragging.
          wasPlaying.current = engine.state.playing;
          engine.pause();
        }}
        onScrubEnd={() => {
          if (wasPlaying.current) engine.play();
        }}
      />

      <Readout
        index={index}
        frameCount={frameCount}
        time={currentTime}
        duration={duration}
      />
    </div>
  );
}
