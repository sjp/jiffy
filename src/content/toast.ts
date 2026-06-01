// Transient status toast for the pick flow (issues #4/#5).
//
// Picking is a one-shot action with a slow middle (fetch + decode of a large GIF
// can take a moment) and several silent dead-ends (a static PNG that sniffs as
// not-animated, a network error). Without feedback the user clicks, nothing
// happens, and it looks broken. This shows a small message anchored at the click
// point: "Loading…" while the pipeline runs (cleared when the overlay mounts) and
// a short auto-dismissing message for the not-animated / error outcomes.
//
// Built like the controls (mount.tsx): a host element positioned in the page, a
// shadow root for a clean style/event boundary, and a <style> node (a
// constructable stylesheet would be a sandbox-realm object the page-realm Xray
// shadow can't adopt). Position is `fixed` to the viewport (click coords are
// viewport-relative) and pointer-events are off so the toast never eats clicks.

const HOST_Z_INDEX = '2147483647';

const TOAST_CSS = `
  .toast {
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
`;

/** A live toast: update its text (optionally auto-dismissing) or remove it. */
export interface Toast {
  /** Replace the message. With `autoDismissMs`, removes itself after that delay. */
  set(text: string, autoDismissMs?: number): void;
  /** Remove the toast immediately (idempotent). */
  dismiss(): void;
}

/** Show a toast anchored at viewport coordinates `clientX`/`clientY`. */
export function showToast(clientX: number, clientY: number): Toast {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = `${clientX}px`;
  host.style.top = `${clientY}px`;
  host.style.zIndex = HOST_Z_INDEX;
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = TOAST_CSS;
  shadow.appendChild(style);

  const box = document.createElement('div');
  box.className = 'toast';
  shadow.appendChild(box);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removed = false;

  const dismiss = (): void => {
    if (removed) return;
    removed = true;
    if (timer != null) clearTimeout(timer);
    host.remove();
  };

  const set = (text: string, autoDismissMs?: number): void => {
    if (removed) return;
    box.textContent = text;
    if (timer != null) clearTimeout(timer);
    timer = autoDismissMs != null ? setTimeout(dismiss, autoDismissMs) : undefined;
  };

  return { set, dismiss };
}
