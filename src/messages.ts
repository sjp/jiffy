// Shared messaging contract for cross-origin GIF fetching.
//
// A content script has an <img>, not raw bytes, and same-origin `fetch` is
// blocked by CORS for cross-origin images. The background script — granted
// `host_permissions` — can fetch those bytes and hand them back over
// `runtime.sendMessage`.
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

/** Narrow an untyped incoming message to a `FetchGifRequest`. */
export function isFetchGifRequest(
  message: unknown,
): message is FetchGifRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "FETCH_GIF" &&
    typeof (message as { url?: unknown }).url === "string"
  );
}

/**
 * Popup → content script: enter "pick a GIF" mode. Sent when
 * the user clicks the toolbar popup's button; the content script then enhances
 * the next GIF they click.
 */
export interface PickGifRequest {
  readonly type: "PICK_GIF";
}

/** Narrow an untyped incoming message to a `PickGifRequest`. */
export function isPickGifRequest(message: unknown): message is PickGifRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "PICK_GIF"
  );
}

// Fetch hardening. The URL is attacker-influenced (the page supplies
// the <img> src the user clicks), so bound the request: restrict the scheme, cap
// the size (the whole body is buffered then structured-cloned across the message
// boundary — an unbounded image risks OOM/jank), and time it out so a hung request
// can't hold the message channel open forever.
const MAX_BYTES = 256 * 1024 * 1024; // 256 MB
const FETCH_TIMEOUT_MS = 120_000; // 2 min — large images on slow links; the
// loading banner's cancel button covers impatience.
// data: is allowed so pages that inline an animated image as a data URI still work;
// everything else (file:, blob:, ftp:, …) is refused.
const ALLOWED_SCHEMES = new Set(["http:", "https:", "data:"]);

function isAllowedUrl(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false; // not a parseable absolute URL
  }
}

/**
 * Read a response body into an ArrayBuffer, aborting if it exceeds `maxBytes`.
 * Streams so an oversized body is rejected without buffering the whole thing
 * (and catches servers that omit or understate Content-Length). Falls back to
 * buffering when the response exposes no readable stream.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes)
      throw new Error(`Image exceeds ${maxBytes} byte limit`);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Image exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

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
  if (!isAllowedUrl(url)) {
    return { ok: false, error: "Refusing to fetch a non-http(s)/data URL" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }
    // Reject early when the server declares an oversized body, before reading it.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, error: `Image exceeds ${maxBytes} byte limit` };
    }
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
