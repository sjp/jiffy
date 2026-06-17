// Headless tests for the content-script glue: animated-image
// detection (GIF + WebP), the per-image pipeline, de-duplication, single-frame
// skip, and teardown. The pipeline collaborators are stubbed (real decode/overlay
// need a canvas), so we exercise the registry/teardown orchestration in jsdom.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";
import {
  createController,
  isAnimatedCandidate,
  enterPickMode,
  exitPickMode,
  enhanceStandaloneImage,
} from "./index.ts";
import { DecodeBudgetError } from "../engine/types.ts";

const imgWith = (src: string) => {
  const img = document.createElement("img");
  img.src = src;
  return img;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- isAnimatedCandidate ---------------------------------------------------
// GIF
assert.equal(isAnimatedCandidate(imgWith("http://x/a.gif")), true);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.gif?v=2")),
  true,
  "query string",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.gif#frag")),
  true,
  "fragment",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.GIF")),
  true,
  "case-insensitive",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.png")),
  true,
  "png candidate",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.PNG")),
  true,
  "png case-insensitive",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.png?v=2")),
  true,
  "png query string",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.pngx")),
  false,
  "png no false positive",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.apng")),
  true,
  "apng candidate",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.APNG")),
  true,
  "apng case-insensitive",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.apng?v=2")),
  true,
  "apng query string",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.apngx")),
  false,
  "apng no false positive",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.gifx")),
  false,
  "no false positive",
);
// WebP
assert.equal(isAnimatedCandidate(imgWith("http://x/a.webp")), true);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.webp?v=2")),
  true,
  "webp query string",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.webp#frag")),
  true,
  "webp fragment",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.WEBP")),
  true,
  "webp case-insensitive",
);
assert.equal(
  isAnimatedCandidate(imgWith("http://x/a.webpx")),
  false,
  "webp no false positive",
);

// ---- pipeline stubs --------------------------------------------------------
let overlays = 0;
let controls = 0;
let destroyed = 0;
let unmounted = 0;
let frameCount = 3;
let closedBitmaps = 0;

const deps = {
  fetchBytes: async () => new ArrayBuffer(8),
  decode: async () => ({
    frames: Array.from({ length: frameCount }, () => ({
      bitmap: { close: () => closedBitmaps++ },
      time: 100,
      delay: 100,
    })),
    duration: 100 * frameCount,
    loops: true,
  }),
  createEngine: () => ({
    setLoop: () => {},
    setSpeed: () => {},
    setReverse: () => {},
    setPingPong: () => {},
  }),
  createOverlay: () => {
    overlays++;
    return {
      canvas: document.createElement("canvas"),
      destroy: () => destroyed++,
    };
  },
  mountControls: () => {
    controls++;
    return () => unmounted++;
  },
} as never;

const ctrl = createController(deps);

// ---- happy path ------------------------------------------------------------
const gif = imgWith("http://x/a.gif");
await ctrl.processImage(gif);
assert.equal(overlays, 1, "overlay created");
assert.equal(controls, 1, "controls mounted");
assert.equal(ctrl.instances.size, 1, "instance registered");

// ---- de-duplication --------------------------------------------------------
await ctrl.processImage(gif);
assert.equal(overlays, 1, "same element not processed twice");
assert.equal(ctrl.instances.size, 1);

// ---- single-frame image is skipped ----------------------------------------
frameCount = 1;
closedBitmaps = 0;
await ctrl.processImage(imgWith("http://x/single.gif"));
assert.equal(ctrl.instances.size, 1, "single-frame image gets no controls");
assert.equal(overlays, 1);
assert.equal(
  closedBitmaps,
  1,
  "bitmap of the skipped single-frame image is closed",
);

// ---- per-element teardown --------------------------------------------------
frameCount = 3;
closedBitmaps = 0;
ctrl.teardown(gif);
assert.equal(destroyed, 1, "overlay destroyed");
assert.equal(unmounted, 1, "controls unmounted");
assert.equal(ctrl.instances.size, 0);
assert.equal(closedBitmaps, 3, "torn-down instance's frame bitmaps are closed");

// ---- multiple instances + global teardown ---------------------------------
frameCount = 3;
await ctrl.processImage(imgWith("http://x/1.gif"));
await ctrl.processImage(imgWith("http://x/2.webp"));
await ctrl.processImage(imgWith("http://x/3.png"));
assert.equal(ctrl.instances.size, 3, "multiple images enhanced");

ctrl.teardownAll();
assert.equal(ctrl.instances.size, 0, "everything torn down");

// ---- reconcile() tears down players whose <img> left the DOM ---------------
const live = imgWith("http://x/live.gif");
document.body.appendChild(live);
await ctrl.processImage(live);
assert.equal(ctrl.instances.size, 1, "connected image enhanced");

const destroyedBefore = destroyed;
live.remove();
ctrl.reconcile();
assert.equal(ctrl.instances.size, 0, "reconcile tore down the removed image");
assert.equal(destroyed, destroyedBefore + 1, "overlay destroyed on reconcile");

// ---- the removal watcher auto-attaches while players are live --------------
// No manual observe() call: enhancing an image must lazily start the watcher,
// and a later removal is reconciled automatically (debounced via microtask).
const watched = imgWith("http://x/watched.gif");
document.body.appendChild(watched);
await ctrl.processImage(watched);
assert.equal(ctrl.instances.size, 1, "watched image enhanced");

watched.remove();
await flush(); // let the watcher's microtask-coalesced reconcile run
assert.equal(ctrl.instances.size, 0, "watcher tore down the removed image");

// The watcher detaches when the registry empties and re-attaches on the next
// enhance, so the idle→active→idle→active cycle keeps reconciling removals.
const again = imgWith("http://x/again.gif");
document.body.appendChild(again);
await ctrl.processImage(again);
assert.equal(ctrl.instances.size, 1, "re-enhanced after going idle");

again.remove();
await flush();
assert.equal(
  ctrl.instances.size,
  0,
  "watcher re-attached and reconciled the removal",
);
ctrl.teardownAll();

// ---- pick-mode state machine -----------------------------------------------
const docEl = document.documentElement;

enterPickMode();
assert.equal(
  docEl.style.cursor,
  "crosshair",
  "pick mode sets crosshair cursor",
);

// Escape cancels.
document.dispatchEvent(
  new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
);
assert.notEqual(docEl.style.cursor, "crosshair", "Escape exits pick mode");

// Clicking a non-candidate cancels too.
enterPickMode();
assert.equal(docEl.style.cursor, "crosshair");
const notAGif = document.createElement("div");
document.body.appendChild(notAGif);
notAGif.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.notEqual(
  docEl.style.cursor,
  "crosshair",
  "clicking a non-candidate exits pick mode",
);

exitPickMode(); // no-op if already exited

// ---- standalone image: toolbar toggles directly (ImageDocument) ------------
// Firefox renders a directly-opened .gif/.webp as an ImageDocument: contentType
// 'image/gif' or 'image/webp', body is a single <img>. A toolbar click toggles
// that image via enhanceStandaloneImage() instead of entering pick mode.
// Returns true on such a document (caller skips pick mode), false otherwise.
const setContentType = (value: string) =>
  Object.defineProperty(document, "contentType", { value, configurable: true });

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
setContentType("text/html");
document.body.innerHTML = "";
document.body.appendChild(imgWith("http://x/page.gif"));
assert.equal(
  enhanceStandaloneImage(standaloneTarget),
  false,
  "normal page → not handled",
);
assert.equal(standalonePicked, null, "normal page is not auto-enhanced");

// Standalone GIF document: first click enhances the single <img>.
setContentType("image/gif");
document.body.innerHTML = "";
const standaloneGif = imgWith("http://x/standalone.gif");
document.body.appendChild(standaloneGif);
assert.equal(
  enhanceStandaloneImage(standaloneTarget),
  true,
  "standalone GIF → handled",
);
await flush();
assert.equal(
  standalonePicked,
  standaloneGif,
  "first toolbar click enhances the GIF",
);

// Second click toggles it back off (tears down).
assert.equal(enhanceStandaloneImage(standaloneTarget), true, "still handled");
assert.equal(
  standaloneTorndown,
  standaloneGif,
  "second toolbar click tears it down",
);

// Standalone WebP document.
setContentType("image/webp");
document.body.innerHTML = "";
standalonePicked = null;
standaloneInstances.clear();
const standaloneWebP = imgWith("http://x/standalone.webp");
document.body.appendChild(standaloneWebP);
assert.equal(
  enhanceStandaloneImage(standaloneTarget),
  true,
  "standalone WebP → handled",
);
await flush();
assert.equal(standalonePicked, standaloneWebP, "standalone WebP enhanced");

// Standalone APNG document.
setContentType("image/apng");
document.body.innerHTML = "";
standalonePicked = null;
standaloneInstances.clear();
const standaloneApng = imgWith("http://x/standalone.apng");
document.body.appendChild(standaloneApng);
assert.equal(
  enhanceStandaloneImage(standaloneTarget),
  true,
  "standalone APNG → handled",
);
await flush();
assert.equal(standalonePicked, standaloneApng, "standalone APNG enhanced");

// Defensive: an image document with a non-candidate img is still "handled"
// (no pick mode on an image page) but enhances nothing.
setContentType("image/gif");
document.body.innerHTML = "";
standalonePicked = null;
document.body.appendChild(imgWith("http://x/not.jpg"));
assert.equal(
  enhanceStandaloneImage(standaloneTarget),
  true,
  "image doc → handled",
);
assert.equal(
  standalonePicked,
  null,
  "non-candidate in an image document is ignored",
);

setContentType("text/html");
document.body.innerHTML = "";

// ---- cancel aborts an in-flight load ---------------------------------------
// A teardown() while decode is still running must abort the signal handed to
// decode (so its loop can bail), report no ready/error status, drop any late
// result, and leave no instance behind.
{
  let capturedSignal: AbortSignal | undefined;
  let resolveDecode: (v: unknown) => void = () => {};
  const statuses: string[] = [];
  let closed = 0;
  const cancelDeps = {
    fetchBytes: async () => new ArrayBuffer(8),
    decode: (_bytes: ArrayBuffer, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise((resolve) => {
        resolveDecode = resolve;
      });
    },
    createEngine: () => ({
      setLoop: () => {},
      setSpeed: () => {},
      setReverse: () => {},
      setPingPong: () => {},
    }),
    createOverlay: () => ({
      canvas: document.createElement("canvas"),
      destroy: () => {},
    }),
    mountControls: () => () => {},
  } as never;

  const cancelCtrl = createController(cancelDeps);
  const cancelImg = imgWith("http://x/cancel.gif");
  const done = cancelCtrl.processImage(cancelImg, (s) => statuses.push(s));
  await flush(); // advance into the decode await

  assert.deepEqual(statuses, ["loading"], "loading reported before cancel");
  assert.ok(capturedSignal, "a signal is handed to decode");
  assert.equal(capturedSignal!.aborted, false, "signal live before cancel");

  cancelCtrl.teardown(cancelImg);
  assert.equal(
    capturedSignal!.aborted,
    true,
    "teardown aborts the in-flight decode signal",
  );

  // A late-resolving decode (e.g. the loop hadn't reached its next abort check)
  // must have its frames dropped, not mounted.
  resolveDecode({
    frames: [{ bitmap: { close: () => closed++ }, time: 1, delay: 1 }],
    duration: 1,
    loops: false,
  });
  await done;

  assert.equal(
    statuses.includes("ready") || statuses.includes("error"),
    false,
    "a cancelled load reports neither ready nor error",
  );
  assert.equal(cancelCtrl.instances.size, 0, "no instance left after cancel");
  assert.equal(
    closed,
    1,
    "a late decode result's frames are closed, not leaked",
  );
}

// ---- teardownAll aborts in-flight loads ------------------------------------
{
  let capturedSignal: AbortSignal | undefined;
  const allDeps = {
    fetchBytes: async () => new ArrayBuffer(8),
    decode: (_bytes: ArrayBuffer, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never settles
    },
    createEngine: () => ({
      setLoop: () => {},
      setSpeed: () => {},
      setReverse: () => {},
      setPingPong: () => {},
    }),
    createOverlay: () => ({
      canvas: document.createElement("canvas"),
      destroy: () => {},
    }),
    mountControls: () => () => {},
  } as never;
  const allCtrl = createController(allDeps);
  void allCtrl.processImage(imgWith("http://x/inflight.gif"));
  await flush();
  assert.equal(capturedSignal!.aborted, false, "in-flight signal live");
  allCtrl.teardownAll();
  assert.equal(
    capturedSignal!.aborted,
    true,
    "teardownAll aborts in-flight loads",
  );
}

// ---- an over-budget decode reports "too-large" -----------------------------
// A DecodeBudgetError (image exceeds the pixel/memory ceiling) is surfaced as a
// distinct status, not a generic error, so the toast can say so.
{
  const statuses: string[] = [];
  const budgetDeps = {
    fetchBytes: async () => new ArrayBuffer(8),
    decode: async () => {
      throw new DecodeBudgetError();
    },
    createEngine: () => ({
      setLoop: () => {},
      setSpeed: () => {},
      setReverse: () => {},
      setPingPong: () => {},
    }),
    createOverlay: () => ({
      canvas: document.createElement("canvas"),
      destroy: () => {},
    }),
    mountControls: () => () => {},
  } as never;
  const budgetCtrl = createController(budgetDeps);
  await budgetCtrl.processImage(imgWith("http://x/huge.gif"), (s) =>
    statuses.push(s),
  );
  assert.deepEqual(
    statuses,
    ["loading", "too-large"],
    "an over-budget decode reports loading then too-large",
  );
  assert.equal(
    budgetCtrl.instances.size,
    0,
    "no instance created for an over-budget image",
  );
}

console.log("content-glue.test: OK");
