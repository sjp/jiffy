// Canvas-over-img overlay: positioning + scroll/resize sync + blit (issue 05 /
// PRD §5).
//
// We deliberately do NOT swap the <img> for a <canvas> — swapping breaks
// selectors, intrinsic sizing and object-fit (PRD §5). Instead the <img> stays
// in place (preserving layout + styling) and an absolutely-positioned canvas is
// laid exactly over its box, covering it, and we drive that canvas from the
// engine's current frame.
import type { Engine, Frame } from '../engine/types';

export interface Overlay {
  canvas: HTMLCanvasElement;
  /** Tear down listeners and remove the canvas. */
  destroy(): void;
}

// Sit above page content but leave headroom for the controls host (issues 07+).
const OVERLAY_Z_INDEX = '2147483646';

/**
 * Walk up the DOM from `el` and return the first non-transparent background
 * colour found. The canvas is inserted into document.body, so its transparent
 * pixels reveal the body background rather than the img's container background;
 * applying the effective colour as the canvas's CSS background-color corrects this.
 */
function getEffectiveBgColor(el: Element): string {
  let node: Element | null = el;
  while (node) {
    const color = getComputedStyle(node).backgroundColor;
    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
    node = node.parentElement;
  }
  return '';
}

// scroll/resize listener options — captured so nested scroll containers also
// trigger a reposition. The same object is handed to removeEventListener.
const SCROLL_OPTS: AddEventListenerOptions = { passive: true, capture: true };

/**
 * Position a canvas exactly over `img` and blit the engine's current frame,
 * keeping the canvas synced on scroll/resize. `frames` is the decoded sequence
 * (issue 03); the canvas drawing buffer is set to the GIF's native resolution.
 */
export function createOverlay(
  img: HTMLImageElement,
  engine: Engine,
  frames: Frame[],
): Overlay {
  const canvas = document.createElement('canvas');

  // Drawing buffer = GIF native pixel size (device pixels). The composited
  // bitmaps are full-canvas at native resolution, so frame 0 carries the size.
  const native = frames[0]?.bitmap;
  canvas.width = native?.width ?? img.naturalWidth;
  canvas.height = native?.height ?? img.naturalHeight;

  // Base styling. The display box (CSS width/height) is set per-reposition.
  // Copying the img's object-fit/position lets the canvas — a replaced element
  // whose intrinsic size is its buffer — reproduce the page's fit/crop intent
  // natively (PRD §5).
  const computed = getComputedStyle(img);
  Object.assign(canvas.style, {
    position: 'absolute',
    margin: '0',
    padding: '0',
    border: '0',
    boxSizing: 'border-box',
    pointerEvents: 'none', // don't intercept page interaction
    zIndex: OVERLAY_Z_INDEX,
    objectFit: computed.objectFit,
    objectPosition: computed.objectPosition,
    opacity: computed.opacity,
    backgroundColor: getEffectiveBgColor(img),
  });

  // The canvas covers the img entirely; hide the original so transparent canvas
  // regions show the page background rather than the underlying image.
  const savedOpacity = img.style.opacity;
  img.style.opacity = '0';

  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  /** Lay the canvas over the img's current border-box, in page coordinates. */
  const reposition = (): void => {
    const rect = img.getBoundingClientRect();
    canvas.style.left = `${rect.left + window.scrollX}px`;
    canvas.style.top = `${rect.top + window.scrollY}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  };

  /** Blit the frame at `index` (clear first so transparency shows through). */
  const draw = (index: number): void => {
    if (!ctx) return;
    const frame = frames[index];
    if (!frame) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame.bitmap, 0, 0);
  };

  // Coalesce scroll/resize bursts into one reposition per frame to avoid thrash.
  let repositionScheduled = false;
  const scheduleReposition = (): void => {
    if (repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(() => {
      repositionScheduled = false;
      reposition();
    });
  };

  // Initial paint.
  reposition();
  draw(engine.state.index);

  // Redraw whenever the engine advances/seeks.
  const unsubscribe = engine.subscribe((s) => draw(s.index));

  // Keep synced with scroll, viewport resize, and img box changes.
  window.addEventListener('scroll', scheduleReposition, SCROLL_OPTS);
  window.addEventListener('resize', scheduleReposition, { passive: true });
  const resizeObserver = new ResizeObserver(scheduleReposition);
  resizeObserver.observe(img);

  return {
    canvas,
    destroy() {
      img.style.opacity = savedOpacity;
      unsubscribe();
      window.removeEventListener('scroll', scheduleReposition, SCROLL_OPTS);
      window.removeEventListener('resize', scheduleReposition);
      resizeObserver.disconnect();
      canvas.remove();
    },
  };
}
