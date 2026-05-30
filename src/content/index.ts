// Content-script entry + per-GIF pipeline (issue 11 / PRD §2, §10.6).
//
// For each animated GIF on the page we run: fetch bytes (issue 06) → decode
// (issue 03) → engine (issue 04) → overlay canvas (issue 05) → controls (07–10),
// tracking every instance so it can be torn down cleanly. One engine + overlay +
// controls per GIF; a decode failure on one GIF must not break the others.
//
// The pipeline's collaborators are injected (createController) so the discovery /
// registry / teardown logic is unit-testable headless without a real canvas or
// the background channel. Dynamic discovery (MutationObserver) is issue 13 — this
// module exposes `discover`/`teardown` so 13 can drive them.
import { decode } from '../engine/decode';
import { createEngine } from '../engine/engine';
import { createOverlay, type Overlay } from './overlay';
import { mountControls } from './mount';
import { fetchGifBytes } from './fetchGif';
import { isPickGifRequest } from '../messages';
import type { DecodeResult, Engine, Frame } from '../engine/types';

/** Collaborators for the per-GIF pipeline (injectable for tests). */
export interface PipelineDeps {
  fetchBytes: (url: string) => Promise<ArrayBuffer>;
  decode: (bytes: ArrayBuffer) => Promise<DecodeResult>;
  createEngine: (frames: Frame[], duration: number) => Engine;
  createOverlay: (img: HTMLImageElement, engine: Engine, frames: Frame[]) => Overlay;
  mountControls: (img: HTMLImageElement, engine: Engine) => () => void;
}

/** A live, controllable GIF on the page. */
interface Instance {
  engine: Engine;
  overlay: Overlay;
  teardownControls: () => void;
}

export interface Controller {
  /** Process one image through the pipeline (de-duplicated). */
  processImage(img: HTMLImageElement): Promise<void>;
  /** Find and process all candidate GIFs under `root`. */
  discover(root?: ParentNode): void;
  /** Tear down a single image's instance. */
  teardown(img: HTMLImageElement): void;
  /** Tear down everything. */
  teardownAll(): void;
  /** Live registry (exposed for issue 13 + tests). */
  readonly instances: ReadonlyMap<HTMLImageElement, Instance>;
}

/** True if the image's resolved URL looks like a GIF. */
export function isGifCandidate(img: HTMLImageElement): boolean {
  const url = img.currentSrc || img.src;
  return /\.gif(?:[?#]|$)/i.test(url);
}

export function createController(deps: PipelineDeps): Controller {
  const instances = new Map<HTMLImageElement, Instance>();
  const pending = new Set<HTMLImageElement>();

  async function processImage(img: HTMLImageElement): Promise<void> {
    if (instances.has(img) || pending.has(img)) return; // never double-process
    pending.add(img);
    try {
      const url = img.currentSrc || img.src;
      const bytes = await deps.fetchBytes(url);
      const { frames, duration } = await deps.decode(bytes);

      // Bail if a single frame (nothing to control) or torn down mid-flight.
      if (frames.length <= 1 || !pending.has(img)) return;

      const engine = deps.createEngine(frames, duration);
      const overlay = deps.createOverlay(img, engine, frames);
      const teardownControls = deps.mountControls(img, engine);
      instances.set(img, { engine, overlay, teardownControls });
    } catch (err) {
      // One bad GIF shouldn't break the rest.
      console.debug('[jiffy] skipping GIF', img.currentSrc || img.src, err);
    } finally {
      pending.delete(img);
    }
  }

  function discover(root: ParentNode = document): void {
    for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
      if (isGifCandidate(img)) void processImage(img);
    }
  }

  function teardown(img: HTMLImageElement): void {
    pending.delete(img);
    const instance = instances.get(img);
    if (!instance) return;
    instance.overlay.destroy();
    instance.teardownControls();
    instances.delete(img);
  }

  function teardownAll(): void {
    pending.clear();
    for (const instance of instances.values()) {
      instance.overlay.destroy();
      instance.teardownControls();
    }
    instances.clear();
  }

  return { processImage, discover, teardown, teardownAll, instances };
}

/** Default wiring used when running as the actual content script. */
export const controller = createController({
  fetchBytes: fetchGifBytes,
  decode,
  createEngine,
  createOverlay,
  mountControls,
});

// Discovery scope (PRD §12): ON-DEMAND via the toolbar popup. The popup's
// "Select a GIF" button sends PICK_GIF to this content script, which enters a
// one-shot "pick mode": the next click on a GIF candidate enhances it (or tears
// it down if already enhanced); Esc or clicking elsewhere cancels. Only GIFs the
// user opts into spin up an engine/overlay/controls.
let picking = false;
let previousCursor = '';

export function enterPickMode(): void {
  if (picking) return;
  picking = true;
  previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';
  document.addEventListener('click', onPickClick, true);
  document.addEventListener('keydown', onPickKey, true);
}

export function exitPickMode(): void {
  if (!picking) return;
  picking = false;
  document.documentElement.style.cursor = previousCursor;
  document.removeEventListener('click', onPickClick, true);
  document.removeEventListener('keydown', onPickKey, true);
}

function onPickClick(event: MouseEvent): void {
  const img = (event.target as Element | null)?.closest('img') as HTMLImageElement | null;
  // Consume the click that ends pick mode so it doesn't reach the page (e.g. a
  // link wrapping the GIF), then leave pick mode regardless of the target.
  event.preventDefault();
  event.stopPropagation();
  exitPickMode();
  if (!img || !isGifCandidate(img)) return; // clicked elsewhere → just cancel
  if (controller.instances.has(img)) controller.teardown(img);
  else void controller.processImage(img);
}

function onPickKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') exitPickMode();
}

/** Bootstrap the toolbar-driven trigger. Returns a teardown for SPA cleanup (issue 13). */
export function init(): () => void {
  // Guard so importing this module headlessly (tests) doesn't touch `browser`.
  if (typeof browser === 'undefined' || !browser.runtime?.onMessage) {
    return () => {};
  }
  const onMessage = (message: unknown) => {
    if (isPickGifRequest(message)) enterPickMode();
    return undefined;
  };
  browser.runtime.onMessage.addListener(onMessage);
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    exitPickMode();
    controller.teardownAll();
  };
}

console.debug('[jiffy] content script loaded');
init();
