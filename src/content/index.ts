// Content-script entry: discover GIFs, then construct an engine + overlay +
// controls per image and handle teardown (issue 10).
import { decode } from '../engine/decode';
import { createEngine } from '../engine/engine';
import { createOverlay } from './overlay';
import { mountControls } from './mount';

/** Bootstrap GIF discovery + per-image wiring. Stub — implemented in issue 10. */
export function init(): void {
  // TODO(issue 10): find GIFs (img[src$=".gif"], currentSrc…), and for each one
  // decode → createEngine → createOverlay → mountControls, with teardown.
  void [decode, createEngine, createOverlay, mountControls];
}

console.debug('[jiffy] content script loaded');
