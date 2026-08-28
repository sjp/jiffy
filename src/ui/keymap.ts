// Keyboard shortcuts. Kept as a pure-ish function of (key, engine) so it can
// be unit-tested without rendering and reused by the controls container.
//
// Scoped to focus by design: the only caller attaches this to the controls'
// `onKeyDown`, never to `window`/`document`, so two controlled GIFs on a page
// don't both respond to one keypress and normal typing in inputs is unaffected.
import type { Engine } from "../engine/types";

/**
 * Handle one keydown for a controlled GIF. Returns true if the key was handled
 * (the caller should `preventDefault` to stop e.g. Space scrolling the page).
 * `step` already pauses, matching the step buttons (issues 08/10).
 */
export function handleControlKey(key: string, engine: Engine): boolean {
  switch (key) {
    case " ":
    case "Spacebar": // legacy key value for Space
      engine.toggle();
      return true;
    case "ArrowLeft":
      engine.step(-1);
      return true;
    case "ArrowRight":
      engine.step(1);
      return true;
    case "Home":
      engine.seekToIndex(0);
      return true;
    case "End":
      engine.seekToIndex(engine.state.frameCount - 1);
      return true;
    default:
      return false;
  }
}
