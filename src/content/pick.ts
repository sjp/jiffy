// Hit-testing for pick mode: which <img> did the user actually click?
//
// `event.target.closest("img")` is not enough. Cards, galleries and lightboxes
// routinely stack something over the image — a stretched link overlay, a
// transparent "click to open" div, a caption gradient — so the click target is
// that overlay, `closest("img")` finds nothing, and the pick looks broken. The
// same is true of an image Jiffy has already enhanced: our own canvas covers it,
// so a click meant to toggle it back off never resolves to the <img>.
//
// So we hit-test the click POINT instead and take the topmost <img> in the
// returned stack. `elementsFromPoint` retargets shadow content to its host, so a
// host in the stack is re-tested against its own shadow root (open roots only —
// a closed one is nothing we can see into) before moving on down the stack.
//
// The stack-walking is a pure function over an element list: jsdom implements
// neither `elementsFromPoint` nor layout, so tests hand it a stack directly.

/** Anything that can hit-test a viewport point: `document`, or an open shadow root. */
export interface PointHitTester {
  elementsFromPoint?(x: number, y: number): Element[];
}

/** Tag check rather than `instanceof`: an <img> from another realm is still an <img>. */
const isImage = (el: Element): el is HTMLImageElement => el.tagName === "IMG";

/**
 * An image with a zero-size box isn't what the user aimed at — a 0×0 tracking
 * pixel, a lazy-loading placeholder that hasn't been given a size yet. Hit stacks
 * can contain them, and enhancing one produces an overlay nobody can see.
 */
function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * First visible <img> in a hit-test stack (topmost first), descending into the
 * open shadow root of any host along the way.
 *
 * `seen` guards the descent: a shadow root's own hit stack includes the host and
 * its ancestors, so without it a host would keep re-entering itself.
 */
export function findImageInStack(
  stack: readonly Element[],
  x: number,
  y: number,
  seen: Set<Element> = new Set(),
): HTMLImageElement | null {
  for (const el of stack) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (isImage(el)) {
      if (isVisible(el)) return el;
      continue;
    }
    // Optional call: jsdom's ShadowRoot has no elementsFromPoint, and neither do
    // older engines, so a missing one simply means "can't look inside this host".
    const inner = (el.shadowRoot as PointHitTester | null)?.elementsFromPoint?.(x, y);
    if (!inner) continue;
    const found = findImageInStack(inner, x, y, seen);
    if (found) return found;
  }
  return null;
}

/**
 * Topmost visible <img> at a viewport point, or null if there is none (or if the
 * document can't hit-test — jsdom, and anything predating elementsFromPoint).
 */
export function findImageAtPoint(
  x: number,
  y: number,
  root: PointHitTester = document,
): HTMLImageElement | null {
  const stack = root.elementsFromPoint?.(x, y);
  return stack ? findImageInStack(stack, x, y) : null;
}
