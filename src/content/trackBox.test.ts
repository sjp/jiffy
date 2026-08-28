// Headless tests for the shared image-box tracker.
//
// The interesting behaviour is all scheduling and teardown: one callback per
// animation frame however many events arrive, capture-phase scroll so nested
// scrollers count, and nothing firing once the caller has torn down. jsdom has
// no layout, so we drive the tracker with events rather than real geometry, and
// pump animation frames by hand so "one per frame" is actually observable.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

// ---- controllable animation frames ----------------------------------------
const frameQueue: Array<() => void> = [];
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void): number => {
  frameQueue.push(cb);
  return frameQueue.length;
};
/** Run everything queued for the next frame (callbacks queued during it wait). */
function flushFrame(): void {
  const due = frameQueue.splice(0, frameQueue.length);
  for (const cb of due) cb();
}

// ---- ResizeObserver stub, recording what was observed ----------------------
const observers: Array<{ target: unknown; fire: () => void; disconnected: boolean }> = [];
(globalThis as Record<string, unknown>).ResizeObserver = class {
  #entry: (typeof observers)[number];
  constructor(callback: () => void) {
    this.#entry = { target: undefined, fire: callback, disconnected: false };
    observers.push(this.#entry);
  }
  observe(target: unknown): void {
    this.#entry.target = target;
  }
  disconnect(): void {
    this.#entry.disconnected = true;
  }
};

const { trackImageBox } = await import("./trackBox.ts");

function setup() {
  const img = document.createElement("img");
  document.body.appendChild(img);
  let calls = 0;
  const stop = trackImageBox(img, () => {
    calls++;
  });
  return { img, stop, observer: observers[observers.length - 1]!, calls: () => calls };
}

// ---- places the caller once, synchronously --------------------------------
{
  const { calls, stop } = setup();
  assert.equal(calls(), 1, "onChange runs once at setup, before any event");
  stop();
}

// ---- a burst of events collapses into one call per frame ------------------
{
  const { calls, stop } = setup();
  for (let i = 0; i < 5; i++) window.dispatchEvent(new window.Event("scroll"));
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(calls(), 1, "events schedule rather than call straight through");
  flushFrame();
  assert.equal(calls(), 2, "the whole burst costs exactly one callback");
  window.dispatchEvent(new window.Event("scroll"));
  flushFrame();
  assert.equal(calls(), 3, "a later scroll schedules again");
  stop();
}

// ---- scroll is heard in the capture phase, so nested scrollers count -------
{
  const { calls, stop } = setup();
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  // A scroll event on an inner element does not bubble; only a capturing
  // listener on window sees it.
  pane.dispatchEvent(new window.Event("scroll", { bubbles: false }));
  flushFrame();
  assert.equal(calls(), 2, "a nested scroller repositions the caller");
  stop();
}

// ---- the image resizing in place repositions too ---------------------------
{
  const { img, calls, observer, stop } = setup();
  assert.equal(observer.target, img, "the img itself is observed for resize");
  observer.fire();
  flushFrame();
  assert.equal(calls(), 2, "a ResizeObserver notification repositions");
  stop();
}

// ---- teardown detaches everything ------------------------------------------
{
  const { calls, observer, stop } = setup();
  stop();
  assert.equal(observer.disconnected, true, "the ResizeObserver is disconnected");
  window.dispatchEvent(new window.Event("scroll"));
  window.dispatchEvent(new window.Event("resize"));
  flushFrame();
  assert.equal(calls(), 1, "no callback after teardown");
}

// ---- a frame already queued at teardown never lands -------------------------
// The caller has removed the canvas / host by then; firing at it would measure
// and write to something that no longer exists.
{
  const { calls, stop } = setup();
  window.dispatchEvent(new window.Event("scroll")); // queues a frame
  stop();
  flushFrame();
  assert.equal(calls(), 1, "an in-flight frame is dropped by teardown");
}

console.log("trackBox.test: OK");
