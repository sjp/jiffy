// Headless tests for the pick-flow status toast.
//
// The toast is a small DOM widget (a fixed host + shadow root) with timer-driven
// auto-dismiss and idempotent teardown. jsdom gives us the DOM; we drive the
// auto-dismiss timer with a fake clock so the test stays deterministic and fast.
//
// Run: `npm test`.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";
import { showToast } from "./toast.ts";

// ---- fake timers ----------------------------------------------------------
// Capture pending setTimeout callbacks keyed by id so we can fire/clear them by
// hand; the toast only ever has one in flight at a time.
let nextTimer = 1;
const timers = new Map<number, () => void>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
(globalThis as { setTimeout: unknown }).setTimeout = (cb: () => void) => {
  const id = nextTimer++;
  timers.set(id, cb);
  return id;
};
(globalThis as { clearTimeout: unknown }).clearTimeout = (id: number) => {
  timers.delete(id);
};
/** Fire the timer with the given id (no-op if already cleared/fired). */
const fire = (id: number) => {
  const cb = timers.get(id);
  timers.delete(id);
  cb?.();
};

const hosts = () =>
  Array.from(document.body.children).filter((el) => el.shadowRoot);
const boxText = (host: Element) =>
  host.shadowRoot?.querySelector(".toast")?.textContent ?? null;

// ---- creation + positioning -----------------------------------------------
const toast = showToast(120, 40);
assert.equal(hosts().length, 1, "one toast host attached to <body>");
const [host] = hosts();
assert.equal(
  (host as HTMLElement).style.position,
  "fixed",
  "host is viewport-fixed",
);
assert.equal((host as HTMLElement).style.left, "120px", "anchored at clientX");
assert.equal((host as HTMLElement).style.top, "40px", "anchored at clientY");
assert.equal(
  (host as HTMLElement).style.pointerEvents,
  "none",
  "toast never eats clicks",
);

// ---- set() writes text into the shadow box --------------------------------
toast.set("Loading…");
assert.equal(boxText(host), "Loading…", "set() updates the message");
toast.set("Not an animated image");
assert.equal(boxText(host), "Not an animated image", "set() replaces the text");

// ---- auto-dismiss removes the host after the delay fires -------------------
assert.equal(timers.size, 0, "no timer pending before an auto-dismiss set");
toast.set("Couldn't load this image", 2500);
assert.equal(timers.size, 1, "auto-dismiss schedules a timer");
const [timerId] = timers.keys();
fire(timerId);
assert.equal(hosts().length, 0, "host removed when the auto-dismiss fires");

// ---- set() after removal is a no-op (no resurrection) ----------------------
toast.set("late");
assert.equal(hosts().length, 0, "set() after dismissal does not re-add a host");

// ---- explicit dismiss() is idempotent and clears a pending timer -----------
const toast2 = showToast(0, 0);
toast2.set("Loading…", 2000);
assert.equal(hosts().length, 1, "second toast mounted");
assert.equal(timers.size, 1, "second toast has a pending auto-dismiss");
toast2.dismiss();
assert.equal(hosts().length, 0, "dismiss() removes the host");
assert.equal(timers.size, 0, "dismiss() clears the pending auto-dismiss timer");
toast2.dismiss(); // idempotent — must not throw or double-remove
assert.equal(hosts().length, 0, "second dismiss() is a no-op");

// ---- re-setting cancels the previous timer (no stale dismissal) ------------
// A "loading" set with no timer after an auto-dismiss set must clear the old
// timer, so the earlier dismissal can't fire and yank a still-live toast.
const toast3 = showToast(0, 0);
toast3.set("Not animated", 2000);
assert.equal(timers.size, 1, "auto-dismiss armed");
toast3.set("Loading…"); // no autoDismissMs → should disarm
assert.equal(timers.size, 0, "re-setting without a delay clears the old timer");
assert.equal(hosts().length, 1, "toast still on screen");
toast3.dismiss();

// ---- cancel button: only present when onCancel is supplied -----------------
const plain = showToast(0, 0);
const plainHost = hosts().at(-1)!;
assert.equal(
  plainHost.shadowRoot?.querySelector(".cancel") ?? null,
  null,
  "no ✕ button when onCancel is omitted",
);
plain.dismiss();

// ---- cancel button: clicking it dismisses and fires onCancel once ----------
let cancelled = 0;
const cancellable = showToast(10, 10, () => cancelled++);
const cancelHost = hosts().at(-1)!;
cancellable.set("Loading…");
const button = cancelHost.shadowRoot!.querySelector(
  ".cancel",
) as HTMLButtonElement | null;
assert.ok(button, "onCancel renders a ✕ button");
assert.equal(
  cancelHost.shadowRoot!.querySelector("span")?.textContent,
  "Loading…",
  "the message lives in its own node beside the button",
);
// set() must update the text without wiping the button.
cancellable.set("Still loading…");
assert.ok(
  cancelHost.shadowRoot!.querySelector(".cancel"),
  "set() preserves the cancel button",
);
button!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.equal(cancelled, 1, "clicking ✕ invokes onCancel exactly once");
assert.equal(hosts().length, 0, "clicking ✕ dismisses the toast");

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
console.log("toast.test: OK");
