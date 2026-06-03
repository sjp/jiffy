// Component test for <Controls>, rendered in jsdom via the esbuild
// test runner. `act` (from preact, no extra dep) flushes renders + effects so
// assertions see the updated DOM. The engine uses an injected clock so no real
// rAF runs.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { Controls } from "./Controls.tsx";
import { createEngine, type EngineClock } from "../engine/engine.ts";

// Clock whose scheduled callback never fires: play() flips `playing` but the
// loop never advances, keeping the test deterministic.
const clock: EngineClock = {
  now: () => 0,
  schedule: () => 1,
  cancel: () => {},
};

const frames = [
  { bitmap: {}, time: 100, delay: 100 },
  { bitmap: {}, time: 200, delay: 100 },
  { bitmap: {}, time: 300, delay: 100 },
] as never;
const engine = createEngine(frames, 300, clock);

const container = document.createElement("div");
document.body.appendChild(container);

act(() => {
  render(<Controls engine={engine} />, container);
});

const buttons = () => Array.from(container.querySelectorAll("button"));
assert.equal(buttons().length, 4, "prev / play-pause / next / settings cog");

const [prev, toggle, next] = buttons();
const text = () => container.textContent ?? "";

// Initial: paused, frame 1 of 3.
assert.equal(toggle!.getAttribute("aria-label"), "Play", "starts paused");
assert.match(text(), /1 \/ 3/, "readout shows 1 / 3");

// Toggle → plays; icon/label reflects state via the subscription.
act(() => toggle!.click());
assert.equal(engine.state.playing, true, "clicking toggle plays");
assert.equal(
  toggle!.getAttribute("aria-label"),
  "Pause",
  "icon reflects playing",
);

// Next → steps one frame and pauses (stepping is exact + paused).
act(() => next!.click());
assert.equal(engine.state.index, 1, "next steps one frame");
assert.equal(engine.state.playing, false, "stepping pauses");
assert.match(text(), /2 \/ 3/, "readout updates to 2 / 3");

// Prev → steps back.
act(() => prev!.click());
assert.equal(engine.state.index, 0, "prev steps back");
assert.match(text(), /1 \/ 3/, "readout back to 1 / 3");

// ---- keyboard shortcuts --------------------------------------------------
// Shortcuts are scoped to the focusable bar (not document), so they only fire
// when the controls have focus. Space toggles + preventDefaults (no page
// scroll); arrows step. State starts paused on frame 1 after the steps above.
const bar = container.querySelector(".bar") as HTMLElement;
assert.equal(bar.tabIndex, 0, "controls bar is focusable");

const press = (key: string) => {
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    bar.dispatchEvent(event);
  });
  return event;
};

const space = press(" ");
assert.equal(engine.state.playing, true, "Space toggles play");
assert.equal(
  space.defaultPrevented,
  true,
  "Space is preventDefault-ed (no page scroll)",
);

press("ArrowRight");
assert.equal(engine.state.index, 1, "ArrowRight steps forward");
assert.equal(engine.state.playing, false, "stepping pauses");

press("ArrowLeft");
assert.equal(engine.state.index, 0, "ArrowLeft steps back");

// Unrelated keys are left for the page/browser.
const other = press("a");
assert.equal(other.defaultPrevented, false, "unrelated keys are not consumed");

// ---- settings menu -------------------------------------------------------
// The cog is always present; clicking it opens a popover menu, Escape closes it.
const cog = buttons().find((b) => b.getAttribute("aria-label") === "Settings")!;
assert.ok(cog, "settings cog button exists");
assert.equal(
  cog.getAttribute("aria-haspopup"),
  "menu",
  "cog advertises a menu",
);
assert.equal(cog.getAttribute("aria-expanded"), "false", "menu starts closed");
assert.equal(
  container.querySelector('[role="menu"]'),
  null,
  "no popover while closed",
);

act(() => cog.click());
assert.equal(cog.getAttribute("aria-expanded"), "true", "cog click opens menu");
assert.ok(container.querySelector('[role="menu"]'), "popover appears");

press("Escape");
assert.equal(cog.getAttribute("aria-expanded"), "false", "Escape closes menu");
assert.equal(
  container.querySelector('[role="menu"]'),
  null,
  "popover removed after Escape",
);

render(null, container);
console.log("Controls.test: OK");
