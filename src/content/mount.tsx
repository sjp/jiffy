// Shadow root + Preact render of the controls UI (issue 07 / PRD §7).
//
// Creates a host element near the <img>, attaches a shadow root (clean two-way
// CSS + event boundary), installs the adopted stylesheet, and renders <Controls>
// bound to the engine. Preact attaches real DOM listeners inside the shadow tree
// (no synthetic event system), so events work across the boundary (PRD §7).
import { render } from 'preact';
import type { Engine } from '../engine/types';
import { Controls } from '../ui/Controls';
import controlsCss from '../ui/controls.css';

// Above the overlay canvas (issue 05) so the bar is clickable over the frame.
const HOST_Z_INDEX = '2147483647';
const SCROLL_OPTS: AddEventListenerOptions = { passive: true, capture: true };
// Keep at least this much of the bar on screen when clamping a drag, so it can
// never be lost entirely off the viewport edge (issue #8).
const MIN_VISIBLE_PX = 24;

/**
 * Mount the controls in a shadow root anchored to `img`. Returns a teardown
 * function that unmounts Preact, detaches listeners, and removes the host.
 */
export function mountControls(img: HTMLImageElement, engine: Engine, onClose: () => void): () => void {
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.zIndex = HOST_Z_INDEX;
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  // Inject CSS via a <style> element rather than a constructable stylesheet:
  // in a Firefox content script `new CSSStyleSheet()` is a sandbox-realm object
  // and `shadow` is a page-realm Xray node, so `adoptedStyleSheets = [sheet]`
  // throws "Accessing from Xray wrapper is not supported". A <style> node is a
  // plain page-realm element with string content, so it crosses no boundary.
  const style = document.createElement('style');
  style.textContent = controlsCss;
  shadow.appendChild(style);

  // User drag offset (issue: movable controls), in page pixels, relative to the
  // default anchored spot. Lives for the lifetime of this mount so the bar stays
  // where the user dropped it across scroll/resize re-anchoring (per-session).
  let userDx = 0;
  let userDy = 0;

  // Pin the bar to the bottom-left of the img box, in page coordinates, plus any
  // user drag offset so a moved bar tracks the image as the page scrolls. The
  // final position is clamped so at least MIN_VISIBLE_PX of the bar stays within
  // the viewport — a drag (or the image scrolling away) can't strand it off-screen
  // with no way back (issue #8). The bar's own size comes from offset* (the host
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
    const clampedLeft = Math.min(Math.max(vpLeft, marginX - w), window.innerWidth - marginX);
    const clampedTop = Math.min(Math.max(vpTop, marginY - h), window.innerHeight - marginY);
    host.style.left = `${clampedLeft + window.scrollX}px`;
    host.style.top = `${clampedTop + window.scrollY}px`;
  };

  // Snap back to the default anchored position (double-click the grip, issue #8).
  const resetPosition = (): void => {
    userDx = 0;
    userDy = 0;
    reposition();
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
    };
    const onUp = (): void => {
      grip.removeEventListener('pointermove', onMove as EventListener);
      grip.removeEventListener('pointerup', onUp as EventListener);
      grip.removeEventListener('pointercancel', onUp as EventListener);
    };
    grip.addEventListener('pointermove', onMove as EventListener);
    grip.addEventListener('pointerup', onUp as EventListener);
    grip.addEventListener('pointercancel', onUp as EventListener);
  };

  // Render into a dedicated mount point so Preact's diffing never touches the
  // sibling <style> node.
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  render(
    <Controls
      engine={engine}
      onDragStart={beginDrag}
      onResetPosition={resetPosition}
      onClose={onClose}
    />,
    mountPoint,
  );

  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      reposition();
    });
  };

  reposition();
  window.addEventListener('scroll', schedule, SCROLL_OPTS);
  window.addEventListener('resize', schedule, { passive: true });
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(img);

  return () => {
    render(null, mountPoint);
    window.removeEventListener('scroll', schedule, SCROLL_OPTS);
    window.removeEventListener('resize', schedule);
    resizeObserver.disconnect();
    host.remove();
  };
}
