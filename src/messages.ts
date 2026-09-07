// Shared messaging contract for cross-origin GIF fetching.
//
// A content script has an <img>, not raw bytes, and same-origin `fetch` is
// blocked by CORS for cross-origin images. The background script — running on
// whatever host access the extension holds — can fetch those bytes and hand them
// back. Host access beyond the active tab is the user's call (see
// src/popup/popup.ts), so a cross-origin fetch here may itself be refused; that
// comes back as an ordinary error message.
//
// The bytes travel over a `runtime.connect` PORT, in base64 chunks, NOT as one
// `sendMessage` reply. Two reasons:
//
//   * Size. Chromium caps a single message (tens of MB, version-dependent) and
//     rejects anything over it with "Message length exceeded maximum allowed
//     length" — which a large image hit only *after* the background had
//     downloaded the whole thing. Chunks of `CHUNK_BYTES` always fit, so the
//     background tier has the same 256 MB ceiling as the direct one.
//   * Memory. The background streams each chunk out as it arrives and never
//     holds the whole image, which matters most in the least memory-tolerant
//     context there is — an MV3 service worker.
//
// Base64, and not a raw `ArrayBuffer`, because Chrome serialises extension
// messages as JSON: an `ArrayBuffer` collapses to `{}`, the content script then
// sniffs empty bytes and reports "Not an animated image". (Firefox
// structured-clones and would round-trip it, but one code path beats two.)
//
// This module is environment-agnostic (no `browser.*`): both the background
// entry and the content client import from it, and it's unit-testable headless.

import {
  assertDeclaredSize,
  assertImageContentType,
  assertReachableFromPage,
  BACKGROUND_SCHEMES,
  concatBytes,
  isAllowedUrl,
  MAX_BYTES,
  readCappedChunks,
} from "./fetchLimits";

/** Name of the port the content script opens for one image fetch. */
export const FETCH_PORT = "jiffy-fetch";

/** Content → background: please fetch this GIF's bytes. First message on the port. */
export interface FetchGifRequest {
  readonly type: "FETCH_GIF";
  readonly url: string;
}

/**
 * Background → content, over the port: a slice of the body as base64, then
 * exactly one terminal message. The port stays open after the terminal message;
 * the content side closes it (see `content/fetchGif`).
 */
export type FetchGifEvent =
  | { readonly type: "FETCH_CHUNK"; readonly data: string }
  | { readonly type: "FETCH_DONE" }
  | { readonly type: "FETCH_ERROR"; readonly error: string };

/**
 * Base64 codec for the wire format. Both supported browsers ship the native
 * `Uint8Array` base64 methods, which skip the intermediate binary string
 * entirely; the hand-rolled pair below is the fallback for anything that
 * doesn't (older Node, say, when this module is exercised headless).
 *
 * `btoa`/`atob` operate on binary strings, so the fallback bridges through one
 * char per byte. Encoding chunks the `String.fromCharCode(...)` spread — a
 * single spread of a multi-MB array would overflow the call-stack argument
 * limit; decoding is a plain per-char loop.
 */
const NativeBase64 = Uint8Array as unknown as {
  fromBase64?(base64: string): Uint8Array;
};

const B64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as { toBase64?(): string }).toBase64?.();
  if (native != null) return native;
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const native = NativeBase64.fromBase64?.(base64);
  if (native != null) return native;
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

/** Narrow an untyped port message to one of the background's three replies. */
export function isFetchGifEvent(message: unknown): message is FetchGifEvent {
  if (hasType(message, "FETCH_CHUNK")) {
    return typeof (message as { data?: unknown }).data === "string";
  }
  if (hasType(message, "FETCH_ERROR")) {
    return typeof (message as { error?: unknown }).error === "string";
  }
  return hasType(message, "FETCH_DONE");
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
// src the user clicks), so bound the request: restrict the scheme, refuse a
// reach into the user's private network, refuse a body the server itself says
// isn't an image, cap the size (all four shared with the content-script tier in
// ./fetchLimits), and time it out so a hung request can't hold the port open
// forever.
const FETCH_TIMEOUT_MS = 120_000; // 2 min — large images on slow links; the
// loading banner's cancel button covers impatience.

/**
 * Raw bytes per `FETCH_CHUNK`, comfortably inside every reported per-message
 * limit once base64 has grown it by a third (4 MB → ~5.3 MB on the wire).
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

export interface StreamFetchGifOptions {
  /** URL of the page that asked, for the private-network guard (`port.sender.url`). */
  pageUrl?: string;
  /** Aborts the transfer — wired to the port disconnecting. */
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  chunkBytes?: number;
}

/**
 * Perform the actual cross-origin fetch (runs in the background context) and
 * push it to `post` as base64 chunks followed by one terminal message. Never
 * throws and never rejects — disallowed schemes, private hosts, non-image
 * Content-Types, oversized bodies, timeouts, network failures and non-OK
 * statuses all become a `FETCH_ERROR`. The options are injectable for tests.
 */
export async function streamFetchGif(
  url: string,
  post: (event: FetchGifEvent) => void,
  {
    pageUrl,
    signal,
    maxBytes = MAX_BYTES,
    timeoutMs = FETCH_TIMEOUT_MS,
    chunkBytes = CHUNK_BYTES,
  }: StreamFetchGifOptions = {},
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (!isAllowedUrl(url, BACKGROUND_SCHEMES)) {
      throw new Error("Refusing to fetch a non-http(s)/data URL");
    }
    assertReachableFromPage(new URL(url), pageUrl);
    // `force-cache` reuses whatever the browser already downloaded for the page
    // instead of paying for the bytes a second time.
    const response = await fetch(url, { cache: "force-cache", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    assertImageContentType(response);
    assertDeclaredSize(response, maxBytes);

    // Coalesce the reader's chunks (typically tens of KB) up to `chunkBytes`, so
    // a few-MB image is a handful of messages rather than hundreds.
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = () => {
      if (pendingBytes === 0) return;
      post({ type: "FETCH_CHUNK", data: bytesToBase64(concatBytes(pending, pendingBytes)) });
      pending = [];
      pendingBytes = 0;
    };
    for await (const chunk of readCappedChunks(response, maxBytes)) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= chunkBytes) flush();
    }
    flush();
    post({ type: "FETCH_DONE" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // The content side hanging up is the common case: it has stopped
      // listening, so there is nobody to tell.
      if (timedOut) post({ type: "FETCH_ERROR", error: `Fetch timed out after ${timeoutMs}ms` });
      return;
    }
    post({ type: "FETCH_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
