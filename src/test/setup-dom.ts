// Minimal jsdom DOM environment for headless component tests. Import this FIRST
// in any test that renders Preact, so `document`/`window` and the DOM classes
// exist as globals before the component code runs.
//
// We copy jsdom's window globals that Node doesn't already define (skipping
// existing ones like `navigator`, which is read-only in modern Node), then force
// `window`/`document` onto globalThis.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><body></body>', {
  pretendToBeVisual: true, // provides requestAnimationFrame
  url: 'http://localhost/',
});

const { window } = dom;
const globals = globalThis as Record<string, unknown>;

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globals) continue; // don't clobber Node built-ins
  try {
    globals[key] = (window as unknown as Record<string, unknown>)[key];
  } catch {
    // Skip any property whose getter throws when read off the global.
  }
}

globals.window = window;
globals.document = window.document;
