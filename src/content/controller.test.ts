// Headless tests for the per-image pipeline: de-duplication, single-frame skip,
// teardown, cancellation and DOM reconciliation. The pipeline collaborators are
// stubbed (real decode/overlay need a canvas), so we exercise the registry /
// teardown orchestration in jsdom. Pick mode and the player loader live in
// ./index and are tested in index.test.ts.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { DecodeBudgetError } from "../engine/types.ts";
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
    loops: false,
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
  await budgetCtrl.processImage(imgWith("http://x/huge.gif"), (s) => statuses.push(s));
  assert.deepEqual(
    statuses,
    ["loading", "too-large"],
    "an over-budget decode reports loading then too-large",
  );
  assert.equal(budgetCtrl.instances.size, 0, "no instance created for an over-budget image");
}

console.log("content-controller.test: OK");
