// Component test for <Controls> (issue 08), rendered in jsdom via the esbuild
// test runner. `act` (from preact, no extra dep) flushes renders + effects so
// assertions see the updated DOM. The engine uses an injected clock so no real
// rAF runs.
import '../test/setup-dom.ts';
import assert from 'node:assert/strict';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Controls } from './Controls.tsx';
import { createEngine, type EngineClock } from '../engine/engine.ts';

// Clock whose scheduled callback never fires: play() flips `playing` but the
// loop never advances, keeping the test deterministic.
const clock: EngineClock = { now: () => 0, schedule: () => 1, cancel: () => {} };

const frames = [
  { bitmap: {}, time: 100, delay: 100 },
  { bitmap: {}, time: 200, delay: 100 },
  { bitmap: {}, time: 300, delay: 100 },
] as never;
const engine = createEngine(frames, 300, clock);

const container = document.createElement('div');
document.body.appendChild(container);

act(() => {
  render(<Controls engine={engine} />, container);
});

const buttons = () => Array.from(container.querySelectorAll('button'));
assert.equal(buttons().length, 3, 'prev / play-pause / next');

const [prev, toggle, next] = buttons();
const text = () => container.textContent ?? '';

// Initial: paused, frame 1 of 3.
assert.equal(toggle!.getAttribute('aria-label'), 'Play', 'starts paused');
assert.match(text(), /1 \/ 3/, 'readout shows 1 / 3');

// Toggle → plays; icon/label reflects state via the subscription.
act(() => toggle!.click());
assert.equal(engine.state.playing, true, 'clicking toggle plays');
assert.equal(toggle!.getAttribute('aria-label'), 'Pause', 'icon reflects playing');

// Next → steps one frame and pauses (stepping is exact + paused).
act(() => next!.click());
assert.equal(engine.state.index, 1, 'next steps one frame');
assert.equal(engine.state.playing, false, 'stepping pauses');
assert.match(text(), /2 \/ 3/, 'readout updates to 2 / 3');

// Prev → steps back.
act(() => prev!.click());
assert.equal(engine.state.index, 0, 'prev steps back');
assert.match(text(), /1 \/ 3/, 'readout back to 1 / 3');

render(null, container);
console.log('Controls.test: OK');
