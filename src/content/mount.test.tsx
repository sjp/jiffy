// Headless tests for mounting the control bar next to an <img>.
//
// jsdom has no layout, so the geometry has to be handed in — but reposition()
// only ever measures three things (the image's rect, the bar's own size, the
// viewport), so stubbing those exercises the real clamping arithmetic. What is
// covered here is what the mount owns and nothing else can test: the keyboard
// move handle and the drag it shares an offset with, the export outcomes it
// reports beside the bar, and handing focus back when the bar goes away — the
// difference between a keyboard user staying oriented and being dropped on
// <body>.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { act } from "preact/test-utils";

// ResizeObserver isn't in jsdom and trackImageBox constructs one. A stub that
// never fires is enough: every reposition here is driven directly.
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe(): void {}
  disconnect(): void {}
};

const { createEngine } = await import("../engine/engine.ts");
const { mountControls } = await import("./mount.tsx");
type FrameExport = Parameters<typeof mountControls>[3];

const clock = { now: () => 0, schedule: () => 1, cancel: () => {} };
const frames = [
  { time: 100, delay: 100 },
  { time: 200, delay: 100 },
] as never;

/** A fresh <img> in the page plus a bar mounted on it. */
function mount(frameExport?: FrameExport) {
  const img = document.createElement("img");
  document.body.appendChild(img);
  const teardown = mountControls(img, createEngine(frames, 200, clock), () => {}, frameExport);
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

// ---- a drag can never strand the bar off-screen ---------------------------
// The grip is the bar's only handle and sits at its left edge, so a hard drag in
// any direction has to leave that edge reachable — otherwise the bar is gone for
// the rest of the session. The clamp also has to be folded back into the stored
// offset: without that, dragging 5000px past an edge builds up 5000px of debt to
// be paid back before the bar visibly moves again.
{
  const { img, host, shadow, teardown } = mount();
  // The three measurements reposition() makes.
  img.getBoundingClientRect = () =>
    ({ left: 200, top: 100, width: 400, height: 300, right: 600, bottom: 400 }) as DOMRect;
  for (const [prop, value] of [
    ["offsetWidth", 160],
    ["offsetHeight", 32],
  ] as const) {
    Object.defineProperty(host, prop, { value, configurable: true });
  }

  const grip = shadow.querySelector(".grip")!;
  const at = (type: string, x: number, y: number): void => {
    grip.dispatchEvent(
      new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }),
    );
  };
  /** One complete drag by (dx, dy) from the origin. */
  const drag = (dx: number, dy: number): void => {
    at("pointerdown", 0, 0);
    at("pointermove", dx, dy);
    at("pointerup", dx, dy);
  };
  const left = () => Number.parseFloat(host.style.left);
  const top = () => Number.parseFloat(host.style.top);

  drag(0, 0);
  assert.deepEqual([left(), top()], [208, 360], "the bar anchors inside the image's bottom-left");

  // window.innerWidth/innerHeight are jsdom's 1024×768; MIN_VISIBLE_PX is 24.
  drag(-5000, 0);
  assert.equal(left(), 0, "a hard left drag stops with the grip at the viewport edge");
  drag(10, 0);
  assert.equal(left(), 10, "…and the next drag moves from there, not from -4792");

  drag(5000, 0);
  assert.equal(left(), 1000, "a hard right drag leaves the grip-side 24px on screen");
  drag(-10, 0);
  assert.equal(left(), 990, "…with no debt on the way back either");

  drag(0, -5000);
  assert.equal(top(), -8, "dragging up stops with 24px of the bar below the top edge");
  drag(0, 5000);
  assert.equal(top(), 744, "and down with 24px above the bottom edge");

  // Enter on the grip is the way back to the anchor from anywhere.
  press(grip, "Enter");
  assert.deepEqual([left(), top()], [208, 360], "Enter snaps a dragged-away bar back");

  teardown();
  img.remove();
}

// ---- an export says what happened, beside the bar -------------------------
// A copy is invisible and a save may or may not raise browser chrome, so the
// menu row's outcome is the only feedback there is. Both outcomes are reported;
// a rejection must not escape as an unhandled rejection.
{
  const outcomes: string[] = [];
  const exporter = {
    copy: async (index: number) => void outcomes.push(`copy(${index})`),
    save: async (index: number) => {
      outcomes.push(`save(${index})`);
      throw new Error("downloads are blocked here");
    },
  };
  const { img, shadow, teardown } = mount(exporter as FrameExport);

  const rows = () => Array.from(shadow.querySelectorAll<HTMLElement>("button.menu-row"));
  const openMenu = (): void => {
    const cog = shadow.querySelector('button[aria-label="Settings"]') as HTMLElement;
    act(() => cog.click());
  };
  const rowNamed = (label: string): HTMLElement => {
    const row = rows().find((r) => (r.textContent ?? "").includes(label));
    assert.ok(row, `the menu offers "${label}"`);
    return row;
  };
  /** The most recent toast's text. Each report mounts its own host. */
  const toastText = (): string => {
    const texts = Array.from(document.querySelectorAll("*"))
      .map((el) => el.shadowRoot?.querySelector(".toast")?.textContent ?? "")
      .filter(Boolean);
    return texts.at(-1) ?? "";
  };

  openMenu();
  act(() => rowNamed("Copy frame").click());
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(outcomes, ["copy(0)"], "the row exports the frame on screen");
  assert.match(toastText(), /Frame copied/, "a successful copy is confirmed");

  openMenu();
  act(() => rowNamed("Save frame").click());
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(outcomes, ["copy(0)", "save(0)"], "the save row runs the save");
  assert.match(toastText(), /Couldn't save this frame/, "a rejected export reports the failure");

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
