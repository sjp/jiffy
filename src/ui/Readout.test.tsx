// Component test for <Readout>: props-driven frame/time text.
import '../test/setup-dom.ts';
import assert from 'node:assert/strict';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Readout } from './Readout.tsx';

const mount = () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};
const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

// Sub-minute: 1-based frame index + seconds with one decimal.
const a = mount();
act(() => render(<Readout index={11} frameCount={48} time={1200} duration={3000} />, a));
assert.match(norm(a.textContent), /12 \/ 48/, '1-based frame / count');
assert.match(norm(a.textContent), /1\.2s \/ 3\.0s/, 'seconds with one decimal');

// Over a minute: m:ss formatting.
const b = mount();
act(() => render(<Readout index={0} frameCount={5} time={65000} duration={125000} />, b));
assert.match(norm(b.textContent), /1:05 \/ 2:05/, 'm:ss for >= 60s');

// Zero duration hides the time portion.
const c = mount();
act(() => render(<Readout index={0} frameCount={1} time={0} duration={0} />, c));
assert.match(norm(c.textContent), /1 \/ 1/, 'frame / count still shown');
assert.doesNotMatch(norm(c.textContent), /s \//, 'no time when duration is 0');

console.log('Readout.test: OK');
