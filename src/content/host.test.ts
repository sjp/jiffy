// Headless tests for host mounting and containing-block correction.
//
// The placement itself needs layout, which jsdom hasn't got. But the correction
// that placement depends on reads exactly two things from the DOM —
// `getComputedStyle` and `getBoundingClientRect` — so stubbing both pins down
// the arithmetic a real browser's measurements would feed it: which ancestors
// count as a containing block, and where its padding box lands in page
// coordinates. Where the host is attached, and the shadow mode it gets, are
// checked against the real jsdom DOM.
//
// Run: `npm test`.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { containingBlockOrigin, createHost } from "./host.ts";

// ---- stubs ----------------------------------------------------------------
// One style record per element; anything unregistered reads as a plain static
// block, which is what <html> and <body> are on a page that does nothing odd.

const DEFAULT_STYLE: Record<string, string> = {
  position: "static",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  filter: "none",
  backdropFilter: "none",
  perspective: "none",
  contain: "none",
  willChange: "auto",
  borderLeftWidth: "0px",
  borderTopWidth: "0px",
};

const styles = new Map<Element, Record<string, string>>();
const setStyle = (el: Element, overrides: Record<string, string>): void => {
  styles.set(el, { ...DEFAULT_STYLE, ...overrides });
};
const fakeGetComputedStyle = (el: Element): Record<string, string> =>
  styles.get(el) ?? DEFAULT_STYLE;
(globalThis as Record<string, unknown>).getComputedStyle = fakeGetComputedStyle;
(window as unknown as Record<string, unknown>).getComputedStyle = fakeGetComputedStyle;

// A scrolled page, so page-vs-viewport coordinates can't be confused.
Object.defineProperty(window, "scrollX", { value: 40, configurable: true });
Object.defineProperty(window, "scrollY", { value: 7, configurable: true });

const setRect = (el: Element, rect: { left: number; top: number }): void => {
  el.getBoundingClientRect = () =>
    ({ ...rect, width: 0, height: 0, right: rect.left, bottom: rect.top }) as DOMRect;
};

// ---- which ancestors establish a containing block --------------------------

const outer = document.createElement("div");
const inner = document.createElement("div");
const host = document.createElement("div");
outer.appendChild(inner);
inner.appendChild(host);
document.body.appendChild(outer);
setRect(outer, { left: 100, top: 50 });
setRect(inner, { left: 200, top: 150 });

assert.deepEqual(
  containingBlockOrigin(host),
  { x: 0, y: 0 },
  "with no positioned ancestor, left/top are page coordinates already",
);

// `position: relative` on an ancestor — the common case this correction exists
// for: the origin moves to that element's padding box, in page coordinates.
setStyle(inner, { position: "relative", borderLeftWidth: "3px", borderTopWidth: "5px" });
assert.deepEqual(
  containingBlockOrigin(host),
  { x: 200 + 40 + 3, y: 150 + 7 + 5 },
  "the origin is the containing block's padding box, scroll included",
);

// The NEAREST such ancestor wins, not the outermost.
setStyle(outer, { position: "absolute" });
assert.deepEqual(
  containingBlockOrigin(host),
  { x: 243, y: 162 },
  "the walk stops at the first containing block it meets",
);

// Everything that promotes an element to a containing block for fixed
// descendants does the same for absolute ones. Each is checked on its own so a
// missed property can't hide behind a neighbour.
styles.delete(outer);
for (const [property, value] of [
  ["transform", "matrix(1, 0, 0, 1, 0, 0)"],
  ["translate", "10px"],
  ["rotate", "45deg"],
  ["scale", "2"],
  ["filter", "blur(2px)"],
  ["backdropFilter", "blur(2px)"],
  ["perspective", "800px"],
  ["contain", "paint"],
  ["contain", "layout style"],
  ["willChange", "transform"],
  ["willChange", "opacity, filter"],
] as const) {
  setStyle(inner, { [property]: value });
  assert.deepEqual(
    containingBlockOrigin(host),
    { x: 240, y: 157 },
    `${property}: ${value} makes an ancestor the containing block`,
  );
}

// …and things that only look like they might.
for (const [property, value] of [
  ["contain", "size"],
  ["contain", "style"],
  ["willChange", "opacity"],
  ["willChange", "scroll-position"],
  ["willChange", "transform-origin"],
  ["position", "static"],
] as const) {
  setStyle(inner, { [property]: value });
  assert.deepEqual(
    containingBlockOrigin(host),
    { x: 0, y: 0 },
    `${property}: ${value} leaves the initial containing block in place`,
  );
}

// jsdom (and any UA that reports nothing for a property it doesn't support)
// resolves these to "" rather than "none"; an empty value must read as absent.
setStyle(inner, { position: "", transform: "", filter: "", contain: "", willChange: "" });
assert.deepEqual(
  containingBlockOrigin(host),
  { x: 0, y: 0 },
  "an unreported property is not mistaken for a containing block",
);

// ---- where a host is attached, and what it exposes -------------------------

styles.clear();

const absolute = createHost({ position: "absolute", zIndex: "5", mode: "closed" });
assert.equal(
  absolute.host.parentElement,
  document.documentElement,
  "an absolute host hangs off <html>, so a positioned <body> can't shift it",
);
assert.equal(
  absolute.host.shadowRoot,
  null,
  "a closed root gives page script no way to the decoded pixels",
);
assert.equal(absolute.host.style.zIndex, "5");
assert.equal(absolute.host.style.pointerEvents, "", "pointer events are left alone by default");

// No ancestor of <html> can establish a containing block, so page coordinates
// pass straight through.
absolute.place(120, 340);
assert.equal(absolute.host.style.left, "120px");
assert.equal(absolute.host.style.top, "340px");

const fixed = createHost({
  position: "fixed",
  zIndex: "9",
  mode: "open",
  css: ".x { color: red }",
  pointerEvents: "none",
});
assert.equal(fixed.host.parentElement, document.body, "a fixed host stays in <body>");
assert.ok(fixed.host.shadowRoot, "an open root is reachable, for the chrome that holds no data");
assert.equal(fixed.host.style.pointerEvents, "none");
assert.equal(
  fixed.shadow.querySelector("style")?.textContent,
  ".x { color: red }",
  "the stylesheet is injected as a <style> node, not adopted",
);

// A fixed host is placed in viewport coordinates: no correction, no scroll.
fixed.place(120, 340);
assert.equal(fixed.host.style.left, "120px");
assert.equal(fixed.host.style.top, "340px");

absolute.remove();
fixed.remove();
assert.equal(absolute.host.isConnected, false, "remove() takes the host out of the page");
assert.equal(fixed.host.isConnected, false);

console.log("host.test: OK");
