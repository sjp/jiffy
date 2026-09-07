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
const observers: Array<{
  targets: unknown[];
  fire: () => void;
  disconnected: boolean;
}> = [];
(globalThis as Record<string, unknown>).ResizeObserver = class {
  #entry: (typeof observers)[number];
  constructor(callback: () => void) {
    this.#entry = { targets: [], fire: callback, disconnected: false };
    observers.push(this.#entry);
  }
  observe(target: unknown): void {
    this.#entry.targets.push(target);
  }
  disconnect(): void {
    this.#entry.disconnected = true;
  }
};

const { trackImageBox } = await import("./trackBox.ts");

function setup(parent: HTMLElement = document.body) {
  const img = document.createElement("img");
  parent.appendChild(img);
  let calls = 0;
  const stop = trackImageBox(img, () => {
    calls++;
  });
  return {
    img,
    stop,
    observer: observers[observers.length - 1]!,
    calls: () => calls,
  };
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
  assert.equal(observer.targets[0], img, "the img itself is observed for resize");
  observer.fire();
  flushFrame();
  assert.equal(calls(), 2, "a ResizeObserver notification repositions");
  stop();
}

// ---- everything the image is laid out inside is observed too ---------------
// A banner collapsing or an accordion opening beside the image reflows it
// without touching its own box and without a scroll, so the ancestor that
// absorbed the change is what has to be watched — up to <html>, whose box
// tracks the document's own height.
{
  const card = document.createElement("div");
  document.body.appendChild(card);
  const { img, observer, calls, stop } = setup(card);
  assert.deepEqual(
    observer.targets,
    [img, card, document.body, document.documentElement],
    "the img and every element it is laid out inside are observed",
  );
  observer.fire();
  flushFrame();
  assert.equal(calls(), 2, "an ancestor resizing repositions the caller");
  stop();
  card.remove();
}

// ---- the chain is walked out of a shadow tree ------------------------------
// An image inside a web component has no parentElement at the tree boundary;
// the elements around the host are still what reflow it.
{
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const inner = document.createElement("span");
  shadow.appendChild(inner);
  const { img, observer, stop } = setup(inner);
  assert.deepEqual(
    observer.targets,
    [img, inner, host, document.body, document.documentElement],
    "the walk steps out of the shadow tree to its host",
  );
  stop();
  host.remove();
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
