// Content-script entry + per-image pipeline.
//
// For each animated image on the page we run: fetch bytes → decode → engine
// → overlay canvas → controls, tracking every instance so it can be torn down
// cleanly. One engine + overlay + controls per image; a decode failure on one
// must not break the others.
//
// The pipeline's collaborators are injected (createController) so the discovery /
// registry / teardown logic is unit-testable headless without a real canvas or
// the background channel.
//
// DOM-lifecycle reconciliation: a debounced MutationObserver tears down a GIF's
// player when its <img> leaves the document (lazy unmount, SPA route change),
// reusing the idempotent registry + teardown so no rAF loop, listener or bitmap
// leaks. Because discovery is ON-DEMAND (the user picks GIFs via the popup), the
// observer does NOT auto-enhance inserted GIFs — it only reconciles removals.
// The observer is attached lazily — only while ≥1 player is live — so an idle
// page (no GIF ever enhanced) carries zero observers and zero listeners.
import { decode, NotAnimatedError } from "../engine/decode";
import { createEngine } from "../engine/engine";
import { DecodeBudgetError } from "../engine/types";
import type { DecodeResult, Engine, Frame } from "../engine/types";
import { isPickGifRequest } from "../messages";
import { fetchGifBytes } from "./fetchGif";
import { mountControls } from "./mount";
import { createOverlay, type Overlay } from "./overlay";
import { showToast } from "./toast";

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
type StatusFn = (status: ProcessStatus) => void;

/** Collaborators for the per-GIF pipeline (injectable for tests). */
export interface PipelineDeps {
  fetchBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  decode: (bytes: ArrayBuffer, signal?: AbortSignal) => Promise<DecodeResult>;
  createEngine: (frames: Frame[], duration: number) => Engine;
  createOverlay: (img: HTMLImageElement, engine: Engine, frames: Frame[]) => Overlay;
  mountControls: (img: HTMLImageElement, engine: Engine, onClose: () => void) => () => void;
}

/** A live, controllable GIF on the page. */
interface Instance {
  engine: Engine;
  overlay: Overlay;
  teardownControls: () => void;
  /** Composited frames owned by this instance; their bitmaps are closed on teardown. */
  frames: Frame[];
}

/**
 * Release the native/GPU memory backing decoded frame bitmaps. ImageBitmap.close()
 * frees deterministically (rather than waiting for GC), so we call it on every
 * teardown and on the decode early-return paths to avoid leaking full-res frames.
 */
function closeFrames(frames: Frame[]): void {
  for (const frame of frames) frame.bitmap.close();
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
      const { frames, duration, loops } = await deps.decode(bytes, ac.signal);

      // Torn down mid-flight (reconcile / teardownAll): drop the frames silently.
      if (!pending.has(img)) {
        closeFrames(frames);
        return;
      }
      // A single frame is nothing to control — same outcome the user cares about
      // as a non-animated sniff: report it as not-animated, not a loaded player.
      if (frames.length <= 1) {
        closeFrames(frames);
        onStatus?.("not-animated");
        return;
      }

      const engine = deps.createEngine(frames, duration);
      // Seed the loop setting from the source so the controls default matches how
      // the image normally plays (e.g. a one-shot GIF starts with looping off).
      engine.setLoop(loops);
      const overlay = deps.createOverlay(img, engine, frames);
      const teardownControls = deps.mountControls(img, engine, () => teardown(img));
      instances.set(img, { engine, overlay, teardownControls, frames });
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
    // Overlay has stopped drawing, so freeing the frame bitmaps is now safe.
    closeFrames(instance.frames);
    instances.delete(img);
    stopWatchingIfIdle(); // last player gone → detach the watcher
  }

  function teardownAll(): void {
    for (const ac of pending.values()) ac.abort();
    pending.clear();
    for (const instance of instances.values()) {
      instance.overlay.destroy();
      instance.teardownControls();
      closeFrames(instance.frames);
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

/** Default wiring used when running as the actual content script. */
export const controller = createController({
  fetchBytes: fetchGifBytes,
  decode,
  createEngine,
  createOverlay,
  mountControls,
});

// Discovery scope: ON-DEMAND via the toolbar popup. The popup's
// "Select a GIF" button sends PICK_GIF to this content script, which enters a
// one-shot "pick mode": the next click on an <img> enhances it (or tears it down
// if already enhanced); Esc or clicking anything else cancels. Only images the
// user opts into spin up an engine/overlay/controls.
//
// Any <img> is a valid pick — there is deliberately no URL/extension pre-filter.
// Plenty of animated images live behind extension-less CDN paths, signed URLs,
// or blob:/data: sources, and rejecting those made pick mode look broken. The
// byte-sniff in decode() is the authority: it throws NotAnimatedError for static
// bytes, which surfaces as a "Not an animated image" toast.

/** The controller surface pick mode drives (injectable for tests). */
type PickTarget = Pick<Controller, "processImage" | "teardown" | "instances">;

let picking = false;
let previousCursor = "";
let pickTarget: PickTarget = controller;

/**
 * Build a status callback that drives a toast anchored at the given viewport
 * point (issues #4/#5). The toast is created lazily on the first status so a
 * no-op pick (e.g. clicking an already-handled image) leaves nothing on screen;
 * the "Loading…" message clears when the overlay mounts, while the terminal
 * messages auto-dismiss.
 */
function toastReporter(clientX: number, clientY: number, onCancel?: () => void): StatusFn {
  let toast: ReturnType<typeof showToast> | null = null;
  const ensure = () => (toast ??= showToast(clientX, clientY, onCancel));
  return (status) => {
    switch (status) {
      case "loading":
        ensure().set("Loading…");
        break;
      case "ready":
        toast?.dismiss();
        break;
      case "not-animated":
        ensure().set("Not an animated image", 2000);
        break;
      case "too-large":
        ensure().set("Image too large to play", 2500);
        break;
      case "error":
        ensure().set("Couldn't load this image", 2500);
        break;
    }
  };
}

export function enterPickMode(target: PickTarget = controller): void {
  if (picking) return;
  picking = true;
  pickTarget = target;
  previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";
  document.addEventListener("click", onPickClick, true);
  document.addEventListener("keydown", onPickKey, true);
}

export function exitPickMode(): void {
  if (!picking) return;
  picking = false;
  document.documentElement.style.cursor = previousCursor;
  document.removeEventListener("click", onPickClick, true);
  document.removeEventListener("keydown", onPickKey, true);
}

function onPickClick(event: MouseEvent): void {
  const img = (event.target as Element | null)?.closest("img") as HTMLImageElement | null;
  // Clicking anything that isn't an image (empty space, a link, a button): just
  // leave pick mode and let the click behave normally — don't swallow it, so a
  // link still navigates and a button still presses.
  if (!img) {
    exitPickMode();
    return;
  }
  // Landing on an image: consume the click so it doesn't reach the page (e.g. a
  // link wrapping the GIF), then enhance it (or toggle it back off). Whether the
  // bytes are actually animated is decode()'s call, reported via the toast.
  const target = pickTarget;
  event.preventDefault();
  event.stopPropagation();
  exitPickMode();
  if (target.instances.has(img)) target.teardown(img);
  else
    void target.processImage(
      img,
      toastReporter(event.clientX, event.clientY, () => target.teardown(img)),
    );
}

function onPickKey(event: KeyboardEvent): void {
  if (event.key === "Escape") exitPickMode();
}

const animatedMimeTypes = ["image/gif", "image/webp", "image/png", "image/apng", "image/avif"];

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
export function enhanceStandaloneImage(target: PickTarget = controller): boolean {
  if (typeof document === "undefined") return false;
  const ct = document.contentType;
  if (!animatedMimeTypes.some((m) => m === ct)) return false;
  const img = document.querySelector("img");
  if (img) {
    if (target.instances.has(img)) target.teardown(img);
    // No cursor here (toolbar click on a full-page image) — anchor feedback at the
    // top-centre of the viewport.
    else
      void target.processImage(
        img,
        toastReporter(window.innerWidth / 2, 56, () => target.teardown(img)),
      );
  }
  return true; // a standalone image document — handled here, don't enter pick mode
}

/** Bootstrap the toolbar-driven trigger. Returns a teardown for SPA cleanup. */
export function init(): () => void {
  // Guard so importing this module headlessly (tests) doesn't touch `browser`.
  if (typeof browser === "undefined" || !browser.runtime?.onMessage) {
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
  // The DOM-removal watcher that keeps the player set in sync with the live DOM
  // is attached lazily by the controller once a GIF is actually enhanced, so an
  // idle page installs nothing beyond this single message listener. teardownAll()
  // below also detaches that watcher if one is active.
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    exitPickMode();
    controller.teardownAll();
  };
}

init();
