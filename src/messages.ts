// Shared messaging contract for cross-origin GIF fetching.
//
// A content script has an <img>, not raw bytes, and same-origin `fetch` is
// blocked by CORS for cross-origin images. The background script — granted
// `host_permissions` — can fetch those bytes and hand them back over
// `runtime.sendMessage`. Firefox structured-clones message payloads, so an
// `ArrayBuffer` round-trips intact (unlike Chrome's JSON message serialisation).
//
// This module is environment-agnostic (no `browser.*`): both the background
// entry and the content client import from it, and it's unit-testable headless.

/** Content → background: please fetch this GIF's bytes. */
export interface FetchGifRequest {
  readonly type: "FETCH_GIF";
  readonly url: string;
}

/** Background → content: the bytes, or a typed error. */
export type FetchGifResponse =
  | { readonly ok: true; readonly data: ArrayBuffer }
  | { readonly ok: false; readonly error: string };

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
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const FETCH_TIMEOUT_MS = 30_000;
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
    return { ok: true, data: await readCapped(response, maxBytes) };
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
