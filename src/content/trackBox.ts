// Keep something pinned to an <img>'s box.
//
// The overlay canvas and the controls bar are both laid out from the image's
// box in page coordinates, so both have to re-measure whenever that box moves
// under them: the page (or any nested scroller) scrolls, the viewport resizes,
// or the image itself changes size. That is one listener set with one teardown,
// wanted identically in two places — hence this helper rather than a copy in
// each.
import { parentElementOrHost } from "./transformBox";

// Capture phase so scrolling in a nested container — a lightbox, a feed pane —
// reaches us too: those events don't bubble to window. The same object is handed
// to removeEventListener so the listener is actually removed.
const SCROLL_OPTS: AddEventListenerOptions = { passive: true, capture: true };

/**
 * Call `onChange` whenever `img`'s box may have moved, plus once immediately so
 * the caller doesn't need its own initial placement. Returns a teardown that
 * detaches everything.
 *
 * Bursts are coalesced into one call per animation frame: scroll fires far more
 * often than the screen repaints, and re-measuring per event thrashes layout.
 * A frame already queued when teardown runs is dropped rather than firing at a
 * caller that has finished with it.
 */
export function trackImageBox(img: Element, onChange: () => void): () => void {
  let scheduled = false;
  let stopped = false;

  const schedule = (): void => {
    if (scheduled || stopped) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!stopped) onChange();
    });
  };

  onChange();

  window.addEventListener("scroll", schedule, SCROLL_OPTS);
  window.addEventListener("resize", schedule, { passive: true });

  // The image also moves when something *around* it resizes and reflows the
  // content it sits in: a cookie banner collapsing, an accordion opening, a web
  // font landing, an ad slot filling in. None of that touches the img's own box
  // or fires scroll/resize, so observing the img alone leaves the canvas behind
  // until the next scroll. Observing every element the img is laid out inside —
  // up through shadow hosts to <html>, whose box grows and shrinks with the
  // document — catches the reflow at whichever ancestor absorbed it.
  //
  // The chain is walked once: an element being re-parented while a player is up
  // is rare, and re-observing per callback risks ResizeObserver's
  // fire-on-observe re-arming us in a loop.
  const resizeObserver = new ResizeObserver(schedule);
  for (let node: Element | null = img; node; node = parentElementOrHost(node)) {
    resizeObserver.observe(node);
  }

  return () => {
    stopped = true;
    window.removeEventListener("scroll", schedule, SCROLL_OPTS);
    window.removeEventListener("resize", schedule);
    resizeObserver.disconnect();
  };
}
