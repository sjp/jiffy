// Headless tests for pick-mode hit-testing: which <img> a click point resolves
// to when the page has stacked something over the image.
//
// jsdom has neither layout nor `elementsFromPoint`, so both are supplied here:
// the hit stack is handed to findImageInStack directly (topmost first, exactly
// what a browser returns), and each element is given the box it's meant to have.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { findImageAtPoint, findImageInStack } from "./pick.ts";

/** An element with a real box, since jsdom measures everything as 0×0. */
const sized = <T extends Element>(el: T, width = 200, height = 100): T => {
  el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0 }) as DOMRect;
  return el;
};

const img = (src = "http://x/a.gif") => {
  const el = sized(document.createElement("img"));
  el.src = src;
  return el;
};
const div = () => sized(document.createElement("div"));

// ---- the topmost image in the stack wins ------------------------------------
{
  const overlay = div(); // a stretched link overlay, a caption gradient, …
  const target = img();
  assert.equal(
    findImageInStack([overlay, target, document.body], 10, 10),
    target,
    "an image under a non-image overlay is found",
  );

  assert.equal(findImageInStack([target], 10, 10), target, "a direct hit is found");
  assert.equal(findImageInStack([overlay, document.body], 10, 10), null, "no image → null");
  assert.equal(findImageInStack([], 10, 10), null, "an empty stack → null");

  // Two images stacked (a thumbnail behind a hover-swap sprite): the top one is
  // what the user is looking at.
  const above = img("http://x/top.gif");
  assert.equal(findImageInStack([above, target], 10, 10), above, "the topmost image wins");
}

// ---- invisible images are skipped -------------------------------------------
{
  const pixel = sized(document.createElement("img"), 0, 0); // 0×0 tracking pixel
  const real = img();
  assert.equal(
    findImageInStack([pixel, real], 10, 10),
    real,
    "a zero-size image is skipped for the one behind it",
  );
  assert.equal(findImageInStack([pixel], 10, 10), null, "a zero-size image alone → null");
}

// ---- shadow hosts are re-tested against their own root ----------------------
// `elementsFromPoint` retargets shadow content to its host, so the image inside
// a custom element only shows up when the host's root is hit-tested in turn.
{
  const host = div();
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const inner = img("http://x/shadow.gif");
  root.appendChild(inner);
  // jsdom's ShadowRoot has no elementsFromPoint; stand one in. The real one
  // returns the host's ancestors below the shadow content, so include them —
  // revisiting the host must not send the walk round in circles.
  const withHitTest = root as ShadowRoot & { elementsFromPoint: () => Element[] };
  withHitTest.elementsFromPoint = () => [inner, host, document.body];

  assert.equal(
    findImageInStack([host, document.body], 10, 10),
    inner,
    "an image inside an open shadow root is found through its host",
  );

  // Nothing in the shadow tree: the walk carries on down the outer stack.
  const behind = img("http://x/behind.gif");
  withHitTest.elementsFromPoint = () => [host, document.body];
  assert.equal(
    findImageInStack([host, behind], 10, 10),
    behind,
    "an empty shadow root doesn't stop the walk",
  );

  // A closed root (or an engine without ShadowRoot.elementsFromPoint) is simply
  // opaque — no throw, just keep going.
  delete (root as { elementsFromPoint?: unknown }).elementsFromPoint;
  assert.equal(
    findImageInStack([host, behind], 10, 10),
    behind,
    "a host we can't hit-test into is skipped",
  );
  host.remove();
}

// ---- findImageAtPoint drives the document -----------------------------------
{
  const overlay = div();
  const beneath = img("http://x/point.gif");
  const hitTester = {
    elementsFromPoint: (x: number, y: number) =>
      x === 40 && y === 60 ? [overlay, beneath, document.body] : [document.body],
  };
  assert.equal(findImageAtPoint(40, 60, hitTester), beneath, "the point's image is returned");
  assert.equal(findImageAtPoint(0, 0, hitTester), null, "a point with no image → null");
  // Anything that can't hit-test (jsdom, an old engine) yields nothing rather
  // than throwing — the caller falls back to the click target.
  assert.equal(findImageAtPoint(40, 60, {}), null, "no elementsFromPoint → null");
}

console.log("pick.test: OK");
