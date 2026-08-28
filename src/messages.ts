// Shared messaging contract for cross-origin GIF fetching.
//
// A content script has an <img>, not raw bytes, and same-origin `fetch` is
// blocked by CORS for cross-origin images. The background script — running on
// whatever host access the extension holds — can fetch those bytes and hand them
// back over `runtime.sendMessage`. Host access beyond the active tab is the
// user's call (see src/popup/popup.ts), so a cross-origin fetch here may itself
// be refused; that comes back as an ordinary error response.
//
// Wire format is base64, NOT a raw `ArrayBuffer`. Firefox structured-clones
// message payloads so an `ArrayBuffer` would round-trip intact there, but Chrome
// serialises messages as JSON — an `ArrayBuffer` collapses to `{}`, the content
// script then sniffs empty bytes and reports "Not an animated image". A base64
// string survives JSON on both browsers; the content client decodes it back to an
// `ArrayBuffer`. (Trade-off: ~33% transfer overhead vs. Firefox's zero-copy clone,
// negligible for typical GIFs and the price of one code path that works in both.)
//
// This module is environment-agnostic (no `browser.*`): both the background
// entry and the content client import from it, and it's unit-testable headless.

import {
  assertDeclaredSize,
  BACKGROUND_SCHEMES,
  isAllowedUrl,
  MAX_BYTES,
  readCapped,
} from "./fetchLimits";

/** Content → background: please fetch this GIF's bytes. */
export interface FetchGifRequest {
  readonly type: "FETCH_GIF";
  readonly url: string;
}

/** Background → content: the bytes as base64 (see wire-format note above), or a typed error. */
export type FetchGifResponse =
  | { readonly ok: true; readonly data: string }
  | { readonly ok: false; readonly error: string };

/**
 * Base64 codec for the message wire format. `btoa`/`atob` operate on binary
 * strings, so we bridge through one char per byte. The encode side chunks the
 * `String.fromCharCode(...)` spread (a single spread of a multi-MB array would
 * overflow the call-stack argument limit); decode is a plain per-char loop.
 */
const B64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Shape test shared by the message guards below. */
function hasType(message: unknown, type: string): boolean {
  return (
    typeof message === "object" && message !== null && (message as { type?: unknown }).type === type
  );
}

/** Narrow an untyped incoming message to a `FetchGifRequest`. */
export function isFetchGifRequest(message: unknown): message is FetchGifRequest {
  return hasType(message, "FETCH_GIF") && typeof (message as { url?: unknown }).url === "string";
}

/**
 * Popup → content script: enter "pick a GIF" mode. Sent when
 * the user clicks the toolbar popup's button; the content script then enhances
 * the next GIF they click. Delivered to every frame of the tab, since the GIF may
 * be inside an embed rather than the top document.
 */
export interface PickGifRequest {
  readonly type: "PICK_GIF";
}

/** Narrow an untyped incoming message to a `PickGifRequest`. */
export function isPickGifRequest(message: unknown): message is PickGifRequest {
  return hasType(message, "PICK_GIF");
}

/**
 * Content → background: the pick is over in this frame — an image was clicked,
 * something else was clicked, or Escape was pressed.
 *
 * The content script runs in every frame of the tab, so `PICK_GIF` arms all of
 * them at once and whichever frame sees the interaction first resolves it. Frames
 * have no way to message each other, so the resolving one tells the background,
 * which fans an `ExitPickRequest` back out to the whole tab. Without that relay a
 * pick made in one frame would leave every other frame armed and wearing a
 * crosshair.
 */
export interface PickEndedRequest {
  readonly type: "PICK_ENDED";
}

/** Narrow an untyped incoming message to a `PickEndedRequest`. */
export function isPickEndedRequest(message: unknown): message is PickEndedRequest {
  return hasType(message, "PICK_ENDED");
}

/** Background → every frame of a tab: leave pick mode (see `PickEndedRequest`). */
export interface ExitPickRequest {
  readonly type: "EXIT_PICK";
}

/** Narrow an untyped incoming message to an `ExitPickRequest`. */
export function isExitPickRequest(message: unknown): message is ExitPickRequest {
  return hasType(message, "EXIT_PICK");
}

// Fetch hardening. The URL is attacker-influenced (the page supplies the <img>
// src the user clicks), so bound the request: restrict the scheme and cap the
// size (both shared with the content-script tier in ./fetchLimits), and time it
// out so a hung request can't hold the message channel open forever.
const FETCH_TIMEOUT_MS = 120_000; // 2 min — large images on slow links; the
// loading banner's cancel button covers impatience.

/**
 * Perform the actual cross-origin fetch (runs in the background context). Never
 * throws — disallowed schemes, oversized bodies, timeouts, network failures and
 * non-OK statuses all become a typed error response. `maxBytes`/`timeoutMs` are
 * injectable for tests.
 */
export async function handleFetchGif(
  url: string,
  {
    maxBytes = MAX_BYTES,
    timeoutMs = FETCH_TIMEOUT_MS,
  }: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchGifResponse> {
  if (!isAllowedUrl(url, BACKGROUND_SCHEMES)) {
    return { ok: false, error: "Refusing to fetch a non-http(s)/data URL" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `force-cache` reuses whatever the browser already downloaded for the page
    // instead of paying for the bytes a second time.
    const response = await fetch(url, { cache: "force-cache", signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }
    assertDeclaredSize(response, maxBytes);
    const buf = await readCapped(response, maxBytes);
    return { ok: true, data: bytesToBase64(new Uint8Array(buf)) };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: `Fetch timed out after ${timeoutMs}ms` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
