// Headless tests for the pick-mode highlight box.
//
// It's a small DOM widget (a fixed host + shadow root) whose whole job is
// geometry and visibility, so jsdom is enough: no layout is needed, since the
// box is positioned from a rect the caller hands it.
//
// Run: `npm test`.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { createHighlight } from "./highlight.ts";

const hosts = () => Array.from(document.body.children).filter((el) => el.shadowRoot);
const box = (host: Element) => host.shadowRoot?.querySelector(".box") ?? null;
const label = (host: Element) => host.shadowRoot?.querySelector(".label") ?? null;

// ---- creation: mounted but invisible until there's something to point at ----
const highlight = createHighlight();
assert.equal(hosts().length, 1, "one highlight host attached to <body>");
const [host] = hosts() as HTMLElement[];
assert.equal(host.style.position, "fixed", "host is viewport-fixed (rects are viewport coords)");
assert.equal(host.style.pointerEvents, "none", "the box never intercepts the pick click");
assert.equal(host.style.display, "none", "nothing is drawn until the first show()");
assert.ok(box(host), "the outline box lives in the shadow root");
assert.match(label(host)?.textContent ?? "", /Esc to cancel/, "the label spells out the exit");

// ---- show() positions the host over the candidate's box --------------------
highlight.show({ top: 120, left: 40, width: 300, height: 200 });
assert.equal(host.style.display, "block", "show() reveals the box");
assert.equal(host.style.left, "40px", "left edge tracks the rect");
assert.equal(host.style.top, "120px", "top edge tracks the rect");
assert.equal(host.style.width, "300px", "width tracks the rect");
assert.equal(host.style.height, "200px", "height tracks the rect");
assert.equal(label(host)?.classList.contains("inside"), false, "room above → label sits above");

// ---- a candidate flush with the top of the viewport keeps its label on screen
highlight.show({ top: 2, left: 0, width: 100, height: 100 });
assert.equal(label(host)?.classList.contains("inside"), true, "no room above → label moves in");

// Moving back down puts it back outside.
highlight.show({ top: 300, left: 10, width: 100, height: 100 });
assert.equal(label(host)?.classList.contains("inside"), false, "the inset is not sticky");

// ---- hide() leaves the box mounted and reusable ----------------------------
highlight.hide();
assert.equal(host.style.display, "none", "hide() takes the box off screen");
assert.equal(hosts().length, 1, "hide() keeps the host for the next candidate");
highlight.show({ top: 10, left: 10, width: 50, height: 50 });
assert.equal(host.style.display, "block", "a hidden box shows again");

// ---- destroy() removes it for good, and is idempotent ----------------------
highlight.destroy();
assert.equal(hosts().length, 0, "destroy() removes the host");
highlight.destroy(); // must not throw or remove someone else's node
assert.equal(hosts().length, 0, "a second destroy() is a no-op");

// A late show() on a destroyed highlight must not resurrect it.
highlight.show({ top: 0, left: 0, width: 10, height: 10 });
highlight.hide();
assert.equal(hosts().length, 0, "show() after destroy() does not re-add a host");

console.log("highlight.test: OK");
