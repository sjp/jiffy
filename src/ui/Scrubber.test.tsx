// Tests for the Scrubber: time-driven seek + pause-while-dragging.
// Part A exercises the Scrubber's props/callbacks in isolation; Part B drives it
// through <Controls> to verify pause-on-drag + resume-on-release against a real
// engine. jsdom's PointerEvent is patchy, so we dispatch plain `window.Event`s of
// the right type — the handlers don't read event coordinates.
import '../test/setup-dom.ts';
import assert from 'node:assert/strict';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Scrubber } from './Scrubber.tsx';
import { Controls } from './Controls.tsx';
import { createEngine, type EngineClock } from '../engine/engine.ts';

const ev = (type: string) => new window.Event(type, { bubbles: true });

// ---- Part A: isolated Scrubber ------------------------------------------
let seeked = -1;
let starts = 0;
let ends = 0;

const a = document.createElement('div');
document.body.appendChild(a);
act(() => {
  render(
    <Scrubber
      time={50}
      duration={300}
      onSeek={(t) => (seeked = t)}
      onScrubStart={() => starts++}
      onScrubEnd={() => ends++}
    />,
    a,
  );
});

const range = a.querySelector('input')!;
assert.equal(range.type, 'range', 'is a range input');
assert.equal(range.max, '300', 'max = duration');
assert.equal(range.value, '50', 'value = time');

act(() => {
  range.value = '150';
  range.dispatchEvent(ev('input'));
});
assert.equal(seeked, 150, 'onSeek gets the dragged time');

act(() => range.dispatchEvent(ev('pointerdown')));
assert.equal(starts, 1, 'pointerdown → onScrubStart');
act(() => range.dispatchEvent(ev('pointerup')));
assert.equal(ends, 1, 'pointerup → onScrubEnd');

render(null, a);

// ---- Part B: pause-while-dragging through <Controls> --------------------
const clock: EngineClock = { now: () => 0, schedule: () => 1, cancel: () => {} };
const frames = [
  { bitmap: {}, time: 100, delay: 100 },
  { bitmap: {}, time: 200, delay: 100 },
  { bitmap: {}, time: 300, delay: 100 },
] as never;
const engine = createEngine(frames, 300, clock);
engine.play(); // playing (the scheduled tick never fires with this clock)

const b = document.createElement('div');
document.body.appendChild(b);
act(() => render(<Controls engine={engine} />, b));

const slider = b.querySelector('input[type=range]')! as HTMLInputElement;

act(() => slider.dispatchEvent(ev('pointerdown')));
assert.equal(engine.state.playing, false, 'pauses while dragging');

act(() => {
  slider.value = '150';
  slider.dispatchEvent(ev('input'));
});
assert.equal(Math.round(engine.state.currentTime), 150, 'drag seeks to time');
assert.equal(engine.state.index, 1, 'time 150 maps to frame 2');

act(() => slider.dispatchEvent(ev('pointerup')));
assert.equal(engine.state.playing, true, 'resumes playback after release');

render(null, b);
console.log('Scrubber.test: OK');
