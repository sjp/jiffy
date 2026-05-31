// Headless tests for the content-script glue (issue 11): animated-image
// detection (GIF + WebP), the per-image pipeline, de-duplication, single-frame
// skip, and teardown. The pipeline collaborators are stubbed (real decode/overlay
// need a canvas), so we exercise the discovery/registry/teardown orchestration
// in jsdom.
import '../test/setup-dom.ts';
import assert from 'node:assert/strict';
import {
  createController,
  isAnimatedCandidate,
  enterPickMode,
  exitPickMode,
  enhanceStandaloneImage,
} from './index.ts';

const imgWith = (src: string) => {
  const img = document.createElement('img');
  img.src = src;
  return img;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- isAnimatedCandidate ---------------------------------------------------
// GIF
assert.equal(isAnimatedCandidate(imgWith('http://x/a.gif')), true);
assert.equal(isAnimatedCandidate(imgWith('http://x/a.gif?v=2')), true, 'query string');
assert.equal(isAnimatedCandidate(imgWith('http://x/a.gif#frag')), true, 'fragment');
assert.equal(isAnimatedCandidate(imgWith('http://x/a.GIF')), true, 'case-insensitive');
assert.equal(isAnimatedCandidate(imgWith('http://x/a.png')), false);
assert.equal(isAnimatedCandidate(imgWith('http://x/a.gifx')), false, 'no false positive');
// WebP
assert.equal(isAnimatedCandidate(imgWith('http://x/a.webp')), true);
assert.equal(isAnimatedCandidate(imgWith('http://x/a.webp?v=2')), true, 'webp query string');
assert.equal(isAnimatedCandidate(imgWith('http://x/a.webp#frag')), true, 'webp fragment');
assert.equal(isAnimatedCandidate(imgWith('http://x/a.WEBP')), true, 'webp case-insensitive');
assert.equal(isAnimatedCandidate(imgWith('http://x/a.webpx')), false, 'webp no false positive');

// ---- pipeline stubs --------------------------------------------------------
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

// ---- happy path ------------------------------------------------------------
const gif = imgWith('http://x/a.gif');
await ctrl.processImage(gif);
assert.equal(overlays, 1, 'overlay created');
assert.equal(controls, 1, 'controls mounted');
assert.equal(ctrl.instances.size, 1, 'instance registered');

// ---- de-duplication --------------------------------------------------------
await ctrl.processImage(gif);
assert.equal(overlays, 1, 'same element not processed twice');
assert.equal(ctrl.instances.size, 1);

// ---- single-frame image is skipped ----------------------------------------
frameCount = 1;
await ctrl.processImage(imgWith('http://x/single.gif'));
assert.equal(ctrl.instances.size, 1, 'single-frame image gets no controls');
assert.equal(overlays, 1);

// ---- per-element teardown --------------------------------------------------
ctrl.teardown(gif);
assert.equal(destroyed, 1, 'overlay destroyed');
assert.equal(unmounted, 1, 'controls unmounted');
assert.equal(ctrl.instances.size, 0);

// ---- discover() scans the DOM, ignoring non-candidates --------------------
frameCount = 3;
document.body.append(
  imgWith('http://x/1.gif'),
  imgWith('http://x/2.webp'),
  imgWith('http://x/3.png'),
);
ctrl.discover(document);
await flush();
assert.equal(ctrl.instances.size, 2, 'GIF and WebP discovered, PNG ignored');

// ---- global teardown -------------------------------------------------------
ctrl.teardownAll();
assert.equal(ctrl.instances.size, 0, 'everything torn down');

// ---- reconcile() tears down players whose <img> left the DOM (issue 13) ---
const live = imgWith('http://x/live.gif');
document.body.appendChild(live);
await ctrl.processImage(live);
assert.equal(ctrl.instances.size, 1, 'connected image enhanced');

const destroyedBefore = destroyed;
live.remove();
ctrl.reconcile();
assert.equal(ctrl.instances.size, 0, 'reconcile tore down the removed image');
assert.equal(destroyed, destroyedBefore + 1, 'overlay destroyed on reconcile');

// ---- observe() reconciles removals automatically (debounced) ---------------
const stop = ctrl.observe(document);
const watched = imgWith('http://x/watched.gif');
document.body.appendChild(watched);
await ctrl.processImage(watched);
assert.equal(ctrl.instances.size, 1, 'watched image enhanced');

watched.remove();
await flush(); // let the observer's microtask-coalesced reconcile run
assert.equal(ctrl.instances.size, 0, 'observer tore down the removed image');

// After stopping, removals are no longer auto-reconciled.
stop();
const orphan = imgWith('http://x/orphan.gif');
document.body.appendChild(orphan);
await ctrl.processImage(orphan);
orphan.remove();
await flush();
assert.equal(ctrl.instances.size, 1, 'no teardown once the observer is stopped');
ctrl.teardownAll();

// ---- pick-mode state machine -----------------------------------------------
const docEl = document.documentElement;

enterPickMode();
assert.equal(docEl.style.cursor, 'crosshair', 'pick mode sets crosshair cursor');

// Escape cancels.
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.notEqual(docEl.style.cursor, 'crosshair', 'Escape exits pick mode');

// Clicking a non-candidate cancels too.
enterPickMode();
assert.equal(docEl.style.cursor, 'crosshair');
const notAGif = document.createElement('div');
document.body.appendChild(notAGif);
notAGif.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.notEqual(docEl.style.cursor, 'crosshair', 'clicking a non-candidate exits pick mode');

exitPickMode(); // no-op if already exited

// ---- standalone image: toolbar toggles directly (ImageDocument) ------------
// Firefox renders a directly-opened .gif/.webp as an ImageDocument: contentType
// 'image/gif' or 'image/webp', body is a single <img>. A toolbar click toggles
// that image via enhanceStandaloneImage() instead of entering pick mode.
// Returns true on such a document (caller skips pick mode), false otherwise.
const setContentType = (value: string) =>
  Object.defineProperty(document, 'contentType', { value, configurable: true });

const standaloneInstances = new Map<HTMLImageElement, object>();
let standalonePicked: HTMLImageElement | null = null;
let standaloneTorndown: HTMLImageElement | null = null;
const standaloneTarget = {
  instances: standaloneInstances as never,
  processImage: async (img: HTMLImageElement) => {
    standalonePicked = img;
    standaloneInstances.set(img, {});
  },
  teardown: (img: HTMLImageElement) => {
    standaloneTorndown = img;
    standaloneInstances.delete(img);
  },
};

// Normal page (not an ImageDocument): returns false → caller uses pick mode.
setContentType('text/html');
document.body.innerHTML = '';
document.body.appendChild(imgWith('http://x/page.gif'));
assert.equal(enhanceStandaloneImage(standaloneTarget), false, 'normal page → not handled');
assert.equal(standalonePicked, null, 'normal page is not auto-enhanced');

// Standalone GIF document: first click enhances the single <img>.
setContentType('image/gif');
document.body.innerHTML = '';
const standaloneGif = imgWith('http://x/standalone.gif');
document.body.appendChild(standaloneGif);
assert.equal(enhanceStandaloneImage(standaloneTarget), true, 'standalone GIF → handled');
await flush();
assert.equal(standalonePicked, standaloneGif, 'first toolbar click enhances the GIF');

// Second click toggles it back off (tears down).
assert.equal(enhanceStandaloneImage(standaloneTarget), true, 'still handled');
assert.equal(standaloneTorndown, standaloneGif, 'second toolbar click tears it down');

// Standalone WebP document.
setContentType('image/webp');
document.body.innerHTML = '';
standalonePicked = null;
standaloneInstances.clear();
const standaloneWebP = imgWith('http://x/standalone.webp');
document.body.appendChild(standaloneWebP);
assert.equal(enhanceStandaloneImage(standaloneTarget), true, 'standalone WebP → handled');
await flush();
assert.equal(standalonePicked, standaloneWebP, 'standalone WebP enhanced');

// Defensive: an image document with a non-candidate img is still "handled"
// (no pick mode on an image page) but enhances nothing.
setContentType('image/gif');
document.body.innerHTML = '';
standalonePicked = null;
document.body.appendChild(imgWith('http://x/not.png'));
assert.equal(enhanceStandaloneImage(standaloneTarget), true, 'image doc → handled');
assert.equal(standalonePicked, null, 'non-candidate in an image document is ignored');

setContentType('text/html');
document.body.innerHTML = '';

console.log('content-glue.test: OK');
