// The player bundle — everything heavy, loaded on demand.
//
// Preact, gifuct-js, the four decoders, the engine, the overlay and the controls
// UI all live behind this ESM entry point. The thin content script (./index) is
// what actually gets injected into every page; it `import()`s this module from
// `web_accessible_resources` the first time the user picks an image, so a tab
// that never activates Jiffy never pays for any of it.
//
// Nothing here runs on import beyond wiring the controller: the loader drives it
// entirely through the `controller` export.
import { decode } from "../engine/decode";
import { createEngine } from "../engine/engine";
import { createController } from "./controller";
import { fetchGifBytes } from "./fetchGif";
import { mountControls } from "./mount";
import { createOverlay } from "./overlay";

/** Default wiring used when running as the actual player. */
export const controller = createController({
  fetchBytes: fetchGifBytes,
  decode,
  createEngine,
  createOverlay,
  mountControls,
});
