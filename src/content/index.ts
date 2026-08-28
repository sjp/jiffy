// Content-script loader — the only code injected into every page.
//
// This script is deliberately tiny: a runtime message listener, the pick-mode
// state machine, and the status toast. Everything with real weight (Preact,
// gifuct-js, the decoders, the engine, the overlay, the controls UI) lives in
// ./player, an ESM bundle listed in `web_accessible_resources` that this module
// `import()`s the first time the user actually picks an image. The overwhelming
// majority of tabs never activate Jiffy, and those pay for this file alone.
//
// Discovery scope: ON-DEMAND via the toolbar popup. The popup's
// "Select a GIF" button sends PICK_GIF to this content script, which enters a
// one-shot "pick mode": the next click on an <img> enhances it (or tears it down
// if already enhanced); Esc or clicking anything else cancels. Only images the
// user opts into spin up an engine/overlay/controls.
//
// Frames: this script is injected into every frame, because plenty of animated
// images live inside embeds (forum posts, comment widgets, sandboxed previews)
// rather than the top document. PICK_GIF is broadcast to the whole tab, so every
// frame arms itself and the one the user actually clicks in resolves the pick —
// then announces it (endPick) so the others disarm. See PickEndedRequest. Each
// frame loads its own copy of the player bundle, on its own first pick.
//
// Any <img> is a valid pick — there is deliberately no URL/extension pre-filter.
// Plenty of animated images live behind extension-less CDN paths, signed URLs,
// or blob:/data: sources, and rejecting those made pick mode look broken. The
// byte-sniff in decode() is the authority: it throws NotAnimatedError for static
// bytes, which surfaces as a "Not an animated image" toast.
import { isExitPickRequest, isPickGifRequest } from "../messages";
import type { PickEndedRequest } from "../messages";
import type { Controller, StatusFn } from "./controller";
import { findImageAtPoint } from "./pick";
import { showToast } from "./toast";

/** The slice of the player bundle this loader drives. */
export type Player = Pick<Controller, "processImage" | "teardown" | "teardownAll" | "instances">;

/** Shape of the lazily-imported ./player module. */
export interface PlayerModule {
  readonly controller: Player;
}

/** Built output name of the player bundle (see scripts/build.mjs + the manifests). */
const PLAYER_BUNDLE = "player.js";

/**
 * How the player bundle is obtained. Firefox and Chrome both allow a content
 * script to `import()` an extension URL that is web-accessible; the specifier
 * has to be built at runtime because the origin is per-profile (Firefox) or
 * per-extension (Chrome). Swappable so the headless tests can drive pick mode
 * without an extension runtime — the same dependency-injection seam the
 * pipeline uses (see PipelineDeps).
 */
let importPlayer = (): Promise<PlayerModule> =>
  import(browser.runtime.getURL(PLAYER_BUNDLE)) as Promise<PlayerModule>;

/** Replace the player import (tests). Also drops any already-loaded player. */
export function setPlayerLoader(load: () => Promise<PlayerModule>): void {
  importPlayer = load;
  player = null;
  loading = null;
}

/** The loaded player, once the bundle has arrived. Null until the first pick. */
let player: Player | null = null;
/** In-flight import, so two quick picks share one load. */
let loading: Promise<Player | null> | null = null;

/**
 * Resolve the player, importing the bundle on first use. A failure (the page
 * blocked the request, the extension was reloaded mid-pick) resolves to null and
 * clears the memo so a later pick retries rather than being stuck forever.
 */
function ensurePlayer(): Promise<Player | null> {
  if (player) return Promise.resolve(player);
  // `.then(importPlayer)` rather than calling it directly: `browser.runtime`
  // throws outright once the extension context is invalidated (reloaded or
  // updated mid-pick), and that must surface as a rejected load, not as an
  // exception thrown back into the click handler.
  loading ??= Promise.resolve()
    .then(importPlayer)
    .then((module) => (player = module.controller))
    .catch((err: unknown) => {
      console.debug("[jiffy] could not load the player bundle", err);
      loading = null;
      return null;
    });
  return loading;
}

/**
 * How long an armed frame waits before disarming itself. A resolved pick disarms
 * every frame through the background relay, but an ABANDONED one (the user
 * wanders off, the embed scrolls out of sight) has no such signal — and a frame
 * left armed swallows the user's next click on one of its images. Generous
 * enough to hunt for the right GIF, short enough that a forgotten pick expires.
 */
const PICK_TIMEOUT_MS = 60_000;

let picking = false;
let previousCursor = "";
let pickTimer: ReturnType<typeof setTimeout> | undefined;

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

/**
 * Toggle Jiffy on `img`: enhance it, or tear it down if it's already enhanced.
 * Feedback is anchored at the viewport point the user acted on.
 *
 * On the frame's very first pick the player bundle has to come across before
 * anything can happen, so the "Loading…" toast goes up straight away — the same
 * one the fetch/decode then keeps writing to, so the user sees one continuous
 * message rather than a dead pause followed by a toast. Cancelling during that
 * window stops the pick; the module load itself is left to finish and is reused
 * by the next one.
 */
async function togglePlayer(
  img: HTMLImageElement,
  clientX: number,
  clientY: number,
): Promise<void> {
  let cancelled = false;
  const report = toastReporter(clientX, clientY, () => {
    cancelled = true;
    player?.teardown(img);
  });

  let target = player;
  if (!target) {
    report("loading");
    target = await ensurePlayer();
    if (!target) {
      report("error");
      return;
    }
    if (cancelled) return;
  }

  if (target.instances.has(img)) target.teardown(img);
  else void target.processImage(img, report);
}

export function enterPickMode(): void {
  if (picking) return;
  picking = true;
  // The user has declared intent, so warm the bundle now rather than on the
  // click: by the time they've aimed at an image it has usually arrived, and the
  // pick lands with no "Loading…" step at all.
  void ensurePlayer();
  previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";
  document.addEventListener("click", onPickClick, true);
  document.addEventListener("keydown", onPickKey, true);
  // Self-disarming safety nets, all local to this frame (see endPick).
  document.addEventListener("visibilitychange", onPickVisibilityChange);
  window.addEventListener("blur", exitPickMode);
  pickTimer = setTimeout(exitPickMode, PICK_TIMEOUT_MS);
}

/** Leave pick mode in THIS frame only. Idempotent. */
export function exitPickMode(): void {
  if (!picking) return;
  picking = false;
  document.documentElement.style.cursor = previousCursor;
  document.removeEventListener("click", onPickClick, true);
  document.removeEventListener("keydown", onPickKey, true);
  document.removeEventListener("visibilitychange", onPickVisibilityChange);
  window.removeEventListener("blur", exitPickMode);
  clearTimeout(pickTimer);
}

/**
 * Leave pick mode here AND in every other frame of the tab, by telling the
 * background to relay an EXIT_PICK broadcast. For the outcomes the user
 * deliberately produced — a click, or Escape — so one pick stays one pick.
 *
 * The safety nets deliberately do NOT come through here. A frame losing focus is
 * precisely what happens when the user clicks into a sibling frame, so
 * broadcasting from there would cancel the sibling a moment before it handles the
 * very click it was armed for.
 */
function endPick(): void {
  exitPickMode();
  if (typeof browser === "undefined" || !browser.runtime?.sendMessage) return;
  const message: PickEndedRequest = { type: "PICK_ENDED" };
  try {
    // A rejection only means nothing was listening; the local exit already ran.
    void browser.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Extension context invalidated (reloaded or updated mid-pick).
  }
}

// Switching tabs abandons the pick. Visibility is shared by every frame of the
// document, so each one disarms on its own without needing the relay.
function onPickVisibilityChange(): void {
  if (document.hidden) exitPickMode();
}

/**
 * Which image did this click mean? The point the user aimed at is the honest
 * answer — an image is very often covered by a stretched link, a caption
 * gradient or (once enhanced) Jiffy's own canvas, none of which the click target
 * can see past. The `event.target` path stays as the fallback for clicks that
 * carry no usable pointer position.
 */
function pickTarget(event: MouseEvent): HTMLImageElement | null {
  // Keyboard-activated clicks (Enter on a focused link) report (0, 0) rather
  // than a pointer position; hit-testing there would pick whatever happens to
  // sit in the top-left corner of the viewport.
  if (event.detail > 0 || event.clientX !== 0 || event.clientY !== 0) {
    const hit = findImageAtPoint(event.clientX, event.clientY);
    if (hit) return hit;
  }
  return (event.target as Element | null)?.closest("img") ?? null;
}

function onPickClick(event: MouseEvent): void {
  const img = pickTarget(event);
  // Clicking anything that isn't an image (empty space, a link, a button): just
  // leave pick mode and let the click behave normally — don't swallow it, so a
  // link still navigates and a button still presses.
  if (!img) {
    endPick();
    return;
  }
  // Landing on an image: consume the click so it doesn't reach the page (a link
  // wrapping the GIF, or the overlay we found it underneath — that one would
  // otherwise navigate away the moment the pick lands), then enhance it (or
  // toggle it back off). Whether the bytes are actually animated is decode()'s
  // call, reported via the toast.
  event.preventDefault();
  event.stopPropagation();
  endPick();
  void togglePlayer(img, event.clientX, event.clientY);
}

function onPickKey(event: KeyboardEvent): void {
  if (event.key === "Escape") endPick();
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
 * The guards are all cheap and synchronous, so a normal page reaches this and
 * bails without touching the player bundle.
 */
export function enhanceStandaloneImage(): boolean {
  if (typeof document === "undefined") return false;
  // Top frame only. A standalone image document is also what an <iframe> pointed
  // straight at a .gif renders, and a page can hold any number of those; toggling
  // every one of them off a single toolbar click isn't what the user asked for.
  // Sub-frames fall through to pick mode so the user says which image they mean.
  if (typeof window !== "undefined" && window !== window.top) return false;
  const ct = document.contentType;
  if (!animatedMimeTypes.some((m) => m === ct)) return false;
  const img = document.querySelector("img");
  // No cursor here (toolbar click on a full-page image) — anchor feedback at the
  // top-centre of the viewport.
  if (img) void togglePlayer(img, window.innerWidth / 2, 56);
  return true; // a standalone image document — handled here, don't enter pick mode
}

/** Bootstrap the toolbar-driven trigger. Returns a teardown for SPA cleanup. */
export function init(): () => void {
  // Guard so importing this module headlessly (tests) doesn't touch `browser`.
  if (typeof browser === "undefined" || !browser.runtime?.onMessage) {
    return () => {};
  }
  const onMessage = (message: unknown) => {
    // Toolbar click, broadcast to every frame. On a standalone GIF (opened
    // directly) there's exactly one unambiguous target, so toggle it straight
    // away; otherwise fall back to on-demand pick mode so the user chooses which
    // GIF — in whichever frame — to enhance.
    if (isPickGifRequest(message)) {
      if (!enhanceStandaloneImage()) enterPickMode();
    } else if (isExitPickRequest(message)) {
      // Another frame resolved the pick; disarm quietly (re-broadcasting from
      // here would just bounce the message around the tab).
      exitPickMode();
    }
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
    player?.teardownAll();
  };
}

init();
