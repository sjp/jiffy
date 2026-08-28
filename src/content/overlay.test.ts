// Headless tests for the overlay's frame drawing.
//
// The overlay no longer holds frames — it asks the frame source for the current
// one by index, and most frames aren't resident, so the answer can be a promise
// (see engine/frameSource). That makes drawing order something the overlay has
// to manage: a frame that arrives after a newer one was requested must be
// dropped, and nothing may paint after teardown. Those are what this covers;
// positioning and background detection are geometry the jsdom canvas can't
// meaningfully exercise.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import type { FrameSource } from "../engine/frameSource.ts";
import type { Engine, EngineState } from "../engine/types.ts";

// ---- stubs ----------------------------------------------------------------
// jsdom has no 2D context and no ResizeObserver; record what the overlay draws.

const drawn: unknown[] = [];
const ctx = {
  clearRect: () => {},
  drawImage: (bitmap: unknown) => drawn.push(bitmap),
};
(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctx;
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const { createOverlay } = await import("./overlay.ts");

/** An engine that only does what the overlay uses: report an index and notify. */
function fakeEngine(): Engine & { emit: (index: number) => void } {
  const subscribers = new Set<(s: EngineState) => void>();
  let index = 0;
  return {
    state: { index: 0 } as EngineState,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    emit(next: number) {
      index = next;
      for (const fn of subscribers) fn({ index } as EngineState);
    },
  } as unknown as Engine & { emit: (index: number) => void };
}

/** A source whose async frames resolve only when the test says so. */
function deferredSource(residentIndexes: number[]): FrameSource & {
  settle: (index: number) => void;
} {
  const pending = new Map<number, (bitmap: unknown) => void>();
  return {
    width: 8,
    height: 4,
    frameCount: 10,
    getBitmap(index: number) {
      if (residentIndexes.includes(index)) return { resident: index } as unknown as ImageBitmap;
      return new Promise<ImageBitmap>((resolve) => {
        pending.set(index, resolve as (bitmap: unknown) => void);
      });
    },
    close() {},
    settle(index: number) {
      pending.get(index)?.({ recomposited: index });
      pending.delete(index);
    },
  } as unknown as FrameSource & { settle: (index: number) => void };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const img = document.createElement("img");
document.body.appendChild(img);

// ---- the canvas takes its buffer size from the source ---------------------

const engine = fakeEngine();
const source = deferredSource([0, 4]);
const overlay = createOverlay(img, engine, source);

assert.equal(overlay.canvas.width, 8, "drawing buffer width comes from the source");
assert.equal(overlay.canvas.height, 4, "drawing buffer height comes from the source");

// ---- a resident frame paints synchronously --------------------------------
// Frame 0 is a keyframe, so the initial paint has already happened by the time
// createOverlay returns — no waiting for a microtask.
assert.deepEqual(drawn, [{ resident: 0 }], "the initial frame paints immediately");

// ---- a recomposited frame paints when it arrives --------------------------
drawn.length = 0;
engine.emit(1);
assert.deepEqual(drawn, [], "nothing painted while the frame is still being built");
source.settle(1);
await flush();
assert.deepEqual(drawn, [{ recomposited: 1 }], "the frame paints once it resolves");

// ---- a stale frame is dropped ---------------------------------------------
// Scrubbing fast asks for several frames at once; whichever resolves, only the
// one the engine is actually on may reach the canvas.
drawn.length = 0;
engine.emit(2);
engine.emit(3);
source.settle(2); // the older request resolves last
source.settle(3);
await flush();
assert.deepEqual(drawn, [{ recomposited: 3 }], "only the newest requested frame paints");

// A resident frame requested after a pending one also wins.
drawn.length = 0;
engine.emit(5);
engine.emit(4); // resident → paints straight away
assert.deepEqual(drawn, [{ resident: 4 }], "the resident frame paints immediately");
source.settle(5);
await flush();
assert.deepEqual(drawn, [{ resident: 4 }], "the superseded async frame is dropped");

// ---- nothing paints after teardown ----------------------------------------
drawn.length = 0;
engine.emit(6);
overlay.destroy();
source.settle(6);
await flush();
assert.deepEqual(drawn, [], "a frame arriving after destroy() is discarded");
assert.equal(overlay.canvas.isConnected, false, "the canvas is removed on destroy");

// A rejected frame (a source closed mid-flight) must not throw into the console.
const rejecting = {
  width: 2,
  height: 2,
  frameCount: 1,
  getBitmap: () => Promise.reject(new Error("frameSource: closed")),
  close() {},
} as unknown as FrameSource;
const engine2 = fakeEngine();
const overlay2 = createOverlay(img, engine2, rejecting);
await flush();
overlay2.destroy();

console.log("overlay.test: OK");
