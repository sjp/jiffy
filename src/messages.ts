// Shared messaging contract for cross-origin GIF fetching (issue 06 / PRD §3).
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
  readonly type: 'FETCH_GIF';
  readonly url: string;
}

/** Background → content: the bytes, or a typed error. */
export type FetchGifResponse =
  | { readonly ok: true; readonly data: ArrayBuffer }
  | { readonly ok: false; readonly error: string };

/** Narrow an untyped incoming message to a `FetchGifRequest`. */
export function isFetchGifRequest(message: unknown): message is FetchGifRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'FETCH_GIF' &&
    typeof (message as { url?: unknown }).url === 'string'
  );
}

/**
 * Perform the actual cross-origin fetch (runs in the background context). Never
 * throws — network failures and non-OK statuses become a typed error response.
 */
export async function handleFetchGif(url: string): Promise<FetchGifResponse> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} ${response.statusText}` };
    }
    return { ok: true, data: await response.arrayBuffer() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
