// Shadow root + Preact render of the controls UI.
//
// Mounts a host near the <img> with a shadow root (clean two-way CSS + event
// boundary; see ./host), installs the stylesheet, and renders <Controls> bound
// to the engine. Preact attaches real DOM listeners inside the shadow tree (no
// synthetic event system), so events work across the boundary.
import { render } from "preact";

import type { Engine } from "../engine/types";
import { Controls } from "../ui/Controls";
import type { FrameActions } from "../ui/Controls";
import type { FrameExport } from "./exportFrame";
import { createHost } from "./host";
import { showToast } from "./toast";
import { trackImageBox } from "./trackBox";

import controlsCss from "../ui/controls.css";

// Above the overlay canvas so the bar is clickable over the frame.
const HOST_Z_INDEX = "2147483647";
// Keep at least this much of the bar on screen when clamping a drag, so it can
// never be lost entirely off the viewport edge.
const MIN_VISIBLE_PX = 24;
// How long a "Frame copied" / "Frame saved" confirmation stays up.
const EXPORT_TOAST_MS = 2000;

/**
 * Mount the controls in a shadow root anchored to `img`. Returns a teardown
 * function that unmounts Preact, detaches listeners, and removes the host.
 *
 * `frameExport` is what the menu's copy/save rows drive; the outcome is
 * reported here, next to the bar, because the export itself has no UI of its
 * own (a copy is invisible, and a download may or may not raise browser chrome).
 */
export function mountControls(
  img: HTMLImageElement,
  engine: Engine,
  onClose: () => void,
  frameExport?: FrameExport,
): () => void {
  // Open, unlike the overlay's: the bar holds no data the page can't already
  // read off the screen, and Preact wants ordinary DOM access to it.
  const { host, shadow, place, remove } = createHost({
    position: "absolute",
    zIndex: HOST_Z_INDEX,
    mode: "open",
    css: controlsCss,
  });

  // User drag offset, in page pixels, relative to the default anchored spot.
  // Lives for the lifetime of this mount so the bar stays
  // where the user dropped it across scroll/resize re-anchoring (per-session).
  let userDx = 0;
  let userDy = 0;

  // Where reposition() last put the bar, in viewport coordinates. A drag reads
  // these back to undo its own over-drag (see beginDrag); the host's own
  // `style.left` can't stand in, because that is relative to whatever
  // containing block the host landed in, not to the viewport.
  let placedLeft = 0;
  let placedTop = 0;

  // Pin the bar to the bottom-left of the img box, in page coordinates, plus any
  // user drag offset so a moved bar tracks the image as the page scrolls. The
  // final position is clamped so at least MIN_VISIBLE_PX of the bar stays within
  // the viewport — a drag (or the image scrolling away) can't strand it off-screen
  // with no way back. The bar's own size comes from offset* (the host
  // is laid out by the time reposition first runs, after the Preact render).
  const reposition = (): void => {
    const rect = img.getBoundingClientRect();
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    // Default anchor (viewport coords): bottom-left inside the image, + user drag.
    // `top` is the bar's top edge, so we subtract its height from the bottom anchor
    // instead of relying on a CSS translate (which clamping would have to undo).
    const vpLeft = rect.left + 8 + userDx;
    const vpTop = rect.top + rect.height - 8 - h + userDy;
    const marginX = Math.min(MIN_VISIBLE_PX, w);
    const marginY = Math.min(MIN_VISIBLE_PX, h);
    // The grip — the bar's only drag handle — sits at its LEFT edge, so the
    // horizontal clamp must keep that left edge reachable. The old lower bound
    // (marginX - w) let the left edge slide off-screen, leaving only the bar's
    // right end visible and the grip stranded with no way to drag back. Bound the
    // left edge to [0, innerWidth - marginX] instead: a hard left drag stops with
    // the grip at the viewport edge; a right drag still leaves the grip-side
    // marginX visible.
    const clampedLeft = Math.min(Math.max(vpLeft, 0), window.innerWidth - marginX);
    const clampedTop = Math.min(Math.max(vpTop, marginY - h), window.innerHeight - marginY);
    placedLeft = clampedLeft;
    placedTop = clampedTop;
    place(clampedLeft + window.scrollX, clampedTop + window.scrollY);
  };

  // reposition() clamps the bar into the viewport; fold that clamp back into the
  // offset so pushing at an edge doesn't build up a debt that has to be paid
  // back before the bar visually responds again. Called after every move.
  const absorbClamp = (): void => {
    const rect = img.getBoundingClientRect();
    userDx = placedLeft - rect.left - 8;
    userDy = placedTop - (rect.top + rect.height - 8 - host.offsetHeight);
  };

  // Snap back to the default anchored position (double-click or Enter on the grip).
  const resetPosition = (): void => {
    userDx = 0;
    userDy = 0;
    reposition();
  };

  // Keyboard move, from the grip's arrow keys. Same offset the drag accumulates
  // into, so the two ways of moving the bar compose rather than fight.
  const nudge = (dx: number, dy: number): void => {
    userDx += dx;
    userDy += dy;
    reposition();
    absorbClamp();
  };

  // Begin dragging the bar from the grip handle. Tracks the pointer on `window`
  // (capturing it on the grip) so the drag survives the pointer leaving the bar,
  // accumulating into the persistent offset that reposition() applies.
  const beginDrag = (event: PointerEvent): void => {
    event.preventDefault();
    const grip = event.currentTarget as Element;
    grip.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const baseDx = userDx;
    const baseDy = userDy;

    const onMove = (e: PointerEvent): void => {
      userDx = baseDx + (e.clientX - startX);
      userDy = baseDy + (e.clientY - startY);
      reposition();
      absorbClamp();
    };
    const onUp = (): void => {
      // The capture is auto-released on pointerup, but release explicitly to
      // mirror the setPointerCapture in this handler and keep the pairing obvious.
      grip.releasePointerCapture?.(event.pointerId);
      grip.removeEventListener("pointermove", onMove as EventListener);
      grip.removeEventListener("pointerup", onUp as EventListener);
      grip.removeEventListener("pointercancel", onUp as EventListener);
    };
    grip.addEventListener("pointermove", onMove as EventListener);
    grip.addEventListener("pointerup", onUp as EventListener);
    grip.addEventListener("pointercancel", onUp as EventListener);
  };

  // Report an export's outcome just above the bar. The bar is where the user
  // asked for it and may have been dragged anywhere by now, so its own box —
  // not the image's — is the honest anchor.
  const notify = (text: string): void => {
    const rect = host.getBoundingClientRect();
    showToast(rect.left, rect.top).set(text, EXPORT_TOAST_MS);
  };

  const report = (work: Promise<void>, done: string, failed: string): void => {
    work.then(
      () => notify(done),
      (err: unknown) => {
        // Blocked clipboard access, a page that forbids downloads, a frame that
        // couldn't be recomposited: the user gets the plain outcome, the
        // console gets the reason.
        console.debug("[jiffy] frame export failed", err);
        notify(failed);
      },
    );
  };

  // Kept as plain calls (not `await`ed here) so the clipboard write starts
  // inside the click that asked for it — see ./exportFrame.
  const frameActions: FrameActions | undefined = frameExport && {
    copy: (index) => report(frameExport.copy(index), "Frame copied", "Couldn't copy this frame"),
    save: (index) => report(frameExport.save(index), "Frame saved", "Couldn't save this frame"),
  };

  // Where focus was when the bar appeared, for putting it back when the bar goes
  // away (see releaseFocus).
  const focusedBefore = document.activeElement;

  /**
   * Hand focus back before the host is removed. Losing it to <body> strands a
   * keyboard user with no idea where they are in the page, and the bar can be
   * closed from inside itself (✕, or Escape on the toast) or from outside
   * (reconcile), so this has to be conditional on actually holding the focus.
   */
  const releaseFocus = (): void => {
    // The shadow root is open, but the page's activeElement is still the host —
    // focus inside a shadow tree is reported as the host that contains it.
    if (document.activeElement !== host) return;
    if (
      focusedBefore instanceof HTMLElement &&
      focusedBefore.isConnected &&
      focusedBefore !== document.body
    ) {
      focusedBefore.focus();
      return;
    }
    // Nothing to go back to — a pick usually starts from a click on the page
    // with nothing focused. Park on the image the bar was about. An <img> takes
    // no focus of its own, so lend it a tabindex and take it back the moment it
    // gives the focus up, leaving the page's own markup as we found it.
    if (!img.hasAttribute("tabindex")) {
      img.setAttribute("tabindex", "-1");
      img.addEventListener("blur", () => img.removeAttribute("tabindex"), { once: true });
    }
    img.focus();
  };

  // Render into a dedicated mount point so Preact's diffing never touches the
  // sibling <style> node.
  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);
  render(
    <Controls
      engine={engine}
      onDragStart={beginDrag}
      onResetPosition={resetPosition}
      onNudge={nudge}
      onClose={onClose}
      frameActions={frameActions}
    />,
    mountPoint,
  );

  // Anchor the bar now — the host is laid out, so reposition can measure it —
  // and keep it on the img's box as the page scrolls, resizes, or reflows.
  const untrack = trackImageBox(img, reposition);

  return () => {
    // Before the unmount, while the focused control is still there to be asked about.
    releaseFocus();
    render(null, mountPoint);
    untrack();
    remove();
  };
}
