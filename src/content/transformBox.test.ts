// Headless tests for overlay placement over transformed images.
//
// jsdom has no layout, but this module only ever reads two things from the DOM —
// `getBoundingClientRect` and `getComputedStyle` — so stubbing both lets the
// geometry be checked exactly: we assert the canvas box and matrix that a real
// browser's measurements would produce.
//
// Run: `npm test`.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import {
  accumulatedTransform,
  IDENTITY,
  isIdentity,
  multiply,
  originUnderTransform,
  overlayBox,
  parseLinear,
  toCssMatrix,
  untransformedSize,
} from "./transformBox.ts";

// ---- stubs ----------------------------------------------------------------
// One style record per element; anything unregistered (body, html) is untouched.

interface FakeStyle {
  transform: string;
  perspective: string;
  width: string;
  height: string;
  [key: string]: string;
}

const DEFAULT_STYLE: FakeStyle = {
  transform: "none",
  perspective: "none",
  width: "auto",
  height: "auto",
  paddingLeft: "0px",
  paddingRight: "0px",
  paddingTop: "0px",
  paddingBottom: "0px",
  borderLeftWidth: "0px",
  borderRightWidth: "0px",
  borderTopWidth: "0px",
  borderBottomWidth: "0px",
};

const styles = new Map<Element, FakeStyle>();
const setStyle = (el: Element, overrides: Partial<FakeStyle>): void => {
  styles.set(el, { ...DEFAULT_STYLE, ...overrides });
};

const fakeGetComputedStyle = (el: Element): FakeStyle => styles.get(el) ?? DEFAULT_STYLE;
(globalThis as Record<string, unknown>).getComputedStyle = fakeGetComputedStyle;
(window as unknown as Record<string, unknown>).getComputedStyle = fakeGetComputedStyle;

// A scrolled page, so page-vs-viewport coordinates can't be confused.
Object.defineProperty(window, "scrollX", { value: 40, configurable: true });
Object.defineProperty(window, "scrollY", { value: 7, configurable: true });

const setRect = (
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
) => {
  el.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
};

// ---- parsing computed transform values -------------------------------------

assert.deepEqual(parseLinear("none"), IDENTITY, "an untransformed element is the identity");
assert.deepEqual(parseLinear(""), IDENTITY, "a UA that reports nothing is treated as upright");
assert.deepEqual(
  parseLinear("matrix(2, 0, 0, 3, 10, 20)"),
  { a: 2, b: 0, c: 0, d: 3 },
  "the translation is dropped; only the linear part is kept",
);
assert.equal(
  parseLinear("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)"),
  null,
  "a 3D matrix has no 2D stand-in — the caller must fall back",
);
assert.equal(parseLinear("rotate(4deg)"), null, "an unresolved value is not guessed at");
assert.equal(parseLinear("matrix(1, 0, 0)"), null, "a short matrix is rejected, not padded");

// ---- composing matrices ----------------------------------------------------

// scale(2) inside a 90° rotation: the scale applies first, the rotation after.
const rotate90 = { a: 0, b: 1, c: -1, d: 0 };
assert.deepEqual(
  multiply(rotate90, { a: 2, b: 0, c: 0, d: 2 }),
  { a: 0, b: 2, c: -2, d: 0 },
  "outer x inner: the ancestor's transform is applied last",
);
assert.ok(isIdentity(multiply({ a: 2, b: 0, c: 0, d: 2 }, { a: 0.5, b: 0, c: 0, d: 0.5 })));
assert.ok(!isIdentity(rotate90), "a rotation is not mistaken for no transform");
assert.equal(toCssMatrix(rotate90), "matrix(0, 1, -1, 0, 0, 0)", "emitted with a zeroed origin");

// ---- recovering the untransformed origin from the measured rect ------------

// A 100x50 box rotated 90° measures 50x100, and its top-left corner is the image
// of the box's BOTTOM-left, so the origin sits 50px right of the rect.
assert.deepEqual(
  originUnderTransform(rotate90, 100, 50, { left: 200, top: 100, width: 50, height: 100 }),
  { x: 250, y: 100 },
  "the origin is offset by the minimum transformed corner",
);
assert.deepEqual(
  originUnderTransform(IDENTITY, 100, 50, { left: 200, top: 100, width: 100, height: 50 }),
  { x: 200, y: 100 },
  "with no transform the origin is the rect's own top-left",
);

// ---- walking the ancestor chain --------------------------------------------

const container = document.createElement("div");
const img = document.createElement("img");
container.appendChild(img);
document.body.appendChild(container);

setStyle(img, { transform: "matrix(2, 0, 0, 2, 0, 0)" });
setStyle(container, { transform: "matrix(0, 1, -1, 0, 0, 0)" });
assert.deepEqual(
  accumulatedTransform(img),
  { a: 0, b: 2, c: -2, d: 0 },
  "a scaled image in a rotated container gets both transforms",
);

setStyle(img, { transform: "none" });
assert.deepEqual(accumulatedTransform(img), rotate90, "an ancestor transform alone still counts");

setStyle(container, { transform: "none" });
assert.deepEqual(accumulatedTransform(img), IDENTITY, "an untransformed chain is the identity");

setStyle(container, { transform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)" });
assert.equal(accumulatedTransform(img), null, "a 3D ancestor bails out of the whole chain");

setStyle(container, { transform: "none", perspective: "800px" });
assert.equal(
  accumulatedTransform(img),
  null,
  "an ancestor's perspective warps us without showing up in any transform",
);

// Perspective on the image itself only affects ITS children, so it isn't a bail.
setStyle(container, { transform: "none" });
setStyle(img, { transform: "none", perspective: "800px" });
assert.deepEqual(accumulatedTransform(img), IDENTITY, "our own perspective is not our problem");

// ---- shadow DOM: transforms outside the host still apply -------------------

const host = document.createElement("div");
document.body.appendChild(host);
const shadowImg = document.createElement("img");
host.attachShadow({ mode: "open" }).appendChild(shadowImg);
setStyle(host, { transform: "matrix(3, 0, 0, 3, 0, 0)" });
assert.deepEqual(
  accumulatedTransform(shadowImg),
  { a: 3, b: 0, c: 0, d: 3 },
  "the walk steps out of a shadow tree to its host",
);

// ---- untransformed size ----------------------------------------------------

setStyle(img, {
  width: "96.5px",
  height: "40px",
  paddingLeft: "1px",
  paddingRight: "1px",
  borderLeftWidth: "0.5px",
  borderRightWidth: "0.5px",
  borderTopWidth: "2px",
});
assert.deepEqual(
  untransformedSize(img),
  { width: 99.5, height: 42 },
  "border box = resolved content box + padding + borders, sub-pixel intact",
);

setStyle(img, { width: "auto", height: "auto" });
Object.defineProperty(img, "offsetWidth", { value: 33, configurable: true });
Object.defineProperty(img, "offsetHeight", { value: 22, configurable: true });
assert.deepEqual(
  untransformedSize(img),
  { width: 33, height: 22 },
  "a size that doesn't resolve falls back to the rounded offset box",
);

// ---- the whole box: untransformed images take the plain rect ---------------

setStyle(img, {});
setRect(img, { left: 200, top: 100, width: 100.5, height: 50 });
assert.deepEqual(
  overlayBox(img),
  { left: 240, top: 107, width: 100.5, height: 50, transform: "none" },
  "no transform: the rect is used as-is, in page coordinates",
);

// ---- ...and a transformed one is placed by its untransformed box -----------

setStyle(img, { transform: "matrix(0, 1, -1, 0, 0, 0)", width: "100px", height: "50px" });
setRect(img, { left: 200, top: 100, width: 50, height: 100 });
assert.deepEqual(
  overlayBox(img),
  { left: 290, top: 107, width: 100, height: 50, transform: "matrix(0, 1, -1, 0, 0, 0)" },
  "rotated: the canvas takes the pre-transform box and mirrors the rotation",
);

// A transform chain that cancels out is still the cheap, exact path.
setStyle(container, { transform: "matrix(0, -1, 1, 0, 0, 0)" });
assert.equal(overlayBox(img).transform, "none", "a chain resolving to identity stays upright");

// Anything 3D degrades to the bounding box rather than guessing.
setStyle(container, { transform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)" });
assert.deepEqual(
  overlayBox(img),
  { left: 240, top: 107, width: 50, height: 100, transform: "none" },
  "3D: fall back to covering the bounding box",
);

console.log("transformBox.test.ts ok");
