// Per-image pipeline + player registry.
//
// For each animated image the user picks we run: fetch bytes → decode → engine
// → overlay canvas → controls, tracking every instance so it can be torn down
// cleanly. One engine + overlay + controls per image; a decode failure on one
// must not break the others.
//
// The pipeline's collaborators are injected (createController) so the discovery /
// registry / teardown logic is unit-testable headless without a real canvas or
// the background channel. The real wiring lives in ./player, the lazily-loaded
// bundle; the always-injected loader (./index) only ever sees this interface.
//
// DOM-lifecycle reconciliation: a debounced MutationObserver tears down a GIF's
// player when its <img> leaves the document (lazy unmount, SPA route change),
// reusing the idempotent registry + teardown so no rAF loop, listener or frame
// source leaks. Because discovery is ON-DEMAND (the user picks GIFs via the
// popup), the observer does NOT auto-enhance inserted GIFs — it only reconciles
// removals.
// The observer is attached lazily — only while ≥1 player is live — so a page
// where the user picked and then closed everything carries zero observers.
import { NotAnimatedError } from "../engine/decode";
import type { FrameSource } from "../engine/frameSource";
import { DecodeBudgetError } from "../engine/types";
import type { DecodeResult, Engine, Frame } from "../engine/types";
import type { Overlay } from "./overlay";

/**
 * Outcomes of running an image through the pipeline, reported to an optional
 * callback so the content script can surface feedback:
 *   loading       — fetch/decode started (show a transient "Loading…")
 *   ready         — overlay mounted, controls live (clear the loading message)
 *   not-animated  — single-frame or no animated sniffer matched
 *   too-large     — decode would exceed the pixel/memory budget
 *   error         — genuine fetch/decode failure
 */
export type ProcessStatus = "loading" | "ready" | "not-animated" | "too-large" | "error";
export type StatusFn = (status: ProcessStatus) => void;

/** Collaborators for the per-GIF pipeline (injectable for tests). */
export interface PipelineDeps {
  fetchBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  decode: (bytes: ArrayBuffer, signal?: AbortSignal) => Promise<DecodeResult>;
  createEngine: (frames: Frame[], duration: number) => Engine;
  createOverlay: (img: HTMLImageElement, engine: Engine, source: FrameSource) => Overlay;
  mountControls: (img: HTMLImageElement, engine: Engine, onClose: () => void) => () => void;
}

/** A live, controllable GIF on the page. */
interface Instance {
  engine: Engine;
  overlay: Overlay;
  teardownControls: () => void;
  /**
   * Frame pixels owned by this instance. Holds keyframe bitmaps (or, for AVIF, a
   * live decoder), so it must be closed on teardown — ImageBitmap.close() frees
   * deterministically rather than waiting for GC.
   */
  source: FrameSource;
}

export interface Controller {
  /** Process one image through the pipeline (de-duplicated). */
  processImage(img: HTMLImageElement, onStatus?: StatusFn): Promise<void>;
  /** Tear down a single image's instance. */
  teardown(img: HTMLImageElement): void;
  /** Tear down everything. */
  teardownAll(): void;
  /** Tear down any instance whose <img> has left the document. */
  reconcile(): void;
  /** Live registry (exposed for tests). */
  readonly instances: ReadonlyMap<HTMLImageElement, Instance>;
}

export function createController(deps: PipelineDeps): Controller {
  const instances = new Map<HTMLImageElement, Instance>();
  // In-flight loads, each paired with the AbortController that cancels it. Aborting
  // unwinds the fetch wait and breaks the decode loop (see throwIfAborted), so a
  // cancel during a slow large-GIF load stops the work rather than just discarding
  // its result. teardown() is the single place that aborts.
  const pending = new Map<HTMLImageElement, AbortController>();

  // DOM-removal watcher, lazily attached. The observer + popstate listener exist
  // ONLY while at least one player is live: with an empty registry reconcile()
  // has nothing to do, so on the overwhelming majority of pages — where the user
  // never activates the extension — we install no MutationObserver and no
  // listener at all. Started on the 0→1 instance transition, torn down on 1→0.
  let stopWatcher: (() => void) | null = null;
  const ensureWatching = (): void => {
    if (!stopWatcher) stopWatcher = startWatcher();
  };
  const stopWatchingIfIdle = (): void => {
    if (stopWatcher && instances.size === 0) {
      stopWatcher();
      stopWatcher = null;
    }
  };

  async function processImage(img: HTMLImageElement, onStatus?: StatusFn): Promise<void> {
    if (instances.has(img) || pending.has(img)) return; // never double-process
    const ac = new AbortController();
    pending.set(img, ac);
    onStatus?.("loading");
    try {
      const url = img.currentSrc || img.src;
      const bytes = await deps.fetchBytes(url, ac.signal);
      const { frames, source, duration, loops } = await deps.decode(bytes, ac.signal);

      // Torn down mid-flight (reconcile / teardownAll): drop the frames silently.
      if (!pending.has(img)) {
        source.close();
        return;
      }
      // A single frame is nothing to control — same outcome the user cares about
      // as a non-animated sniff: report it as not-animated, not a loaded player.
      if (frames.length <= 1) {
        source.close();
        onStatus?.("not-animated");
        return;
      }

      const engine = deps.createEngine(frames, duration);
      // Seed the loop setting from the source so the controls default matches how
      // the image normally plays (e.g. a one-shot GIF starts with looping off).
      engine.setLoop(loops);
      const overlay = deps.createOverlay(img, engine, source);
      const teardownControls = deps.mountControls(img, engine, () => teardown(img));
      instances.set(img, { engine, overlay, teardownControls, source });
      ensureWatching(); // first live player → start watching for DOM removals
      onStatus?.("ready");
    } catch (err) {
      // One bad GIF shouldn't break the rest. Distinguish "not an animated image"
      // (expected — the user can click any <img>, and most images are static) from
      // a genuine failure so the feedback can be specific. Stay silent if torn
      // down mid-flight.
      console.debug("[jiffy] skipping image", img.currentSrc || img.src, err);
      if (pending.has(img)) {
        const status: ProcessStatus =
          err instanceof NotAnimatedError
            ? "not-animated"
            : err instanceof DecodeBudgetError
              ? "too-large"
              : "error";
        onStatus?.(status);
      }
    } finally {
      pending.delete(img);
    }
  }

  function teardown(img: HTMLImageElement): void {
    // Abort first: if the image is still loading this cancels the fetch wait and
    // breaks the decode loop; if it's already a live instance there's no pending
    // controller and this is a no-op.
    pending.get(img)?.abort();
    pending.delete(img);
    const instance = instances.get(img);
    if (!instance) return;
    instance.overlay.destroy();
    instance.teardownControls();
    // Overlay has stopped drawing, so freeing the frame pixels is now safe.
    instance.source.close();
    instances.delete(img);
    stopWatchingIfIdle(); // last player gone → detach the watcher
  }

  function teardownAll(): void {
    for (const ac of pending.values()) ac.abort();
    pending.clear();
    for (const instance of instances.values()) {
      instance.overlay.destroy();
      instance.teardownControls();
      instance.source.close();
    }
    instances.clear();
    stopWatchingIfIdle(); // registry emptied → detach the watcher
  }

  // Tear down players whose <img> is no longer in the document. Cheap (O(live
  // players)) and idempotent, so it's safe to call from a noisy observer.
  function reconcile(): void {
    for (const img of instances.keys()) {
      if (!img.isConnected) teardown(img);
    }
  }

  // Attach the DOM-removal watcher and return a stop fn. Called lazily by
  // ensureWatching() once a player is live — never on an idle page.
  function startWatcher(): () => void {
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
      typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null;
    observer?.observe(document, { childList: true, subtree: true });
    // SPA route changes can swap DOM via history navigation; reconcile then too.
    const onPopState = (): void => schedule();
    if (typeof window !== "undefined") {
      window.addEventListener("popstate", onPopState);
    }
    return () => {
      observer?.disconnect();
      if (typeof window !== "undefined") {
        window.removeEventListener("popstate", onPopState);
      }
    };
  }

  return { processImage, teardown, teardownAll, reconcile, instances };
}
