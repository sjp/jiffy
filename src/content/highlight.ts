// The "which image will I get?" box drawn under the cursor in pick mode.
//
// A crosshair cursor says Jiffy is waiting for a click, but not what that click
// would land on. On a dense page — a gallery grid, a card with a stretched link
// over the thumbnail, a lightbox trigger — the image the pick resolves to is the
// one under the POINT (see ./pick), which is often not the element the page
// would have given the click. Outlining the candidate makes that resolution
// visible before the user commits to it.
//
// Built like the toast: a host element positioned in the page, a shadow root for
// a clean style/event boundary, and a <style> node (a constructable stylesheet
// would be a sandbox-realm object the page-realm Xray shadow can't adopt). The
// host is `fixed` because getBoundingClientRect gives viewport coordinates, and
// pointer-events are off throughout — otherwise the box would sit between the
// cursor and the very image it is advertising, and elementsFromPoint would
// return it instead of that image on the next move.

// Alongside the toast at the top of the stack: the two never coexist (a pick
// resolves before any status is reported), and the box has to be visible over
// page chrome and over a control bar Jiffy has already mounted.
const HOST_Z_INDEX = "2147483647";

/** Below this much room above the box, the label would be off-screen — put it inside. */
const LABEL_INSET_THRESHOLD_PX = 26;

const HIGHLIGHT_CSS = `
  :host {
    /* Belt and braces: the host carries this inline too, but a page-level
       blanket rule setting pointer-events on everything would otherwise reach
       the shadow content. */
    pointer-events: none;
  }
  .box {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    /* Inset outline rather than a border: the box is sized to the image exactly,
       and a border would push the tint in by its own width. */
    outline: 2px solid #4c9ffe;
    outline-offset: -2px;
    background: rgba(76, 159, 254, 0.16);
    border-radius: 2px;
  }
  .label {
    position: absolute;
    left: 0;
    bottom: 100%;
    margin-bottom: 4px;
    font: 12px/1.4 system-ui, -apple-system, sans-serif;
    background: rgba(20, 20, 20, 0.92);
    color: #fff;
    padding: 3px 7px;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    white-space: nowrap;
  }
  /* An image flush with the top of the viewport has no room above it. */
  .label.inside {
    bottom: auto;
    top: 4px;
    left: 4px;
  }
`;

const LABEL_TEXT = "Click to control · Esc to cancel";

/** A viewport-relative box — the part of a DOMRect the highlight needs. */
export interface HighlightRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** A live highlight box: move it over a candidate, hide it, or remove it. */
export interface Highlight {
  /** Draw the box over `rect` (viewport coordinates), showing it if hidden. */
  show(rect: HighlightRect): void;
  /** Hide the box, leaving it ready to show again. */
  hide(): void;
  /** Remove the box from the page for good (idempotent). */
  destroy(): void;
}

/**
 * Create the pick-mode highlight, hidden until the first `show()`. One lives for
 * the duration of a pick; `destroy()` leaves nothing behind.
 */
export function createHighlight(): Highlight {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.zIndex = HOST_Z_INDEX;
  host.style.pointerEvents = "none";
  host.style.display = "none";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = HIGHLIGHT_CSS;
  shadow.appendChild(style);

  const box = document.createElement("div");
  box.className = "box";
  shadow.appendChild(box);

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = LABEL_TEXT;
  shadow.appendChild(label);

  let removed = false;

  return {
    show(rect) {
      if (removed) return;
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.width = `${rect.width}px`;
      host.style.height = `${rect.height}px`;
      label.classList.toggle("inside", rect.top < LABEL_INSET_THRESHOLD_PX);
      host.style.display = "block";
    },
    hide() {
      if (removed) return;
      host.style.display = "none";
    },
    destroy() {
      if (removed) return;
      removed = true;
      host.remove();
    },
  };
}
