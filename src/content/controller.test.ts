// Headless tests for the per-image pipeline: de-duplication, single-frame skip,
// teardown, cancellation and DOM reconciliation. The pipeline collaborators are
// stubbed (real decode/overlay need a canvas), so we exercise the registry /
// teardown orchestration in jsdom. Pick mode and the player loader live in
// ./index and are tested in index.test.ts.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { DecodeBudgetError, UnsupportedFormatError } from "../engine/types.ts";
import { createController } from "./controller.ts";

const imgWith = (src: string) => {
  const img = document.createElement("img");
  img.src = src;
  return img;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- pipeline stubs --------------------------------------------------------
let overlays = 0;
let controls = 0;
let destroyed = 0;
let unmounted = 0;
let frameCount = 3;
let closedSources = 0;

const deps = {
  fetchBytes: async () => new ArrayBuffer(8),
  decode: async () => ({
    frames: Array.from({ length: frameCount }, (_, i) => ({
      time: 100 * (i + 1),
      delay: 100,
    })),
    source: {
      width: 4,
      height: 4,
      frameCount,
      getBitmap: () => ({}),
      close: () => closedSources++,
    },
    duration: 100 * frameCount,
    repeat: Infinity,
  }),
  createEngine: () => ({
    setLoop: () => {},
    setRepeat: () => {},
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
closedSources = 0;
await ctrl.processImage(imgWith("http://x/single.gif"));
assert.equal(ctrl.instances.size, 1, "single-frame image gets no controls");
assert.equal(overlays, 1);
assert.equal(closedSources, 1, "the skipped single-frame image's frame source is closed");

// ---- per-element teardown --------------------------------------------------
frameCount = 3;
closedSources = 0;
ctrl.teardown(gif);
assert.equal(destroyed, 1, "overlay destroyed");
assert.equal(unmounted, 1, "controls unmounted");
assert.equal(ctrl.instances.size, 0);
assert.equal(closedSources, 1, "the torn-down instance's frame source is closed");

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
assert.equal(ctrl.instances.size, 0, "watcher re-attached and reconciled the removal");
ctrl.teardownAll();

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
      setRepeat: () => {},
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
  assert.equal(capturedSignal!.aborted, true, "teardown aborts the in-flight decode signal");

  // A late-resolving decode (e.g. the loop hadn't reached its next abort check)
  // must have its frame source dropped, not mounted.
  resolveDecode({
    frames: [{ time: 1, delay: 1 }],
    source: { width: 1, height: 1, frameCount: 1, getBitmap: () => ({}), close: () => closed++ },
    duration: 1,
    repeat: 0,
  });
  await done;

  assert.equal(
    statuses.includes("ready") || statuses.includes("error"),
    false,
    "a cancelled load reports neither ready nor error",
  );
  assert.equal(cancelCtrl.instances.size, 0, "no instance left after cancel");
  assert.equal(closed, 1, "a late decode result's frame source is closed, not leaked");
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
      setRepeat: () => {},
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
  assert.equal(capturedSignal!.aborted, true, "teardownAll aborts in-flight loads");
}

// ---- an over-budget decode reports "too-large" -----------------------------
// A DecodeBudgetError (image exceeds the memory ceiling) is surfaced as a
// distinct status, not a generic error, so the toast can say so — with the size
// the decoder measured, formatted here so the content script needn't import the
// engine to render it.
{
  const statuses: string[] = [];
  let reported: string | undefined;
  const budgetDeps = {
    fetchBytes: async () => new ArrayBuffer(8),
    decode: async () => {
      throw new DecodeBudgetError(1_800_000_000, 1_200_000_000);
    },
    createEngine: () => ({
      setLoop: () => {},
      setRepeat: () => {},
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
  await budgetCtrl.processImage(imgWith("http://x/huge.gif"), (s, detail) => {
    statuses.push(s);
    if (detail) reported = detail;
  });
  assert.deepEqual(
    statuses,
    ["loading", "too-large"],
    "an over-budget decode reports loading then too-large",
  );
  assert.equal(reported, "~1.8 GB", "the estimated size travels with the status");
  assert.equal(budgetCtrl.instances.size, 0, "no instance created for an over-budget image");
}

// ---- a format this browser can't decode reports "unsupported" -------------
// Animated AVIF where WebCodecs ImageDecoder is missing. The image is fine and
// the browser animates it in the page — only Jiffy can't drive it — so this
// reports as its own outcome, carrying the format name for the toast, rather
// than as the generic error.
{
  const statuses: string[] = [];
  let reported: string | undefined;
  const unsupportedDeps = {
    fetchBytes: async () => new ArrayBuffer(8),
    decode: async () => {
      throw new UnsupportedFormatError("Animated AVIF");
    },
    createEngine: () => ({
      setLoop: () => {},
      setRepeat: () => {},
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
  const unsupportedCtrl = createController(unsupportedDeps);
  await unsupportedCtrl.processImage(imgWith("http://x/clip.avif"), (s, detail) => {
    statuses.push(s);
    if (detail) reported = detail;
  });
  assert.deepEqual(
    statuses,
    ["loading", "unsupported"],
    "a format with no decoder here reports loading then unsupported",
  );
  assert.equal(reported, "Animated AVIF", "the format name travels with the status");
  assert.equal(unsupportedCtrl.instances.size, 0, "no instance created for an undecodable image");
}

// ---- cancel then immediately re-pick the same image -------------------------
// The stale pipeline's rejection lands after the new pick has registered its own
// AbortController under the same <img>. Keyed by presence it would report the
// stale failure and delete the new pick's entry, which then finds itself
// "torn down" and silently drops its frames — the user picks and gets nothing.
// Keyed by identity, the stale pipeline sees the map is no longer its own and
// stays out of the way.
{
  const stale: string[] = [];
  const fresh: string[] = [];
  let failFirstFetch!: (err: unknown) => void;
  let fetches = 0;
  const raceDeps = {
    fetchBytes: (_url: string) => {
      fetches++;
      // The first pick hangs until we fail it by hand; the second resolves at once.
      return fetches === 1
        ? new Promise<ArrayBuffer>((_resolve, reject) => {
            failFirstFetch = reject;
          })
        : Promise.resolve(new ArrayBuffer(8));
    },
    decode: async () => ({
      frames: [
        { time: 100, delay: 100 },
        { time: 200, delay: 100 },
      ],
      source: { width: 4, height: 4, frameCount: 2, getBitmap: () => ({}), close: () => {} },
      duration: 200,
      repeat: Infinity,
    }),
    createEngine: () => ({
      setLoop: () => {},
      setRepeat: () => {},
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

  const raceCtrl = createController(raceDeps);
  const raceImg = imgWith("http://x/race.gif");
  const first = raceCtrl.processImage(raceImg, (s) => stale.push(s));
  await flush(); // first pick is parked in its fetch

  raceCtrl.teardown(raceImg); // user cancels from the toast
  const second = raceCtrl.processImage(raceImg, (s) => fresh.push(s)); // and picks again
  failFirstFetch(new Error("network")); // only now does the first pick unwind
  await Promise.all([first, second]);

  assert.equal(fetches, 2, "the re-pick started its own load");
  assert.deepEqual(stale, ["loading"], "the superseded pipeline reports nothing after its cancel");
  assert.deepEqual(fresh, ["loading", "ready"], "the re-pick runs to ready");
  assert.equal(raceCtrl.instances.size, 1, "the re-pick's instance survives the stale rejection");
}

// ---- a change of source tears the overlay down ----------------------------
// The element outlives the picture on carousels, lazy-loaders and SPAs. The
// overlay is tied to the bytes we decoded, so once the <img> has loaded a
// different URL the instance must go rather than paint the old animation over
// the new image (which the overlay's `visibility: hidden` would keep hidden).
{
  const swapCtrl = createController(deps);
  const swap = imgWith("http://x/first.gif");
  document.body.appendChild(swap);
  await swapCtrl.processImage(swap);
  assert.equal(swapCtrl.instances.size, 1, "carousel image enhanced");

  // A load that resolves to the same URL (a re-decode, a cache revalidation)
  // leaves the player alone.
  swap.dispatchEvent(new window.Event("load"));
  assert.equal(swapCtrl.instances.size, 1, "a load of the same source keeps the player");

  swap.src = "http://x/second.gif";
  swap.dispatchEvent(new window.Event("load"));
  assert.equal(swapCtrl.instances.size, 0, "the player is torn down when the source changes");

  // A new source that fails to load is still a different picture.
  const failing = imgWith("http://x/third.gif");
  document.body.appendChild(failing);
  await swapCtrl.processImage(failing);
  failing.src = "http://x/gone.gif";
  failing.dispatchEvent(new window.Event("error"));
  assert.equal(swapCtrl.instances.size, 0, "a failed new source also tears the player down");

  // Teardown detaches the listeners, so a later load on a torn-down element
  // reaches no stale handler.
  const detached = imgWith("http://x/detached.gif");
  document.body.appendChild(detached);
  await swapCtrl.processImage(detached);
  const beforeDetach = destroyed;
  swapCtrl.teardown(detached);
  detached.src = "http://x/other.gif";
  detached.dispatchEvent(new window.Event("load"));
  assert.equal(destroyed, beforeDetach + 1, "the source listener is removed on teardown");
  swapCtrl.teardownAll();
  document.body.replaceChildren();
}

console.log("content-controller.test: OK");
