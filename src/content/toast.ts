// Transient status toast for the pick flow (issues #4/#5).
//
// Picking is a one-shot action with a slow middle (fetch + decode of a large GIF
// can take a moment) and several silent dead-ends (a static PNG that sniffs as
// not-animated, a network error). Without feedback the user clicks, nothing
// happens, and it looks broken. This shows a small message anchored at the click
// point: "Loading…" while the pipeline runs (cleared when the overlay mounts) and
// a short auto-dismissing message for the not-animated / error outcomes.
//
// Built like the rest of Jiffy's chrome (see ./host): a host element positioned
// in the page and a shadow root for a clean style/event boundary. Position is
// `fixed` to the viewport (click coords are viewport-relative) and pointer-events
// are off so the toast never eats clicks.
import { createHost } from "./host";

const HOST_Z_INDEX = "2147483647";

const TOAST_CSS = `
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    font: 13px/1.4 system-ui, -apple-system, sans-serif;
    background: rgba(20, 20, 20, 0.92);
    color: #fff;
    padding: 6px 10px;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    white-space: nowrap;
    /* Sit just above-right of the click point, out from under the cursor. */
    transform: translate(8px, -120%);
  }
  .cancel {
    /* The host has pointer-events: none so the toast never eats page clicks;
       re-enable them on the button alone so it stays clickable. */
    pointer-events: auto;
    cursor: pointer;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.15);
    color: inherit;
    font: inherit;
    line-height: 1;
  }
  .cancel:hover {
    background: rgba(255, 255, 255, 0.3);
  }
`;

/** A live toast: update its text (optionally auto-dismissing) or remove it. */
export interface Toast {
  /** Replace the message. With `autoDismissMs`, removes itself after that delay. */
  set(text: string, autoDismissMs?: number): void;
  /**
   * Take the ✕ away, for a toast that has reached an outcome: there is no
   * longer a pick to cancel, and a live-looking button that does nothing is
   * worse than no button. Idempotent, and a no-op on a toast that never had one.
   */
  hideCancel(): void;
  /** Remove the toast immediately (idempotent). */
  dismiss(): void;
}

/**
 * Show a toast anchored at viewport coordinates `clientX`/`clientY`. When
 * `onCancel` is given, a ✕ button is shown (used for the cancellable "Loading…"
 * state); clicking it dismisses the toast and invokes the callback.
 */
export function showToast(clientX: number, clientY: number, onCancel?: () => void): Toast {
  const { shadow, place, remove } = createHost({
    position: "fixed",
    zIndex: HOST_Z_INDEX,
    mode: "open",
    css: TOAST_CSS,
    pointerEvents: "none",
  });
  place(clientX, clientY);

  const box = document.createElement("div");
  box.className = "toast";
  shadow.appendChild(box);

  // The message lives in its own node so the cancel button (a sibling) survives
  // a set() — writing box.textContent directly would wipe the button.
  const label = document.createElement("span");
  box.appendChild(label);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removed = false;

  const dismiss = (): void => {
    if (removed) return;
    removed = true;
    if (timer != null) clearTimeout(timer);
    remove();
  };

  const set = (text: string, autoDismissMs?: number): void => {
    if (removed) return;
    label.textContent = text;
    if (timer != null) clearTimeout(timer);
    timer = autoDismissMs != null ? setTimeout(dismiss, autoDismissMs) : undefined;
  };

  let cancel: HTMLButtonElement | null = null;
  if (onCancel) {
    cancel = document.createElement("button");
    cancel.className = "cancel";
    cancel.type = "button";
    cancel.textContent = "✕";
    cancel.setAttribute("aria-label", "Cancel");
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      dismiss();
      onCancel();
    });
    box.appendChild(cancel);
  }

  const hideCancel = (): void => {
    cancel?.remove();
    cancel = null;
  };

  return { set, hideCancel, dismiss };
}
