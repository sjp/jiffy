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
import { DecodeBudgetError, formatBytes, UnsupportedFormatError } from "../engine/types";
import type { DecodeResult, Engine, Frame } from "../engine/types";
import { createFrameExport } from "./exportFrame";
import type { FrameExport } from "./exportFrame";
import type { Overlay } from "./overlay";

/**
 * Outcomes of running an image through the pipeline, reported to an optional
 * callback so the content script can surface feedback:
 *   loading       — fetch/decode started (show a transient "Loading…")
 *   ready         — overlay mounted, controls live (clear the loading message)
 *   not-animated  — single-frame or no animated sniffer matched
 *   too-large     — decode would exceed the memory budget
 *   unsupported   — an animated format this browser has no decoder for
 *   error         — genuine fetch/decode failure
 */
export type ProcessStatus =
  | "loading"
  | "ready"
  | "not-animated"
  | "too-large"
  | "unsupported"
  | "error";
/**
 * `detail` is a short human phrase the message may fold in: the decode's
 * estimated size for `too-large` ("~1.8 GB"), the format's name for
 * `unsupported` ("Animated AVIF"). Resolved here rather than in the content
 * script so the always-loaded script keeps no dependency on the engine bundle.
 */
export type StatusFn = (status: ProcessStatus, detail?: string) => void;

/** Collaborators for the per-GIF pipeline (injectable for tests). */
export interface PipelineDeps {
  fetchBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  decode: (bytes: ArrayBuffer, signal?: AbortSignal) => Promise<DecodeResult>;
  createEngine: (frames: Frame[], duration: number) => Engine;
  createOverlay: (img: HTMLImageElement, engine: Engine, source: FrameSource) => Overlay;
  mountControls: (
    img: HTMLImageElement,
    engine: Engine,
    onClose: () => void,
    frameExport: FrameExport,
  ) => () => void;
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
  /**
   * Detaches the source-change listeners. An instance is tied to the bytes we
   * decoded, not to the element it hangs off, so it must go when the <img>
   * loads something else.
   */
  stopSourceWatch: () => void;
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

/**
 * Was this rejection the user's own cancel? Matched on `name` rather than
 * `instanceof DOMException` because the abort can be raised in the worker realm
 * (decodeInWorker) as well as here.
 */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
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
    // Identity, not presence: cancel-then-repick on the same <img> puts a second
    // pipeline in the map before this one's abort rejection has unwound, and
    // asking "is anything pending for this img?" would then hand the newer
    // pipeline's entry to the older one — which would report the older one's
    // failure and delete the newer one's registration, losing both loads.
    const mine = (): boolean => pending.get(img) === ac;
    onStatus?.("loading");
    try {
      const url = img.currentSrc || img.src;
      const bytes = await deps.fetchBytes(url, ac.signal);
      const { frames, source, duration, loops } = await deps.decode(bytes, ac.signal);

      // Torn down mid-flight (reconcile / teardownAll), or superseded by a newer
      // pick of the same image: drop the frames silently.
      if (!mine()) {
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
      // The controls export frames straight out of the source that feeds the
      // overlay, so a saved frame is exactly the one on screen — and the image's
      // URL is what names the file.
      const teardownControls = deps.mountControls(
        img,
        engine,
        () => teardown(img),
        createFrameExport(source, url),
      );
      instances.set(img, {
        engine,
        overlay,
        teardownControls,
        source,
        stopSourceWatch: watchSource(img, url),
      });
      ensureWatching(); // first live player → start watching for DOM removals
      onStatus?.("ready");
    } catch (err) {
      // One bad GIF shouldn't break the rest. Distinguish "not an animated image"
      // (expected — the user can click any <img>, and most images are static) from
      // a genuine failure so the feedback can be specific. Stay silent if torn
      // down mid-flight.
      console.debug("[jiffy] skipping image", img.currentSrc || img.src, err);
      // An abort is the user's own cancel, so it never gets a toast — checked
      // independently of the map so a pipeline whose entry was already replaced
      // still stays silent.
      if (mine() && !isAbort(err)) {
        const status: ProcessStatus =
          err instanceof NotAnimatedError
            ? "not-animated"
            : err instanceof DecodeBudgetError
              ? "too-large"
              : err instanceof UnsupportedFormatError
                ? "unsupported"
                : "error";
        // Size is only known when the decoder measured it before bailing.
        const detail =
          err instanceof DecodeBudgetError && err.bytes !== undefined
            ? `~${formatBytes(err.bytes)}`
            : err instanceof UnsupportedFormatError
              ? err.format
              : undefined;
        onStatus?.(status, detail);
      }
    } finally {
      if (mine()) pending.delete(img);
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
    instance.stopSourceWatch();
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
      instance.stopSourceWatch();
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

  // Watch one live player's <img> for a change of source, and return a stop fn.
  // reconcile() only catches an element leaving the document, but the element
  // commonly outlives the picture: carousels reuse one <img> and swap `src`,
  // lazy-loaders replace a placeholder with the real URL, `srcset` re-selects a
  // different candidate on resize, and SPAs rewrite `src` on a route change. The
  // overlay would go on painting the animation we decoded over a different image
  // while the page's own <img> stays hidden, so the instance is torn down and the
  // page gets its picture back.
  //
  // `load`/`error` is the signal rather than a MutationObserver on `src`/`srcset`:
  // an attribute change fires before the browser has chosen a candidate, and
  // `currentSrc` — which is what a `<picture>` re-selection moves — is only
  // settled once the load has resolved. `error` counts too: a new source that
  // fails to load still means the old frames are the wrong picture.
  function watchSource(img: HTMLImageElement, url: string): () => void {
    const onLoadEnd = (): void => {
      if ((img.currentSrc || img.src) !== url) teardown(img);
    };
    img.addEventListener("load", onLoadEnd);
    img.addEventListener("error", onLoadEnd);
    return () => {
      img.removeEventListener("load", onLoadEnd);
      img.removeEventListener("error", onLoadEnd);
    };
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
