// Headless tests for the content-script glue (issue 11): GIF detection, the
// per-GIF pipeline, de-duplication, single-frame skip, and teardown. The
// pipeline collaborators are stubbed (real decode/overlay need a canvas), so we
// exercise the discovery/registry/teardown orchestration in jsdom.
import '../test/setup-dom.ts';
import assert from 'node:assert/strict';
import { createController, isGifCandidate, enterPickMode, exitPickMode } from './index.ts';

const imgWith = (src: string) => {
  const img = document.createElement('img');
  img.src = src;
  return img;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- isGifCandidate ------------------------------------------------------
assert.equal(isGifCandidate(imgWith('http://x/a.gif')), true);
assert.equal(isGifCandidate(imgWith('http://x/a.gif?v=2')), true, 'query string');
assert.equal(isGifCandidate(imgWith('http://x/a.gif#frag')), true, 'fragment');
assert.equal(isGifCandidate(imgWith('http://x/a.GIF')), true, 'case-insensitive');
assert.equal(isGifCandidate(imgWith('http://x/a.png')), false);
assert.equal(isGifCandidate(imgWith('http://x/a.gifx')), false, 'no false positive');

// ---- pipeline stubs ------------------------------------------------------
let overlays = 0;
let controls = 0;
let destroyed = 0;
let unmounted = 0;
let frameCount = 3;

const deps = {
  fetchBytes: async () => new ArrayBuffer(8),
  decode: async () => ({
    frames: Array.from({ length: frameCount }, () => ({ bitmap: {}, time: 100, delay: 100 })),
    duration: 100 * frameCount,
  }),
  createEngine: () => ({}),
  createOverlay: () => {
    overlays++;
    return { canvas: document.createElement('canvas'), destroy: () => destroyed++ };
  },
  mountControls: () => {
    controls++;
    return () => unmounted++;
  },
} as never;

const ctrl = createController(deps);

// ---- happy path ----------------------------------------------------------
const gif = imgWith('http://x/a.gif');
await ctrl.processImage(gif);
assert.equal(overlays, 1, 'overlay created');
assert.equal(controls, 1, 'controls mounted');
assert.equal(ctrl.instances.size, 1, 'instance registered');

// ---- de-duplication ------------------------------------------------------
await ctrl.processImage(gif);
assert.equal(overlays, 1, 'same element not processed twice');
assert.equal(ctrl.instances.size, 1);

// ---- single-frame GIF is skipped ----------------------------------------
frameCount = 1;
await ctrl.processImage(imgWith('http://x/single.gif'));
assert.equal(ctrl.instances.size, 1, 'single-frame GIF gets no controls');
assert.equal(overlays, 1);

// ---- per-element teardown ------------------------------------------------
ctrl.teardown(gif);
assert.equal(destroyed, 1, 'overlay destroyed');
assert.equal(unmounted, 1, 'controls unmounted');
assert.equal(ctrl.instances.size, 0);

// ---- discover() scans the DOM, ignoring non-GIFs -------------------------
frameCount = 3;
document.body.append(
  imgWith('http://x/1.gif'),
  imgWith('http://x/2.gif'),
  imgWith('http://x/3.png'),
);
ctrl.discover(document);
await flush();
assert.equal(ctrl.instances.size, 2, 'two GIFs discovered, PNG ignored');

// ---- global teardown -----------------------------------------------------
ctrl.teardownAll();
assert.equal(ctrl.instances.size, 0, 'everything torn down');

// ---- pick-mode state machine --------------------------------------------
const docEl = document.documentElement;

enterPickMode();
assert.equal(docEl.style.cursor, 'crosshair', 'pick mode sets crosshair cursor');

// Escape cancels.
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.notEqual(docEl.style.cursor, 'crosshair', 'Escape exits pick mode');

// Clicking a non-GIF cancels too.
enterPickMode();
assert.equal(docEl.style.cursor, 'crosshair');
const notAGif = document.createElement('div');
document.body.appendChild(notAGif);
notAGif.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.notEqual(docEl.style.cursor, 'crosshair', 'clicking a non-GIF exits pick mode');

exitPickMode(); // no-op if already exited

console.log('content-glue.test: OK');
