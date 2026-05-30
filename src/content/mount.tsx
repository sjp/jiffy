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

/**
 * Mount the controls in a shadow root anchored to `img`. Returns a teardown
 * function that unmounts Preact, detaches listeners, and removes the host.
 */
export function mountControls(img: HTMLImageElement, engine: Engine): () => void {
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.zIndex = HOST_Z_INDEX;
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(controlsCss);
  shadow.adoptedStyleSheets = [sheet];

  render(<Controls engine={engine} />, shadow);

  // Pin the bar to the bottom-left of the img box, in page coordinates.
  const reposition = (): void => {
    const rect = img.getBoundingClientRect();
    host.style.left = `${rect.left + window.scrollX + 8}px`;
    host.style.top = `${rect.top + window.scrollY + rect.height - 8}px`;
    host.style.transform = 'translateY(-100%)';
  };

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
    render(null, shadow);
    window.removeEventListener('scroll', schedule, SCROLL_OPTS);
    window.removeEventListener('resize', schedule);
    resizeObserver.disconnect();
    host.remove();
  };
}
