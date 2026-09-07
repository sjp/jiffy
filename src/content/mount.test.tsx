// Headless tests for mounting the control bar next to an <img>.
//
// jsdom has no layout, so the placement arithmetic isn't what's exercised here —
// what is, is the two things the mount owns that nothing else can test: the
// keyboard move handle (the grip's arrows have to reach the host's own offset)
// and handing focus back when the bar goes away, which is the difference between
// a keyboard user staying oriented and being dropped on <body>.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

// ResizeObserver isn't in jsdom and trackImageBox constructs one. A stub that
// never fires is enough: every reposition here is driven directly.
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe(): void {}
  disconnect(): void {}
};

const { createEngine } = await import("../engine/engine.ts");
const { mountControls } = await import("./mount.tsx");

const clock = { now: () => 0, schedule: () => 1, cancel: () => {} };
const frames = [
  { time: 100, delay: 100 },
  { time: 200, delay: 100 },
] as never;

/** A fresh <img> in the page plus a bar mounted on it. */
function mount() {
  const img = document.createElement("img");
  document.body.appendChild(img);
  const teardown = mountControls(img, createEngine(frames, 200, clock), () => {});
  // The bar's host is the last <div> on <html> (createHost attaches absolutely
  // positioned hosts there, out of a positioned <body>'s way).
  const host = Array.from(document.documentElement.children).findLast(
    (el) => el instanceof window.HTMLDivElement && el.shadowRoot,
  ) as HTMLDivElement;
  const shadow = host.shadowRoot!;
  return { img, host, shadow, teardown };
}

const press = (el: Element, key: string, shiftKey = false): void => {
  el.dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
};

// ---- the grip's arrow keys move the bar -----------------------------------
{
  const { img, host, shadow, teardown } = mount();
  const grip = shadow.querySelector(".grip")!;
  const left = () => Number.parseFloat(host.style.left);
  const top = () => Number.parseFloat(host.style.top);

  const [x0, y0] = [left(), top()];
  press(grip, "ArrowRight");
  assert.equal(left(), x0 + 8, "ArrowRight moves the bar one step right");
  press(grip, "ArrowDown");
  assert.equal(top(), y0 + 8, "ArrowDown moves it down");
  press(grip, "ArrowLeft", true);
  assert.equal(left(), x0 + 7, "Shift+arrow moves a single pixel");

  // The same offset a drag accumulates into, so Enter resets both alike.
  press(grip, "Enter");
  assert.deepEqual([left(), top()], [x0, y0], "Enter snaps back to the anchored spot");

  teardown();
  img.remove();
}

// ---- focus goes back to the image when the bar is torn down ----------------
// A pick usually starts from a click with nothing focused, so there is no
// earlier element to return to; the image the bar was about is the honest place
// to land. An <img> takes no focus of its own, hence the borrowed tabindex.
{
  const { img, host, shadow, teardown } = mount();
  const close = shadow.querySelector('button[aria-label="Close"]') as HTMLElement;
  close.focus();
  assert.equal(document.activeElement, host, "focus is inside the bar (reported as its host)");

  teardown();
  assert.equal(document.activeElement, img, "teardown hands focus to the image");
  assert.equal(img.getAttribute("tabindex"), "-1", "…on a borrowed tabindex");

  // And the loan is returned: the page's markup is left as it was found.
  const elsewhere = document.createElement("button");
  document.body.appendChild(elsewhere);
  elsewhere.focus();
  assert.equal(img.hasAttribute("tabindex"), false, "the tabindex comes off when focus leaves");
  elsewhere.remove();
  img.remove();
}

// ---- focus goes back to wherever it came from, when there was somewhere ----
{
  const before = document.createElement("button");
  document.body.appendChild(before);
  before.focus();

  const { img, shadow, teardown } = mount();
  (shadow.querySelector('button[aria-label="Close"]') as HTMLElement).focus();
  teardown();

  assert.equal(document.activeElement, before, "focus returns to where the bar took it from");
  assert.equal(img.hasAttribute("tabindex"), false, "the image is left untouched");
  before.remove();
  img.remove();
}

// ---- a teardown that doesn't hold the focus leaves it alone ----------------
// The bar is torn down from outside too (reconcile, a source change). Yanking
// focus off whatever the user is doing elsewhere would be worse than the bug.
{
  const outside = document.createElement("button");
  document.body.appendChild(outside);

  const { img, teardown } = mount();
  outside.focus();
  teardown();

  assert.equal(document.activeElement, outside, "focus stays where it was");
  outside.remove();
  img.remove();
}

console.log("mount.test: OK");
