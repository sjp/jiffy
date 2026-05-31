// Content-script entry + per-image pipeline (issue 11 / PRD §2, §10.6).
//
// For each animated image (GIF or WebP) on the page we run: fetch bytes
// (issue 06) → decode (issue 03) → engine (issue 04) → overlay canvas (issue 05)
// → controls (07–10), tracking every instance so it can be torn down cleanly.
// One engine + overlay + controls per image; a decode failure on one must not
// break the others.
//
// The pipeline's collaborators are injected (createController) so the discovery /
// registry / teardown logic is unit-testable headless without a real canvas or
// the background channel.
//
// Issue 13 adds DOM-lifecycle reconciliation: a debounced MutationObserver tears
// down a GIF's player when its <img> leaves the document (lazy unmount, SPA route
// change), reusing the idempotent registry + teardown so no rAF loop, listener or
// bitmap leaks. Because discovery is ON-DEMAND (the user picks GIFs via the
// popup), the observer does NOT auto-enhance inserted GIFs — it only reconciles
// removals.
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
  /** Tear down any instance whose <img> has left the document (issue 13). */
  reconcile(): void;
  /** Watch `target` and reconcile removals (debounced); returns a stop fn (issue 13). */
  observe(target?: Node): () => void;
  /** Live registry (exposed for issue 13 + tests). */
  readonly instances: ReadonlyMap<HTMLImageElement, Instance>;
}

/** True if the image's resolved URL looks like an animated GIF or WebP. */
export function isAnimatedCandidate(img: HTMLImageElement): boolean {
  const url = img.currentSrc || img.src;
  return /\.(gif|webp)(?:[?#]|$)/i.test(url);
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
      console.debug('[jiffy] skipping image', img.currentSrc || img.src, err);
    } finally {
      pending.delete(img);
    }
  }

  function discover(root: ParentNode = document): void {
    for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
      if (isAnimatedCandidate(img)) void processImage(img);
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

  // Tear down players whose <img> is no longer in the document. Cheap (O(live
  // players)) and idempotent, so it's safe to call from a noisy observer.
  function reconcile(): void {
    for (const img of [...instances.keys()]) {
      if (!img.isConnected) teardown(img);
    }
  }

  function observe(target: Node = document): () => void {
    // Coalesce a burst of mutations (infinite scroll, an SPA swapping a whole
    // subtree) into a single reconcile on the next microtask.
    let scheduled = false;
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        reconcile();
      });
    };
    const observer =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    observer?.observe(target, { childList: true, subtree: true });
    // SPA route changes can swap DOM via history navigation; reconcile then too.
    const onPopState = (): void => schedule();
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', onPopState);
    }
    return () => {
      observer?.disconnect();
      if (typeof window !== 'undefined') {
        window.removeEventListener('popstate', onPopState);
      }
    };
  }

  return { processImage, discover, teardown, teardownAll, reconcile, observe, instances };
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
  if (!img || !isAnimatedCandidate(img)) return; // clicked elsewhere → just cancel
  if (controller.instances.has(img)) controller.teardown(img);
  else void controller.processImage(img);
}

function onPickKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') exitPickMode();
}

/**
 * Handle a toolbar click on a standalone animated image (top-level navigation to
 * a .gif or .webp renders as an ImageDocument: a generated page whose body is a
 * single <img>). There's exactly one unambiguous target, so toggle it directly —
 * enhance it, or tear it down if already enhanced — instead of entering pick mode.
 *
 * Returns `true` when this is a standalone animated-image document (caller should
 * skip pick mode), `false` on a normal page so the caller falls back to pick mode.
 * Guarded by content type so it never fires on pages that merely contain images.
 */
export function enhanceStandaloneImage(
  target: Pick<Controller, 'processImage' | 'teardown' | 'instances'> = controller,
): boolean {
  if (typeof document === 'undefined') return false;
  const ct = document.contentType;
  if (ct !== 'image/gif' && ct !== 'image/webp') return false;
  const img = document.querySelector('img');
  if (img && isAnimatedCandidate(img)) {
    if (target.instances.has(img)) target.teardown(img);
    else void target.processImage(img);
  }
  return true; // a standalone image document — handled here, don't enter pick mode
}

/** Bootstrap the toolbar-driven trigger. Returns a teardown for SPA cleanup (issue 13). */
export function init(): () => void {
  // Guard so importing this module headlessly (tests) doesn't touch `browser`.
  if (typeof browser === 'undefined' || !browser.runtime?.onMessage) {
    return () => {};
  }
  const onMessage = (message: unknown) => {
    // Toolbar click. On a standalone GIF (opened directly) there's exactly one
    // unambiguous target, so toggle it straight away; otherwise fall back to
    // on-demand pick mode so the user chooses which GIF on the page to enhance.
    if (isPickGifRequest(message) && !enhanceStandaloneImage()) enterPickMode();
    return undefined;
  };
  browser.runtime.onMessage.addListener(onMessage);
  // Keep the player set in sync with the live DOM: tear down players whose GIF
  // was removed (lazy unmount / SPA navigation) so nothing leaks (issue 13).
  const stopObserving = controller.observe();
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    stopObserving();
    exitPickMode();
    controller.teardownAll();
  };
}

console.debug('[jiffy] content script loaded');
init();
